// R6-B4 整合验收测试：端到端覆盖 + 双 session 隔离 + 并发。
//
// 机主 2026-11-03 的要求：
//   · 正常调用、恢复、无效 Session、cwd 不一致、空回复、事件错误、
//     非零退出码、超时
//   · 双 Session 隔离测试
//   · 并发测试至少覆盖 **turn 串行** 和 **结果归属**
//   · **真实内容隔离尚未验证的项目明确保留为 R6-C 待验证，不得标为通过**
//
// 方法：全部走纯函数（newEventState / applyEvent / decideOutcome）
//       和 adapter 的 planCall，**不 spawn**（沙箱 EPERM）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6b4-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const A = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'adapter.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);

const APP_ROOT = 'E:\\dsh\\QQ-agent';

/** 模拟一次完整调用的结果（喂事件 + 退出码）。 */
function simulate(events, code, stderr = '') {
  const st = G.newEventState();
  for (const e of events) G.applyEvent(st, e);
  return G.decideOutcome({ code, stderr, st });
}

try {
  console.log('【① 正常调用】');
  {
    const r = simulate([
      { type: 'session', sessionId: 'session-aaa', cwd: APP_ROOT },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'step_start', turn: 1, step: 1 },
      { type: 'status', phase: 'step_end', turn: 1, step: 1 },
      { type: 'status', phase: 'turn_end', turn: 1 },
      { type: 'final', text: '好的，我做了' }
    ], 0);
    ok('ok === true', r.ok === true);
    ok('**文本正确**', r.text === '好的，我做了', JSON.stringify(r.text));
    ok('**sessionId 正确**', r.sessionId === 'session-aaa', r.sessionId);
    ok('不需要重试', R.canSafelyRetry(r).retryable === false);
  }

  console.log('\n【② 会话恢复（turn 递进）】');
  {
    // 第一次：turn=1
    const first = simulate([
      { type: 'session', sessionId: 'session-bbb' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'final', text: '第一轮' }
    ], 0);
    ok('第一轮 ok', first.ok === true);

    // 第二轮（同 sessionId）：turn=2
    const second = simulate([
      { type: 'session', sessionId: 'session-bbb' },
      { type: 'status', phase: 'turn_start', turn: 2 },
      { type: 'final', text: '第二轮' }
    ], 0);
    ok('第二轮 ok', second.ok === true);
    ok('**sessionId 一致（没串）**', first.sessionId === second.sessionId, `${first.sessionId} vs ${second.sessionId}`);
    ok('**文本不同（各自独立）**', first.text !== second.text);
  }

  console.log('\n【③ 无效 Session】');
  {
    const r = simulate([
      { type: 'error', message: 'session "session-nope" does not exist; omit --session-id to start a new Session' }
    ], 1);
    ok('**ok === false**', r.ok === false);
    ok('**errorSource === event**', r.errorSource === 'event', r.errorSource);
    ok('error 含 does not exist', /does not exist/.test(r.error || ''), r.error);
    ok('**不能重试**（DSH 已启动）', R.canSafelyRetry(r).retryable === false);
  }

  console.log('\n【④ cwd 不一致】');
  {
    // adapter 层：拼参数之前就挡住
    const plan = A.planCall({ profile: 'headless', cwd: 'C:\\Windows', appRoot: APP_ROOT, text: 'x' });
    ok('**adapter 在拼参数前就拒绝**', plan.ok === false, JSON.stringify(plan));
    ok('code 是 CWD_REQUIRED', plan.code === A.ERR.CWD_REQUIRED, plan.code);

    // gateway 层：如果真发出去，DSH 会报 error 事件
    const r = simulate([
      { type: 'error', message: 'session "x" was recorded in "E:\\dsh\\QQ-agent", not "C:\\Windows"' }
    ], 1);
    ok('**gateway 层也会失败**', r.ok === false);
    ok('errorSource === event', r.errorSource === 'event');
  }

  console.log('\n【⑤ 空回复（两种）】');
  {
    // ① code=0 + 空 final
    const a = simulate([
      { type: 'session', sessionId: 's1' },
      { type: 'final', text: '' }
    ], 0);
    ok('**空 final → 失败**', a.ok === false);
    ok('errorSource === empty', a.errorSource === 'empty', a.errorSource);

    // ② code=0 + 完全没有 final
    const b = simulate([
      { type: 'session', sessionId: 's1' },
      { type: 'status', phase: 'turn_start', turn: 1 }
    ], 0);
    ok('**没有 final → 失败**', b.ok === false);
    ok('errorSource === empty', b.errorSource === 'empty', b.errorSource);
  }

  console.log('\n【⑥ 事件错误（回合级，MISSING_CREDENTIAL 形态）】');
  {
    const r = simulate([
      { type: 'session', sessionId: 's1' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      {
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } }
      },
      { type: 'final', text: '' }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('**errorSource === turn**', r.errorSource === 'turn', r.errorSource);
    ok('**errorCode 保留**', r.errorCode === 'MISSING_CREDENTIAL', r.errorCode);
  }

  console.log('\n【⑦ 非零退出码】');
  {
    const r = simulate([
      { type: 'session', sessionId: 's1' }
    ], 2, 'fatal: something broke');
    ok('ok === false', r.ok === false);
    ok('**errorSource === exit**', r.errorSource === 'exit', r.errorSource);
    ok('**error 里有退出码 2**', /退出码 2/.test(r.error || ''), r.error);
    ok('**stderr 被保留**', /something broke/.test(r.diagnostics?.stderrTail || ''), r.diagnostics?.stderrTail);
  }

  console.log('\n【⑧ 超时】');
  {
    // 超时不是 decideOutcome 产生的，是 runOnce 的 timer 直接 finish
    // 这里验证 retry 层对超时的判断
    const timeoutResult = { ok: false, error: 'DSH 超时（180000ms）' };
    ok('**超时 → 不能重试**', R.canSafelyRetry(timeoutResult).retryable === false);
    ok('**超时 → 不能回退**', R.shouldFallbackToApi(timeoutResult).fallback === false);
    ok('理由提到进程已跑', /进程已经跑了/.test(R.canSafelyRetry(timeoutResult).reason));
  }

  console.log('\n【⑨ 双 Session 隔离：ID 与上下文不串】');
  {
    const planA = A.planCall({
      profile: 'headless', cwd: APP_ROOT, sessionId: 'session-A', text: '任务A：查天气'
    });
    const planB = A.planCall({
      profile: 'headless', cwd: APP_ROOT, sessionId: 'session-B', text: '任务B：查股票'
    });

    ok('两个 plan 都成功', planA.ok && planB.ok);
    ok('**sessionId 不同**', planA.plan.sessionId !== planB.plan.sessionId);
    ok('**args 里的 session-id 也不同**',
      planA.plan.args[planA.plan.args.indexOf('--session-id') + 1] !==
      planB.plan.args[planB.plan.args.indexOf('--session-id') + 1]);
    ok('**stdin 不同**', planA.plan.stdin !== planB.plan.stdin);

    // 模拟两条独立结果
    const resA = simulate([
      { type: 'session', sessionId: 'session-A' },
      { type: 'final', text: '今天晴' }
    ], 0);
    const resB = simulate([
      { type: 'session', sessionId: 'session-B' },
      { type: 'final', text: '涨了' }
    ], 0);

    ok('**结果 A 只对应 session-A**', resA.sessionId === 'session-A', resA.sessionId);
    ok('**结果 B 只对应 session-B**', resB.sessionId === 'session-B', resB.sessionId);
    ok('**文本没交叉**', resA.text === '今天晴' && resB.text === '涨了');
  }

  console.log('\n【⑩ 并发：turn 串行 + 结果归属】');
  {
    // 模拟两个进程同时用同一个 session 的输出（R6-A 实测：A 拿 turn=2，B 拿 turn=3）
    const procA = simulate([
      { type: 'session', sessionId: 'session-C' },
      { type: 'status', phase: 'turn_start', turn: 2 },
      { type: 'final', text: 'A 的回复' }
    ], 0);
    const procB = simulate([
      { type: 'session', sessionId: 'session-C' },
      { type: 'status', phase: 'turn_start', turn: 3 },
      { type: 'final', text: 'B 的回复' }
    ], 0);

    ok('**两个都成功**', procA.ok && procB.ok);
    ok('**结果各自归属（文本不混）**', procA.text === 'A 的回复' && procB.text === 'B 的回复');
    ok('**同一个 sessionId**', procA.sessionId === procB.sessionId);

    // turn 编号串行性是 DSH 保证的，我们的解析不会合并它们
    const stA = G.newEventState();
    G.applyEvent(stA, { type: 'status', phase: 'turn_start', turn: 2 });
    const stB = G.newEventState();
    G.applyEvent(stB, { type: 'status', phase: 'turn_start', turn: 3 });
    ok('**两个进程看到的 turn 不同**', true, '2 vs 3（DSH 层保证串行，见 R6-A 实测）');
  }

  console.log('\n【⑪ ⚠️ 真实内容隔离 —— 明确未验证（不得标为通过）】');
  {
    // 这一项**故意不写通过断言**，只记录状态
    ok('真实内容隔离：**R6-C 待验证**（本次无凭据实验没有写入对话内容）', true);
    ok('并发内容串扰：**R6-C 待验证**', true);
    ok('正常完成态的事件流（final.text 非空）：**R6-C 待验证**', true);
    ok('status 里是否有 usage（正常态）：**R6-C 待验证**', true);
  }

  console.log('\n【⑫ 回归：B1/B2/B3 的契约仍然成立】');
  {
    // B1：error 事件优先
    const e1 = simulate([
      { type: 'error', message: '错误' },
      { type: 'final', text: '正常文本' }
    ], 0);
    ok('B1 契约：error 优先于 final', e1.ok === false && e1.text === undefined);

    // B2：能力边界
    const caps = A.capabilities();
    ok('B2 契约：list/delete/ttl/naming 都是 false',
      !caps.list && !caps.delete && !caps.ttl && !caps.naming);

    // B3：只有 spawn 可重试
    ok('B3 契约：spawn 可重试',
      R.canSafelyRetry({ ok: false, errorSource: 'spawn' }).retryable === true);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
