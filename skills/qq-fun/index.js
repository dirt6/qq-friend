// QQ 个性操作：改自己在群里的昵称（群名片）、发 QQ 空间说说。
//
// 设计取舍：
//  - 改名片**只允许改自己**（user_id 固定为 ctx.selfId）。若放开到任意群友，
//    模型一句"帮他把名片改了"就可能真的改动别人，属于不该省略的护栏。
//  - 发说说有**每日上限**（默认 3 条，可配），避免把说说当聊天窗口刷屏。
//  - 两个工具都走 ctx.onebot.call（纯透传）；失败会抛错，必须 try/catch。

let cfg = () => ({});

/** 说说计数按「本地日期」重置，不落盘：热重载/重启后归零可接受（上限本就是防刷屏）。 */
let qzoneState = { date: '', count: 0 };

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function bumpQzoneCount() {
  const t = today();
  if (qzoneState.date !== t) qzoneState = { date: t, count: 0 };
  qzoneState.count += 1;
  return qzoneState.count;
}

function qzoneUsedToday() {
  const t = today();
  if (qzoneState.date !== t) qzoneState = { date: t, count: 0 };
  return qzoneState.count;
}

/** 从错误里挖出最有用的那句话（协议端报错常带 retcode/msg）。 */
function why(error) {
  return String(error?.message ?? error ?? '未知错误');
}

