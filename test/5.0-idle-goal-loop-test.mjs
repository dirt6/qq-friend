// 空闲 Goal/Purpose 规划：纯逻辑，用假快照验证“先看方向/待办/兴趣，再决定动作”。
import assert from 'node:assert/strict';
import {
  planIdleCycle, describePlanForPrompt, ACTIONS_BY_TYPE, gateOf, recentlyDone
} from '../src/autonomous/idle-plan.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const now = new Date('2026-11-05T21:00:00+08:00').getTime();

// 1) 用户明确交代的长期方向：空闲可以推进它
const goal = { id: 'g1', text: '把星图记忆方案接进 5.0', status: 'active', source: 'user_directed' };
let p = planIdleCycle({ now, goals: [goal], pending: [], messages: [], recentActions: [] });
ok('有长期方向时选中 advance_goal', p.ok && p.gate.allow && p.selected?.type === 'advance_goal', JSON.stringify(p.gate));
ok('目标对象带回来', p.target?.kind === 'goal' && p.target.id === 'g1');

// 2) 主人还在等回应：不自主行动
const asked = [{ self: false, text: '帮我看看这个配置怎么改？', ts: now - 60e3 }];
let q = planIdleCycle({ now, goals: [goal], pending: [], messages: asked, recentActions: [] });
ok('未解决提问时不自主', q.ok && q.gate.allow === false && ['conversation_open', 'unresolved_requests'].includes(q.gate.reason), JSON.stringify(q.gate));
ok('被拦下时没有选中活动', q.selected === null && ['conversation_open', 'unresolved_requests'].includes(q.skipReason));

// 3) 她已经回答、主人没回：属于“对话暂停”，可以自主
const answered = [
  { self: false, text: '帮我看看这个配置怎么改？', ts: now - 600e3 },
  { self: true, text: '改这两行就行，先备份。', ts: now - 540e3 }
];
let h = planIdleCycle({ now, goals: [goal], pending: [], messages: answered, recentActions: [] });
ok('答完等待确认时允许自主', h.ok && h.gate.allow === true && h.selected?.type === 'advance_goal', JSON.stringify(h.gate));

// 4) 刚做过：6 小时冷却内不重复
const cooled = planIdleCycle({
  now, goals: [goal], pending: [], messages: [],
  recentActions: [{ goalId: 'g1', result: 'success', at: now - 3600e3 }]
});
ok('冷却内不重复推进同一目标', cooled.ok && cooled.selected === null, JSON.stringify(cooled.skipReason));
ok('冷却原因可见', /all_candidates_rejected|recently_completed/.test(String(cooled.skipReason)) || cooled.activity?.reason === 'all_candidates_rejected');

// 5) 自主 Goal 没有证据：需要确认 → 不执行
const autoGoal = { id: 'g2', text: '自己找个理由去评论', status: 'active', source: 'autonomous' };
const ag = planIdleCycle({ now, goals: [autoGoal], pending: [], messages: [], recentActions: [] });
ok('无证据的自主目标不执行', ag.ok && ag.selected === null, JSON.stringify(ag.skipReason));

// 6) 她自己的兴趣：没有目标时也能形成一个方向
const interest = [{
  id: 'i1', text: '想看看别人怎么评价这套记忆架构', owner: 'partner',
  intent: 'interest', epistemic: 'observed', explicit: false
}];
const it = planIdleCycle({ now, goals: [], pending: [], messages: [], materials: interest, recentActions: [] });
ok('兴趣可以成为本轮方向', it.ok && it.selected?.type === 'interest_exploration', JSON.stringify(it.skipReason));
ok('兴趣标题正确', /记忆架构/.test(String(it.selected?.title || '')));

// 7) 六天内做过同一兴趣：过滤掉，不反复（账本默认看 7 天）
const seen = [{ title: '想看看别人怎么评价这套记忆架构', ok: true, done: true, at: now - 6 * 86400e3 }];
ok('recentlyDone 识别包含关系', recentlyDone('看看别人怎么评价这套记忆架构', seen, now) === true);
const it2 = planIdleCycle({ now, goals: [], pending: [], messages: [], materials: interest, recentActions: seen });
ok('做过的兴趣不再入选', it2.ok && it2.selected === null && it2.droppedMaterials === 1, JSON.stringify(it2));

// 8) 动作清单包含写日记/写本子；静默过滤由调用方做
const acts = ACTIONS_BY_TYPE.interest_exploration;
ok('兴趣允许写日记', acts.includes('write_diary'));
ok('兴趣允许写本子', acts.includes('write_notebook'));
ok('prompt 说明带标题和动作', /这轮|这一轮/.test(describePlanForPrompt(it)) && describePlanForPrompt(it).includes('write_notebook'));
ok('prompt 会收窄动作清单', describePlanForPrompt(it, ['sleep', 'none']).includes('sleep / none'));

// 9) 没有输入：不硬造方向
const none = planIdleCycle({ now, goals: [], pending: [], messages: [], recentActions: [] });
ok('没有方向时不编造', none.ok && none.selected === null && none.skipReason === 'no_purpose_candidates');

// 10) gateOf 兜底
ok('closure 失败时不放行', gateOf(null).allow === false);

// 11) R8 停止条件：同一方向连续 3 轮没进展 → 暂停 24h
const fails = [1, 2, 3].map((i) => ({ goalId: 'g1', result: 'failed', target: goal.text, at: now - i * 3 * 3600e3 }));
const paused = planIdleCycle({ now, goals: [goal], pending: [], messages: [], recentActions: fails });
ok('连续无进展后暂停该方向', paused.ok && paused.selected === null && paused.progress?.pausedCount === 1, JSON.stringify(paused.skipReason));
ok('暂停原因可见', paused.skipReason === 'no_progress_pause');
ok('暂停项带恢复时间', paused.progress?.paused?.[0]?.until > now);

// 12) 中间成功一次就清零
const mixed = [
  { goalId: 'g1', result: 'failed', target: goal.text, at: now - 9 * 3600e3 },
  { goalId: 'g1', result: 'failed', target: goal.text, at: now - 6 * 3600e3 },
  { goalId: 'g1', result: 'success', target: goal.text, at: now - 3 * 3600e3 },
  { goalId: 'g1', result: 'failed', target: goal.text, at: now - 1 * 3600e3 }
];
const resumed = planIdleCycle({ now, goals: [goal], pending: [], messages: [], recentActions: mixed });
ok('有进展则不暂停', resumed.ok && (resumed.progress?.pausedCount || 0) === 0 && String(resumed.skipReason) !== 'no_progress_pause', JSON.stringify(resumed.progress));

// 13) 超过 24h 自动恢复重试
const old = [1, 2, 3].map((i) => ({ goalId: 'g1', result: 'failed', target: goal.text, at: now - (25 + i) * 3600e3 }));
const retry = planIdleCycle({ now, goals: [goal], pending: [], messages: [], recentActions: old });
ok('暂停 24h 后允许再试', retry.ok && retry.selected?.type === 'advance_goal', JSON.stringify(retry.progress));

// 14) 一个方向暂停，另一个正常方向照常选
const goal2 = { id: 'g2b', text: '整理房间方案里的验收表', status: 'active', source: 'user_directed' };
const mixedGoals = planIdleCycle({ now, goals: [goal, goal2], pending: [], messages: [], recentActions: fails });
ok('其他方向不被连坐', mixedGoals.ok && mixedGoals.selected?.title === goal2.text, JSON.stringify(mixedGoals.selected));

console.log(`\nIdle goal loop: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
