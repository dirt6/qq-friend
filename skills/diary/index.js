// 记忆库（diary）：约定 / 愿望 / 日记 / 核心档案，全部是 E:\dsh 下的 markdown。
//
// ── 为什么要"人类把关" ────────────────────────────────────────────────────
// 模型会幻觉，直接把"它以为发生过的事"写进长期记忆，记忆就被污染了 ——
// 而且污染是持久的，之后每一次回忆都在放大它。所以写入分两步：
//   propose  →  生成一条待确认请求（不落盘）
//   老大回话  →  commit  才真正写文件
//
// 「同一轮里自己提议自己确认」用**用户消息时间戳**判定：propose 时记下
// "最后一条用户消息的时间"，commit 时如果这个时间没前进，说明老大还没回话，
// 直接拒绝。比 session id 可靠（session 可能被复用，ts 不会）。
//
// ── 文件结构 ──────────────────────────────────────────────────────────────
//   <root>/core_profile.md     核心档案（很少改）
//   <root>/promises.md         约定清单（- [ ] / - [x]）
//   <root>/wishlist.md         愿望清单（- [ ]）
//   <root>/YYYY-MM-DD.md       当天的高光时刻 + 小情绪
//
// ── 只记正向 ──────────────────────────────────────────────────────────────
// 痛苦/负能量只安慰、不落盘。这条靠提示词约束（工具无法判断情绪），
// 所以 prompt.sections 里把它写成了硬规则。

import fs from 'node:fs';
// 4.0 / 1.5.2：日记写入统一走 Writer（src/diary/writer.js）。
// 保留 addDiary 的签名与返回值形状，调用方一个字都不用改。
import { write as writeDiaryEntry } from '../../src/diary/index.js';
import path from 'node:path';

const DEFAULT_ROOT = 'E:\\dsh\\本子\\日记';
const PENDING_TTL_MS = 30 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const KINDS = { promise: '约定', wish: '愿望', diary: '日记', core: '核心档案' };
/** 按日期的日记单独放一层：<root>/每日/YYYY-MM-DD.md，promises 等仍在 <root>/ 同级。 */
const DIARY_SUBDIR = '每日';
const DEFAULT_MOOD = '平静';
/** 日记条目的重要程度：只有后两级在正文里加 [标记]，"一般"是默认、不加标记。 */
const IMPORTANCE = ['一般', '重要', '非常重要'];
const DEFAULT_IMPORTANCE = '一般';

let cfg = () => ({});

// 待确认队列：id -> { kind, content, day, part, done, anchorTs, createdAt, chatKey }
const pending = new Map();

const pad = (n) => String(n).padStart(2, '0');
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));

function conf() {
  const c = cfg() || {};
  return {
    root: String(c.root || DEFAULT_ROOT),
    requireConfirm: c.requireConfirm !== false,
    autoRecall: c.autoRecall !== false,
    maxInjectItems: clamp(c.maxInjectItems || 5, 1, 20),
    maxRecallChars: clamp(c.maxRecallChars || 1500, 200, 8000)
  };
}

function paths() {
  const { root } = conf();
  return {
    root,
    core: path.join(root, 'core_profile.md'),
    promises: path.join(root, 'promises.md'),
    wishlist: path.join(root, 'wishlist.md'),
    // 按日期的日记单独放一层：<root>/每日/2026-10-17.md；
    // promises/wishlist/core 仍在 <root>/ 这一层（同级）。
    diaryDir: path.join(root, DIARY_SUBDIR)
  };
}

function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** '2026-10-17' -> '周五'（解析不到就空串）。 */
function weekdayOf(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  if (!y || !m || !d) return '';
  return WEEK[new Date(y, m - 1, d).getDay()] || '';
}

function ensureFile(file, header) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, header, 'utf8');
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

function clip(text, max) {
  const t = String(text ?? '');
  if (t.length <= max) return t;
  return `${t.slice(0, max)}\n…（后面还有 ${t.length - max} 字；需要更细的内容就按日期或关键词再查）`;
}

function listDayFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => DATE_RE.test(n)).sort().reverse();
  } catch { return []; }
}

/* ── 解析 ────────────────────────────────────────────────────────────── */

