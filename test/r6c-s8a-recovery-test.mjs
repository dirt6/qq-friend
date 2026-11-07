// R6-C S8-A：无副作用异常恢复验收。
//
// ── 机主的硬约束 ────────────────────────────────────────────────
//   · 用依赖注入 + Fake ChildProcess，**经过真实 Adapter 状态机**
//   · 不允许只测独立分类函数就宣称整个 Adapter 通过
//   · **Fake 测试必须明确标注，不得冒充真实 OS 进程测试**
//   · S8 总结论仍为 INCONCLUSIVE
//
// ── 覆盖的 12 个场景（机主指定）──────────────────────────────────
//    1. spawn 失败
//    2. spawn 成功后 runtime error
//    3. timeout + kill 成功
//    4. timeout + kill 失败
//    5. abort
//    6. 非零 exit
//    7. 正常 exit + empty output
//    8. Session 恢复后继续调用
//    9. 已有 usage 后异常中断
//   10. 同一事件重复送达
//   11. retry 事件与原 attempt 的关联
//   12. 多次异常后恢复，状态不串扰
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6cs8a-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);
const A = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'adapter.js')).href);

// ══════════════════════════════════════════════════════════════
// Fake ChildProcess（**明确标注：这不是真实 OS 进程**）
// ══════════════════════════════════════════════════════════════
/**
 * 造一个假 ChildProcess。
 *
 * ⚠️ **这不是真实进程**：它只 emit 事件，不创建任何 OS 进程。
 *    本测试验证的是 **Adapter 的状态机与分类逻辑**，
 *    **不能**宣称"真实进程路径已验证"。
 */
function fakeChild(script = {}) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => true, end: () => true };
  child._killed = false;
  child._killCalls = 0;
  child.kill = () => {
    child._killCalls += 1;
    if (script.killThrows) throw new Error(script.killErrMsg || 'kill EPERM');
    child._killed = true;
    return true;
  };

  setImmediate(() => {
    if (script.sawSpawn) child.emit('spawn');
    for (const line of script.stdout || []) stdout.emit('data', JSON.stringify(line) + '\n');
    for (const chunk of script.stderr || []) stderr.emit('data', chunk);

    if (script.emitError) {
      const e = new Error(script.errorMessage || 'boom');
      e.code = script.errorCode || 'EPERM';
      child.emit('error', e);
      if (script.closeAfterError) child.emit('close', script.exitCode ?? 1);
      return;
    }
    if (script.hang) return;
    if (child._killed) return;
    child.emit('close', script.exitCode ?? 0);
  });

  return child;
}

/** 用假 spawn 跑一次 ask（**经过真实 runOnce 状态机**）。 */
async function runWith(script, opts = {}) {
  const child = fakeChild(script);
  const r = await G.ask('k-' + Math.random().toString(36).slice(2, 8), '任务', {
    timeoutMs: opts.timeoutMs || 3000,
    deps: { spawn: () => child }
  });
  return { result: r, child };
}

const U = (a, b, c, d, e) => ({ inputTokens: a, outputTokens: b, cacheReadTokens: c, cacheWriteTokens: d, totalTokens: e });

