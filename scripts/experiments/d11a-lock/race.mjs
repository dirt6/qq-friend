// D1-1A 补充验证：rename 认领竞态（barrier 实验）。
//
// 时间线：
//   A（回收者）：读 L1（已过期）→ 暂停 800ms → rename(lock → claimedA) → wx 自己的锁 → 临界区
//   B（另一合法认领者）：在 A 暂停期间认领 L1 → 建活锁 L2 → 进入临界区（hold 1500ms）
//   检查：A 是否把 L2 当 L1 移走？B 是否仍认为持锁？两者临界区是否重叠？
//
// 用法：node race.mjs main
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const role = process.argv[2];

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
const readJson = (p, f) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return f; } };

if (role === 'a' || role === 'b') {
  const dir = process.argv[3];
  const lock = path.join(dir, 'c.json.lock');
  const file = path.join(dir, 'c.json');
  const events = path.join(dir, 'events.jsonl');
  const log = (o) => fs.appendFileSync(events, JSON.stringify({ role, ...o, at: Date.now() }) + '\n');
  const token = role === 'a' ? 'A' : 'B';

  if (role === 'a') {
    const l1 = readJson(lock, null);
    log({ event: 'stale-checked', sawToken: l1?.token ?? null, sawPid: l1?.pid ?? null });
    sleep(800);                                   // ← 检查后暂停（barrier）
    const claimed = path.join(dir, 'claimed-A.json');
    let moved = null;
    try {
      fs.renameSync(lock, claimed);
      moved = readJson(claimed, null);
      log({ event: 'renamed', movedToken: moved?.token ?? null, movedPid: moved?.pid ?? null });
    } catch (e) {
      log({ event: 'rename-failed', code: e.code });
    }
    try {
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' });
      log({ event: 'enter' });
      const data = readJson(file, { count: 0 });
      data.count = Number(data.count || 0) + 1;
      sleep(100);
      fs.writeFileSync(file, JSON.stringify(data));
      log({ event: 'exit', count: data.count });
      try { if (readJson(lock, null)?.pid === process.pid) fs.unlinkSync(lock); } catch { /* ignore */ }
    } catch (e) {
      log({ event: 'wx-failed', code: e.code });
    }
    process.exit(0);
  }

  // B：等 A 检查完，认领 L1，建活锁 L2，进入临界区
  sleep(200);
  const l1 = readJson(lock, null);
  log({ event: 'b-saw', token: l1?.token ?? null });
  const claimedB = path.join(dir, 'claimed-B.json');
  try { fs.renameSync(lock, claimedB); } catch (e) { log({ event: 'b-rename-failed', code: e.code }); }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now(), token }), { flag: 'wx' });
    log({ event: 'b-lock-created', token });
  } catch (e) { log({ event: 'b-wx-failed', code: e.code }); }
  log({ event: 'enter' });
  const data = readJson(file, { count: 0 });
  data.count = Number(data.count || 0) + 1;
  sleep(1500);                                     // 持锁期间，A 会来 rename
  fs.writeFileSync(file, JSON.stringify(data));
  log({ event: 'exit', count: data.count, stillHoldsLockFile: readJson(lock, null)?.token === token });
  process.exit(0);
}

if (role === 'main') {
  const runs = Number(process.argv[3] || 5);
  const out = [];
  for (let i = 0; i < runs; i++) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11a-race-'));
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ count: 0 }));
    // L1：已死进程的锁，token 明确为 L1
    fs.writeFileSync(path.join(dir, 'c.json.lock'), JSON.stringify({ pid: 999999, at: Date.now() - 60000, token: 'L1' }));
    const a = spawn(process.execPath, [SELF, 'a', dir], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    const b = spawn(process.execPath, [SELF, 'b', dir], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
    await Promise.all([new Promise((r) => a.on('exit', r)), new Promise((r) => b.on('exit', r))]);
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const ev = (r, e) => events.find((x) => x.role === r && x.event === e);
    const aEnter = ev('a', 'enter')?.at;
    const bExit = ev('b', 'exit')?.at;
    const bEnter = ev('b', 'enter')?.at;
    const aExit = ev('a', 'exit')?.at;
    const overlap = Boolean(aEnter && bExit && aEnter < bExit) || Boolean(bEnter && aExit && bEnter < aExit);
    out.push({
      run: i + 1,
      aSawToken: ev('a', 'stale-checked')?.sawToken ?? null,
      aMovedToken: ev('a', 'renamed')?.movedToken ?? null,
      bLockCreated: ev('b', 'b-lock-created')?.token ?? null,
      aEnter, aExit, bEnter, bExit,
      critialOverlap: overlap,
      aMovedLiveLock: ev('a', 'renamed')?.movedToken === 'B',
      bStillThoughtHolding: ev('b', 'exit')?.stillHoldsLockFile ?? null,
      finalCount: readJson(path.join(dir, 'c.json'), {}).count ?? null
    });
  }
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

console.error('role must be main|a|b');
process.exit(2);