/** 承诺清单：只取 `- [ ]` / `- [x]` 行。 */
function parseChecklist(text) {
  return String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^- \[[ xX]\]/.test(l))
    .map((l) => ({ done: /^- \[[xX]\]/.test(l), text: l.replace(/^- \[[ xX]\]\s*/, '').trim() }));
}

/** 日记条目：`## 记录` 下的 `- 心情：xx｜正文` 行。 */
function diaryLines(text) {
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((l) => l.trim() === '## 记录');
  if (at < 0) return [];
  const out = [];
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    const t = lines[i].trim();
    if (t.startsWith('- ')) out.push(t);
  }
  return out;
}

/* ── 写入 ────────────────────────────────────────────────────────────── */

function addChecklistItem(file, header, content, day, done = false) {
  ensureFile(file, header);
  const line = `- [${done ? 'x' : ' '}] ${day}: ${String(content).replace(/\s+/g, ' ').trim()}\n`;
  fs.appendFileSync(file, line, 'utf8');
}

/**
 * 找今天已经写过的、和这条重复的条目。
 * 判据故意保守：前 14 个字完全相同才算重复（"老大今天带我去……"这种模板化开头不算）。
 * 命中时由调用方决定「替换成更完整的」还是「跳过」。
 */
function findSimilarDiaryLine(lines, content) {
  // 比较时去掉「约定：」「愿望：」前缀：同一件事在旧日记里往往不带前缀，
  // 带前缀只是迁移/写入时的标记，不该让它躲过去重。
  const strip = (s) => String(s ?? '').replace(/^(约定：|愿望：)/, '');
  const norm = (s) => strip(s).replace(/[\s，。！？、,.!?]/g, '');
  const t = norm(content);
  if (t.length < 8) return null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^- 心情：[^｜]*｜(?:\[[^\]]+\]\s*)?(.+)$/);
    if (!m) continue;
    const prev = norm(m[1]);
    if (prev.length < 8) continue;
    if (prev.slice(0, 14) === t.slice(0, 14)) return { index: i, prev, text: m[1] };
  }
  return null;
}

const MOOD_PREFIX_RE = /^\s*心情\s*[：:]\s*[^｜|]{0,20}[｜|]\s*/;

/** 剥掉正文里自带的「心情：xx｜」前缀（最多 3 层），避免行首叠两层。 */
function stripMoodPrefix(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 3 && MOOD_PREFIX_RE.test(t); i += 1) {
    t = t.replace(MOOD_PREFIX_RE, '').trim();
  }
  return t;
}

/**
 * 写一条日记（4.0 / 1.5.2 起转发给统一 Writer）。
 *
 * 为什么改成转发：以前这里自己拼行、自己写盘，另外两处（autonomous、
 * qq-tools → orchestrator）也各写各的，谁都没有幂等，同一件事可能落两行。
 * 现在只有一个写入口，这里只负责把参数翻译过去、把返回值翻译回来。
 *
 * 行为保持不变（Writer 的格式/分级/心情/去重与原来的实现逐字同构）：
 *   · 同一天同一件事再写一次 → 命中去重，不新增行；
 *   · mood 里误填成等级词的 → Writer 内部纠正回 importance；
 *   · 失败不再静默：Writer 返回 ok:false 时这里抛错，让工具层如实报告。
 */
function addDiary(content, day, mood, importance) {
  const key = day || dateKey();
  const r = writeDiaryEntry({
    source: 'skills/diary',
    content,
    day: key,
    mood,
    importance,
    // 用技能自己的 conf() 目录（测试会 mock 它）；不传就回落到全局配置
    root: paths().diaryDir
  });
  if (!r?.ok) throw new Error(r?.error || '日记写入失败');
  return { file: r.file || `${key}.md`, merged: Boolean(r.merged), skipped: Boolean(r.skipped) };
}

function addCore(content, day) {
  const { core } = paths();
  ensureFile(core, '# 核心档案\n\n');
  fs.appendFileSync(core, `\n## ${day}\n${String(content).trim()}\n`, 'utf8');
}

/**
 * 写一条记忆。
 *
 * 2026-10-21 起：约定和愿望**不再单独写 promises.md / wishlist.md**，
 * 统一并进当天日记，等级固定「非常重要」，正文前缀「约定：」「愿望：」。
 * 旧的两个文件只读不写（历史条目还在里面，会一起展示）。
 */
