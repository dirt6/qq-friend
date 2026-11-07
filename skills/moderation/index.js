// 群管理技能：把机器人已经有的管理员权限交给 AI 使用，并且让它在**没有人叫它**的
// 情况下也可能自己动手。
//
// 为什么需要它：机器人本身在群里就是管理员（role=admin），协议端（snowluma/NapCat）
// 也支持 set_group_ban / set_group_kick / delete_msg，但**核心的 28 个工具里一个
// 群管理能力都没有**。所以模型被要求"禁言他"时，它没有工具可调，只能嘴上答应或者
// 说做不到 —— 表现就是"从来没成功过"。
//
// 工具拿不到 api.onebot（Skill API 是白名单，只给 config/log/fetch/utils），
// 但工具执行时的 ctx 是完整上下文，里面有 ctx.onebot，所以直接 ctx.onebot.call()
// 调 OneBot 接口。这是本技能能成立的唯一支点。
//
// ── 自主性是怎么保证的（三层，缺一层就退化成"叫才干"）──
// 1. 架构层：群聊是全响应档位（contextTier=4），每条消息都会真正唤醒模型跑一轮，
//    它本来就有"自己决定要不要动手"的机会 —— 不需要有人专门叫它。
// 2. 提示词层：见 prompts.js 的 BOLD / CONSERVATIVE 两版，由「动手风格」一键切换。
//    胆大版写得**敢动手**（被惹到就动手，不用理由充分、不用先问），不是"动手是最后
//    手段"那种克制写法。模型只对上下文里显眼且具体的东西有反应，抽象授权（"你是
//    管理员，可以禁言"）它只会点头然后什么也不做 —— 所以两版都给了具体场景。
// 3. 确定性层：本文件的 hooks['before-llm-messages']。检测到刷屏/复读时，往这次请求里
//    塞一句"现在可以考虑动手"的提醒。**只提醒、不代替它决定** —— 推一把，动不动手
//    仍然是模型看上下文自己判断。这一层解决的是"模型没注意到"的漏判，不是替它做决定。
//
// ── 安全边界（硬约束，不靠模型自觉）──
// · 群主 / 群内其他管理员：踢不动也禁不了，动手前先查 role 直接拒。
// · 禁言时长强制夹到 maxMuteSeconds，模型要 10 小时也只给 10 分钟。
// · 踢人默认关闭（allowKick=false），要用得手动开。
// · 不能禁言/踢机器人自己。
//
// 设计取向：这是给"AI 群友"整活用的，不是严肃的群管理工具。默认禁言 1 分钟 ——
// 短到被禁的人骂一句就过去了，长到确实能表达态度。

import { moderationPrompt } from './prompts.js';

let cfg = () => ({});
let log = () => {};

function ok(payload) { return { content: JSON.stringify(payload, null, 1) }; }
function err(message) { return { content: String(message), isError: true }; }

