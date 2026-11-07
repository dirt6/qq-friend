// 自主活动 2.3 的验收测试：自主唤醒 + 不再限制调用次数。
//
// 只测程序侧能确认的部分：预约的边界（30 分钟~24 小时 / 每天 4 次 / 覆盖）、
// 预算闸门不再卡次数但**仍然卡钱**、模型输出的 wakeAfterMinutes 校验。
// 「她能做几件事」属于行为观察，要在真实运行里看，不在这里假装测出来。
import { internals } from '../plugins/autonomous/index.js';
// 4.0 / 1.5.4 修：日期必须用**本地时区**。原来用 toISOString().slice(0,10)（UTC），
// 北京 00:00~08:00 期间和代码里的本地日期对不上，测试会凭空失败（2026-11-01 02:05 实测）。
const p2 = (n) => String(n).padStart(2, '0');
const _now = new Date();
const TODAY = `${_now.getFullYear()}-${p2(_now.getMonth() + 1)}-${p2(_now.getDate())}`;
const THIS_MONTH = TODAY.slice(0, 7);

import { validateDecision } from '../plugins/autonomous/lib/planner.js';
import { gate } from '../plugins/autonomous/lib/usage.js';

const { applySelfWake, MAX_ACTIONS_SAFETY } = internals;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};
const mkSt = () => ({});

console.log('【1. 自主预约：边界】');
{
  const st = mkSt();
  ok('30 分钟可以', applySelfWake(st, 30, '想接着看') === true);
  ok('预约写进 selfWake', st.selfWake?.enabled === true && st.selfWake.reason === '想接着看');
  const at = st.selfWake.wakeAt - Date.now();
  ok('时间点约等于 30 分钟后', at > 29 * 60000 && at <= 30 * 60000 + 2000, String(at));

  const st2 = mkSt();
  ok('29 分钟被拒（下限 30）', applySelfWake(st2, 29, 'x') === false && !st2.selfWake);
  ok('1441 分钟被拒（上限 24h）', applySelfWake(mkSt(), 1441, 'x') === false);
  ok('1440 分钟可以', applySelfWake(mkSt(), 1440, 'x') === true);
  ok('非数字被拒', applySelfWake(mkSt(), 'abc', 'x') === false);
}

console.log('\n【2. 每天最多 4 次，且新约覆盖旧约】');
{
  const st = mkSt();
  for (let i = 1; i <= 4; i += 1) applySelfWake(st, 60 * i, `第${i}次`);
  ok('前 4 次都成功', Number(st.selfWakeCount[Object.keys(st.selfWakeCount)[0]]) === 4, JSON.stringify(st.selfWakeCount));
  ok('第 4 次的理由留下了', st.selfWake.reason === '第4次');
  const kept = st.selfWake.wakeAt;
  ok('第 5 次被拒', applySelfWake(st, 120, '第5次') === false);
  ok('被拒时原预约没被改', st.selfWake.wakeAt === kept);
}

console.log('\n【3. 模型输出里的 wakeAfterMinutes】');
{
  const a = validateDecision({ action: 'finish', wakeAfterMinutes: 45 }, 3);
  ok('45 分钟被接受', a.wakeAfterMinutes === 45, String(a.wakeAfterMinutes));
  ok('小于 30 归零（当作没约）', validateDecision({ action: 'finish', wakeAfterMinutes: 5 }, 3).wakeAfterMinutes === 0);
  ok('大于 1440 归零', validateDecision({ action: 'finish', wakeAfterMinutes: 5000 }, 3).wakeAfterMinutes === 0);
  ok('不填就是 0', validateDecision({ action: 'finish' }, 3).wakeAfterMinutes === 0);
  ok('小数被取整', validateDecision({ action: 'finish', wakeAfterMinutes: 90.7 }, 3).wakeAfterMinutes === 90);
}

console.log('\n【4. 预算闸门：不卡次数，但卡钱】');
{
  const usage = {
    days: { [TODAY]: { calls: 999, input_tokens: 0, output_tokens: 0, estimated_cost_yuan: 0 } },
    monthKey: THIS_MONTH,
    version: 1
  };
  const noCap = gate(usage, { maxCallsPerDay: null });
  ok('999 次也不拦', noCap.ok === true, JSON.stringify(noCap));
  const withCap = gate(usage, { maxCallsPerDay: 40 });
  ok('显式传上限时仍然拦', withCap.ok === false, JSON.stringify(withCap));

  const thisMonth = THIS_MONTH;
  const broke = {
    days: { [`${thisMonth}-01`]: { calls: 3, input_tokens: 0, output_tokens: 0, estimated_cost_yuan: 5 } },
    monthKey: thisMonth,
    budgetYuan: 5,
    version: 1
  };
  const noMoney = gate(broke, { maxCallsPerDay: null });
  ok('钱花完照样拦（费用保护保留）', noMoney.ok === false, JSON.stringify(noMoney));
}

console.log('\n【5. 安全上限是个保险，不是常规限制】');
{
  ok('安全上限 >= 6（正常轮次远用不到）', MAX_ACTIONS_SAFETY >= 6, String(MAX_ACTIONS_SAFETY));
  ok('安全上限不是 2（否则等于退回 2.1）', MAX_ACTIONS_SAFETY > 2);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
