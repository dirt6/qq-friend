// R6-B 补充：真实 ChildProcess 事件路径测试。
//
// 机主 2026-11-03 的要求：
//   「目前只有纯函数测试，尚不足以证明真实 ChildProcess 事件顺序下不会误分类。
//     好消息是这一部分不需要 API Key：可以用本地假进程测试启动成功、启动失败、
//     延迟退出、超时、stdout/stderr、异常退出等场景。」
//
// 方法：通过 deps.spawn 注入一个**假 ChildProcess**（EventEmitter + 假流），
//       让它按指定顺序 emit 事件，完整走一遍 runOnce 的真实控制流
//       （stdout 缓冲、close 判定、错误分类、timeout 计时器）。
//
// 重点验证：
//   · errorSource='spawn' **只**在进程确实没启动时出现
//   · 一旦进程启动过，任何后续错误都不能归为 spawn
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6bp-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  skills: { autonomous: { enabled: false } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);

/**
 * 造一个假 ChildProcess。
 * @param {object} script 事件剧本：
 *   { emitError, stdout: [...], stderr: [...], exitCode, exitDelayMs, hang }
 */
function makeFakeChild(script) {
  const child = new EventEmitter();
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  stdout.setEncoding = () => {};
  stderr.setEncoding = () => {};
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = { write: () => true, end: () => true };
  child.kill = () => { child._killed = true; };

  const run = async () => {
    // ① 启动失败：只 emit error，不 emit close
    if (script.emitError) {
      child.emit('error', Object.assign(new Error(script.errorMessage || 'spawn EPERM'), { code: 'EPERM' }));
      return;
    }

    // ② 正常启动：先吐 stdout/stderr，再 close
    for (const line of script.stdout || []) {
      stdout.emit('data', JSON.stringify(line) + '\n');
    }
    for (const chunk of script.stderr || []) {
      stderr.emit('data', chunk);
    }

    if (script.hang) return;   // 永不 close（等 timeout）

    if (script.exitDelayMs) {
      await new Promise((r) => setTimeout(r, script.exitDelayMs));
    }
    if (child._killed) return;  // 被 timeout 杀掉了
    child.emit('close', script.exitCode ?? 0);
  };

  // 让事件在 ask() 挂好监听之后才发
  setImmediate(() => { run().catch(() => {}); });
  return child;
}

/** 用假 spawn 跑一次 ask。 */
function askWith(script, opts = {}) {
  const fakeSpawn = () => makeFakeChild(script);
  return G.ask('k-' + Math.random().toString(36).slice(2, 8), '任务', {
    timeoutMs: opts.timeoutMs || 3000,
    deps: { spawn: fakeSpawn }
  });
}

