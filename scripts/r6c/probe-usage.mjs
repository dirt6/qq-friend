#!/usr/bin/env node
// 抓多 step 的真实事件流，分析 usage 语义。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DSH = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');
const KEY = process.env.QQ_R6C_DEEPSEEK_API_KEY || '';

if (!KEY) { console.error('没有实验凭据'); process.exit(2); }

const base = fs.mkdtempSync(path.join(process.env.TEMP, 'dsh-usagediag-'));
const dshHome = path.join(base, 'dsh-home');
const cwd = path.join(base, 'work');
fs.mkdirSync(dshHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

function runOnce(text) {
  const runDir = path.join(base, 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
  fs.mkdirSync(runDir, { recursive: true });
  const taskFile = path.join(runDir, 'task.txt');
  const outFile = path.join(runDir, 'out.txt');
  const errFile = path.join(runDir, 'err.txt');
  fs.writeFileSync(taskFile, text, 'utf8');

  const bat = path.join(runDir, 'run.bat');
  fs.writeFileSync(bat, [
    '@echo off',
    '"' + DSH + '" --profile headless --json - < "' + taskFile + '" > "' + outFile + '" 2> "' + errFile + '"',
    'exit /b %ERRORLEVEL%'
  ].join('\r\n'), 'utf8');

  return new Promise((resolve) => {
    const child = spawn('cmd', ['/c', bat], {
      cwd, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: KEY }
    });
    child.on('close', (code) => {
      let raw = [];
      try { raw = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch {}
      resolve({ code, raw });
    });
    child.on('error', () => resolve({ code: -1, raw: [] }));
  });
}

// 任务：故意让它需要多步
const TASK = process.env.PROBE_TASK || '请先用 shell 执行 echo hello，再用 shell 执行 echo world，最后把两次输出告诉我。';

const r = await runOnce(TASK);
console.log('退出码:', r.code);
console.log('事件行数:', r.raw.length);
console.log('');
console.log('=== 完整原始事件流 ===');
for (const line of r.raw) console.log(line);
console.log('');

// 分析 usage
const evs = r.raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const stepEnds = evs.filter((e) => e.type === 'status' && e.phase === 'step_end');
const turnEnds = evs.filter((e) => e.type === 'status' && e.phase === 'turn_end');

console.log('=== 分析 ===');
console.log('step_end 数量:', stepEnds.length);
for (let i = 0; i < stepEnds.length; i++) {
  console.log(`  step ${i + 1}: usage = ${JSON.stringify(stepEnds[i].usage)}`);
}
console.log('turn_end 数量:', turnEnds.length);
for (let i = 0; i < turnEnds.length; i++) {
  console.log(`  turn ${i + 1}: usage = ${JSON.stringify(turnEnds[i].usage)}  reason = ${JSON.stringify(turnEnds[i].reason)}`);
}

console.log('');
console.log('=== 判定 ===');
if (stepEnds.length > 1) {
  const us = stepEnds.map((s) => s.usage).filter(Boolean);
  if (us.length > 1) {
    const totals = us.map((u) => u.totalTokens);
    const inputT = us.map((u) => u.inputTokens);
    console.log('各 step 的 totalTokens:', totals);
    console.log('各 step 的 inputTokens:', inputT);
    // 若累计，后一个 >= 前一个；若增量，可能互不包含
    const increasing = totals.every((v, i) => i === 0 || v >= totals[i - 1]);
    const sameSum = totals[totals.length - 1] === totals.reduce((a, b) => a + b, 0);
    console.log('totalTokens 单调递增（可能是累计）:', increasing);
    console.log('最后一个 === 全部之和（也可能是巧合）:', sameSum);
  }
} else {
  console.log('⚠️ 只有', stepEnds.length, '个 step —— 本次任务没触发多步，无法判定增量/累计');
}

fs.writeFileSync(path.join(base, 'events.json'), JSON.stringify({ raw: r.raw, evs }, null, 1), 'utf8');
console.log('');
console.log('原始事件已存:', path.join(base, 'events.json'));
console.log('实验目录:', base);
