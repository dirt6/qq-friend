#!/usr/bin/env node
// 测热会话（带 --session-id）的 usage 位置。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DSH = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');
const KEY = process.env.QQ_R6C_DEEPSEEK_API_KEY || '';
if (!KEY) { console.error('没有凭据'); process.exit(2); }

const base = fs.mkdtempSync(path.join(process.env.TEMP, 'dsh-hot-'));
const dshHome = path.join(base, 'dsh-home');
const cwd = path.join(base, 'work');
fs.mkdirSync(dshHome, { recursive: true });
fs.mkdirSync(cwd, { recursive: true });

function runOnce(text, sessionId = '') {
  const runDir = path.join(base, 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
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
    const child = spawn('cmd', ['/c', bat], {
      cwd, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, DSH_HOME: dshHome, DEEPSEEK_API_KEY: KEY, TEMP: path.join(base, 'tmp'), TMP: path.join(base, 'tmp') }
    });
    child.on('close', (code) => {
      let raw = [];
      try { raw = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean); } catch {}
      resolve({ code, raw });
    });
  });
}

const show = (label, r) => {
  console.log(`--- ${label} ---`);
  const evs = r.raw.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const steps = evs.filter((e) => e.type === 'status' && e.phase === 'step_end');
  const turns = evs.filter((e) => e.type === 'status' && e.phase === 'turn_end');
  console.log('  step_end:', steps.length, ' turn_end:', turns.length);
  for (const s of steps) console.log('    step' + s.step + ' usage=' + JSON.stringify(s.usage));
  for (const t of turns) console.log('    turn' + t.turn + ' usage=' + JSON.stringify(t.usage));
  console.log('  事件类型:', JSON.stringify([...new Set(evs.map(e => e.type))]));
  return { steps, turns, evs };
};

// ① 冷会话
const r1 = await runOnce('只回一个字：好');
const s1 = show('冷会话（新建）', r1);
const sid = s1.evs.find((e) => e.type === 'session')?.sessionId || '';
console.log('  sessionId:', sid);
console.log('');

// ② 热会话（带 session-id）
const r2 = await runOnce('再回一个字：好', sid);
const s2 = show('热会话（--session-id）', r2);

console.log('');
console.log('=== 判定 ===');
console.log('  冷会话有 usage:', s1.steps.some(s => s.usage) ? '✓' : '✗');
console.log('  热会话有 usage:', s2.steps.some(s => s.usage) ? '✓' : '✗');
console.log('  热会话有 turn_end usage:', s2.turns.some(t => t.usage) ? '✓' : '✗');
console.log('');
console.log('实验目录:', base);
