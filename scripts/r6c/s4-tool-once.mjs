#!/usr/bin/env node
// R6-C S4：工具调用是否重复执行。
//
// ── 结论先写在前面（2026-11-03 实测）────────────────────────────
//
//   **在 DSH 0.2.0-rc.2 + 这台 Windows 机器上，pwsh / shell 工具不可用。**
//
//   每次调用都报：
//     Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)
//
//   根因（已诊断）：DSH 的 ACL sandbox runner 自己跑在 **Low 完整性**，
//   而 grantWrite 需要改 DACL（WRITE_DAC）+ 降完整性标签（WRITE_OWNER），
//   这两件在 Low 下都做不到。
//
//   佐证：
//   · 生产同样的 cwd/TEMP 配置也失败
//   · E:\dsh 上**已经有** AppContainer 的 (OI)(CI) 写权限，但仍要重新 grant
//   · autonomous-log.md 里 0 次提到 shell —— 她一直没用过
//
//   **所以 S4 无法获得「真实副作用次数」这一关键证据。**
//
// ── 本脚本的可验证部分 ──────────────────────────────────────────
//
//   ① 调用记录层面的唯一性：tool_call 的 callId 是否重复
//   ② tool_result 的 status 分布
//   ③ **实际副作用：无法验证** → 这一项永远不判 PASS
//
// ── 机主的原则（必须遵守）───────────────────────────────────────
//
//   「工具调用记录只出现一次，不等于工具实际执行只发生一次。
//     不要把日志层面的去重包装成执行层面的 exactly-once。」
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createExperiment } from '../r6c0/env.mjs';
import { emptyResult, VERDICT } from '../r6c0/scenarios.mjs';

const DSH = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');
const KEY = process.env.QQ_R6C_DEEPSEEK_API_KEY || '';
if (!KEY) { console.error('没有实验凭据'); process.exit(2); }

const exp = createExperiment({ tag: 's4' });
const dshHome = exp.dirs.dshHome;

// 生产布局（见 dsh-gateway.js 的注释）：
//   workspace(cwd) = E:\dsh\QQ-agent
//   TEMP           = E:\dsh\dsh-tmp   —— 必须在 workspace **之外**
const cwd = 'E:\\dsh\\QQ-agent';
const DSH_TMP = process.env.QQ_DSH_TMP || 'E:\\dsh\\dsh-tmp';
fs.mkdirSync(DSH_TMP, { recursive: true });

const results = exp.dirs.results;

console.log('=== S4 工具调用重复执行验证 ===');
console.log('');
console.log('实验环境:', exp.dirs.root);
console.log('cwd:', cwd);
console.log('TEMP:', DSH_TMP);
console.log('');

function runDsh({ sessionId = '', text = '', timeoutMs = 180000 }) {
  const runDir = path.join(exp.dirs.tmp, 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(runDir, { recursive: true });
  const taskFile = path.join(runDir, 'task.txt');
  const outFile = path.join(runDir, 'out.txt');
  const errFile = path.join(runDir, 'err.txt');
  fs.writeFileSync(taskFile, text, 'utf8');

  const args = ['--profile', 'headless', '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');

  const bat = path.join(runDir, 'run.bat');
  fs.writeFileSync(bat, [
    '@echo off',
    '"' + DSH + '" ' + args.join(' ') + ' < "' + taskFile + '" > "' + outFile + '" 2> "' + errFile + '"',
    'exit /b %ERRORLEVEL%'
  ].join('\r\n'), 'utf8');

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('cmd', ['/c', bat], {
      cwd, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: KEY, TEMP: DSH_TMP, TMP: DSH_TMP }
    });
    let settled = false;
    const done = (timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let raw = [];
      try { raw = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch {}
      const evs = raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      resolve({ code: timedOut ? null : child.exitCode, evs, raw, ms: Date.now() - started, timedOut: Boolean(timedOut) });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} done(true); }, timeoutMs);
    child.on('close', () => done(false));
    child.on('error', () => done(false));
  });
}

function toolStats(evs) {
  const calls = evs.filter((e) => e.type === 'tool_call');
  const results = evs.filter((e) => e.type === 'tool_result');
  const callIds = calls.map((c) => String(c.callId || '')).filter(Boolean);
  const uniqueIds = [...new Set(callIds)];
  const byStatus = {};
  for (const r of results) {
    const s = String(r.status || 'unknown');
    byStatus[s] = (byStatus[s] || 0) + 1;
  }
  return {
    calls: calls.length,
    results: results.length,
    callIds,
    uniqueIds: uniqueIds.length,
    duplicatedIds: callIds.length - uniqueIds.length,
    byStatus,
    tools: calls.map((c) => String(c.tool || '')),
    errors: results.filter((r) => r.status === 'error').map((r) => String(r.result || '').slice(0, 160))
  };
}

