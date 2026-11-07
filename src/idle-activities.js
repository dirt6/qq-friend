// 5.0 空闲活动：只读浏览、日记整理、分享、主动聊天、B站评论/回复。
// think 先经 autonomous/idle-plan 的 Goal/Purpose 规划：醒来先看长期方向/未完成事项/她自己的兴趣，
// 没有明确方向时才回到自由思考（保留旧能力）。公开动作仍由 idle-actions 的静默/去重保护；
// 小黑盒自动评论不走浏览器。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { createXhhReader } from './xhh-heybox.js';
import { createReadonlyAdapter } from './autonomous/readonly-adapter.js';
import { planIdleCycle, describePlanForPrompt, ACTIONS_BY_TYPE } from './autonomous/idle-plan.js';
import { inboxBili } from '../plugins/autonomous/lib/social/inbox.js';
import { reviewDiary } from './diary-review.js';
import { chatCompletionObserved } from './llm.js';
import { appendNotebook, readNotebook } from './notebook.js';
import { write as diaryWrite } from './diary/index.js';
import { setSelfWake } from './idle-wake.js';
import { readCompanion, activePending } from './companion/state.js';
import { getChatStore } from './companion-core/context.js';
import { createIdleGoalLog } from './idle-goal-log.js';
import { createDrawAdapter } from './autonomous/draw-adapter.js';
import { resolveBiliMention } from './bili-owner.js';

let idleActions = null;
export function attachIdleActions(actions) { idleActions = actions; }

let idleLog = null;
export function attachIdleGoalLog(log) { idleLog = log; }
function goalLog() {
  if (!idleLog) idleLog = createIdleGoalLog();
  return idleLog;
}

export const IDLE_ACTIVITIES = Object.freeze([
  { id: 'xhh_browse', title: '逛一逛（B站/小黑盒）', risk: 'low', kind: 'read' },
  { id: 'share', title: '分享一条', risk: 'low', kind: 'share' },
  { id: 'comment', title: 'B站评论（可 @ 老大）', risk: 'medium', kind: 'comment' },
  { id: 'comment_share', title: '评论 + 分享同一条', risk: 'medium', kind: 'comment_share' },
  { id: 'reply', title: '回复评论/@', risk: 'medium', kind: 'reply' },
  { id: 'draw', title: '画画', risk: 'low', kind: 'draw' },
  { id: 'chat', title: '和老大说话', risk: 'low', kind: 'chat' },
  { id: 'write_diary', title: '写日记', risk: 'low', kind: 'write' },
  { id: 'write_notebook', title: '整理/写本子', risk: 'low', kind: 'write' },
  { id: 'diary_review', title: '整理日记', risk: 'low', kind: 'review' },
  { id: 'write_skill', title: '写一个小 skill', risk: 'medium', kind: 'create' },
  { id: 'daily_review', title: '记录检查（11:00 / 23:00）', risk: 'low', kind: 'write' },
  { id: 'think', title: '自己想想做什么', risk: 'low', kind: 'think' },
  { id: 'sleep', title: '睡觉', risk: 'none', kind: 'sleep' }
]);

export function listIdleActivities() { return IDLE_ACTIVITIES.map((x) => ({ ...x })); }

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const localTime = (at) => new Date(at).toLocaleString('zh-CN', { hour12: false });

async function gen(prompt, maxTokens = 350, maxChars = 700) {
  const r = await chatCompletionObserved('idle-action', {
    messages: [
      { role: 'system', content: '你是小鲸鱼。只做简短、自然、有依据的表达，不编造没看到的内容。' },
      { role: 'user', content: prompt }
    ],
    temperature: 0.7,
    maxTokens,
    thinkingMode: 'off'
  });
  return clip(r?.message?.content ?? r?.content, maxChars);
}

const THINK_JSON_HINT = '输出严格 JSON：{"action":"...","message":"可选，聊天/分享配文","includeLink":true,"wakeAfterMinutes":可选的30-1440整数,"next":"下一步打算（一句话，可选）","reason":"一句话原因"}。';

function parseThinkJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const d = JSON.parse(m[0]);
    return d && typeof d === 'object' && !Array.isArray(d) ? d : null;
  } catch { return null; }
}

/** 只读快照：Goal 的活跃/搁置项 + 未结算 Pending；读失败不猜，返回空并带错误。 */
function readGoalSnapshot() {
  try {
    const st = readCompanion();
    const goals = (Array.isArray(st?.goals) ? st.goals : [])
      .filter((g) => g && g.id && ['active', 'paused'].includes(String(g.status)));
    return { ok: true, goals, pending: activePending() || [] };
  } catch (e) {
    return { ok: false, goals: [], pending: [], error: String(e?.message || e) };
  }
}

/** ChatStore 最近消息（只读）；没有 store/chatKey 时返回空，不报错。 */
function readRecentMessages(limit = 20) {
  try {
    const store = getChatStore();
    const key = idleActions?.status?.().chatKey || '';
    if (!store || !key) return [];
    const rows = store.recent(key, { limit }) || [];
    return rows.map((m) => ({ self: Boolean(m?.self), text: String(m?.text ?? ''), ts: Number(m?.ts) || 0 }));
  } catch { return []; }
}

/**
 * 从她自己的本子记录里找一件“真心还想继续”的兴趣（不是待办、不是目标）。
 * 没有本子/没有可读内容时不生成候选——绝不凭空造兴趣。
 */
