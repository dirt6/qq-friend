// 阶段 3.0-R5-C 专项测试：锁生命周期（**真跨进程**）。
//
// 机主 2026-11-02 的要求：
//   · 唯一 owner token
//   · 释放时验证 owner
//   · **PID 存活检查不能单独作为身份判断**
//   · 陈旧锁回收必须防止两个进程竞争时同时进入临界区
//   · **持锁进程仍存活，即使超过 15 秒，也不能被误判为陈旧锁**
//   · 崩溃进程留下的锁必须可以安全恢复
//   · 锁超时必须明确报错
//
// **不用单进程模拟代替跨进程测试。**
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const WORKER = path.join(ROOT, 'scripts', 'lock-test-worker.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

function runWorker(dir, mode, tag, holdMs = 0) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, dir, mode, tag, String(holdMs)], {
      stdio: 'ignore',
      env: { ...process.env }
    });
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 30000);
    child.on('exit', (code) => { clearTimeout(t); resolve(code); });
    child.on('error', () => { clearTimeout(t); resolve(-1); });
  });
}

function readRes(dir, tag) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, `res-${tag}.json`), 'utf8')); } catch { return null; }
}

const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'r5c-'));
const lockOf = (dir) => path.join(dir, 'protected.json.lock');

async function main() {
  const F = await import(pathToFileURL(path.join(ROOT, 'src', 'file-lock.js')).href);

  console.log('【① 两个独立进程争锁：**串行**，不重叠】');
  {
    const dir = mkDir();
    await Promise.all([
      runWorker(dir, 'hold', 'P1', 400),
      runWorker(dir, 'hold', 'P2', 400)
    ]);
    const a = readRes(dir, 'P1');
    const b = readRes(dir, 'P2');
    ok('两个都完成', a?.ok === true && b?.ok === true, JSON.stringify([a, b]));
    // 两个进程的进入时间不能太接近（说明没同时在临界区）
    const gap = Math.abs((a?.enteredAt || 0) - (b?.enteredAt || 0));
    ok('**进入临界区的时间差 ≥ 300ms**（说明串行了）', gap >= 300, `${gap}ms`);
    ok('没有残留锁', !fs.existsSync(lockOf(dir)));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【② 持锁进程存活超过 15 秒 → **不被误判陈旧**】');
  {
    const dir = mkDir();
    // 子进程持锁 17 秒（超过旧的 15s staleMs）
    const child = spawn(process.execPath, [WORKER, dir, 'hold', 'LONG', '17000'], { stdio: 'ignore' });
    // 等 2 秒确认它拿到锁
    await new Promise((r) => setTimeout(r, 2000));
    const st = F.lockState(path.join(dir, 'protected.json'));
    ok('**锁还在，且判为 holder-alive**', st.stale === false && st.reason === 'holder-alive', JSON.stringify(st));

    // 再等 14 秒（累计 16 秒 > 15s）
    await new Promise((r) => setTimeout(r, 14000));
    const st2 = F.lockState(path.join(dir, 'protected.json'));
    ok('**超过 15 秒仍然是 holder-alive**（旧实现这里会误判）', st2.stale === false && st2.reason === 'holder-alive', JSON.stringify(st2));

    try { child.kill('SIGKILL'); } catch { /* ignore */ }
    await new Promise((r) => { child.on('exit', r); setTimeout(r, 2000); });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【③ 持锁进程崩溃 → 锁可以安全恢复】');
  {
    const dir = mkDir();
    const code = await runWorker(dir, 'crash', 'CRASH');
    ok('子进程确实异常退出', code !== 0, String(code));
    ok('**锁文件残留**', fs.existsSync(lockOf(dir)));

    const st = F.lockState(path.join(dir, 'protected.json'));
    ok('**判为 holder-dead（可回收）**', st.stale === true && st.reason === 'holder-dead', JSON.stringify(st));

    // 另一个进程能抢到
    await runWorker(dir, 'hold', 'AFTER', 0);
    const r = readRes(dir, 'AFTER');
    ok('**后续进程能拿到锁**', r?.ok === true, JSON.stringify(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【④ 竞争回收陈旧锁：两个进程同时抢，只有一个进临界区】');
  {
    const dir = mkDir();
    // 造一个死进程的锁
    fs.writeFileSync(lockOf(dir), JSON.stringify({ pid: 999999, token: 'dead', startedAt: 1 }));
    await Promise.all([
      runWorker(dir, 'hold', 'C1', 200),
      runWorker(dir, 'hold', 'C2', 200)
    ]);
    const a = readRes(dir, 'C1');
    const b = readRes(dir, 'C2');
    ok('两个都完成', a?.ok === true && b?.ok === true, JSON.stringify([a, b]));
    const gap = Math.abs((a?.enteredAt || 0) - (b?.enteredAt || 0));
    ok('**进入时间差 ≥ 150ms**（没同时进）', gap >= 150, `${gap}ms`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【⑤ 释放时 owner token 不匹配 → 不删别人的锁】');
  {
    const dir = mkDir();
    const target = path.join(dir, 'x.json');
    // 锁文件必须是 target + '.lock'（和 withFileLock 一致）
    const lock = target + '.lock';

    // 手动写一个"别人的锁"
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'someone-else', startedAt: Date.now() }));

    // 我们自己拿不到锁（因为持有人 pid 是本进程，alive）→ 会一直等
    let err = null;
    try {
      F.withFileLock(target, () => { /* 不该进来 */ }, { retries: 3, waitMs: 5 });
    } catch (e) { err = e; }

    ok('**超时报错**', err?.code === 'ELOCKTIMEOUT', err?.code);
    ok('**别人的锁还在**（没被误删）', fs.existsSync(lock));
    const holder = JSON.parse(fs.readFileSync(lock, 'utf8'));
    ok('token 还是别人的', holder.token === 'someone-else', holder.token);

    fs.rmSync(lock, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【⑥ 锁格式：有 pid/token/startedAt/host】');
  {
    const dir = mkDir();
    const target = path.join(dir, 'x.json');
    const lock = target + '.lock';
    let captured = null;
    F.withFileLock(target, () => {
      captured = JSON.parse(fs.readFileSync(lock, 'utf8'));
    });
    ok('有 pid', captured?.pid === process.pid, String(captured?.pid));
    ok('**有唯一 token**', typeof captured?.token === 'string' && captured.token.length > 10, captured?.token);
    ok('有 startedAt', typeof captured?.startedAt === 'number');
    ok('**释放后锁没了**', !fs.existsSync(lock));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('\n【⑦ 源码级：陈旧判定不看年龄（有 pid 时）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'file-lock.js'), 'utf8');
    ok('**有 isPidAlive**', /export function isPidAlive/.test(src));
    ok('**lockState 里先看 holder.pid 再看 mtime**', (() => {
      const i = src.indexOf('export function lockState');
      const seg = src.slice(i, i + 1200);
      const pidIdx = seg.indexOf('isPidAlive(holder.pid)');
      const mtimeIdx = seg.indexOf('st.mtimeMs');
      return pidIdx > 0 && mtimeIdx > pidIdx;
    })(), '顺序不对');
    ok('**释放时验证 token**', /holder && holder\.token === myToken/.test(src));
    ok('**回收后重新竞争（continue，不直接进临界区）**', /try \{ fs\.unlinkSync\(lock\); \} catch[\s\S]{0,80}continue;/.test(src));
  }
}

main().then(() => {
  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  process.exit(fail ? 1 : 0);
}).catch((e) => {
  console.log(`\n✗ 测试执行抛异常：${e?.message || e}`);
  process.exit(1);
});
