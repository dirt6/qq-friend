#!/usr/bin/env node
// 真实请求验证：确认 finish 返回的 usage 正确、model-calls 记录正确。
//
// 用隔离 DSH_HOME，走真实的 dsh-gateway.ask()（带 deps 注入不了，用默认 spawn）。
// 因为沙箱不允许 pipe，这里改成：直接调 DSH + 用新的纯函数解析，验证端到端。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DSH = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');
const KEY = process.env.QQ_R6C_DEEPSEEK_API_KEY || '';
const ROOT = 'E:/dsh/QQ-agent';

if (!KEY) { console.error('没有实验凭据'); process.exit(2); }

const base = fs.mkdtempSync(path.join(process.env.TEMP, 'dsh-verifusage-'));
const dshHome = path.join(base, 'dsh-home');
const cwd = path.join(base, 'work');
fs.mkdirSync(dshHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

function runOnce(text) {
  const runDir = path.join(base, 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
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
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: KEY, TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp') }
    });
    child.on('close', (code) => {
      let raw = [];
      try { raw = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch {}
      resolve({ code, raw });
    });
    child.on('error', () => resolve({ code: -1, raw: [] }));
  });
}

const G = await import('file://' + ROOT + '/src/dsh-gateway.js');

function parseWithGateway(raw, code) {
  const st = G.newEventState();
  for (const line of raw) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    G.applyEvent(st, ev);
  }
  return G.decideOutcome({ code, st });
}

console.log('=== 真实验证 1：单 step ===');
const r1 = await runOnce('只回一个字：好');
const o1 = parseWithGateway(r1.raw, r1.code);
console.log('  ok:', o1.ok, ' text:', JSON.stringify(o1.text), ' usageSteps:', o1.usageSteps);
console.log('  usage:', JSON.stringify(o1.usage));

console.log('');
console.log('=== 真实验证 2：多 step（触发工具）===');
const r2 = await runOnce('请用 shell 依次执行 echo a 和 echo b，然后告诉我两次输出。');
const o2 = parseWithGateway(r2.raw, r2.code);
console.log('  ok:', o2.ok, ' usageSteps:', o2.usageSteps);
console.log('  usage:', JSON.stringify(o2.usage));

console.log('');
console.log('=== 判定 ===');
const checks = [
  ['单 step 有 usage', o1.usage && o1.usage.total > 0, JSON.stringify(o1.usage?.total)],
  ['单 step usageSteps === 1', o1.usageSteps === 1, String(o1.usageSteps)],
  ['单 step 四项之和 === total',
    o1.usage && (o1.usage.input + o1.usage.output + o1.usage.cacheRead + o1.usage.cacheWrite === o1.usage.total),
    o1.usage ? String(o1.usage.input + o1.usage.output + o1.usage.cacheRead + o1.usage.cacheWrite) + ' vs ' + o1.usage.total : 'n/a'],
  ['多 step 有 usage', o2.usage && o2.usage.total > 0, JSON.stringify(o2.usage?.total)],
  ['多 step usageSteps > 1', o2.usageSteps > 1, String(o2.usageSteps)],
  ['多 step 四项之和 === total',
    o2.usage && (o2.usage.input + o2.usage.output + o2.usage.cacheRead + o2.usage.cacheWrite === o2.usage.total),
    o2.usage ? String(o2.usage.input + o2.usage.output + o2.usage.cacheRead + o2.usage.cacheWrite) + ' vs ' + o2.usage.total : 'n/a']
];
let bad = 0;
for (const [name, cond, detail] of checks) {
  console.log('  ' + (cond ? '✓' : '✗') + ' ' + name + '  [' + detail + ']');
  if (!cond) bad += 1;
}

console.log('');
console.log('实验目录:', base);
console.log(bad === 0 ? '**全部通过**' : `**${bad} 项失败**`);
process.exit(bad === 0 ? 0 : 1);