async function readInterestCandidates({ notebook }) {
  const text = String(notebook?.ok ? notebook.text : '').trim();
  if (text.length < 40) return [];
  const raw = await gen(`下面是你自己最近写下的本子片段。找出一件你现在真心还想继续看一眼、弄明白或者做一点的小事——不是待办，不是别人交给你的任务，不是目标；如果没有，text 留空。
只输出严格 JSON：{"text":"不超过40字的具体小事","evidence":"引用本子里的一句话，不超过40字"}；没有就输出 {"text":""}。
本子片段：
${text.slice(0, 1500)}`, 260, 500);
  const d = parseThinkJson(raw);
  const idea = clip(d?.text, 60);
  if (!idea) return [];
  return [{
    id: `interest-${Math.abs(hashCode(idea))}`,
    text: idea,
    owner: 'partner',
    intent: 'interest',
    epistemic: 'observed',
    explicit: false,
    evidence: clip(d?.evidence || d?.reason, 120)
  }];
}

function hashCode(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

function recentLines(entries = []) {
  if (!entries.length) return '（还没有）';
  return entries.map((e) => `- ${localTime(e.at)}：${e.action || e.type}${e.title ? `（${e.title}）` : ''}${e.summary ? `：${e.summary}` : ''}${e.next ? `（下一步：${e.next}）` : ''}`).join('\n');
}
/** 连着逛了几轮就提醒“别只看不动”（2026-11-06 机主观察：她连续 4 轮都在逛）。 */
function recentBrowseNote(log) {
  try {
    const recent = log?.recent?.({ limit: 3 }) || [];
    const browses = recent.filter((x) => String(x?.action || '') === 'browse').length;
    if (browses >= 2) return '你已经连着逛了几轮了：光看不动。这一轮不要只逛——分享一条、评论一条、写下来，或者停下来。';
  } catch { /* ignore */ }
  return '';
}


function browseSummary(r) {
  const items = Array.isArray(r?.items) ? r.items.slice(0, 3) : [];
  return items.map((x) => `《${clip(x.title, 40)}》`).join('；');
}

/** 这一轮“看到的东西”：优先用刚浏览过的记录（写下来就是写这些）；没有才现拉小黑盒。 */
async function collectBrowsingMaterial(limit = 5) {
  const browsed = loadBrowse();
  if (browsed.length) {
    return browsed.slice(0, limit)
      .map((x, i) => `${i + 1}. [${x.source || ''}] ${clip(x.title, 50)}${x.summary ? `：${clip(x.summary, 60)}` : ''}`)
      .join('\n');
  }
  try {
    const r = await createXhhReader().feed({ limit });
    if (!r.ok || !Array.isArray(r.items) || !r.items.length) return '';
    return r.items.slice(0, limit)
      .map((x, i) => `${i + 1}. ${clip(x.title, 50)}${x.summary ? `：${clip(x.summary, 60)}` : ''}`)
      .join('\n');
  } catch { return ''; }
}

/** 写日记：有浏览素材才写，没看到东西就不编。 */
async function writeDiaryFromCycle({ decision, notebook, when }) {
  const material = await collectBrowsingMaterial();
  const raw = await gen(`现在 ${when}。你想把这一轮看到/想到的记进今天的日记。
${material ? `刚看到的内容：\n${material}` : '这一轮没有新的浏览内容，只能写你自己真实想到的。'}
最近本子片段（不要照抄）：
${notebook?.ok && notebook.text ? notebook.text.slice(0, 500) : '（无）'}
写一到两句，第一人称，具体、有依据；不编造没看到的内容，不提自动化/系统/工具。
输出严格 JSON：{"text":"日记正文，不超过120字","mood":"一个词的心情，可空","reason":"为什么想写"}`, 260, 500);
  const d = parseThinkJson(raw);
  const content = clip(d?.text, 200) || clip(decision?.message, 200);
  if (!content) return { ok: false, done: false, error: 'empty_diary_text' };
  const r = diaryWrite({ content, source: 'idle', importance: '一般', mood: clip(d?.mood, 10) });
  return { ok: r?.ok === true, done: r?.ok === true, summary: content, result: r };
}

/** 写本子：她自己的私人记录，读者只有她自己。 */
async function writeNotebookFromCycle({ decision, notebook, when }) {
  const material = await collectBrowsingMaterial();
  const raw = await gen(`现在 ${when}。你想往自己的私人本子里记一段（只有你自己看，不会给别人看）。
${material ? `刚看到/想到的：\n${material}` : '这一轮没有新的浏览内容，只能写自己真实想到的。'}
最近本子片段（不要照抄、不要重复已经写过的）：
${notebook?.ok && notebook.text ? notebook.text.slice(0, 500) : '（无）'}
写具体一点，不编造没看到的内容，不提自动化/系统/工具。
输出严格 JSON：{"title":"不超过20字的小标题","text":"不超过200字","reason":"为什么想记"}`, 320, 700);
  const d = parseThinkJson(raw);
  const body = clip(d?.text, 400) || clip(decision?.message, 400);
  if (!body) return { ok: false, done: false, error: 'empty_notebook_text' };
  const r = appendNotebook({ title: clip(d?.title, 40) || `空闲 ${localTime(Date.now())}`, text: body });
  return { ok: r?.ok === true, done: r?.ok === true, summary: body, result: r };
}

/** 浏览记录：她“逛”过什么。browse 时写入，comment/share 优先从这里选。 */
const BROWSE_FILE = path.join(DATA_DIR, 'idle-browse.json');
function saveBrowse(items) {
  try {
    fs.mkdirSync(path.dirname(BROWSE_FILE), { recursive: true });
    fs.writeFileSync(BROWSE_FILE, JSON.stringify({ at: Date.now(), items: items.slice(0, 20) }, null, 1), 'utf8');
  } catch { /* 存不了就现拉 */ }
}
function loadBrowse(maxAgeMs = 6 * 3600e3) {
  try {
    const j = JSON.parse(fs.readFileSync(BROWSE_FILE, 'utf8'));
    if (!j || !Array.isArray(j.items)) return [];
    if (Date.now() - Number(j.at || 0) > maxAgeMs) return [];
    return j.items;
  } catch { return []; }
}

/** 逛：想搜就搜（B站/小黑盒关键词），再补推荐流；看到的内容记下来。 */
async function runBrowseActivity({ limit = 8, query = '' } = {}) {
  const out = [];
  const push = (source, items) => {
    for (const it of (items || [])) {
      const title = String(it.title || '').trim();
      const url = String(it.url || '').trim();
      if (!title) continue;
      out.push({ source, title, url, summary: it.summary || it.description || '', bvid: it.contentId || '' });
    }
  };
  let keyword = String(query || '').trim().slice(0, 20);
  // 主题常常是一句口语（“想看看康陶高管在夜之城…”），先压成 2–8 字的搜索词，
  // 否则搜索会被整句带偏，搜不到又混推荐流，就是“想看的”和“看到的”对不上。
  if (keyword.length > 10) {
    try {
      const k = await gen(`把这句话提炼成 2-8 个字的搜索关键词，只回 JSON：{"keyword":"..."}：${keyword}`, 40, 60);
      const m = String(k || '').match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : '{}');
      const kv = String(j.keyword || '').trim().slice(0, 12);
      if (kv) keyword = kv;
    } catch { /* 保留原词 */ }
  }
  if (!keyword) {
    try {
      const k = await gen(`你一个人待着，想搜点什么看看吗？想搜就给一个关键词（<=12字，比如你最近感兴趣的东西），不想搜就留空。只回 JSON：{"keyword":"关键词（可空）"}`, 60, 80);
      const m = String(k || '').match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : '{}');
      keyword = String(j.keyword || '').trim().slice(0, 20);
    } catch { /* 不搜 */ }
  }
  let searched = false;
  if (keyword) {
    try { const b = await createReadonlyAdapter().search({ keyword, limit }); push('B站', (b.ok ? b.items : [])); } catch { /* ignore */ }
    try { const x = await createXhhReader().search(keyword, { limit }); push('小黑盒', (x.ok ? x.items : [])); } catch { /* ignore */ }
    searched = out.length > 0;
  }
  // 只有没搜到（或没给主题）才补推荐流，避免“想看的”和“实际看到的”对不上
  if (!searched) {
    try { const b = await createReadonlyAdapter().read({ limit }); push('B站', (b.ok ? b.items : [])); } catch { /* ignore */ }
    try { const x = await createXhhReader().feed({ limit }); push('小黑盒', (x.ok ? x.items : [])); } catch { /* ignore */ }
  }
  const seen = new Set();
  const items = out.filter((c) => { const k = c.url || c.title; if (seen.has(k)) return false; seen.add(k); return true; });
  if (items.length) saveBrowse(items);
  return { ok: items.length > 0, activity: 'xhh_browse', title: keyword ? `逛：${keyword}` : '逛B站/小黑盒', items, keyword, searched };
}