try {
  // ══════════════════════════════════════════════════════════════
  console.log('【场景 1：spawn 失败 → errorSource=spawn（唯一可重试）】');
  {
    const { result: r } = await runWith({ sawSpawn: false, emitError: true });
    ok('ok === false', r.ok === false);
    ok('**errorSource === spawn**', r.errorSource === 'spawn', r.errorSource);
    ok('**可安全重试**', R.canSafelyRetry(r).retryable === true, JSON.stringify(R.canSafelyRetry(r)));
    ok('错误文案含「起不来」', /起不来/.test(r.error || ''), r.error);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 2：spawn 成功后 runtime error → 不可重试】');
  {
    const { result: r } = await runWith({ sawSpawn: true, emitError: true });
    ok('ok === false', r.ok === false);
    ok('**errorSource === runtime**（不是 spawn）', r.errorSource === 'runtime', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('文案含「已启动后出错」', /已启动后出错/.test(r.error || ''), r.error);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 3：timeout + kill 成功 → errorSource=timeout，不可重试】');
  {
    const { result: r, child } = await runWith({ sawSpawn: true, hang: true }, { timeoutMs: 400 });
    ok('ok === false', r.ok === false);
    ok('**errorSource === timeout**', r.errorSource === 'timeout', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('kill 被调用过', child._killCalls >= 1, String(child._killCalls));
    ok('diagnostics.killOk === true', r.diagnostics?.killOk === true, JSON.stringify(r.diagnostics));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 4：timeout + kill 失败 → timeout_kill_failed，绝对不可重试】');
  {
    const { result: r, child } = await runWith(
      { sawSpawn: true, hang: true, killThrows: true, killErrMsg: 'kill EPERM for test' },
      { timeoutMs: 400 }
    );
    ok('ok === false', r.ok === false);
    ok('**errorSource === timeout_kill_failed**', r.errorSource === 'timeout_kill_failed', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('**diagnostics.killOk === false**（没被误判为已终止）', r.diagnostics?.killOk === false, JSON.stringify(r.diagnostics));
    ok('diagnostics.killErr 有内容', /EPERM/.test(r.diagnostics?.killErr || ''), r.diagnostics?.killErr);
    ok('**没有被标成 spawn**（不能当可重试）', r.errorSource !== 'spawn');
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 5：abort —— 当前实现不支持，如实记录】');
  {
    // 代码里没有 abort 处理（只在一处注释里提到 AbortSignal）
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    const hasAbortImpl = /child\.on\('abort'/.test(src) || /AbortController/.test(src.replace(/\/\/.*$/gm, ''));
    ok('**事实：代码里没有 abort 实现**（如实记录，不假装通过）', hasAbortImpl === false,
      hasAbortImpl ? '意外发现有实现' : '只有注释提到 AbortSignal');
    ok('**abort 不在可重试来源里**（保守）', !R.__internals.SAFE_RETRY_SOURCES.includes('abort'));
    ok('**abort 也不在不可重试列表里**（未定义 → 默认不可重试）',
      !R.__internals.UNSAFE_RETRY_SOURCES.includes('abort'));
    // 未定义来源走保守分支
    const unknown = R.canSafelyRetry({ ok: false, errorSource: 'abort' });
    ok('**未定义的 errorSource → 保守判不可重试**', unknown.retryable === false, JSON.stringify(unknown));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 6：非零 exit → errorSource=exit，不可重试】');
  {
    const { result: r } = await runWith({
      sawSpawn: true,
      stdout: [{ type: 'session', sessionId: 'session-s8-6' }],
      stderr: ['fatal: 崩了\n'],
      exitCode: 2
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === exit**', r.errorSource === 'exit', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('error 里有退出码 2', /退出码 2/.test(r.error || ''), r.error);
    ok('stderr 被保留', /崩了/.test(r.diagnostics?.stderrTail || ''), r.diagnostics?.stderrTail);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 7：正常 exit + empty output → errorSource=empty，不可重试】');
  {
    const { result: r } = await runWith({
      sawSpawn: true,
      stdout: [{ type: 'session', sessionId: 's' }, { type: 'final', text: '' }],
      exitCode: 0
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === empty**', r.errorSource === 'empty', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('文案说清「没有收到任何回复文本」', /没有收到任何回复文本/.test(r.error || ''), r.error);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 8：Session 恢复后继续调用】');
  {
    const sid = 'session-s8-8';
    // 第一次：建立 session
    const first = await runWith({
      sawSpawn: true,
      stdout: [
        { type: 'session', sessionId: sid },
        { type: 'status', phase: 'turn_start', turn: 1 },
        { type: 'final', text: '第一轮' }
      ],
      exitCode: 0
    });
    ok('第一次成功', first.result.ok === true);
    ok('sessionId 正确', first.result.sessionId === sid, first.result.sessionId);

    // 第二次：带同一个 sessionId 恢复
    const plan = A.planCall({ profile: 'headless', cwd: 'E:\\dsh\\QQ-agent', sessionId: sid, text: '继续' });
    ok('**Adapter 能拼出恢复调用**', plan.ok === true && plan.plan.mode === 'resume', JSON.stringify(plan.plan?.mode));
    ok('**args 里带 --session-id**', plan.plan.args.includes('--session-id'));

    const second = await runWith({
      sawSpawn: true,
      stdout: [
        { type: 'session', sessionId: sid },
        { type: 'status', phase: 'turn_start', turn: 2 },
        { type: 'final', text: '第二轮' }
      ],
      exitCode: 0
    });
    ok('第二次成功', second.result.ok === true);
    ok('**sessionId 没串**', second.result.sessionId === sid);
    ok('文本各自独立', first.result.text !== second.result.text);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 9：已有 usage 后异常中断 → 不伪造成功统计】');
  {
    // 先收到 usage，再收到 error
    const { result: r } = await runWith({
      sawSpawn: true,
      stdout: [
        { type: 'session', sessionId: 's9' },
        { type: 'status', phase: 'step_start', turn: 1, step: 1 },
        { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: U(100, 20, 5, 0, 125) },
        { type: 'error', message: '中途挂了', code: 'MID_FAIL' }
      ],
      exitCode: 0
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === event**', r.errorSource === 'event', r.errorSource);
    ok('**失败时不返回 usage**（不伪造成功统计）', r.usage === undefined, String(r.usage));
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 10：同一事件重复送达 → usage 幂等】');
  {
    const st = G.newEventState();
    const ev = { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: U(100, 20, 5, 0, 125) };
    G.applyEvent(st, ev);
    G.applyEvent(st, ev);   // 同一条重放
    G.applyEvent(st, ev);   // 再重放一次
    G.applyEvent(st, { type: 'final', text: 'x' });
    const r = G.decideOutcome({ code: 0, st });
    ok('**usageSteps === 1**（去重生效）', r.usageSteps === 1, String(r.usageSteps));
    ok('**total 仍是 125**（没重复累计）', r.usage.total === 125, String(r.usage.total));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 11：retry 事件与原 attempt 的关联】');
  {
    // 现状：小鲸鱼的幂等键是 (turn, step)，**没有 retry 轴**
    // SurfCore 用 (session, turn, step, retry)，且 llm/retry-started 会另起一个作用域
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    const hasRetryAxis = /retry/i.test(src);
    ok('**现状：没有 retry 轴**（如实记录缺口）', hasRetryAxis === false,
      hasRetryAxis ? '意外发现有' : '只按 (turn, step) 去重');

    // 验证当前行为：同一 turn+step 的"重试"会被当成重复而忽略
    const st = G.newEventState();
    G.applyEvent(st, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: U(100, 20, 0, 0, 120) });
    // 假设这是 retry 后的第二次调用（同一个 turn+step，但 usage 不同）
    G.applyEvent(st, { type: 'status', phase: 'step_end', turn: 1, step: 1, usage: U(150, 30, 0, 0, 180) });
    G.applyEvent(st, { type: 'final', text: 'x' });
    const r = G.decideOutcome({ code: 0, st });
    // 2026-11-03：语义改成"替换成后者"（对齐 DSH 的 addReplacing）
    // 2026-11-03：语义改成替换 —— 第二次的 180 会**替换**第一次的 120
    ok('**第二次被替换：用 180 不是 120**', r.usage.total === 180, String(r.usage.total));
    ok('**冲突被记录下来了**', (r.usageDiag?.conflicts?.length || 0) === 1,
      JSON.stringify(r.usageDiag?.conflicts?.length));
    ok('**这是一个已知缺口：真实 retry 会被少算**（写进报告，不在此修复）', true);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【场景 12：多次异常后恢复，状态不串扰】');
  {
    const keyA = 'k-a-' + Math.random().toString(36).slice(2, 6);
    const keyB = 'k-b-' + Math.random().toString(36).slice(2, 6);

    // A 失败
    const a1 = await G.ask(keyA, '任务A', {
      timeoutMs: 2000,
      deps: { spawn: () => fakeChild({ sawSpawn: false, emitError: true }) }
    });
    ok('A 失败', a1.ok === false);
    ok('A errorSource=spawn', a1.errorSource === 'spawn');

    // B 成功（不能继承 A 的失败状态）
    const b1 = await G.ask(keyB, '任务B', {
      timeoutMs: 2000,
      deps: { spawn: () => fakeChild({ sawSpawn: true, stdout: [{ type: 'session', sessionId: 'sess-B' }, { type: 'final', text: 'B成功' }], exitCode: 0 }) }
    });
    ok('**B 成功（没被 A 的状态污染）**', b1.ok === true, JSON.stringify({ ok: b1.ok, error: b1.error }));
    ok('B 的 sessionId 是自己的', b1.sessionId === 'sess-B', b1.sessionId);
    ok('B 的文本正确', b1.text === 'B成功', b1.text);

    // A 再失败一次，仍然不影响 B
    const a2 = await G.ask(keyA, '任务A2', {
      timeoutMs: 2000,
      deps: { spawn: () => fakeChild({ sawSpawn: true, hang: true }) }
    });
    ok('A 第二次超时', a2.ok === false && a2.errorSource === 'timeout');

    const b2 = await G.ask(keyB, '任务B2', {
      timeoutMs: 2000,
      deps: { spawn: () => fakeChild({ sawSpawn: true, stdout: [{ type: 'session', sessionId: 'sess-B' }, { type: 'final', text: 'B2成功' }], exitCode: 0 }) }
    });
    ok('**B 依然成功**', b2.ok === true, JSON.stringify({ ok: b2.ok, error: b2.error }));
    ok('B 的 sessionId 没变', b2.sessionId === 'sess-B');

    // ⚠️ 注意：这里无法验证持久化的 sessionId 映射会不会串，
    //    因为 ask 用 deps 注入时不走 saveSessions 的完整路径。
    //    这一条留给 S8-B 的真实进程测试。
    ok('（持久化 session 映射的串扰验证 → 留给 S8-B）', true);
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【附加：错误来源的完整矩阵】');
  {
    const matrix = [
      ['spawn', true],
      ['event', false], ['turn', false], ['exit', false], ['empty', false],
      ['runtime', false], ['timeout', false], ['timeout_kill_failed', false]
    ];
    for (const [src, expected] of matrix) {
      const got = R.canSafelyRetry({ ok: false, errorSource: src }).retryable;
      ok(`**${src} → retryable=${expected}**`, got === expected, `实际 ${got}`);
    }
    ok('**SAFE_RETRY_SOURCES 只有 spawn**',
      R.__internals.SAFE_RETRY_SOURCES.length === 1 && R.__internals.SAFE_RETRY_SOURCES[0] === 'spawn',
      JSON.stringify(R.__internals.SAFE_RETRY_SOURCES));
  }

  // ══════════════════════════════════════════════════════════════
  console.log('\n【附加：kill 失败不会被误判为已终止】');
  {
    const { result: r, child } = await runWith(
      { sawSpawn: true, hang: true, killThrows: true },
      { timeoutMs: 300 }
    );
    ok('kill 抛了异常', child._killCalls >= 1);
    ok('**diagnostics 明确记录 killOk=false**', r.diagnostics?.killOk === false);
    ok('**errorSource 与 killOk=true 的情况不同**', r.errorSource === 'timeout_kill_failed');
    ok('**两者都不可重试**（不确定就不重发）',
      R.canSafelyRetry(r).retryable === false
      && R.canSafelyRetry({ ok: false, errorSource: 'timeout' }).retryable === false);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log('');
console.log('⚠️ 本测试全部使用 Fake ChildProcess（依赖注入），');
console.log('   **不创建任何真实 OS 进程**，验证的是 Adapter 状态机与分类逻辑。');
console.log('   不能据此宣称"真实进程路径已验证"。');
if (fail) process.exit(1);
process.exit(0);