/**
 * 删/改「约定」「愿望」——它们现在散在最近 30 天的日记里（正文带「约定：」「愿望：」前缀）。
 * 旧的两个清单文件还在时也一并兜底搜，但新数据不会写进去。
 */
function forgetInDiary({ kind, match, replace, p }) {
  const prefix = kind === 'promise' ? '约定：' : '愿望：';
  const hits = [];
  const scan = (file, isLegacy) => {
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { return; }
    lines.forEach((l, i) => {
      const hit = isLegacy
        ? /^- \[[ xX]\]/.test(l.trim()) && l.includes(match)
        : l.includes(prefix) && l.includes(match);
      if (hit) hits.push({ file, index: i, text: l, lines });
    });
  };
  for (const name of listDayFiles(p.diaryDir).slice(0, 30)) scan(path.join(p.diaryDir, name), false);
  const legacy = kind === 'promise' ? p.promises : p.wishlist;
  if (fs.existsSync(legacy)) scan(legacy, true);
  if (!hits.length) return { content: `没找到含「${match}」的${KINDS[kind]}。`, isError: true };
  if (hits.length > 1) {
    const list = hits.slice(0, 5).map((h) => `· ${h.text.trim().slice(0, 60)}`).join('\n');
    return { content: `有 ${hits.length} 条都含「${match}」，先确认要改哪条（把 match 写得更具体）：\n${list}`, isError: true };
  }
  const h = hits[0];
  try {
    const trash = path.join(p.root, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    fs.copyFileSync(h.file, path.join(trash, `${path.basename(h.file)}.${Date.now()}.bak`));
  } catch { /* 备份失败不阻塞 */ }
  const deleting = replace === null || replace === '';
  if (deleting) h.lines.splice(h.index, 1);
  else h.lines[h.index] = h.text.replace(match, () => replace);
  const out = `${h.lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
  fs.writeFileSync(h.file, out, 'utf8');
  return {
    content: deleting
      ? `删掉了：${h.text.trim()}\n（不用跟老大汇报文件路径，说一句"删了"就行。）`
      : `改成：${h.lines[h.index].trim()}\n（原来：${h.text.trim()}）`
  };
}

function writeEntry(entry) {
  const day = entry.day || dateKey();
  switch (entry.kind) {
    case 'promise':
    case 'wish': {
      const prefix = entry.kind === 'promise' ? '约定：' : '愿望：';
      const done = entry.done ? '（已经做到了）' : '';
      const r = addDiary(`${prefix}${entry.content}${done}`, day, entry.mood, '非常重要');
      return { file: path.join(DIARY_SUBDIR, r.file), merged: r.merged };
    }
    case 'diary': {
      const r = addDiary(entry.content, day, entry.mood, entry.importance);
      return { file: path.join(DIARY_SUBDIR, r.file), merged: r.merged };
    }
    case 'core':
      addCore(entry.content, day);
      return { file: 'core_profile.md', merged: false };
    default:
      throw new Error(`未知的记忆类型：${entry.kind}`);
  }
}

/* ── 工具 ctx 辅助 ───────────────────────────────────────────────────── */

/** 这个会话里最后一条"别人发的"消息的时间（用来判断老大有没有回话）。 */
function lastUserTs(ctx) {
  try {
    const msgs = ctx?.store?.recent?.(ctx.chatKey, { limit: 12, includeSelf: false }) || [];
    let ts = 0;
    for (const m of msgs) if (!m?.self) ts = Math.max(ts, Number(m.ts) || 0);
    return ts;
  } catch { return 0; }
}

/* ── 入口 ────────────────────────────────────────────────────────────── */

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'propose',
    name: '提议记住',
    description: '想把一件事写进你们的长期记忆（约定/愿望/日记/核心档案）时，先用这个提出请求，**不要直接写盘**。它只生成一条待确认的提议，不会改任何文件。接下来在聊天里跟老大说一句（例如"这个我想记下来，可以吗"）；他点头（"好""可以""记吧"）之后，你下一次才能用「确认记下」真正写进去。只记正向、有趣、重要的事——他倾诉痛苦或负能量时安慰就好，不要提议记录。',
    category: 'memory',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: Object.keys(KINDS),
          description: '写到哪里：promise=约定（谁答应了谁）；wish=她想要的；diary=今天的一件小事（带心情）；core=核心档案（相处模式变了才用，很少）。'
        },
        content: { type: 'string', description: '要记的内容，一两句话。用你自己的语气，不要写成公文体。' },
        mood: { type: 'string', description: 'kind=diary 时：这条当时的心情，一两个词（开心/平静/委屈/想他……），默认「平静」。' },
        importance: { type: 'string', enum: IMPORTANCE, description: 'kind=diary 时必填。先看有没有后续：答应了要做、约好了、要买/要去 → 重要；影响长期目标、关键决定或你们相处方式 → 非常重要；纯粹当天的情绪和见闻 → 一般。别为显得认真乱升级，也别把有后续的事压成一般。' },
        done: { type: 'boolean', description: 'kind=promise 时：这件事是否已经做到（默认 false，写成待办）' },
        day: { type: 'string', description: '可选：日期 YYYY-MM-DD，默认今天（补记昨天的事时才用）' }
      },
      required: ['kind', 'content']
    },
    async execute(ctx, args) {
      const kind = KINDS[String(args?.kind ?? '')] ? String(args.kind) : '';
      if (!kind) return { content: `kind 必须是：${Object.keys(KINDS).join(' / ')}。`, isError: true };
      const content = String(args?.content ?? '').trim();
      if (!content) return { content: '要记的内容是空的。', isError: true };
      // 不再限制字数（机主要求取消）：模型写多长就记多长，只在明显失控时兜一下
      if (content.length > 8000) return { content: `这段异常长（${content.length} 字），先确认是不是粘错了。`, isError: true };
      const day = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.day ?? '')) ? String(args.day) : dateKey();
      const importance = IMPORTANCE.includes(String(args?.importance)) ? String(args.importance) : DEFAULT_IMPORTANCE;
      // 约定/愿望一律按「非常重要」：它们本来就该长期记住
      const finalImportance = (kind === 'promise' || kind === 'wish') ? '非常重要' : importance;
      const entry = {
        kind,
        content,
        day,
        importance: finalImportance,
        done: args?.done === true,
        mood: String(args?.mood ?? '').trim().slice(0, 12) || DEFAULT_MOOD,
        anchorTs: lastUserTs(ctx),
        chatKey: String(ctx?.chatKey ?? ''),
        createdAt: Date.now()
      };

      const c = conf();
      if (!c.requireConfirm) {
        try {
          const r = writeEntry(entry);
          return {
            content: r.merged
              ? `这条今天已经记过类似的，合并更新了一下（${r.file}）。正常聊天，不用汇报。`
              : `已写进 ${r.file}${importance === DEFAULT_IMPORTANCE ? '' : `（标记为「${importance}」）`}。（没开"写入前确认"，所以直接记了。正常聊天，不用汇报。）`
          };
        } catch (error) {
          return { content: `写入失败：${error?.message ?? error}`, isError: true };
        }
      }

      const id = `m_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      pending.set(id, { ...entry, id });
      const label = KINDS[kind];
      return {
        content: `已提议（还没写盘）：[${id}] ${label} · ${content}\n`
          + '现在跟老大说一句，问他要不要记下来。他同意之后，你下一次再调「确认记下」才真正写入。'
      };
    }
  });

  api.registerTool({
    id: 'commit',
    name: '确认记下',
    description: '把之前「提议记住」的条目真正写进记忆文件。只在老大明确同意后调用（他说"好""可以""记吧""记下来"之类）。同一轮里刚提议就自己确认会被拒绝——必须等他回话。',
    category: 'memory',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '可选：提议时返回的 [m_xxxx]。不传就取最近一条待确认的。' }
      }
    },
    async execute(ctx, args) {
      const wanted = String(args?.id ?? '').trim();
      const now = Date.now();
      for (const [key, v] of pending) if (now - v.createdAt > PENDING_TTL_MS) pending.delete(key);
      const entry = wanted
        ? pending.get(wanted)
        : [...pending.values()].sort((a, b) => b.createdAt - a.createdAt)[0];
      if (!entry) {
        return { content: '没有待确认的记忆请求（可能已经写过，或者早就过期了）。要记的话先重新「提议记住」。', isError: true };
      }
      if (entry.chatKey && String(ctx?.chatKey ?? '') !== entry.chatKey) {
        return { content: '这条提议是别的会话里提的，别在这里确认。', isError: true };
      }
      // 关键：老大必须在这条提议之后说过话，否则就是"自己提议自己确认"
      if (lastUserTs(ctx) <= entry.anchorTs) {
        return { content: '这条是你这一轮刚提的，老大还没回话。先问他一句，等他同意了你下次再确认。', isError: true };
      }
      try {
        const r = writeEntry(entry);
        pending.delete(entry.id);
        return {
          content: r.merged
            ? `记下了，不过今天已经有类似的，合并更新了（${r.file}）。（不用向老大汇报写入动作，正常聊你的。）`
            : `记下了：${KINDS[entry.kind]} → ${r.file}。（不用向老大汇报写入动作，正常聊你的。）`
        };
      } catch (error) {
        return { content: `写入失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'forget',
    name: '忘掉/改掉',
    description: '删掉或修改记忆里的一条。老大明确让你删（「把那条删了」「别记这个」「你忘了这件事」）或改的时候用。kind 选哪一类，match 填能定位那条的一段原文（至少两个字），replace 给了就改成它、不给就删掉；日记要带 date。匹配到多条会拒绝并列出候选，别硬删。删之前会自动备份到 <root>/.trash\\，删错了还能捞回来。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: Object.keys(KINDS), description: '从哪删：promise=约定；wish=愿望；diary=日记；core=核心档案' },
        match: { type: 'string', description: '要删/改的那条里的一段原文（至少 2 个字，能唯一定位）' },
        replace: { type: 'string', description: '可选：改成什么。不给就是删掉。' },
        date: { type: 'string', description: 'kind=diary 时：哪一天的日记，YYYY-MM-DD' }
      },
      required: ['kind', 'match']
    },
    async execute(_ctx, args) {
      const kind = KINDS[String(args?.kind ?? '')] ? String(args.kind) : '';
      if (!kind) return { content: `kind 必须是：${Object.keys(KINDS).join(' / ')}。`, isError: true };
      const match = String(args?.match ?? '').trim();
      if (match.length < 2) return { content: 'match 太短了，至少给两个字，不然容易删错。', isError: true };
      const replace = args?.replace === undefined || args?.replace === null ? null : String(args.replace).trim();
      const p = paths();

      let file = '';
      // 约定/愿望已并入日记：去最近的日记里找（旧的清单文件只作兜底）
      if (kind === 'promise' || kind === 'wish') {
        return forgetInDiary({ kind, match, replace, p });
      }
      if (kind === 'core') file = p.core;
      else {
        const date = String(args?.date ?? '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { content: '删日记要给 date（YYYY-MM-DD），不然不知道删哪天的。', isError: true };
        file = path.join(p.diaryDir, `${date}.md`);
      }
      if (!fs.existsSync(file)) return { content: '这个文件还不存在，没什么可删的。', isError: true };

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const isTarget = (l) => {
        if (kind === 'promise' || kind === 'wish') return /^- \[[ xX]\]/.test(l.trim()) && l.includes(match);
        if (kind === 'diary') return l.trim().startsWith('- 心情：') && l.includes(match);
        return Boolean(l.trim()) && !l.startsWith('#') && l.includes(match);
      };
      const hits = [];
      lines.forEach((l, i) => { if (isTarget(l)) hits.push(i); });
      if (!hits.length) return { content: `没找到含「${match}」的${KINDS[kind]}。`, isError: true };
      if (hits.length > 1) {
        const list = hits.slice(0, 5).map((i) => `· ${lines[i].trim().slice(0, 60)}`).join('\n');
        return { content: `有 ${hits.length} 条都含「${match}」，先确认要改哪条（把 match 写得更具体）：\n${list}`, isError: true };
      }

      const i = hits[0];
      const before = lines[i];
      // 删之前留一份备份：老大让你忘，但"想反悔"也得有路可走
      try {
        const trash = path.join(p.root, '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.copyFileSync(file, path.join(trash, `${path.basename(file)}.${Date.now()}.bak`));
      } catch { /* 备份失败不阻塞删除 */ }

      const deleting = replace === null || replace === '';
      if (deleting) lines.splice(i, 1);
      // 用函数形式替换：replace 里出现 $& / $1 这类字符时不会被当成替换模式
      else lines[i] = before.replace(match, () => replace);

      const out = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
      fs.writeFileSync(file, out, 'utf8');
      return {
        content: deleting
          ? `删掉了：${before.trim()}\n（不用跟老大汇报文件路径，说一句"删了"就行。）`
          : `改成：${lines[i].trim()}\n（原来：${before.trim()}）`
      };
    }
  });

  api.registerTool({
    id: 'level',
    name: '改等级',
    description: '改某条日记的重要性等级（一般 / 重要 / 非常重要），正文和心情都不动。老大说「这条该算重要」「把那条改成非常重要」「这个其实没那么重要」时用。要带 date（YYYY-MM-DD），match 填那段原文里至少两个字，能唯一定位。',
    category: 'memory',
    icon: '⭐',
    parameters: {
      type: 'object',
      properties: {
        match: { type: 'string', description: '那条日记里的一段原文（至少 2 个字，能唯一定位）' },
        importance: { type: 'string', enum: IMPORTANCE, description: '改成哪一级' },
        date: { type: 'string', description: '哪一天的日记，YYYY-MM-DD' }
      },
      required: ['match', 'importance', 'date']
    },
    async execute(_ctx, args) {
      const match = String(args?.match ?? '').trim();
      if (match.length < 2) return { content: 'match 太短了，至少给两个字，不然容易改错。', isError: true };
      const imp = String(args?.importance ?? '').trim();
      if (!IMPORTANCE.includes(imp)) return { content: `importance 必须是：${IMPORTANCE.join(' / ')}。`, isError: true };
      const date = String(args?.date ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { content: '要给 date（YYYY-MM-DD），不然不知道改哪天的日记。', isError: true };
      const p = paths();
      const file = path.join(p.diaryDir, `${date}.md`);
      if (!fs.existsSync(file)) return { content: '这一天还没有日记。', isError: true };

      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const hits = [];
      lines.forEach((l, i) => { if (l.trim().startsWith('- 心情：') && l.includes(match)) hits.push(i); });
      if (!hits.length) return { content: `没找到含「${match}」的日记条目。`, isError: true };
      if (hits.length > 1) {
        const list = hits.slice(0, 5).map((i) => `· ${lines[i].trim().slice(0, 60)}`).join('\n');
        return { content: `有 ${hits.length} 条都含「${match}」，把 match 写得更具体一点：\n${list}`, isError: true };
      }

      const i = hits[0];
      const before = lines[i];
      const m = /^(\s*-\s*心情：)([^｜|]*)([｜|])([\s\S]*)$/.exec(before);
      if (!m) return { content: `这条格式不对，读不出来：${before.trim().slice(0, 60)}`, isError: true };
      // 正文前面可能已经挂着 [重要] / [非常重要]，先剥掉再按新等级加
      const body = m[4].replace(/^\s*\[(一般|重要|非常重要)\]\s*/, '');
      const after = `${m[1]}${m[2]}${m[3]}${imp === DEFAULT_IMPORTANCE ? body : `[${imp}] ${body}`}`;
      if (after === before) return { content: '这条本来就是这个等级，没动。' };

      lines[i] = after;
      const out = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
      fs.writeFileSync(file, out, 'utf8');
      return { content: `改好了：${after.trim()}\n（原来：${before.trim()}）` };
    }
  });

  api.registerTool({
    id: 'read',
    name: '翻记忆',
    description: '翻你们的长期记忆。聊到以前的事、答应过的事、她想要的东西时，先翻再回答，别凭印象编。可以看约定、愿望、某天的日记、最近几天、按关键词搜，或看核心档案。翻不到就直说不记得，不要补细节。',
    category: 'memory',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['promise', 'wish', 'diary', 'core'], description: '看哪一类：promise=约定；wish=愿望；diary=日记；core=核心档案' },
        date: { type: 'string', description: 'target=diary 时看某一天，YYYY-MM-DD' },
        days: { type: 'number', description: 'target=diary 时看最近几天（1~14，默认 1）' },
        keyword: { type: 'string', description: '在所有记忆里搜这个词（约定/愿望/日记都会搜）' }
      }
    },
    async execute(_ctx, args) {
      const { maxRecallChars } = conf();
      const p = paths();
      const target = String(args?.target ?? 'diary').trim();
      const keyword = String(args?.keyword ?? '').trim();

      if (keyword) {
        const hits = [];
        const scan = (file, label) => {
          const t = readText(file);
          if (t.includes(keyword)) hits.push({ label, text: t });
        };
        scan(p.promises, 'promises.md');
        scan(p.wishlist, 'wishlist.md');
        scan(p.core, 'core_profile.md');
        for (const name of listDayFiles(p.diaryDir)) scan(path.join(p.diaryDir, name), name);
        if (!hits.length) return { content: `记忆里没有提到「${keyword}」的。` };
        const per = Math.max(150, Math.floor(maxRecallChars / Math.min(5, hits.length)));
        const body = hits.slice(0, 5).map((h) => `### ${h.label}\n${clip(h.text, per)}`).join('\n\n');
        return { content: `在 ${hits.length} 处记忆里找到了「${keyword}」：\n\n${body}` };
      }

      if (target === 'promise') {
        const mined = mineImportantFromDiary(14);
        const legacy = parseChecklist(readText(p.promises)).filter((x) => !x.done).map((x) => ({ text: x.text, day: '' }));
        const items = [...legacy, ...mined.promises];
        if (!items.length) return { content: '约定清单还是空的。' };
        const body = items.map((x) => `- ${x.text}${x.day ? `（${x.day}）` : ''}`).join('\n');
        return { content: clip(`${body}\n（共 ${items.length} 条，都还没做到）`, maxRecallChars) };
      }
      if (target === 'wish') {
        const mined = mineImportantFromDiary(14);
        const legacy = parseChecklist(readText(p.wishlist)).filter((x) => !x.done).map((x) => ({ text: x.text, day: '' }));
        const items = [...legacy, ...mined.wishes];
        if (!items.length) return { content: '愿望清单还是空的。' };
        const body = items.map((x) => `- ${x.text}${x.day ? `（${x.day}）` : ''}`).join('\n');
        return { content: clip(`${body}\n（共 ${items.length} 条）`, maxRecallChars) };
      }
      if (target === 'core') {
        const t = readText(p.core);
        return { content: t.trim() ? clip(t, maxRecallChars) : '核心档案还是空的（还没写过相处模式和自己的设定）。' };
      }

      const date = String(args?.date ?? '').trim();
      if (date) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { content: '日期格式不对，用 YYYY-MM-DD（如 2026-10-17）。', isError: true };
        const t = readText(path.join(p.diaryDir, `${date}.md`));
        return { content: t.trim() ? clip(t, maxRecallChars) : `${date} 没写过日记。` };
      }
      const days = clamp(args?.days || 1, 1, 14);
      const parts = [];
      for (let i = 0; i < days; i += 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const t = readText(path.join(p.diaryDir, `${dateKey(d)}.md`));
        if (t.trim()) parts.push(t.trim());
      }
      if (!parts.length) return { content: `最近 ${days} 天没写过日记。` };
      return { content: clip(parts.join('\n\n---\n\n'), maxRecallChars) };
    }
  });

  api.registerTool({
    id: 'list',
    name: '记忆目录',
    description: '看一眼记忆库里都有什么：没完成的约定、愿望、写过哪些天的日记（日期 + 当天的小节）。想快速知道"我们还剩什么没做"时用它。',
    category: 'memory',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多列几天日记，默认 10' }
      }
    },
    async execute(_ctx, args) {
      const p = paths();
      const fromDiary = mineImportantFromDiary(14);
      const promises = [...parseChecklist(readText(p.promises)), ...fromDiary.promises.map((x) => ({ text: x.text, done: false }))];
      const wishes = [...parseChecklist(readText(p.wishlist)), ...fromDiary.wishes.map((x) => ({ text: x.text, done: false }))];
      const days = listDayFiles(p.diaryDir);
      const limit = clamp(args?.limit || 10, 1, 60);
      const lines = [];
      lines.push(`约定：${promises.length} 条（未完成 ${promises.filter((x) => !x.done).length} 条）`);
      for (const x of promises.filter((i) => !i.done).slice(0, 5)) lines.push(`  · [ ] ${x.text}`);
      lines.push(`愿望：${wishes.length} 条（未实现 ${wishes.filter((x) => !x.done).length} 条）`);
      for (const x of wishes.slice(0, 5)) lines.push(`  · [ ] ${x.text}`);
      if (!days.length) {
        lines.push('日记：还没写过');
      } else {
        lines.push(`日记：${days.length} 天`);
        for (const name of days.slice(0, limit)) {
          const t = readText(path.join(p.diaryDir, name));
          const items = diaryLines(t);
          lines.push(`  · ${name.replace('.md', '')}：${items.length ? `${items.length} 条记录` : '（空）'}`);
        }
      }
      return { content: lines.join('\n') };
    }
  });
}