/** 逛完之后的“接下来”：分享 / 评论 / 写下来 / 停（同一轮内决策，不靠禁止 browse）。 */
async function afterBrowseDecision(browse, { when = localTime(Date.now()) } = {}) {
  if (!idleActions) return { action: 'none' };
  const items = (browse?.items || []).filter((x) => x && x.title).slice(0, 5);
  if (!items.length) return { action: 'none' };
  const list = items.map((x, i) => `${i + 1}. [${x.source}] ${x.title}`).join('\n');
  const raw = await gen(`你刚看完这些：\n${list}\n接下来想做什么？可以：share（挑一条分享给老大，可不说配话）、comment（评论一条 B站视频，可 @ 老大）、write_diary（把好玩的写进日记）、none（停）。只回 JSON：{"action":"share|comment|write_diary|none","index":编号,"note":"可选"}`, 120, 200);
  let j = {};
  try { const m = String(raw || '').match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : '{}'); } catch { j = {}; }
  const act = String(j.action || 'none').toLowerCase();
  if (act === 'none') return { action: 'none' };
  const n = Number(j.index);
  const idx = Number.isInteger(n) && n >= 1 && n <= items.length ? n - 1 : 0;
  const item = items[idx];
  if (act === 'share') {
    let say = String(j.note || '').trim().slice(0, 300);
    if (say && (say.length > 40 || /\d{2,}/.test(say))) say = await naturalShareLine(item.title);
    const out = await idleActions.share({ title: item.title, url: item.url, text: say, includeLink: true });
    return { action: 'share', ok: out.ok === true, title: item.title, result: out };
  }
  if (act === 'comment' && item.bvid) {
    const at = resolveBiliMention('owner');
    const text = String(j.note || '').trim() || await gen(`给这条B站视频写一句自然、克制的评论，不超过80字，不编造：\n标题：${item.title}\n简介：${item.summary || '（无）'}`, 160);
    if (!text) return { action: 'comment', ok: false, error: 'empty_generated_text' };
    const out = await idleActions.commentBili({ bvid: item.bvid, text, mention: at.ok && at.mention ? at.mention : '' });
    return { action: 'comment', ok: out.ok === true, title: item.title, result: out };
  }
  if (act === 'write_diary') {
    const out = await writeDiaryFromCycle({ decision: { message: String(j.note || '').slice(0, 300), reason: '看完想写下来' }, notebook: readNotebook({ chars: 900 }), when });
    return { action: 'write_diary', ok: out.ok === true, result: out };
  }
  return { action: act };
}

/** 统一候选池：只从“刚浏览过的”里选——没看过就不能评论/分享（必须先 browse）。 */
async function collectCandidates(limit = 6) {
  return loadBrowse().slice(0, limit);
}