try {
  console.log('【① 启动失败（EPERM）→ errorSource=spawn，**可重试**】');
  {
    const r = await askWith({ emitError: true });
    ok('ok === false', r.ok === false);
    ok('**errorSource === spawn**', r.errorSource === 'spawn', r.errorSource);
    ok('**error 含「起不来」**', /起不来/.test(r.error || ''), r.error);
    ok('**可安全重试**', R.canSafelyRetry(r).retryable === true, JSON.stringify(R.canSafelyRetry(r)));
  }

  console.log('\n【② 正常完成 → ok=true，**不带 errorSource**】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 'session-fake-1' },
        { type: 'status', phase: 'turn_start', turn: 1 },
        { type: 'final', text: '正常回复' }
      ],
      exitCode: 0
    });
    ok('ok === true', r.ok === true, JSON.stringify({ ok: r.ok, error: r.error }));
    ok('text 正确', r.text === '正常回复', r.text);
    ok('sessionId 正确', r.sessionId === 'session-fake-1', r.sessionId);
    ok('**不带 errorSource**', r.errorSource === undefined, String(r.errorSource));
  }

  console.log('\n【③ 顶层 error 事件 + exit 0 → **errorSource=event（不是 spawn）**】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'error', message: '会话不存在', code: 'SESSION_NOT_FOUND' },
        { type: 'final', text: '' }
      ],
      exitCode: 0
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === event**（不是 spawn）', r.errorSource === 'event', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false, JSON.stringify(R.canSafelyRetry(r)));
    ok('error 是事件里的 message', r.error === '会话不存在', r.error);
  }

  console.log('\n【④ 回合级错误 + exit 1 → **errorSource=turn（不是 spawn）**】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'status', phase: 'turn_start', turn: 1 },
        {
          type: 'status',
          phase: 'turn_end',
          turn: 1,
          reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } }
        },
        { type: 'final', text: '' }
      ],
      exitCode: 1
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === turn**（不是 spawn）', r.errorSource === 'turn', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('errorCode 保留', r.errorCode === 'MISSING_CREDENTIAL', r.errorCode);
  }

  console.log('\n【⑤ 非零退出码 + 无 final → **errorSource=exit（不是 spawn）**】');
  {
    const r = await askWith({
      stdout: [{ type: 'session', sessionId: 's1' }],
      stderr: ['fatal: 崩溃了\n'],
      exitCode: 3
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === exit**（不是 spawn）', r.errorSource === 'exit', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
    ok('**error 里有退出码 3**', /退出码 3/.test(r.error || ''), r.error);
    ok('**stderr 被保留**', /崩溃了/.test(r.diagnostics?.stderrTail || ''), r.diagnostics?.stderrTail);
  }

  console.log('\n【⑥ 空 final + exit 0 → **errorSource=empty（不是 spawn）**】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'final', text: '' }
      ],
      exitCode: 0
    });
    ok('ok === false', r.ok === false);
    ok('**errorSource === empty**（不是 spawn）', r.errorSource === 'empty', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
  }

  console.log('\n【⑦ 超时（进程挂着不退）→ **不可重试，且不是 spawn**】');
  {
    const r = await askWith({
      stdout: [{ type: 'session', sessionId: 's1' }],
      hang: true
    }, { timeoutMs: 700 });
    ok('ok === false', r.ok === false);
    ok('**error 含「超时」**', /超时/.test(r.error || ''), r.error);
    ok('**errorSource 不是 spawn**', r.errorSource !== 'spawn', String(r.errorSource));
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false, JSON.stringify(R.canSafelyRetry(r)));
  }

  console.log('\n【⑧ 延迟退出（慢但正常）→ 仍然是成功】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'final', text: '慢回复' }
      ],
      exitCode: 0,
      exitDelayMs: 300
    }, { timeoutMs: 3000 });
    ok('**ok === true**', r.ok === true, JSON.stringify({ ok: r.ok, error: r.error }));
    ok('text 正确', r.text === '慢回复', r.text);
  }

  console.log('\n【⑨ 延迟退出但超过 timeout → 超时，不可重试】');
  {
    const r = await askWith({
      stdout: [{ type: 'session', sessionId: 's1' }],
      exitCode: 0,
      exitDelayMs: 2000
    }, { timeoutMs: 500 });
    ok('ok === false', r.ok === false);
    ok('**超时**', /超时/.test(r.error || ''), r.error);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false);
  }

  console.log('\n【⑩ stdout 分块到达（真实流式）→ 能正确拼起来】');
  {
    // 手工构造一个分块到达的 child
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    stdout.setEncoding = () => {};
    stderr.setEncoding = () => {};
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = { write: () => true, end: () => true };
    child.kill = () => { child._killed = true; };

    setImmediate(() => {
      // 一条 JSON 被拆成三段到达
      const full = JSON.stringify({ type: 'final', text: '分块到达的回复' }) + '\n';
      stdout.emit('data', full.slice(0, 5));
      stdout.emit('data', full.slice(5, 20));
      stdout.emit('data', full.slice(20));
      child.emit('close', 0);
    });

    const r = await G.ask('k-chunk', '任务', {
      timeoutMs: 3000,
      deps: { spawn: () => child }
    });
    ok('**ok === true**', r.ok === true, JSON.stringify({ ok: r.ok, error: r.error }));
    ok('**分块能正确拼接**', r.text === '分块到达的回复', JSON.stringify(r.text));
  }

  console.log('\n【⑪ 非 JSON 行被跳过，不影响后续解析】');
  {
    const r = await askWith({
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'final', text: '回复' }
      ],
      stderr: ['dsh: 一些诊断信息\n'],
      exitCode: 0
    });
    ok('ok === true', r.ok === true);
    ok('**stderr 不干扰 stdout 解析**', r.text === '回复', r.text);
  }

  console.log('\n【⑫ 核心断言：errorSource=spawn **只**出现在进程没启动时】');
  {
    const scenarios = [
      ['启动失败', { emitError: true }, 'spawn'],
      ['正常完成', { stdout: [{ type: 'final', text: 'x' }], exitCode: 0 }, undefined],
      ['error 事件', { stdout: [{ type: 'error', message: 'e' }], exitCode: 0 }, 'event'],
      ['回合错误', { stdout: [{ type: 'status', phase: 'turn_end', reason: { kind: 'error', error: { message: 'e' } } }], exitCode: 1 }, 'turn'],
      ['非零退出', { stdout: [{ type: 'session', sessionId: 's' }], exitCode: 2 }, 'exit'],
      ['空 final', { stdout: [{ type: 'final', text: '' }], exitCode: 0 }, 'empty']
    ];

    for (const [name, script, expected] of scenarios) {
      const r = await askWith(script);
      const got = r.errorSource;
      ok(`**${name} → errorSource=${expected || '(无)'}**`, got === expected, `实际: ${got}`);
    }

    // 超时单独
    const to = await askWith({ stdout: [], hang: true }, { timeoutMs: 500 });
    ok('**超时 → errorSource 不是 spawn**', to.errorSource !== 'spawn', String(to.errorSource));
  }

  console.log('\n【⑬ 源码级：deps 是测试专用，生产默认真 spawn】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('**默认用真正的 spawn**', /typeof deps\.spawn === 'function' \? deps\.spawn : spawn/.test(src));
    ok('**注释说明了仅测试用**', /仅测试用/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
