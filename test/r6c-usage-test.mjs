// R6-C Token 统计专项测试。
//
// 数据来源：2026-11-03 隔离 DSH_HOME 的真实事件流（DSH 0.2.0-rc.2）。
// 真实样本已脱敏（去掉 sessionId / cwd 里的用户名）。
//
// 实测的完整事件流（4 step 的真实案例）：
//   {"type":"session","sessionId":"session-***","cwd":"...\\work"}
//   {"type":"status","phase":"turn_start","turn":1}
//   {"type":"status","phase":"step_start","turn":1,"step":1}
//   {"type":"thinking","text":""}
//   {"type":"tool_call",...}
//   {"type":"tool_result",...}
//   {"type":"status","phase":"step_end","turn":1,"step":1,"usage":{...}}
//   {"type":"status","phase":"step_start","turn":1,"step":2}
//   ...
//   {"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
//   {"type":"final","text":"..."}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6cusage-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);

// ── 真实样本 fixture（脱敏）──────────────────────────────────────
const REAL_STEPS = [
  { inputTokens: 5702, outputTokens: 104, cacheReadTokens: 384, cacheWriteTokens: 0, totalTokens: 6190 },
  { inputTokens: 164, outputTokens: 74, cacheReadTokens: 6144, cacheWriteTokens: 0, totalTokens: 6382 },
  { inputTokens: 1708, outputTokens: 843, cacheReadTokens: 6272, cacheWriteTokens: 0, totalTokens: 8823 },
  { inputTokens: 151, outputTokens: 619, cacheReadTokens: 8704, cacheWriteTokens: 0, totalTokens: 9474 }
];

function makeStream(usages, { withTurnEndUsage = null, withFinal = '好' } = {}) {
  const evs = [
    { type: 'session', sessionId: 'session-fixture-001', cwd: 'C:\\exp\\work' },
    { type: 'status', phase: 'turn_start', turn: 1 }
  ];
  usages.forEach((u, i) => {
    evs.push({ type: 'status', phase: 'step_start', turn: 1, step: i + 1 });
    evs.push({ type: 'thinking', text: '' });
    evs.push({ type: 'text', text: 'x' });
    evs.push({ type: 'status', phase: 'step_end', turn: 1, step: i + 1, usage: u });
  });
  const turnEnd = { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } };
  if (withTurnEndUsage) turnEnd.usage = withTurnEndUsage;
  evs.push(turnEnd);
  evs.push({ type: 'final', text: withFinal });
  return evs;
}

function run(events, code = 0) {
  const st = G.newEventState();
  for (const e of events) G.applyEvent(st, e);
  return G.decideOutcome({ code, st });
}