/** 从候选里挑一条（模型挑，失败用第一条）。 */
async function pickIndex(cands, hint) {
  if (cands.length <= 1) return 0;
  const list = cands.map((c, i) => `${i + 1}. [${c.source}] ${c.title}`).join('\n');
  const raw = await gen(`你刚看到这些，${hint}（只挑一个）：\n${list}\n只回 JSON：{"index": 编号}`, 80, 120);
  try {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : '{}');
    const n = Number(j.index);
    if (Number.isInteger(n) && n >= 1 && n <= cands.length) return n - 1;
  } catch { /* 用第一条 */ }
  return 0;
}

/** 评论：从统一候选池挑一条 B站视频，写评论（可 @ 主人）。 */
async function runCommentActivity({ note = '' } = {}) {
  if (!idleActions) return { ok: false, done: false, error: 'idle_actions_missing' };
  const cands = (await collectCandidates(6)).filter((c) => c.source === 'B站' && c.bvid);
  if (!cands.length) return { ok: true, done: false, skipped: true, reason: 'no_comment_candidate' };
  const item = cands[await pickIndex(cands, '挑一条你真的想评论的')];
  const at = resolveBiliMention('owner');
  const canAt = at.ok && at.mention;
  const text = String(note || '').trim() || await gen(`给这条B站视频写一句自然、克制的评论，不超过80字，不编造视频内容。${canAt ? `如果合适，可以自然提一下老大（会 @ ${at.mention}），不是必须。` : ''}\n标题：${item.title}\n简介：${item.summary || '（无）'}`, 180);
  if (!text) return { ok: false, done: false, error: 'empty_generated_text' };
  const out = await idleActions.commentBili({ bvid: item.bvid, text, mention: canAt ? at.mention : '' });
  return { ok: out.ok === true, done: out.ok === true, source: 'B站', title: item.title, summary: clip(`评论｜${item.title}｜${text}`, 160), result: out };
}

/** 评论 + 分享同一条（她看中一条，两件事一起做）。 */
async function runCommentShareActivity({ note = '' } = {}) {
  if (!idleActions) return { ok: false, done: false, error: 'idle_actions_missing' };
  const cands = (await collectCandidates(6)).filter((c) => c.source === 'B站' && c.bvid);
  if (!cands.length) return { ok: true, done: false, skipped: true, reason: 'no_comment_candidate' };
  const item = cands[await pickIndex(cands, '挑一条你想评论、也想分享给老大的')];
  const at = resolveBiliMention('owner');
  const canAt = at.ok && at.mention;
  const text = String(note || '').trim() || await gen(`给这条B站视频写一句自然、克制的评论，不超过80字，不编造视频内容。${canAt ? `如果合适，可以自然提一下老大（会 @ ${at.mention}），不是必须。` : ''}\n标题：${item.title}\n简介：${item.summary || '（无）'}`, 180);
  if (!text) return { ok: false, done: false, error: 'empty_generated_text' };
  const c = await idleActions.commentBili({ bvid: item.bvid, text, mention: canAt ? at.mention : '' });
  const sh = await idleActions.share({ title: item.title, url: item.url, text: '', includeLink: true });
  return { ok: c.ok === true && sh.ok === true, done: true, source: 'B站', title: item.title, summary: clip(`评论+分享｜${item.title}`, 160), result: { comment: c, share: sh } };
}

/** 画画：随机场景，让她起标题/备注，保存到画廊（不自动发）。 */
/** 每天 11:00 / 23:00 的记录检查：有值得写的就写日记/本子，没有就跳过。 */
async function runDailyReview({ when = localTime(Date.now()) } = {}) {
  if (!idleActions) return { ok: false, activity: 'daily_review', error: 'idle_actions_missing' };
  const notebook = readNotebook({ chars: 900 });
  const recent = readRecentMessages(30).map((m) => `${m.self ? '我' : '老大'}：${clip(m.text, 60)}`).join('\n');
  const browse = loadBrowse().slice(0, 6).map((x, i) => `${i + 1}. [${x.source}] ${x.title}`).join('\n');
  const raw = await gen(`现在是 ${when}。检查一下今天有没有值得写进日记或本子的：\n最近聊天：\n${recent || '（无）'}\n刚看过：\n${browse || '（无）'}\n本子片段：\n${notebook?.ok ? notebook.text.slice(0, 500) : '（无）'}\n如果值得记，就写：diary（一条心情记录）或 notebook（几行）。没有就 none。只回 JSON：{"write":"diary|notebook|none","mood":"心情（diary 用）","content":"内容（<=120字）"}`, 200, 300);
  let j = {};
  try { const m = String(raw || '').match(/\{[\s\S]*\}/); j = JSON.parse(m ? m[0] : '{}'); } catch { j = {}; }
  const write = String(j.write || 'none').toLowerCase();
  if (write === 'none') return { ok: true, activity: 'daily_review', skipped: true, reason: 'nothing_to_write' };
  const content = String(j.content || '').trim().slice(0, 200);
  if (!content) return { ok: true, activity: 'daily_review', skipped: true, reason: 'empty_content' };
  if (write === 'notebook') {
    try { appendNotebook({ title: `记录 ${when}`, text: content }); } catch (e) { return { ok: false, activity: 'daily_review', error: String(e?.message || e) }; }
    return { ok: true, activity: 'daily_review', wrote: 'notebook', content };
  }
  try {
    const mood = String(j.mood || '平静').slice(0, 20);
    const r = diaryWrite({ content, mood, importance: '一般', day: new Date().toISOString().slice(0, 10) });
    return { ok: r?.ok === true, activity: 'daily_review', wrote: 'diary', content, result: r };
  } catch (e) { return { ok: false, activity: 'daily_review', error: String(e?.message || e) }; }
}