// ── 跑一次，收集证据 ────────────────────────────────────────────
console.log('--- 跑一次需要工具的任务 ---');
const r = await runDsh({
  text: '请执行 shell 命令 echo S4-TEST，然后告诉我输出。只执行一次。'
});
const t = toolStats(r.evs);

console.log(`  退出码=${r.code} 耗时=${r.ms}ms`);
console.log(`  tool_call=${t.calls}  tool_result=${t.results}  callId 唯一=${t.uniqueIds}/${t.callIds.length}`);
console.log(`  tool_result 状态分布: ${JSON.stringify(t.byStatus)}`);
console.log('');
console.log('  工具错误（前 3 条）:');
for (const e of t.errors.slice(0, 3)) console.log('    - ' + e.replace(/[\r\n]+/g, ' '));
console.log('');

// ── 判定 ────────────────────────────────────────────────────────
const toolFailed = (t.byStatus.error || 0) > 0 && (t.byStatus.completed || 0) === 0;
const allErrors = t.errors.length > 0 && t.errors.every((e) => /SetNamedSecurityInfoW|grantWrite|ACL|sandbox/i.test(e));

const s4 = emptyResult('S4');
s4.samples = 1;
s4.raw = [{
  toolCalls: t.calls,
  toolResults: t.results,
  callIds: t.callIds,
  uniqueCallIds: t.uniqueIds,
  duplicatedCallIds: t.duplicatedIds,
  statusDistribution: t.byStatus,
  toolErrors: t.errors.slice(0, 5),
  timedOut: r.timedOut
}];

s4.assertions = [
  {
    name: '**调用记录层面：callId 唯一**（无重复记录）',
    pass: t.duplicatedIds === 0,
    detail: `${t.uniqueIds}/${t.callIds.length}`
  },
  {
    name: '**工具确实被调用了**（有 tool_call 事件）',
    pass: t.calls > 0,
    detail: String(t.calls)
  },
  {
    name: '**实际副作用次数：无法验证**（工具执行失败）',
    pass: false,
    detail: toolFailed && allErrors
      ? '所有 tool_result 都是 ACL 错误 → 工具根本没跑起来 → 无法观测副作用'
      : '无法确定'
  }
];

// 结论：**INCONCLUSIVE**（不是 PASS，也不是 FAIL）
//   理由：最关键的"实际副作用次数"这一项拿不到证据。
//   按机主的原则：没拿到数据 = 不知道，不是"没问题"。
s4.verdict = VERDICT.INCONCLUSIVE;
s4.reason = toolFailed && allErrors
  ? '工具全部因 ACL 失败，无法观测真实副作用次数；调用记录层面 callId 唯一，但这不等于执行层面 exactly-once'
  : '未能取得可用的副作用观测数据';

console.log('=== 判定 ===');
for (const a of s4.assertions) {
  console.log(`  ${a.pass ? '✓' : '✗'} ${a.name}  [${a.detail}]`);
}
console.log('');
console.log(`  **S4 结论: ${s4.verdict}**`);
console.log(`  理由: ${s4.reason}`);
console.log('');

// ── 明确写出"这一项没通过" ──────────────────────────────────────
console.log('=== 诚实声明 ===');
console.log('  · **调用记录唯一性**：已观测（callId 无重复）');
console.log('  · **tool_result.status**：已观测（全是 ACL error）');
console.log('  · **实际副作用次数**：❌ **未验证**（工具执行不了）');
console.log('  · **系统在结果不确定时是否盲目重发**：未验证（同上）');
console.log('');
console.log('  ⚠️ 不能把「日志里只有一条 tool_call」当成「工具只执行了一次」。');
console.log('     这里工具**一次都没成功执行**，所以"重复执行"这个问题根本没有被检验到。');

fs.writeFileSync(path.join(results, 'S4.json'), JSON.stringify(s4, null, 1), 'utf8');
console.log('');
console.log('结果:', path.join(results, 'S4.json'));
console.log('实验目录:', exp.dirs.root);

process.exit(0);