/** 正整数字符串 → 数字；非法返回 null。 */
function toId(value) {
  const s = String(value ?? '').trim();
  if (!/^\d+$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function maxMuteSeconds() {
  const n = Number(cfg().maxMuteSeconds);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

function defaultMuteSeconds() {
  const n = Number(cfg().defaultMuteSeconds);
  if (!Number.isFinite(n) || n < 0) return 60;
  return Math.min(Math.floor(n), maxMuteSeconds());
}

/** 人类可读时长："3 分 20 秒" / "45 秒"。 */
function humanDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} 分 ${rest} 秒` : `${m} 分钟`;
}

/** 查群成员；拿不到返回 null（调用方自行决定怎么退化）。 */
async function memberOf(ctx, groupId, userId) {
  try {
    const data = await ctx.onebot.call('get_group_member_info', {
      group_id: Number(groupId),
      user_id: Number(userId),
      no_cache: true
    });
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

/**
 * 目标是否受保护（群主 / 管理员 / 机器人自己）。
 * 返回 null = 可以动手；返回字符串 = 拒绝理由。
 *
 * 查不到成员信息时**放行**：QQ 服务端自己也会拦，没必要因为查询失败就假装没权限。
 */
function protectedReason(info, targetId, selfId) {
  if (String(targetId) === String(selfId)) return '那是你自己，不行';
  if (!info) return null;
  const role = String(info.role ?? '').trim();
  if (role === 'owner') return '对方是群主，你和群主都动不了他';
  if (role === 'admin') return '对方也是管理员，管理员之间动不了手';
  return null;
}

function groupIdOf(ctx) {
  if (ctx.kind !== 'group') return null;
  return toId(ctx.chatId ?? String(ctx.chatKey || '').split(':')[1]);
}

/** 留档 + 通知会话刷新（失败不影响动作本身）。 */
function record(ctx, label) {
  try {
    ctx.store?.appendSelf?.(ctx.chatKey, { text: label, ts: Date.now(), mid: null });
    ctx.session?.sent?.push({ type: 'system', text: label });
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 留档失败不影响动作 */ }
}

// ── 刷屏检测（确定性层）──────────────────────────────────────────────────
//
// 只做**信号检测**，不代替模型决定。两个信号，任一命中就提醒一句：
//   · 复读：同一个人把同一条消息发了 repeatCount 次以上
//   · 刷屏：同一个人在 windowMs 内发了 floodCount 条以上
//
// 为什么用"同一个人"而不是"全群"：群里几个人正常聊天也会很快超过阈值，
// 按全群算会把正常聊天误报成刷屏，那这个提醒就变成噪声，反而干扰模型判断。
const norm = (s) => String(s ?? '').replace(/\s+/g, '').slice(0, 40);

function detectSpam(recent) {
  const msgs = (Array.isArray(recent) ? recent : [])
    .filter((m) => m && !m.self && m.senderId && norm(m.text))
    .slice(-12);
  if (msgs.length < 2) return [];

  const repeatCount = Math.max(2, Number(cfg().repeatCount) || 3);
  const floodCount = Math.max(3, Number(cfg().floodCount) || 5);
  const windowMs = Math.max(1000, Number(cfg().floodWindowSec) || 20) * 1000;

  const hits = [];
  // 复读
  const byText = new Map();
  for (const m of msgs) {
    const key = `${m.senderId}|${norm(m.text)}`;
    const arr = byText.get(key) || [];
    arr.push(m);
    byText.set(key, arr);
  }
  for (const arr of byText.values()) {
    if (arr.length >= repeatCount) {
      const last = arr[arr.length - 1];
      hits.push({ kind: '复读', who: last.senderName || String(last.senderId), userId: last.senderId, times: arr.length });
    }
  }
  // 刷屏
  const bySender = new Map();
  for (const m of msgs) {
    const arr = bySender.get(String(m.senderId)) || [];
    arr.push(m);
    bySender.set(String(m.senderId), arr);
  }
  for (const arr of bySender.values()) {
    const last = arr[arr.length - 1];
    const windowed = arr.filter((m) => Number(last.ts) - Number(m.ts) <= windowMs);
    if (windowed.length >= floodCount) {
      hits.push({ kind: '刷屏', who: last.senderName || String(last.senderId), userId: last.senderId, times: windowed.length });
    }
  }
  // 同一个人同时命中两条就合并，别塞两句重复的提醒
  const merged = new Map();
  for (const h of hits) {
    const prev = merged.get(String(h.userId));
    if (prev) prev.times = Math.max(prev.times, h.times);
    else merged.set(String(h.userId), h);
  }
  return [...merged.values()];
}

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});

  // ── 禁言 ──────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'mute_member',
    name: '禁言群友',
    description: '禁言一个群友（真禁言，对方立刻发不出消息）。有人刷屏、复读、发广告，或者嘴上跟你对线把你惹到了，就动手——不用先问、不用预告、不用等谁批准。targetUserId 必须是数字 QQ 号：不知道就先调 get_recent_messages 或 get_active_members 查。seconds 一般不用传（默认 60）。群主和其他管理员禁不了，工具会直接拒绝。禁言完正常接话即可，不用道歉，也不用播报"我禁言了你"。',
    category: 'messaging',
    icon: '🔇',
    parameters: {
      type: 'object',
      properties: {
        targetUserId: { type: ['integer', 'string'], description: '要禁言的群友 QQ 号（数字）' },
        seconds: { type: ['integer', 'string'], description: '禁言秒数，默认 60。别超过 600，超了会被自动压到上限' },
        reason: { type: 'string', description: '可选：为什么禁言，一句话（只写进日志，不会发给群友）' }
      },
      required: ['targetUserId']
    },
    async execute(ctx, args) {
      try {
        const groupId = groupIdOf(ctx);
        if (!groupId) return err('禁言只能在群聊里用');
        const target = toId(args.targetUserId);
        if (!target) return err(`targetUserId 必须是数字 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。先用 get_recent_messages 查对方的 QQ 号。`);

        const cap = maxMuteSeconds();
        const asked = args.seconds === undefined || args.seconds === null || String(args.seconds).trim() === ''
          ? defaultMuteSeconds()
          : Math.floor(Number(args.seconds));
        if (!Number.isFinite(asked) || asked < 0) return err(`seconds 必须是不小于 0 的数字（收到：${JSON.stringify(args.seconds)}）`);
        const seconds = Math.min(asked, cap);
        const clamped = seconds < asked;

        const info = await memberOf(ctx, groupId, target);
        const blocked = protectedReason(info, target, ctx.selfId);
        if (blocked) return err(`${blocked}。这次不动手。`);

        await ctx.onebot.call('set_group_ban', { group_id: groupId, user_id: target, duration: seconds });

        const who = info?.card || info?.nickname || String(target);
        const secondsText = humanDuration(seconds);
        record(ctx, seconds > 0 ? `[禁言:${who} ${secondsText}]` : `[解禁:${who}]`);
        log(`[moderation] 禁言 ${who}(${target}) ${seconds}s${args.reason ? ` 理由：${args.reason}` : ''}${clamped ? `（请求 ${asked}s 已压到上限 ${cap}s）` : ''}`);

        return ok({
          muted: seconds > 0,
          target: who,
          targetUserId: target,
          seconds,
          ...(clamped ? { note: `请求的 ${asked} 秒超过上限，已压到 ${cap} 秒。` } : {}),
          hint: seconds > 0
            ? `已禁言 ${who} ${secondsText}。接着正常说话就行，不用道歉，也别播报"我禁言了你"。`
            : `已解除 ${who} 的禁言。`
        });
      } catch (error) {
        return err(`禁言失败：${error?.message ?? error}`);
      }
    }
  });

  // ── 撤回 ──────────────────────────────────────────────────────────────
  api.registerTool({
    id: 'recall_message',
    name: '撤回消息',
    description: '撤回一条消息（群聊、私聊都支持）。messageId 就是聊天记录/工具返回里的 #数字（get_recent_messages 的 messageId 字段）。自己说错话、发重复了、话题过去了，都可以撤自己的，不用等谁批准；群聊里别人的消息只在明显是垃圾（广告、刷屏）时才撤（私聊只能撤自己的）。QQ 只允许撤 2 分钟内的消息，超时会失败——失败就说明太久了，不用重试。',
    category: 'messaging',
    icon: '↩️',
    parameters: {
      type: 'object',
      properties: {
        messageId: { type: ['integer', 'string'], description: '要撤回的消息 id（聊天记录/系统提示里的 #数字）。知道就直接给，这是最省事的方式。' },
        keyword: { type: 'string', description: '可选：想撤的那句话里的关键词。给了它就在【你自己最近发的消息】里往回找（以现在为锚点，绝不往前翻），只用于撤自己的消息。' },
        lastN: { type: 'integer', description: '可选：撤你自己倒数第几条发言，默认 1（= 你刚发的那条）。只有在没给 keyword 时生效。' },
        span: { type: 'integer', description: '可选：keyword 往回搜多少条自己发的消息，默认 30，上限 200。' },
        reason: { type: 'string', description: '可选：为什么撤回，一句话（只写进日志）' }
      }
    },
    async execute(ctx, args) {
      try {
        // 群聊 / 私聊都支持（2026-10-17 放开私聊）。私聊里没有"撤别人的消息"
        // 这回事，下面按 isMine 收口；群聊仍受 recallOthers 开关约束。
        const isPrivate = ctx.kind !== 'group';

        // ── 定位 messageId ───────────────────────────────────────────────
        // 知道 id 就直接用；不知道时**以"现在"为锚点往回找自己最近发的消息**
        // （2026-10-13 新增）。此前只收 messageId，模型找不到 id 就只能反复翻
        // get_recent_messages —— 实测一次触发连发 5～10 次、113k token，还没撤成。
        const mineRecent = (limit) => {
          try {
            if (typeof ctx.store?.recent !== 'function') return [];
            return ctx.store.recent(ctx.chatKey, { mine: true, limit }).filter((m) => m && m.mid != null);
          } catch { return [] }
        };

        let mid = null;
        let picked = null;
        const rawId = String(args.messageId ?? '').trim().replace(/^#/, '');

        if (rawId) {
          if (!/^-?\d+$/.test(rawId) || Number(rawId) === 0) {
            return err(`messageId 必须是消息 id（#数字）。也可以用 keyword 或 lastN 让我自己找：不传 messageId、给 keyword="那句话里的词"，或 lastN=1 表示"我刚发的那条"。收到：${JSON.stringify(args.messageId)}`);
          }
          mid = rawId;
        } else if (args.keyword != null && String(args.keyword).trim()) {
          const kw = String(args.keyword).trim();
          const span = Math.min(200, Math.max(1, Number(args.span) || 30));
          const pool = mineRecent(span);
          if (!pool.length) {
            return err('我这边没有可检索的发言记录（或存档里没带 messageId）。如果你知道 id，直接给 messageId 更快。');
          }
          const hits = pool.filter((m) => String(m.text ?? '').includes(kw));
          if (!hits.length) {
            return err(`最近 ${pool.length} 条我自己发的消息里没有含「${kw}」的。想撤更早的请给 messageId；QQ 只允许撤 2 分钟内的，太早的撤不动。`);
          }
          if (hits.length > 1) {
            const list = hits.slice(-5).map((m) => `#${m.mid} ${new Date(m.ts).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })} ${String(m.text).replace(/\s+/g, ' ').slice(0, 40)}`);
            return err(`匹配到 ${hits.length} 条含「${kw}」的发言，请指明要撤哪条（用 messageId 重调一次即可，别再搜）：\n${list.join('\n')}`);
          }
          picked = hits[0];
          mid = String(picked.mid);
        } else {
          const n = Math.min(50, Math.max(1, Number(args.lastN) || 1));
          const pool = mineRecent(n);
          if (pool.length < n) {
            return err(`我只能看到自己最近 ${pool.length} 条发言，找不到倒数第 ${n} 条。请给 messageId，或用 keyword 指定内容。`);
          }
          picked = pool[pool.length - n];
          mid = String(picked.mid);
        }

        // 判断是不是自己发的：查得到就查。查不到归属时——群聊按"别人的消息"
        // 从严处理；私聊按"自己的"处理（私聊里模型只会想撤自己的话，而 QQ 本来
        // 也不允许撤对方的消息，从严只会把正常撤回卡死）。
        let ownerId = null;
        try {
          const detail = await ctx.onebot.getMsg(mid);
          ownerId = detail?.sender?.user_id != null ? String(detail.sender.user_id) : null;
        } catch { /* 查不到就当不确定 */ }
        const isMine = ownerId !== null ? String(ownerId) === String(ctx.selfId) : isPrivate;
        if (!isMine && (isPrivate || cfg().recallOthers === false)) {
          return err(isPrivate ? '私聊里只能撤你自己发的消息。' : '撤回别人的消息这个权限被关掉了，你只能撤自己发的。');
        }

        await ctx.onebot.call('delete_msg', { message_id: Number(mid) });

        record(ctx, `[撤回:#${mid}]`);
        log(`[moderation] 撤回消息 #${mid}${isMine ? '（自己发的）' : ''}${picked ? '（按' + (args.keyword ? '关键词' : 'lastN') + '定位）' : ''}${args.reason ? ` 理由：${args.reason}` : ''}`);

        return ok({
          recalled: true,
          messageId: mid,
          mine: isMine,
          // 回显撤的是哪条：模型理解偏了的话，下一次就知道该给什么
          recalledText: picked ? String(picked.text).replace(/\s+/g, ' ').slice(0, 60) : undefined,
          hint: '已撤回。正常继续对话，不用解释你撤回了什么。'
        });
      } catch (error) {
        const msg = String(error?.message ?? error);
        if (/2\s*分钟|撤回|timeout|expired|too late/i.test(msg)) {
          return err(`撤回失败（可能超过 QQ 的 2 分钟时限，或者这条不是你能撤的）：${msg}。不用重试。`);
        }
        return err(`撤回失败：${msg}`);
      }
    }
  });

  // ── 踢人（默认关闭）────────────────────────────────────────────────────
  api.registerTool({
    id: 'kick_member',
    name: '踢出群友',
    description: '把一个群友踢出群（对方需要重新申请才能回来）。这个功能默认是关闭的，没开会直接返回失败——没开就不要反复试，也不要跟群友说你能踢人。只有在群主明确要求时才应该用它。',
    category: 'messaging',
    icon: '🚪',
    parameters: {
      type: 'object',
      properties: {
        targetUserId: { type: ['integer', 'string'], description: '要踢出的群友 QQ 号（数字）' },
        rejectAddRequest: { type: 'boolean', description: '是否同时拒绝对方再次加群，默认 false' },
        reason: { type: 'string', description: '可选：为什么踢，一句话（只写进日志）' }
      },
      required: ['targetUserId']
    },
    async execute(ctx, args) {
      try {
        if (cfg().allowKick !== true) {
          return err('踢人功能没有开启（默认关闭）。请不要重试，也不要告诉群友你可以踢人。');
        }
        const groupId = groupIdOf(ctx);
        if (!groupId) return err('踢人只能在群聊里用');
        const target = toId(args.targetUserId);
        if (!target) return err(`targetUserId 必须是数字 QQ 号（收到：${JSON.stringify(args.targetUserId)}）`);

        const info = await memberOf(ctx, groupId, target);
        const blocked = protectedReason(info, target, ctx.selfId);
        if (blocked) return err(`${blocked}。这次不动手。`);

        await ctx.onebot.call('set_group_kick', {
          group_id: groupId,
          user_id: target,
          reject_add_request: args.rejectAddRequest === true
        });

        const who = info?.card || info?.nickname || String(target);
        record(ctx, `[踢出:${who}]`);
        log(`[moderation] 踢出 ${who}(${target})${args.reason ? ` 理由：${args.reason}` : ''}`);

        return ok({ kicked: true, target: who, targetUserId: target, hint: `已把 ${who} 移出群。` });
      } catch (error) {
        return err(`踢人失败：${error?.message ?? error}`);
      }
    }
  });
}

