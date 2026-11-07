// R6-C0 专项：spawn 边界与错误分类（真实 ChildProcess 事件路径）。
//
// 机主 2026-11-03 的四点要求：
//   ① 是否区分 ChildProcess 的 spawn 成功事件与 error 事件
//   ② spawn 成功后的 kill 失败 / AbortSignal / 运行期错误不得归为可重试的启动失败
//   ③ 启动失败的 error 与后续 close 不得重复结算
//   ④ 超时后 kill 失败不得触发安全重试
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6c0s-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);

/**
 * 造假 ChildProcess。
 * script.sawSpawn=true → 先 emit 'spawn'（模拟启动成功）
 * script.emitError    → emit 'error'
 * script.exitCode     → emit 'close'
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
  child._killed = false;
  child.kill = () => {
    if (script.killThrows) throw new Error('kill EPERM');
    child._killed = true;
  };

  setImmediate(() => {
    // ① 启动成功事件
    if (script.sawSpawn) child.emit('spawn');

    // ② 可选 stdout
    for (const line of script.stdout || []) {
      stdout.emit('data', JSON.stringify(line) + '\n');
    }

    // ③ 错误
    if (script.emitError) {
      const e = new Error(script.errorMessage || 'boom');
      e.code = script.errorCode || 'EPERM';
      child.emit('error', e);
      // 关键：error 之后**也可能**再 emit close（真实 Node 行为）
      if (script.closeAfterError) child.emit('close', script.exitCode ?? 1);
      return;
    }

    if (script.hang) return;
    if (child._killed) return;
    child.emit('close', script.exitCode ?? 0);
  });

  return child;
}

function askWith(script, opts = {}) {
  return G.ask('k-' + Math.random().toString(36).slice(2, 8), '任务', {
    timeoutMs: opts.timeoutMs || 3000,
    deps: { spawn: () => makeFakeChild(script) }
  });
}

try {
  console.log('【① didSpawn=false 的 error → errorSource=spawn（可重试）】');
  {
    const r = await askWith({ sawSpawn: false, emitError: true });
    ok('ok === false', r.ok === false);
    ok('**errorSource === spawn**', r.errorSource === 'spawn', r.errorSource);
    ok('**可重试**', R.canSafelyRetry(r).retryable === true, JSON.stringify(R.canSafelyRetry(r)));
  }

  console.log('\n【② ⚠️ didSpawn=true 的 error → errorSource=runtime（**不可重试**）】');
  {
    const r = await askWith({ sawSpawn: true, emitError: true });
    ok('ok === false', r.ok === false);
    ok('**errorSource === runtime**（不是 spawn）', r.errorSource === 'runtime', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false, JSON.stringify(R.canSafelyRetry(r)));
    ok('error 说明是「已启动后出错」', /已启动后出错/.test(r.error || ''), r.error);
  }

  console.log('\n【③ 启动失败 + 后续 close → **不重复结算**】');
  {
    const r = await askWith({ sawSpawn: false, emitError: true, closeAfterError: true, exitCode: 1 });
    ok('ok === false', r.ok === false);
    ok('**仍然标 spawn**（第一次 error 定的）', r.errorSource === 'spawn', r.errorSource);
    ok('只有一条结果（不是数组，没有覆盖）', typeof r === 'object' && !Array.isArray(r));
    // settled 保证只 finish 一次 —— 通过 errorSource 没被 close 分支覆盖来间接验证
    ok('**error 文案来自 error 分支**（不是退出码分支）', /起不来 dsh/.test(r.error || ''), r.error);
  }

  console.log('\n【④ 超时 → errorSource=timeout，**不可重试**】');
  {
    const r = await askWith({ sawSpawn: true, hang: true }, { timeoutMs: 500 });
    ok('ok === false', r.ok === false);
    ok('**errorSource === timeout**', r.errorSource === 'timeout', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false, JSON.stringify(R.canSafelyRetry(r)));
    ok('diagnostics.killOk === true', r.diagnostics?.killOk === true, JSON.stringify(r.diagnostics));
  }

  console.log('\n【⑤ ⚠️ 超时且 kill 抛异常 → errorSource=timeout_kill_failed，**绝对不可重试**】');
  {
    const r = await askWith({ sawSpawn: true, hang: true, killThrows: true }, { timeoutMs: 500 });
    ok('ok === false', r.ok === false);
    ok('**errorSource === timeout_kill_failed**', r.errorSource === 'timeout_kill_failed', r.errorSource);
    ok('**不可重试**', R.canSafelyRetry(r).retryable === false, JSON.stringify(R.canSafelyRetry(r)));
    ok('diagnostics.killOk === false', r.diagnostics?.killOk === false, JSON.stringify(r.diagnostics));
    ok('diagnostics.killErr 有内容', /EPERM/.test(r.diagnostics?.killErr || ''), r.diagnostics?.killErr);
  }

  console.log('\n【⑥ 全部 errorSource 的可重试性矩阵】');
  {
    const matrix = [
      ['spawn', true],
      ['event', false],
      ['turn', false],
      ['exit', false],
      ['empty', false],
      ['runtime', false],
      ['timeout', false],
      ['timeout_kill_failed', false]
    ];
    for (const [src, expect] of matrix) {
      const got = R.canSafelyRetry({ ok: false, errorSource: src }).retryable;
      ok(`**${src} → retryable=${expect}**`, got === expect, `实际 ${got}`);
    }
  }

  console.log('\n【⑦ 只有 spawn 一个来源可重试（源码级）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'session', 'retry.js'), 'utf8');
    // 精确提取 SAFE_RETRY_SOURCES 数组的内容（到 ] 为止），只允许 spawn
    const m = src.match(/SAFE_RETRY_SOURCES = Object\.freeze\(\[([\s\S]*?)\]\)/);
    const safeBody = m ? m[1] : '';
    const safeItems = (safeBody.match(/'([a-z_]+)'/g) || []).map((x) => x.replace(/'/g, ''));
    ok('**SAFE_RETRY_SOURCES 只有 spawn**',
      safeItems.length === 1 && safeItems[0] === 'spawn',
      JSON.stringify(safeItems));
    ok('UNSAFE 里有 runtime', /'runtime'/.test(src));
    ok('UNSAFE 里有 timeout', /'timeout'/.test(src));
    ok('UNSAFE 里有 timeout_kill_failed', /'timeout_kill_failed'/.test(src));
  }

  console.log('\n【⑧ 源码级：didSpawn 的用法正确】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('**监听了 spawn 事件**', /child\.on\('spawn', \(\) => \{ didSpawn = true; \}\)/.test(src));
    ok('**error 分支检查 didSpawn**', /if \(didSpawn\) \{[\s\S]{0,300}errorSource: 'runtime'/.test(src));
    ok('**只有未 spawn 时才标 spawn**',
      /if \(didSpawn\)[\s\S]{0,400}errorSource: 'spawn'/.test(src));
    ok('**超时有 killOk 诊断**', /diagnostics: \{ killOk, killErr/.test(src));
  }

  console.log('\n【⑨ 正常路径没被这些改动影响】');
  {
    const r = await askWith({
      sawSpawn: true,
      stdout: [
        { type: 'session', sessionId: 's1' },
        { type: 'final', text: '正常' }
      ],
      exitCode: 0
    });
    ok('ok === true', r.ok === true);
    ok('text 正确', r.text === '正常', r.text);
    ok('**不带 errorSource**', r.errorSource === undefined, String(r.errorSource));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