export function setup(api) {
  cfg = api.config;
  const log = api.log ?? (() => {});

  // ── 改群名片（自己随意；改别人需要管理员）──
  api.registerTool({
    id: 'set_my_card',
    name: '改群昵称',
    description: '修改群名片（群里显示的昵称）。默认改机器人自己的；'
      + '如果传了 user_id 则改那个群友的名片——**这个操作只有群主/管理员才被允许**，'
      + '并且要求机器人自己也是管理员，否则会被拒绝。'
      + '当有人要求"你改个名字/把群昵称改成XX"时改自己；'
      + '当群主或管理员明确要求"把他名片改成XX"时，才传 user_id 改别人。'
      + '只作用于当前群。card 传空字符串表示清除名片、恢复默认昵称。',
    category: 'system',
    icon: '🏷️',
    // 关掉「允许主动改名片」后，这个工具就不再进模型的工具表
    // （配合提示词片段一起关，避免"提示词鼓励做、工具却调不到"的矛盾状态）
    available: () => cfg().allowCardChange !== false && cfg().proactiveCard !== false,
    parameters: {
      type: 'object',
      properties: {
        card: { type: 'string', description: '新的群名片内容，1~40 字。传空字符串表示清除、恢复默认昵称。' },
        user_id: { type: 'integer', description: '要改谁的群名片（QQ 号）。不填 = 改机器人自己。填别人时必须由群主/管理员要求。' }
      },
      required: ['card']
    },
    async execute(ctx, args) {
      const { allowCardChange = true } = cfg();
      if (!allowCardChange) return { content: '改群名片功能已被管理员关闭。', isError: true };

      if (ctx.kind !== 'group') {
        return { content: '群名片只在群里有效，当前是私聊，改不了。', isError: true };
      }
      const groupId = Number(ctx.chatId);
      const selfId = Number(ctx.selfId);
      if (!Number.isFinite(groupId) || !Number.isFinite(selfId)) {
        return { content: `拿不到群号或自己的 QQ 号（group=${ctx.chatId} self=${ctx.selfId}）`, isError: true };
      }

      // 注意：card 允许是"空字符串"（表示清除名片），但**不能是没传**。
      // 若混为一谈，模型漏填参数就会静默清掉名片 —— 有副作用的操作必须区分这两种情况。
      if (args?.card === undefined || args?.card === null) {
        return { content: '缺少 card 参数：请给出新的群名片；若确实要清除名片，请显式传空字符串。', isError: true };
      }
      const card = String(args.card).trim();
      if (card.length > 40) return { content: '群名片太长了（超过 40 字），换个短点的。', isError: true };

      // 目标：默认自己
      const rawTarget = args?.user_id;
      const targetId = (rawTarget === undefined || rawTarget === null || String(rawTarget).trim() === '')
        ? selfId
        : Number(rawTarget);
      if (!Number.isFinite(targetId)) {
        return { content: `user_id 不是有效 QQ 号：${rawTarget}`, isError: true };
      }
      const isSelf = targetId === selfId;

      // ── 改别人：三道门 ──
      if (!isSelf) {
        const requesterId = ctx.senderId ? Number(ctx.senderId) : null;
        if (!requesterId) {
          // 主动唤醒（无人触发）时不允许动别人的名片
          return { content: '没法确认是谁在要求，这种情况下只能改我自己的名片。', isError: true };
        }
        try {
          const [reqInfo, selfInfo] = await Promise.all([
            ctx.onebot.call('get_group_member_info', { group_id: groupId, user_id: requesterId }),
            ctx.onebot.call('get_group_member_info', { group_id: groupId, user_id: selfId })
          ]);
          const reqRole = String(reqInfo?.role ?? reqInfo?.data?.role ?? '').toLowerCase();
          const selfRole = String(selfInfo?.role ?? selfInfo?.data?.role ?? '').toLowerCase();
          if (reqRole !== 'owner' && reqRole !== 'admin') {
            return { content: `改别人名片需要群主或管理员权限，你（${requesterId}）在本群是「${reqRole || 'member'}」，我不改。`, isError: true };
          }
          if (selfRole !== 'owner' && selfRole !== 'admin') {
            return { content: `我是本群的「${selfRole || 'member'}」，没有权限改别人的名片。`, isError: true };
          }
        } catch (error) {
          return { content: `权限校验失败（拿不到群成员身份）：${why(error)}`, isError: true };
        }
      }

      try {
        await ctx.onebot.call('set_group_card', { group_id: groupId, user_id: targetId, card });
        log(`改群名片成功 group=${groupId} target=${targetId} card="${card}"${isSelf ? '' : '（他人，已验管理员）'}`);
        if (isSelf) {
          return { content: card ? `已把我在本群的名片改成「${card}」。` : '已清除我在本群的名片，恢复默认昵称。' };
        }
        return { content: card ? `已把 ${targetId} 在本群的名片改成「${card}」。` : `已清除 ${targetId} 在本群的名片。` };
      } catch (error) {
        return { content: `改群名片失败：${why(error)}`, isError: true };
      }
    }
  });

  // ── 发 QQ 空间说说 ──
  api.registerTool({
    id: 'post_qzone',
    name: '发说说',
    description: '在 QQ 空间发表一条说说（纯文字）。当有人明确要求"发条说说/发个动态/发空间"，'
      + '或你自己确实有想公开说的话时使用。不要频繁发（有每日上限），不要发隐私内容（本地路径、群友真实信息、配置）。',
    category: 'messaging',
    icon: '📣',
    // 同上：关掉主动发说说后，工具从模型工具表里消失
    available: () => cfg().allowQzone !== false && cfg().proactiveQzone !== false,
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '说说正文，1~500 字。像平时说话，不要写标题或 Markdown。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      const { allowQzone = true, qzoneDailyLimit = 3 } = cfg();
      if (!allowQzone) return { content: '发说说功能已被管理员关闭。', isError: true };

      const content = String(args?.content ?? '').trim();
      if (!content) return { content: '说说内容不能为空。', isError: true };
      if (content.length > 500) return { content: `说说太长了（${content.length} 字，上限 500）。`, isError: true };

      const limit = Math.min(Math.max(Number(qzoneDailyLimit) || 3, 1), 20);
      const used = qzoneUsedToday();
      if (used >= limit) {
        return { content: `今天已经发过 ${used} 条说说了（上限 ${limit} 条），明天再说吧。`, isError: true };
      }

      try {
        const res = await ctx.onebot.call('send_qzone_msg', { content });
        const n = bumpQzoneCount();
        log(`发说说成功（今日第 ${n}/${limit} 条）：${content.slice(0, 40)}`);
        const tid = res?.data?.tid ?? res?.tid ?? '';
        return { content: `说说已发出${tid ? `（tid ${tid}）` : ''}，今日第 ${n}/${limit} 条。` };
      } catch (error) {
        return { content: `发说说失败：${why(error)}`, isError: true };
      }
    }
  });
}