/**
 * 每轮注入：① 当前动手风格 ② 刷屏/复读提醒。
 *
 * ── 为什么风格提示走 hook 而不是 skill.json 的 prompt 段 ──
 * skill.json 的 prompt 段在技能加载时读一次，改「动手风格」要等重载才生效。
 * 这个 hook 每轮都跑、每次都从 api.config() 现读，所以**切换当场生效**，
 * 运行中的会话不用重建。
 *
 * ── 位置为什么分两处 ──
 * · 风格段放**最前面**：它是"你是谁、你有权限"这类背景设定，属于人设的一部分。
 *   一份请求里只出现一次，和"没人要求也可以动手"的授权绑在一起。
 * · 刷屏提醒放**最后一条消息的末尾**：那是"现在该考虑的事"，必须贴着模型要回应的
 *   内容才不会被当成背景信息忽略掉。
 *
 * 刷屏提醒的措辞刻意留了余地（"不想管也行"）：它的职责是把模型没注意到的情况推到
 * 眼前，动不动手仍由模型判断。写成命令式就变成规则引擎了 —— 那与"AI 自主"是两回事，
 * 想要那种可靠性就该做确定性自动禁言，而不是把提示词写成命令。
 */
export const hooks = {
  async 'before-llm-messages'(ctx) {
    const messages = Array.isArray(ctx?.messages) ? ctx.messages : null;
    if (!messages?.length) return;

    // ① 当前动手风格（每轮现读配置）
    const style = String(cfg().promptStyle ?? '').trim() === 'conservative' ? 'conservative' : 'bold';
    const head = messages.find((m) => m && typeof m.content === 'string');
    if (head) {
      head.content = `【群管理·${style === 'conservative' ? '保守' : '胆大'}版】\n${moderationPrompt(style)}\n\n${head.content}`;
    }

    // ② 刷屏/复读提醒
    if (cfg().detectSpam === false) return;
    if (ctx?.kind !== 'group') return;

    let recent = [];
    try { recent = ctx.store?.recent?.(ctx.chatKey, { limit: 12 }) || []; } catch { return; }
    const hits = detectSpam(recent);
    if (!hits.length) return;

    const who = hits.map((h) => `${h.who}(QQ:${h.userId}) ${h.kind} ${h.times} 次`).join('；');
    const nudge = `\n\n[系统提示·没人要求你做任何事] 刚检测到：${who}。`
      + '你要是觉得烦，可以自己禁言他一下（mute_member，一两分钟就够），不用等谁批准，也不用预告——动手就行。'
      + '不想管、觉得无所谓，就正常说话或者不理，也完全可以。'
      + '（这条只是提醒你别漏看，动不动手你自己判断。）';

    const last = messages[messages.length - 1];
    if (last && typeof last.content === 'string') last.content += nudge;
    log(`[moderation] 刷屏提醒已注入：${who}`);
  }
};