async function runDrawActivity() {
  const presets = ['night', 'cat', 'flower', 'sky', 'day'];
  const preset = presets[Math.floor(Math.random() * presets.length)];
  let title = ''; let note = '';
  const spec = await gen(`你一个人待着，想画一张画（场景：${preset}）。给这张画起个标题（<=20字），再写一句备注（<=50字，可以空）。只回 JSON：{"title":"标题","note":"备注"}`, 80, 120);
  try { const m = String(spec || '').match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : '{}'); title = String(j.title || '').slice(0, 60); note = String(j.note || '').slice(0, 200); } catch { /* 用空标题 */ }
  const r = await createDrawAdapter().draw({ preset, title, note });
  if (!r.ok) return { ok: false, done: false, error: r.error || '画画失败' };
  // 画完可以选择分享（也可以只存画廊）
  let share = false; let cap = '';
  try {
    const d = await gen(`你刚画完《${title || preset}》。想分享给老大吗？想就写一句配文（<=30字），不想就留空。只回 JSON：{"share":true或false,"note":"配文（可空）"}`, 80, 120);
    const m = String(d || '').match(/\{[\s\S]*\}/); const j = JSON.parse(m ? m[0] : '{}');
    share = j.share === true; cap = String(j.note || '').slice(0, 100);
  } catch { /* 默认不分享 */ }
  let sent = null;
  if (share && idleActions?.sendImage) sent = await idleActions.sendImage({ file: r.path, note: cap });
  return {
    ok: true, done: true,
    summary: clip(`画画｜${title || preset}${sent?.ok ? '｜已分享' : ''}`, 160),
    result: { ...r, shared: sent?.ok === true }
  };
}

