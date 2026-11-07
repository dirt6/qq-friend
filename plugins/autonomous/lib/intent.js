// 自主活动 2.2：意图先行。
//
// 为什么要有这一层（2026-10-31 机主观察）：20 轮里 19 轮的 goal 都是
// 「把 X 递给/甩给/拎给老大」——她不是在想"我想干嘛"，而是在想"这条发给谁看"。
// 根因是醒来第一件事就抓榜单，任务被框成"从这 9 条里挑一条"。
//
// 所以先问一句「你现在想做什么」，**这一步不给任何候选**。
// 拿到意图之后，程序再决定要不要抓内容、抓什么。
import { parseDecision, safeSlice } from './planner.js';

/** 允许的意图类型（详见 doc/自主活动-2.2方案.md 第二节）。 */
export const INTENT_KINDS = new Set([
  'explore',   // 随便逛逛
  'create',    // 想画点什么 / 写点什么
  'learn',     // 想弄明白一件事
  'reflect',   // 理一理自己的想法
  'communicate', // 想找老大说句话
  'continue',  // 接着上次没做完的
  'finish'     // 什么都不想做
]);

/** 哪些意图需要先抓外部内容。 */
export const INTENT_NEEDS_CONTENT = new Set(['explore', 'learn', 'continue']);

const SYSTEM = `你是她"一个人待着"时的自己。现在是她的空闲时间，没人跟她说话。

先想清楚：**这一刻你想做什么**？不用先看有什么内容。

可以选：
- explore：随便逛逛，看看有没有新鲜事
- learn：想弄明白一件事（topic 写清是什么）
- create：想画点什么
- reflect：想理一理最近的想法
- communicate：想找老大说句话
- continue：接着上次没做完的事
- finish：现在没什么想做的，休息

规则：
1. 只写你此刻真的想做，不用每轮都有大计划。想休息就 finish。
2. goal 一句话说清想干嘛；why 说为什么是现在；topic 是相关话题（可空）。
3. desiredOutcome 是"想得到什么"（可空）：弄懂、玩一下、画出来、跟他说说。
4. 不要为了有产出而想事情。没有明确兴趣时，explore 或 finish 都正常。
5. 上次留了事没做完（下面会写），可以 continue，也可以不想做了。
6. 下面还会给你最近几句对话。**已经聊过、对方已经答过的事不要再追问**；上次留的事如果已经在对话里完成，就当它结束了，别换个说法再问一遍。

只输出 JSON：{"intent":"...","goal":"...","why":"...","topic":"...","desiredOutcome":"..."}`;

/**
 * 构造意图阶段的 messages（固定，不随候选裁剪）。
 *
 * @param {object} o
 * @param {string} [o.personaSnippet] 人设片段（把握口吻）
 * @param {string} [o.when] 现在几点
 * @param {string} [o.abilities] 她现在能做什么
 * @param {string} [o.pending] 上次留下的事
 * @param {string} [o.learned] 已学经验（几行）
 * @param {string} [o.recentDiary] 最近日记（一小段）
 * @param {string} [o.recentChat] 最近几句对话（我/老大）
 */
export function makeIntentMessages({
  personaSnippet = '', when = '', abilities = '', pending = '', learned = '', recentDiary = '', recentChat = ''
} = {}) {
  const user = [
    personaSnippet ? `你平时的样子（只作参考，别复述）：\n${personaSnippet}\n` : '',
    when ? `现在是 ${when}。` : '',
    abilities ? `你现在能做：${abilities}` : '',
    pending ? `上次留给这次的事：${pending}` : '上次没留下什么要做的事。',
    learned ? `你记得的经验：\n${learned}` : '',
    recentDiary ? `最近写过：\n${recentDiary}` : '',
    recentChat ? `最近聊过：\n${recentChat}` : '',
    '你现在想做什么？'
  ].filter(Boolean).join('\n');
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user }
  ];
}

/** 归一化意图输出；不认识的 intent 降级成 explore，不抛错。 */
export function validateIntent(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  const intent = INTENT_KINDS.has(String(d.intent ?? '')) ? String(d.intent) : 'explore';
  return {
    intent,
    goal: safeSlice(String(d.goal ?? '').trim(), 80),
    why: safeSlice(String(d.why ?? '').trim(), 120),
    topic: safeSlice(String(d.topic ?? '').trim(), 40),
    desiredOutcome: safeSlice(String(d.desiredOutcome ?? '').trim(), 60)
  };
}

/** 宽松解析（允许包 ```json / 前后有废话）。 */
export function parseIntent(text) {
  const r = parseDecision(text);
  if (!r.ok) return r;
  return { ok: true, intent: validateIntent(r.decision) };
}

/** 人读的一行，写进日志/状态。 */
export function describeIntent(it) {
  if (!it) return '（没生成意图）';
  const bits = [it.intent || 'explore'];
  if (it.goal) bits.push(it.goal);
  if (it.topic) bits.push(`话题：${it.topic}`);
  return bits.join('｜');
}
