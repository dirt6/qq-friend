// 自主活动 2.1 的验收测试（2026-10-31 按方案第十节逐条对）。
//
// 测试不碰真实网络/真机：只测程序判定的部分（result 枚举、stopReason、
// planner 的第二次决策提示、reflection 透传）。真发消息、画图、评论、发帖
// 一律走 dryRun 或直接不测 —— 那些要在真机上观察。
import { makeBuilder, validateDecision } from '../plugins/autonomous/lib/planner.js';
import { activityMemory, internals } from '../plugins/autonomous/index.js';

const { executeAction, stopReasonOf } = internals;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const S = {
  shareMode: 'dryRun', quietRange: '00:00-07:00', maxSharePerSession: 2,
  diaryEnabled: true, drawEnabled: false, commentMode: 'live', publishMode: 'live'
};
const mkSt = () => ({ shares: [], lastWakeAt: 0 });
const mkRec = () => ({ actions: [] });

console.log('【1. result 枚举：成功 / 失败 / 跳过 / 无产出 要分得开】');
{
  // 没挑中内容 → 无产出，不是失败
  const a = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: { action: 'share', message: '随便说点', goal: 'g', why: 'w', next: '' }, picked: null
  });
  ok('share 没有内容 → no_output', a.result === 'no_output', a.result);
  ok('resultSummary 写清楚为什么没做', Boolean(a.resultSummary), a.resultSummary);

  // 演练模式 → skipped（不是 failed，也不是 success）
  const b = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: { action: 'share', message: '老大你看这个', goal: 'g', why: 'w', next: '' },
    picked: { title: '帖子A', url: 'https://x', source: 'xhh' }
  });
  ok('演练里分享 → skipped', b.result === 'skipped', b.result);
  ok('skipped 不会伪装成已分享', !/拎给老大看了/.test(b.resultSummary), b.resultSummary);

  // explore = 看了没做 → no_output
  const c = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: { action: 'explore', goal: '随便翻翻', why: 'w', next: '' }, picked: null
  });
  ok('explore → no_output', c.result === 'no_output', c.result);

  // search = 计划，算 success（但 summary 必须说是"下次搜"，不是搜过了）
  const d = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: { action: 'search', search: { keyword: 'dsh 部署坑', source: 'xhh' }, goal: 'g', why: 'w', next: '' }, picked: null
  });
  ok('search → success（记下了计划）', d.result === 'success', d.result);
  ok('search 明说"下次醒来先搜"', /下次醒来先搜/.test(d.resultSummary), d.resultSummary);
}

console.log('\n【2. 模型的 reflection 与程序的 result 分开存】');
{
  const a = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: {
      action: 'explore', goal: '翻猫贴', why: '想找点轻松的',
      reflection: '今天没什么特别想说的', next: '下次换个分区看看'
    },
    picked: null
  });
  ok('reflection 原样保留', a.reflection === '今天没什么特别想说的', a.reflection);
  ok('result 是程序判定，不是模型说了算', a.result === 'no_output', a.result);
  ok('next 与 nextStatus 都记下', a.next === '下次换个分区看看' && a.nextStatus === 'pending', `${a.next}/${a.nextStatus}`);

  const empty = await executeAction({
    s: S, st: mkSt(), rec: mkRec(), dryRun: true,
    decision: { action: 'explore', goal: 'g', why: 'w' }, picked: null
  });
  ok('没给 reflection 就是空字符串，不编造', empty.reflection === '', JSON.stringify(empty.reflection));
}

console.log('\n【3. 结束语：两件事都要能描述】');
{
  ok('没有行动 → 什么都没做', stopReasonOf({ actions: [] }) === '完成：这轮什么都没做');
  const one = stopReasonOf({ actions: [{ action: 'share', result: 'success' }] });
  ok('一件事成功', one.includes('1 件') && one.includes('share'), one);
  const two = stopReasonOf({
    actions: [{ action: 'share', result: 'success' }, { action: 'draw', result: 'success' }]
  });
  ok('两件事都成功', two.includes('2 件') && two.includes('share') && two.includes('draw'), two);
  const none = stopReasonOf({
    actions: [{ action: 'explore', result: 'no_output' }, { action: 'draw', result: 'no_output' }]
  });
  ok('两件都没结果也正常结束，不说"完成 2 件"', none.includes('都没结果'), none);
  ok('预先写好的 stopReason 优先（超时/兜底）',
    stopReasonOf({ stopReason: '完成：她决定到这里为止', actions: [{ action: 'chat', result: 'success' }] })
      === '完成：她决定到这里为止');
}

console.log('\n【4. 第二次决策能看到第一次的结果和已用类型】');
{
  const candidates = [{ title: '帖子A', source: 'xhh', summary: '摘要', url: 'https://x' }];
  const build = makeBuilder({
    candidates,
    state: {},
    usedTypes: ['share'],
    prevResult: { action: 'share', result: 'skipped', resultSummary: '演练里没发' },
    round: 2
  });
  const msgs = build(1, 20);
  const user = msgs[1].content;
  ok('提示里说"已经做过"', user.includes('已经做过'), user.slice(0, 200));
  ok('提示里点名了用过的类型', user.includes('分享帖子'), user.slice(0, 200));
  ok('提示里带了上次的真实结果', user.includes('skipped'), user.slice(0, 260));
  ok('提示里说明了这是第二件事', user.includes('第二件事'), user.slice(0, 260));
  ok('system 里仍然禁止声称看过全文', msgs[0].content.includes('不能声称看过全文'));
}

console.log('\n【5. reflection 从模型输出里透传】');
{
  const d = validateDecision({ action: 'chat', message: '在', reflection: '刚才那句话说得有点冲' }, 3);
  ok('保留 reflection', d.reflection === '刚才那句话说得有点冲', d.reflection);
  ok('超长 reflection 被截断', validateDecision({ action: 'chat', message: '在', reflection: 'x'.repeat(300) }, 3).reflection.length <= 120);
  ok('没有 reflection 时是空串', validateDecision({ action: 'chat', message: '在' }, 3).reflection === '');
}

console.log('\n【6. 日记只挑值得记的那件】');
{
  const twoActs = {
    actions: [
      { action: 'explore', result: 'no_output', goal: '随便翻翻', why: '闲' },
      { action: 'share', result: 'success', goal: '把部署的坑告诉他', why: '他在搞部署', picked: '帖子A', shareMode: 'live', next: '看他回不回' }
    ]
  };
  const mem = activityMemory(twoActs);
  ok('两件事里挑成功的那件', mem && /帖子A/.test(mem.diary), mem && mem.diary);
  ok('不会把没产出的那件写成经历', mem && !/随便翻翻/.test(mem.diary), mem && mem.diary);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