export function available() { return { ok: true }; }

/**
 * 动态片段：把"还没完成的约定 / 愿望 / 最近日记"带进上下文。
 * 只带条目本身（每条截短），不带全文——记忆要能想起来，但不能挤爆窗口。
 */
/**
 * 从最近的日记里捞「约定：」「愿望：」条目。
 * 2026-10-21 起它们并进了每日日记（不再单独成文件），这里负责把它们重新聚合出来。
 */
function mineImportantFromDiary(days = 14) {
  const dir = paths().diaryDir;
  const promises = [];
  const wishes = [];
  for (const name of listDayFiles(dir).slice(0, days)) {
    const text = readText(path.join(dir, name));
    for (const line of text.split('\n')) {
      const m = line.match(/^- 心情：[^｜]*｜(?:\[([^\]]+)\]\s*)?(.+)$/);
      if (!m) continue;
      const body = String(m[2] ?? '').trim();
      if (!body || /（已经做到了）$/.test(body)) continue;
      if (body.startsWith('约定：')) promises.push({ text: body.slice(3).trim(), day: name.replace('.md', '') });
      else if (body.startsWith('愿望：')) wishes.push({ text: body.slice(3).trim(), day: name.replace('.md', '') });
    }
  }
  return { promises, wishes };
}

export function promptSections() {
  const c = conf();
  if (!c.autoRecall) return [];
  const p = paths();
  const n = c.maxInjectItems;
  const short = (s) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > 40 ? `${t.slice(0, 40)}…` : t;
  };
  // 新的约定/愿望都在日记里；旧的两个文件还留着历史，一起读
  const legacyPromises = parseChecklist(readText(p.promises)).filter((x) => !x.done);
  const legacyWishes = parseChecklist(readText(p.wishlist)).filter((x) => !x.done);
  const fromDiary = mineImportantFromDiary(14);
  const promises = [...legacyPromises.map((x) => ({ text: x.text })), ...fromDiary.promises];
  const wishes = [...legacyWishes.map((x) => ({ text: x.text })), ...fromDiary.wishes];
  const days = listDayFiles(p.diaryDir);
  if (!promises.length && !wishes.length && !days.length) {
    return [{ id: 'mem-empty', title: '', priority: 40, content: '【你的记忆库】还空着（E:\\dsh\\本子\\日记\\ 下的承诺/愿望/核心档案，以及 每日\\ 下的日记都还没有内容）。想记什么就说一声、再记，不用硬写。' }];
  }
  const bits = [];
  if (promises.length) bits.push(`未完成的约定：${promises.slice(0, n).map((x) => short(x.text)).join('；')}`);
  if (wishes.length) bits.push(`愿望：${wishes.slice(0, n).map((x) => short(x.text)).join('；')}`);
  if (days.length) bits.push(`最近日记：${days.slice(0, 3).map((x) => x.replace('.md', '')).join('、')}`);
  return [{
    id: 'mem-recent',
    title: '',
    priority: 40,
    content: `【你的记忆库】${bits.join('；')}。聊到相关的事先翻记忆（qq_diary_read）再回答，别凭印象编；也别把文件原文念出来，像人自然想起那样说。`
  }];
}

/** 自测用。 */
export const internals = {
  conf,
  paths,
  dateKey,
  weekdayOf,
  parseChecklist,
  diaryLines,
  addDiary,
  writeEntry,
  listDayFiles,
  KINDS,
  DIARY_SUBDIR,
  DEFAULT_MOOD,
  pending,
  setConfig: (fn) => { cfg = fn; },
  clearPending: () => pending.clear(),
  DEFAULT_ROOT
};