/** 写一个自己的 skill：生成 her-<id> 的 skill.json + index.js，语法校验通过才落盘。 */
async function runWriteSkillActivity() {
  const draft = await gen(`你想给自己写一个小 skill（工具），以后聊天或空闲时能用。写一个安全的、只读或低风险的小工具（不要发消息、不要删文件、不要起子进程、不要联网）。只回 JSON：{"id":"her-xxx（小写字母数字连字符，her- 开头）","name":"名称","description":"一句话","code":"完整的 ESM 代码，export function setup(api)，用 api.registerTool({id,name,description,category,parameters,async execute(ctx,args){...}}) 注册一个工具"}`, 700, 4000);
  let spec = null;
  try { const m = String(draft || '').match(/\{[\s\S]*\}/); spec = JSON.parse(m ? m[0] : ''); } catch { spec = null; }
  if (!spec || !spec.id || !spec.code) return { ok: false, done: false, error: 'skill_generation_failed' };
  const id = String(spec.id).toLowerCase();
  if (!/^her-[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return { ok: false, done: false, error: 'bad_skill_id' };
  const code = String(spec.code);
  if (/child_process|process\.exit|eval\(|new Function|rmdir|unlinkSync|rmSync/.test(code)) return { ok: false, done: false, error: 'skill_code_denied' };
  const { fileURLToPath } = await import('node:url');
  const { spawnSync } = await import('node:child_process');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = path.join(DATA_DIR, 'tmp', `${id}-index.mjs`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, code, 'utf8');
  const check = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
  if (check.status !== 0) {
    const draftDir = path.join(DATA_DIR, 'tmp', 'skill-drafts');
    fs.mkdirSync(draftDir, { recursive: true });
    fs.writeFileSync(path.join(draftDir, `${id}.draft.txt`), code, 'utf8');
    return { ok: false, done: false, error: `skill_syntax_error: ${String(check.stderr || '').slice(0, 120)}` };
  }
  const dir = path.join(root, 'skills', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.js'), code, 'utf8');
  fs.writeFileSync(path.join(dir, 'skill.json'), JSON.stringify({
    id,
    name: String(spec.name || id).slice(0, 40),
    version: '0.1.0',
    apiVersion: 1,
    category: 'utility',
    author: '小鲸鱼自己写的',
    enabledByDefault: true,
    description: String(spec.description || '').slice(0, 200)
  }, null, 2), 'utf8');
  try { appendNotebook({ title: `给自己写了个 skill：${id}`, text: String(spec.description || '').slice(0, 200) }); } catch { /* 记不上也不阻塞 */ }
  return { ok: true, done: true, summary: clip(`写了个 skill：${id}`, 160), result: { id, dir } };
}

/** 分享：B站 + 小黑盒同级候选，让她挑一个喜欢的；可以说一句话，也可以不说。 */
/** 分享配文：像朋友随手甩链接，不写总结/数字/“已核实”。 */
async function naturalShareLine(title) {
  try {
    const t = await gen(`你刷到《${clip(title, 50)}》，想随手甩给老大。用一句口语、自然的话说（像朋友分享，不总结内容、不列数字、不提“核实”），10-30字，只回这句话本身。`, 60, 80);
    const line = String(t || '').replace(/^["'「『]|["'」』]$/g, '').trim();
    return line.slice(0, 60);
  } catch { return ''; }
}

async function runShareActivity({ note = '' } = {}) {
  if (!idleActions) return { ok: false, done: false, error: 'idle_actions_missing' };
  const cands = await collectCandidates(6);
  if (!cands.length) return { ok: true, done: false, skipped: true, reason: 'no_share_candidate' };
  const idx = await pickIndex(cands, '挑一个你真的想分享给老大的');
  const item = cands[idx];
  let say = String(note || '').trim();
  if (say && (say.length > 40 || /\d{2,}/.test(say))) say = await naturalShareLine(item.title);
  const out = await idleActions.share({ title: item.title, url: item.url, text: say, includeLink: true });
  return { ok: out.ok === true, done: out.ok === true, source: item.source, title: item.title, summary: clip(`${item.source}｜${item.title}${say ? '｜' + say : ''}`, 160), result: out };
}

/** 执行受限 think 选中的动作；返回统一形状，供账本记录。 */
async function performPlannedAction(action, decision, { days, limit, notebook, when }) {
  if (action === 'browse') {
    const query = clip(decision?.message || decision?.reason || '', 60);
    const r = await runIdleActivity('xhh_browse', { limit, query });
    const after = await afterBrowseDecision(r, { when });
    return { ok: r.ok === true, done: r.ok === true || after.ok === true, summary: browseSummary(r) + (after.action && after.action !== 'none' ? ` → ${after.action}` : ''), result: { ...r, after } };
  }
  if (action === 'diary') {
    const r = await runIdleActivity('diary_review', { days });
    return { ok: r.ok === true, done: r.ok === true, summary: clip(r.summary, 160), result: r };
  }
  if (action === 'write_diary') return writeDiaryFromCycle({ decision, notebook, when });
  if (action === 'write_notebook') return writeNotebookFromCycle({ decision, notebook, when });
  if (action === 'share') {
    return runShareActivity({ note: clip(decision?.message, 300) });
  }
  if (action === 'chat') {
    if (!idleActions) return { ok: false, done: false, error: 'idle_actions_missing' };
    const text = clip(decision?.message, 300);
    if (!text) return { ok: false, done: false, error: 'think_chat_empty' };
    const out = await idleActions.chat({ text });
    return { ok: out.ok === true, done: out.ok === true, summary: text, result: out };
  }
  // sleep / none：合法但不推进，不计入冷却。
  return { ok: true, done: false, summary: '', skipped: true, reason: action };
}

/** 受限 think：围绕 planner 选中的那一件事，只允许对应动作。 */
async function runPlannedThink(plan, { days, limit, when, notebook, quiet = false }) {
  const type = String(plan.selected.type || '');
  // 静默时段不提供公开动作（分享/聊天）；写日记/本子/整理/只读浏览仍然可以。
  const allowed = (ACTIONS_BY_TYPE[type] || ['sleep', 'none'])
    .filter((a) => !quiet || !['share', 'chat'].includes(a));
  const actions = allowed.length ? allowed : ['sleep', 'none'];
  const quietNote = quiet
    ? '现在是静默时间（00:00–08:00）：可以睡觉，也可以做不打扰人的事——写日记、写本子、整理、只看不发。不要发消息、分享或评论。\n'
    : '';
  const log = goalLog();
  const prompt = `现在 ${when}。你一个人待着。
${quietNote}${describePlanForPrompt(plan, actions)}
最近几轮你醒来做过的事：
${recentLines(log.recent({ limit: 5 }))}
${recentBrowseNote(log)}

最近浏览过（要评论/分享就从这些里选）：
${loadBrowse().slice(0, 6).map((x, i) => `${i + 1}. [${x.source}] ${clip(x.title, 50)}`).join('\n') || '（这一轮还没逛）'}
最近本子片段：
${notebook?.ok && notebook.text ? notebook.text.slice(0, 900) : '（无）'}

${THINK_JSON_HINT}不要点赞，不要编造没看过的内容，不要同时做两件事。`;

  const raw = await gen(prompt, 500, 900);
  const decision = parseThinkJson(raw);
  if (!decision) {
    return { ok: true, activity: 'think', action: 'none', reason: 'think_parse_failed', plan: planBrief(plan) };
  }
  if (Number(decision.wakeAfterMinutes) >= 30) {
    try { setSelfWake({ afterMinutes: Number(decision.wakeAfterMinutes), reason: clip(decision.reason, 120) }); } catch { /* 上限/异常不阻塞 */ }
  }
  let action = String(decision.action || 'none').toLowerCase();
  let invalidAction = '';
  if (!actions.includes(action)) { invalidAction = action; action = 'none'; }
  if (action === 'sleep') {
    log.append({ at: Date.now(), type, title: String(plan.selected.title || ''), goalId: plan.target?.kind === 'goal' ? plan.target.id : '', pendingId: plan.target?.kind === 'pending' ? plan.target.id : '', action, ok: true, done: false, reason: clip(decision.reason, 120), next: clip(decision.next, 120) });
    return { ok: true, activity: 'think', action, sleep: true, reason: clip(decision.reason, 120), plan: planBrief(plan) };
  }
  if (action === 'none') {
    const reason = invalidAction ? `action_not_allowed:${invalidAction}` : clip(decision.reason, 120);
    log.append({ at: Date.now(), type, title: String(plan.selected.title || ''), goalId: plan.target?.kind === 'goal' ? plan.target.id : '', pendingId: plan.target?.kind === 'pending' ? plan.target.id : '', action, ok: true, done: false, reason, next: clip(decision.next, 120) });
    return { ok: true, activity: 'think', action, reason, plan: planBrief(plan) };
  }

  const out = await performPlannedAction(action, decision, { days, limit, notebook, when });
  log.append({
    at: Date.now(),
    type,
    title: String(plan.selected.title || ''),
    goalId: plan.target?.kind === 'goal' ? plan.target.id : '',
    pendingId: plan.target?.kind === 'pending' ? plan.target.id : '',
    action,
    ok: out.ok === true,
    done: out.done === true,
    reason: clip(decision.reason, 120),
    summary: out.summary || '',
    next: clip(decision.next, 120)
  });
  return {
    ok: out.ok === true,
    activity: 'think',
    action,
    done: out.done === true,
    reason: clip(decision.reason, 120),
    result: out.result,
    plan: planBrief(plan)
  };
}

function planBrief(plan) {
  return {
    type: plan?.selected?.type || '',
    title: plan?.selected?.title || '',
    target: plan?.target || null,
    gate: plan?.gate || null,
    closure: plan?.closure || null,
    reason: plan?.activity?.reason || plan?.skipReason || ''
  };
}

/** 自由 think：没有明确方向时保留旧能力。静默时段只允许不打扰人的动作。 */
async function runFreeThink({ days, limit, when, notebook, snapshot, quiet = false }) {
  const log = goalLog();
  const freeActions = quiet
    ? ['browse', 'diary', 'write_diary', 'write_notebook', 'sleep', 'none']
    : ['browse', 'diary', 'write_diary', 'write_notebook', 'share', 'chat', 'comment', 'comment_share', 'reply', 'check_xhh', 'draw', 'write_skill', 'sleep', 'none'];
  const actionHint = quiet
    ? 'browse（按你想看的主题去搜 B站/小黑盒；搜不到才看推荐。看到的内容会记下来）、diary（整理日记）、write_diary（写今天的日记）、write_notebook（写自己的本子）、sleep（睡觉）、none（什么都不做）'
    : 'browse（逛一逛 B站/小黑盒，看到的内容会记下来）、diary（整理日记）、write_diary（写今天的日记）、write_notebook（写自己的本子）、share（从B站或小黑盒挑一条想分享的给老大，可以不带话）、chat（主动找老大）、comment（B站评论，可以 @ 老大）、comment_share（看中一条：评论它并分享给老大）、draw（画画，画完可以选择分享给老大）、write_skill（给自己写个小工具）、reply（B站回复）、check_xhh（看小黑盒有没有人找你）、sleep（睡一会儿）、none（什么都不做）';
  const quietNote = quiet
    ? '现在是静默时间（00:00–08:00）：可以睡觉，也可以做不打扰人的事；不要发消息、分享、评论。\n'
    : '';
  const prompt = `现在 ${when}。你一个人待着，可以做：${actionHint}。选择一件真的想做的事，${THINK_JSON_HINT}不要选点赞，不要编造没看过的内容。
${quietNote}你现在的长期方向和没做完的事（可能为空）：
${(snapshot.goals || []).map((g) => `- [${g.status}] ${clip(g.text, 60)}`).join('\n') || '（没有）'}
${(snapshot.pending || []).slice(0, 5).map((p) => `- [待办] ${clip(p.text, 60)}`).join('\n')}
最近几轮你醒来做过的事：
${recentLines(log.recent({ limit: 5 }))}
${recentBrowseNote(log)}
最近浏览过（要评论/分享就从这些里选）：
${loadBrowse().slice(0, 6).map((x, i) => `${i + 1}. [${x.source}] ${clip(x.title, 50)}`).join('\n') || '（这一轮还没逛）'}
最近本子片段：
${notebook?.ok ? notebook.text.slice(0, 900) : '（无）'}`;
  const raw = await gen(prompt, 500, 900);
  const decision = parseThinkJson(raw);
  if (!decision) {
    log.append({ at: Date.now(), type: 'free_think', action: 'none', ok: true, done: false, reason: 'think_parse_failed' });
    return { ok: true, activity: 'think', action: 'none', reason: 'think_parse_failed' };
  }
  let action = String(decision.action || 'none');
  const invalidAction = action;
  if (!freeActions.includes(action)) action = 'none';
  if (Number(decision.wakeAfterMinutes) >= 30) {
    try { setSelfWake({ afterMinutes: Number(decision.wakeAfterMinutes), reason: decision.reason || '' }); } catch { /* ignore */ }
  }
  if (action === 'sleep') return { ok: true, activity: 'think', action, sleep: true, free: true };
  if (action === 'browse') {
    const r = await runIdleActivity('xhh_browse', { limit, query: clip(decision.message, 60) });
    const after = await afterBrowseDecision(r, { when });
    return { ...r, after, via: 'think', free: true, reason: decision.reason || '' };
  }
  if (action === 'diary') return { ...(await runIdleActivity('diary_review', { days })), via: 'think', free: true, reason: decision.reason || '' };
  if (action === 'write_diary' || action === 'write_notebook') {
    const out = action === 'write_diary'
      ? await writeDiaryFromCycle({ decision, notebook, when })
      : await writeNotebookFromCycle({ decision, notebook, when });
    log.append({ at: Date.now(), type: 'free_think', action, ok: out.ok === true, done: out.done === true, summary: out.summary || '', reason: clip(decision.reason, 120), next: clip(decision.next, 120) });
    return { ok: out.ok === true, activity: 'think', action, done: out.done === true, result: out.result, free: true };
  }
  if (action === 'chat') {
    const text = clip(decision.message, 300);
    if (!text) return { ok: false, activity: 'think', error: 'think_chat_empty' };
    const out = await idleActions.chat({ text });
    return { ok: out.ok === true, activity: 'think', action, result: out, free: true, reason: decision.reason || '' };
  }
  if (action === 'share') {
    const out = await runShareActivity({ note: clip(decision.message, 300) });
    return { ...out, activity: 'think', action, free: true, reason: decision.reason || '' };
  }
  if (action === 'check_xhh') {
    const out = await runIdleActivity('xhh_notify', { limit: 10 });
    return { ...out, via: 'think', free: true, reason: decision.reason || '' };
  }
  if (action === 'draw') {
    const out = await runDrawActivity();
    return { ...out, activity: 'think', action, free: true, reason: decision.reason || '' };
  }
  if (action === 'write_skill') {
    const out = await runWriteSkillActivity();
    return { ...out, activity: 'think', action, free: true, reason: decision.reason || '' };
  }
  if (action === 'comment') {
    const out = await runCommentActivity({ note: clip(decision.message, 300) });
    return { ...out, activity: 'think', action, free: true, reason: decision.reason || '' };
  }
  if (action === 'comment_share') {
    const out = await runCommentShareActivity({ note: clip(decision.message, 300) });
    return { ...out, activity: 'think', action, free: true, reason: decision.reason || '' };
  }
  if (action === 'reply') {
    const out = await runIdleActivity(action, { limit });
    return { ...out, via: 'think', free: true, reason: decision.reason || '' };
  }
  log.append({ at: Date.now(), type: 'free_think', action: 'none', ok: true, done: false, reason: clip(decision.reason, 120) });
  return {
    ok: true, activity: 'think', action: 'none', free: true,
    reason: invalidAction !== 'none' ? `action_not_allowed:${invalidAction}` : clip(decision.reason, 120)
  };
}

/** think 主流程：每轮最多 3 个动作，可以提前结束（sleep/none）。 */
async function runThink({ days = 7, limit = 8, quiet = false } = {}) {
  const notebook = readNotebook({ chars: 1200 });
  const snapshot = readGoalSnapshot();
  const log = goalLog();

  // 空闲时先处理 B站 @/回复与小黑盒通知（非静默），再做这一轮的事。
  let social = null;
  if (!quiet) {
    try {
      const replyOut = await runIdleActivity('reply', { limit: 8 });
      const xhhOut = await runIdleActivity('xhh_notify', { limit: 10 });
      social = { reply: replyOut, xhh: xhhOut };
    } catch { /* 社交检查失败不影响本轮 */ }
  }

  const results = [];
  const MAX_ACTIONS = 3;
  for (let round = 0; round < MAX_ACTIONS; round += 1) {
    const now = Date.now();
    const when = localTime(now);
    let plan = planIdleCycle({
      now,
      goals: snapshot.goals,
      pending: snapshot.pending,
      messages: readRecentMessages(20),
      recentActions: log.recentActions({ limit: 30 })
    });
    if (!plan.ok) {
      if (!results.length) return { ok: false, activity: 'think', error: plan.error || plan.code || 'plan_failed' };
      break;
    }
    if (!plan.gate.allow) {
      log.append({ at: now, type: 'skip', action: 'none', ok: true, done: false, reason: plan.gate.reason });
      break;
    }
    if (!plan.selected) {
      const interests = await readInterestCandidates({ notebook });
      if (interests.length) {
        plan = planIdleCycle({
          now,
          goals: snapshot.goals,
          pending: snapshot.pending,
          messages: readRecentMessages(20),
          materials: interests,
          recentActions: log.recentActions({ limit: 30 })
        });
      }
    }
    if (!plan.ok) { if (!results.length) return { ok: false, activity: 'think', error: plan.error || plan.code || 'plan_failed' }; break; }
    const single = plan.selected
      ? await runPlannedThink(plan, { days, limit, when, notebook, quiet })
      : await runFreeThink({ days, limit, when, notebook, snapshot, quiet });
    results.push(single);
    const act = String(single?.action || 'none');
    if (act === 'none' || act === 'sleep' || single?.skipped) break;
  }

  const last = results[results.length - 1] || { ok: true, activity: 'think', action: 'none' };
  return {
    ...last, activity: 'think', actions: results, action: last.action,
    done: results.some((r) => r.done === true),
    ...(social ? { social } : {})
  };
}

export async function runIdleActivity(id, { days = 7, limit = 8, quiet = false, query = '' } = {}) {
  if (id === 'xhh_browse') {
    return runBrowseActivity({ limit, query });
  }
  if (id === 'daily_review') {
    return runDailyReview();
  }
  if (id === 'diary_review') {
    const r = await reviewDiary({ days, chat: (args) => chatCompletionObserved('diary-review', args) });
    if (!r.ok) return { ok: false, activity: id, error: r.error || '日记整理失败' };
    try {
      const today = new Date().toISOString().slice(0, 10);
      const title = `空闲日记整理 ${today}`;
      if (!readNotebook().text.includes(title)) appendNotebook({ title, text: r.summary.slice(0, 2000) });
    } catch { /* 本子失败不影响回顾 */ }
    return { ok: true, activity: id, title: '整理日记', summary: r.summary, days: r.days };
  }
  if (id === 'think') return runThink({ days, limit, quiet });
  if (id === 'sleep') return { ok: true, activity: 'sleep', sleep: true };
  if (!idleActions) return { ok: false, activity: id, error: 'idle_actions_missing' };

  if (id === 'share') {
    const out = await runShareActivity();
    return { ...out, activity: id };
  }
  if (id === 'chat') {
    const nb = readNotebook({ chars: 900 });
    const when = localTime(Date.now());
    const text = await gen(`现在是 ${when}。你一个人待着，想给老大发一句自然的话。可以参考你最近的本子片段，但不要复述隐私、不要提自动化/系统：\n${nb.ok ? nb.text : ''}`);
    if (!text) return { ok: false, activity: id, error: 'empty_generated_text' };
    const out = await idleActions.chat({ text });
    return { ok: out.ok === true, activity: id, result: out };
  }
  if (id === 'comment') {
    return { ...(await runCommentActivity()), activity: id };
  }

  if (id === 'comment_share') {
    return { ...(await runCommentShareActivity()), activity: id };
  }

  if (id === 'reply') {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'bili-auth.json'), 'utf8'));
      const cookie = Object.entries(auth?.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
      const r = await inboxBili({ cookie, limit: 8 });
      if (!r.ok || !r.items.length) return { ok: true, activity: id, skipped: true, reason: 'no_inbox' };
      const item = r.items.find((x) => x.target && x.replyTo);
      if (!item) return { ok: true, activity: id, skipped: true, reason: 'no_replyable_target' };
      const text = await gen(`有人在B站回复/提到了你。写一句自然、简短的回复，不超过80字，不吵架、不编造：\n对方：${item.user}\n内容：${item.text}\n视频：${item.context || ''}`, 180);
      if (!text) return { ok: false, activity: id, error: 'empty_generated_text' };
      const out = await idleActions.commentBili({ bvid: item.target, text, replyTo: item.replyTo, root: item.root });
      return { ok: out.ok === true, activity: id, result: out };
    } catch (e) { return { ok: false, activity: id, error: String(e?.message || e) }; }
  }
  return { ok: false, error: 'unknown_activity' };
}

export { runThink };