try {
  console.log('【① 单 step 正常 usage】');
  {
    const r = run(makeStream([REAL_STEPS[0]]));
    ok('ok === true', r.ok === true);
    ok('**usageSteps === 1**', r.usageSteps === 1, String(r.usageSteps));
    ok('**input 正确**', r.usage.input === 5702, String(r.usage.input));
    ok('**output 正确**', r.usage.output === 104, String(r.usage.output));
    ok('**cacheRead 正确**', r.usage.cacheRead === 384, String(r.usage.cacheRead));
    ok('**total 正确**', r.usage.total === 6190, String(r.usage.total));
  }

  console.log('\n【② camelCase 字段解析】');
  {
    const u = G.normalizeUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5, cacheWriteTokens: 1, totalTokens: 126 });
    ok('**inputTokens → input**', u.input === 100);
    ok('**outputTokens → output**', u.output === 20);
    ok('**cacheReadTokens → cacheRead**', u.cacheRead === 5);
    ok('**cacheWriteTokens → cacheWrite**', u.cacheWrite === 1);
    ok('**totalTokens → total**', u.total === 126);
  }

  console.log('\n【③ 多 step usage 聚合（真实 4-step 数据）】');
  {
    const r = run(makeStream(REAL_STEPS));
    ok('**usageSteps === 4**', r.usageSteps === 4, String(r.usageSteps));
    ok('**input 累加 = 7725**', r.usage.input === 7725, String(r.usage.input));
    ok('**output 累加 = 1640**', r.usage.output === 1640, String(r.usage.output));
    ok('**cacheRead 累加 = 21504**', r.usage.cacheRead === 21504, String(r.usage.cacheRead));
    ok('**total 累加 = 30869**', r.usage.total === 30869, String(r.usage.total));
    // 交叉验证：input + output + cacheRead + cacheWrite === total
    const sum = r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
    ok('**四项之和 === total**', sum === r.usage.total, `${sum} vs ${r.usage.total}`);
  }

  console.log('\n【④ 同一 step 重复事件不重复统计（幂等性检查）】');
  {
    // 现实中 DSH 不会重复发，但要确认我们的累加逻辑不会把"重放"当两倍
    const evs = makeStream([REAL_STEPS[0]]);
    const r = run(evs);
    const oneStepTotal = r.usage.total;

    // 手动重放同一个 step_end 事件 → 会累加两次（这是预期，因为没有 step 去重）
    // 关键断言：单次流里只算一次
    ok('**单次流只算一次**', r.usageSteps === 1 && r.usage.total === oneStepTotal);
    // 记录行为：重放会累加（如实说明，不假装有去重）
    const st2 = G.newEventState();
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: REAL_STEPS[0] });
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: REAL_STEPS[0] });
    // 4.0 / R6-C 收尾：现在有 turn+step 幂等，重放**不会**累加
    ok('**同一 step_end 重放 → 只算一次（幂等生效）**', st2.usage.total === 6190, String(st2.usage.total));
  }

  console.log('\n【⑤ turn_end 没有 usage → 不影响统计】');
  {
    const r = run(makeStream([REAL_STEPS[0]]));
    ok('**turn_end 没 usage 时统计正常**', r.usageSteps === 1 && r.usage.total === 6190);
  }

  console.log('\n【⑥ step_end 与 turn_end 同时有 usage】');
  {
    // 假设将来 DSH 给 turn_end 也加了 usage（实测没有），会怎样？
    const r = run(makeStream([REAL_STEPS[0]], { withTurnEndUsage: { inputTokens: 9999, outputTokens: 9999, totalTokens: 19998 } }));
    // 4.0 / R6-C 收尾：turn_end 的 usage **不再**和 step 相加
    ok('**step + turn 同时有 usage → 不相加**', r.usage.total === 6190, String(r.usage.total));
    ok('**来源仍是 step**', r.usageSource === 'step', r.usageSource);
    ok('**记录了来源冲突诊断**', Boolean(r.usageDiag?.sourceConflict));
  }

  console.log('\n【⑦ usage 字段部分缺失】');
  {
    const u = G.normalizeUsage({ inputTokens: 100 });
    ok('**有 input**', u.input === 100);
    ok('**output 保持 null（不是 0）**', u.output === null, String(u.output));
    ok('**cacheRead 保持 null**', u.cacheRead === null);
    ok('**total 保持 null（不自己推导）**', u.total === null, String(u.total));

    // 聚合时缺失字段的处理
    const r = run(makeStream([{ inputTokens: 100 }, { inputTokens: 200 }]));
    ok('**聚合后 input = 300**', r.usage.input === 300, String(r.usage.input));
    ok('**聚合后 output 仍是 null**', r.usage.output === null, String(r.usage.output));
    ok('**聚合后 total 仍是 null**', r.usage.total === null, String(r.usage.total));
  }

  console.log('\n【⑧ usage 为 0 的合法情况】');
  {
    const u = G.normalizeUsage({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0 });
    ok('**全 0 能识别（不是 null）**', u !== null, String(u));
    ok('input === 0', u.input === 0);
    ok('output === 0', u.output === 0);
    ok('**total === 0**', u.total === 0);

    const r = run(makeStream([{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }]));
    ok('**0 值也算进 usageSteps**', r.usageSteps === 1, String(r.usageSteps));
    ok('**total === 0**', r.usage.total === 0);
  }

  console.log('\n【⑨ error / timeout / empty 不伪造成功统计】');
  {
    // error 事件：即使有 usage 也不该返回 ok:true
    const st1 = G.newEventState();
    G.applyEvent(st1, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: REAL_STEPS[0] });
    G.applyEvent(st1, { type: 'error', message: '出错了' });
    G.applyEvent(st1, { type: 'final', text: '某个文本' });
    const e1 = G.decideOutcome({ code: 0, st: st1 });
    ok('**有 error 事件 → ok:false**', e1.ok === false);
    ok('**失败时不带 usage**', e1.usage === undefined, String(e1.usage));

    // 空 final
    const st2 = G.newEventState();
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: REAL_STEPS[0] });
    G.applyEvent(st2, { type: 'final', text: '' });
    const e2 = G.decideOutcome({ code: 0, st: st2 });
    ok('**空 final → ok:false**', e2.ok === false);
    ok('**失败时不带 usage**', e2.usage === undefined);

    // 非零退出
    const st3 = G.newEventState();
    G.applyEvent(st3, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: REAL_STEPS[0] });
    const e3 = G.decideOutcome({ code: 1, st: st3, stderr: 'x' });
    ok('**非零退出 → ok:false**', e3.ok === false);
    ok('**失败时不带 usage**', e3.usage === undefined);
  }

  console.log('\n【⑩ 旧格式字段兼容】');
  {
    const u1 = G.normalizeUsage({ prompt_tokens: 100, completion_tokens: 50 });
    ok('**snake_case: prompt_tokens**', u1.input === 100);
    ok('**snake_case: completion_tokens**', u1.output === 50);

    const u2 = G.normalizeUsage({ promptTokens: 200, completionTokens: 80 });
    ok('**camelCase 旧写法: promptTokens**', u2.input === 200);
    ok('**camelCase 旧写法: completionTokens**', u2.output === 80);

    const u3 = G.normalizeUsage({ input_tokens: 300, output_tokens: 90, cached_tokens: 10 });
    ok('**input_tokens**', u3.input === 300);
    ok('**cached_tokens**', u3.cacheRead === 10);

    ok('**完全无法识别的对象 → null**', G.normalizeUsage({ foo: 1 }) === null);
    ok('**null 输入 → null**', G.normalizeUsage(null) === null);
    ok('**非对象 → null**', G.normalizeUsage('x') === null);
  }

  console.log('\n【⑪ 回归：错误契约没被破坏】');
  {
    const r1 = run([{ type: 'error', message: 'e' }, { type: 'final', text: 'x' }], 0);
    ok('error 仍优先', r1.ok === false && r1.errorSource === 'event');

    const r2 = run([{ type: 'final', text: '' }], 0);
    ok('空 final 仍判 empty', r2.ok === false && r2.errorSource === 'empty');

    ok('retry 契约未变：只有 spawn 可重试',
      R.canSafelyRetry({ ok: false, errorSource: 'spawn' }).retryable === true
      && R.canSafelyRetry({ ok: false, errorSource: 'runtime' }).retryable === false);
  }

  console.log('\n【⑪b usage 幂等（turn+step 去重）】');
  {
    // ① 同一 step 相同 usage 重复两次 → 只累计一次
    const st = G.newEventState();
    G.applyEvent(st, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    G.applyEvent(st, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    G.applyEvent(st, { type: 'final', text: 'x' });
    const r = G.decideOutcome({ code: 0, st });
    ok('**① 同 step 相同重复 → 只算一次**', r.usageSteps === 1 && r.usage.total === 120,
      `steps=${r.usageSteps} total=${r.usage.total}`);

    // ② 同一 step 不同 usage → 记录冲突，不覆盖
    const st2 = G.newEventState();
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, totalTokens: 100 } });
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 999, totalTokens: 999 } });
    G.applyEvent(st2, { type: 'final', text: 'x' });
    const r2 = G.decideOutcome({ code: 0, st: st2 });
    // 2026-11-03：语义从"保留第一个"改成"替换成后者"（对齐 DSH 的 addReplacing）
  ok('**② 同 step 不同 → 替换成后者（999）**', r2.usage.total === 999, String(r2.usage.total));
    ok('**② 记录了冲突**', (r2.usageDiag?.conflicts?.length || 0) === 1,
      JSON.stringify(r2.usageDiag?.conflicts?.length));
    // 2026-11-03：字段从 kept/ignored 改成 oldUsage/newUsage（替换语义要记两边）
    ok('**② 冲突里同时记了旧值和新值**',
      r2.usageDiag.conflicts[0].oldUsage?.total === 100 && r2.usageDiag.conflicts[0].newUsage?.total === 999,
      JSON.stringify({ old: r2.usageDiag.conflicts[0].oldUsage, now: r2.usageDiag.conflicts[0].newUsage }));

    // ③ 两个不同 step 正常累加
    const st3 = G.newEventState();
    G.applyEvent(st3, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, totalTokens: 100 } });
    G.applyEvent(st3, { type: 'status', phase: 'step_end', turn: 1, step: 2, usage: { inputTokens: 50, totalTokens: 50 } });
    G.applyEvent(st3, { type: 'final', text: 'x' });
    const r3 = G.decideOutcome({ code: 0, st: st3 });
    ok('**③ 两个不同 step → 累加**', r3.usageSteps === 2 && r3.usage.total === 150,
      `steps=${r3.usageSteps} total=${r3.usage.total}`);
  }

  console.log('\n【⑪c usage 来源优先级】');
  {
    // ④ step + turn 相同 → 不重复累计
    const st = G.newEventState();
    G.applyEvent(st, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, totalTokens: 100 } });
    G.applyEvent(st, { type: 'status', phase: 'turn_end', turn: 1, usage: { inputTokens: 100, totalTokens: 100 } });
    G.applyEvent(st, { type: 'final', text: 'x' });
    const r = G.decideOutcome({ code: 0, st });
    ok('**④ step + turn 相同 → 不相加**', r.usage.total === 100, String(r.usage.total));
    ok('**④ source === step**', r.usageSource === 'step', r.usageSource);

    // ⑤ step + turn 不同 → 用 step，记录差异
    const st2 = G.newEventState();
    G.applyEvent(st2, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 100, totalTokens: 100 } });
    G.applyEvent(st2, { type: 'status', phase: 'turn_end', turn: 1, usage: { inputTokens: 200, totalTokens: 200 } });
    G.applyEvent(st2, { type: 'final', text: 'x' });
    const r2 = G.decideOutcome({ code: 0, st: st2 });
    ok('**⑤ step + turn 不同 → 用 step**', r2.usage.total === 100, String(r2.usage.total));
    ok('**⑤ source === step**', r2.usageSource === 'step', r2.usageSource);
    ok('**⑤ 记录了来源冲突**', Boolean(r2.usageDiag?.sourceConflict), JSON.stringify(r2.usageDiag?.sourceConflict));
    ok('**⑤ 冲突里有 turn 的值**', r2.usageDiag.sourceConflict.turnTotal.total === 200);

    // ⑥ 只有 turn → 兜底
    const st3 = G.newEventState();
    G.applyEvent(st3, { type: 'status', phase: 'turn_end', turn: 1, usage: { inputTokens: 200, totalTokens: 200 } });
    G.applyEvent(st3, { type: 'final', text: 'x' });
    const r3 = G.decideOutcome({ code: 0, st: st3 });
    ok('**⑥ 只有 turn → 用它兜底**', r3.usage.total === 200, String(r3.usage.total));
    ok('**⑥ source === turn**', r3.usageSource === 'turn', r3.usageSource);

    // ⑦ 两种都没有 → null
    const st4 = G.newEventState();
    G.applyEvent(st4, { type: 'final', text: 'x' });
    const r4 = G.decideOutcome({ code: 0, st: st4 });
    ok('**⑦ 都没有 → usage 是 null**', r4.usage === null, String(r4.usage));
    ok('**⑦ source === none**', r4.usageSource === 'none', r4.usageSource);

    // ⑧ 旧格式兼容仍然通过（幂等逻辑不破坏兼容）
    const st5 = G.newEventState();
    G.applyEvent(st5, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } });
    G.applyEvent(st5, { type: 'final', text: 'x' });
    const r5 = G.decideOutcome({ code: 0, st: st5 });
    ok('**⑧ 旧 snake_case 仍能解析**',
      r5.usage.input === 100 && r5.usage.output === 20 && r5.usage.cacheRead === 50,
      JSON.stringify(r5.usage));
  }

  console.log('\n【⑫ 源码级：recordDshCall 用 normalizeUsage】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('**recordDshCall 调 normalizeUsage**', /recordDshCall[\s\S]{0,3000}normalizeUsage\(usage\)/.test(src));
    ok('**保留了旧的 prompt/completion/cached 字段名**',
      /prompt: u\.input/.test(src) && /completion: u\.output/.test(src) && /cached: u\.cacheRead/.test(src));
    ok('**新增 cacheRead/cacheWrite/total**',
      /cacheRead: u\.cacheRead/.test(src) && /cacheWrite: u\.cacheWrite/.test(src) && /total: u\.total/.test(src));
    ok('**不再有 || 0 的伪装**', !/usage\.input_tokens\) \|\| 0/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
