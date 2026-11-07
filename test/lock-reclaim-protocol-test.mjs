// P2 研究：陈旧锁回收协议的 Windows 语义与竞态反例（2026-11-03）。
//
// 这不是"产品功能测试"，而是**协议安全性实验**：
//   · 用独立临时目录 + 独立子进程 + 文件 barrier 制造可控竞态；
//   · 断言的是"反例确实成立"（通过 = 证明现有回收协议不安全）；
//   · 结论写进 docs/roadmap/P1-P2-REPORT.md（P2 暂停）。
//
// 不修改 src/file-lock.js。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lock-protocol-'));
const c = createChecker('P2 锁回收协议实验（Windows）');

const L = path.join(dir, 'chat.json.lock');
const aReady = path.join(dir, 'a.ready');
const bDone = path.join(dir, 'b.done');
const aResult = path.join(dir, 'a.result');
const bResult = path.join(dir, 'b.result');

function runChild(tag, code) {
  return new Promise((resolve) => {
    const out = fs.openSync(path.join(dir, `${tag}.out`), 'a');
    const err = fs.openSync(path.join(dir, `${tag}.err`), 'a');
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: dir, stdio: ['ignore', out, err], windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 30000);
    child.on('exit', (codeExit) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* ignore */ }
      try { fs.closeSync(err); } catch { /* ignore */ }
      resolve({
        code: codeExit,
        err: (() => { try { return fs.readFileSync(path.join(dir, `${tag}.err`), 'utf8').slice(0, 300); } catch { return ''; } })()
      });
    });
  });
}

/** 子进程脚本公共前缀：导入 fs、定义 barrier 等待。 */
const preamble = `
const fs = await import('node:fs');
const L = ${JSON.stringify(L)};
const aReady = ${JSON.stringify(aReady)};
const bDone = ${JSON.stringify(bDone)};
const aResult = ${JSON.stringify(aResult)};
const bResult = ${JSON.stringify(bResult)};
const wait = async (pred, ms = 10000) => {
  const t = Date.now();
  while (!pred()) { if (Date.now() - t > ms) throw new Error('barrier timeout'); await new Promise((r) => setTimeout(r, 10)); }
};
`;

/** A：读到死锁 → 等 B 完成回收+建新锁 → 再认领（rename）。 */
const A = preamble + `
try {
  const holder = JSON.parse(fs.readFileSync(L, 'utf8'));
  const dead = !Number.isInteger(Number(holder.pid)) || holder.pid === 999999;
  fs.writeFileSync(aReady, '1');
  await wait(() => fs.existsSync(bDone));
  const recl = L + '.reclaimA';
  fs.renameSync(L, recl);
  const got = JSON.parse(fs.readFileSync(recl, 'utf8'));
  fs.writeFileSync(aResult, JSON.stringify({ renamed: true, deadAtCheck: dead, gotPid: got.pid, gotToken: got.token }));
} catch (e) {
  fs.writeFileSync(aResult, JSON.stringify({ renamed: false, code: e.code, message: e.message }));
}
`;

/** B：等 A 判定死锁 → 回收 → 原子建自己的新锁。 */
const B = preamble + `
try {
  await wait(() => fs.existsSync(aReady));
  fs.renameSync(L, L + '.reclaimB');
  fs.writeFileSync(L, JSON.stringify({ pid: process.pid, token: 'B-alive', startedAt: Date.now() }), { flag: 'wx' });
  fs.writeFileSync(bDone, '1');
  fs.writeFileSync(bResult, JSON.stringify({ created: true, pid: process.pid }));
} catch (e) {
  fs.writeFileSync(bDone, '1');
  fs.writeFileSync(bResult, JSON.stringify({ created: false, code: e.code, message: e.message }));
}
`;

try {
  c.section('1. Windows 上 rename 覆盖已存在目标（"搬回去"会覆盖别人新锁）');
  {
    fs.writeFileSync(path.join(dir, 'target'), 'OLD', 'utf8');
    fs.writeFileSync(path.join(dir, 'src'), 'NEW', 'utf8');
    let got = '';
    let code = '';
    try {
      fs.renameSync(path.join(dir, 'src'), path.join(dir, 'target'));
      got = fs.readFileSync(path.join(dir, 'target'), 'utf8');
    } catch (e) {
      code = e.code;
    }
    await c.check('rename 成功且目标被覆盖（got=NEW）', () => {
      if (got !== 'NEW') throw new Error(`got=${got} code=${code}`);
    });
    await c.check('源文件已不存在', () => {
      if (fs.existsSync(path.join(dir, 'src'))) throw new Error('src 还在');
    });
  }

  c.section('2. 两个进程同时 rename 同一把死锁 → 只有一个成功');
  {
    fs.writeFileSync(L, JSON.stringify({ pid: 999999, token: 'dead', startedAt: 0 }), 'utf8');
    const code = preamble + `
const dest = L + '.' + process.env.RACE_TAG;
try { fs.renameSync(L, dest); fs.writeFileSync(dest + '.ok', '1'); }
catch (e) { fs.writeFileSync(dest + '.err', e.code); }
`;
    const runRace = (tag) => new Promise((resolve) => {
      const out = fs.openSync(path.join(dir, `race-${tag}.out`), 'a');
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: dir, env: { ...process.env, RACE_TAG: tag }, stdio: ['ignore', out, 'ignore'], windowsHide: true
      });
      child.on('exit', () => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(); });
    });
    await Promise.all([runRace('r1'), runRace('r2')]);
    const ok1 = fs.existsSync(path.join(dir, 'chat.json.lock.r1.ok'));
    const ok2 = fs.existsSync(path.join(dir, 'chat.json.lock.r2.ok'));
    await c.check('恰好一个进程 rename 成功', () => {
      if (ok1 === ok2) throw new Error(`ok1=${ok1} ok2=${ok2}`);
    });
    await c.check('另一个得到 ENOENT', () => {
      const err = fs.existsSync(path.join(dir, 'chat.json.lock.r1.err'))
        ? fs.readFileSync(path.join(dir, 'chat.json.lock.r1.err'), 'utf8')
        : fs.readFileSync(path.join(dir, 'chat.json.lock.r2.err'), 'utf8');
      if (err !== 'ENOENT') throw new Error(err);
    });
  }

  c.section('3. 反例：判死后被重建 → A 的认领搬走的是 B 的活锁');
  {
    for (const f of [aReady, bDone, aResult, bResult]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
    fs.writeFileSync(L, JSON.stringify({ pid: 999999, token: 'dead', startedAt: 0 }), 'utf8');
    const [ca, cb] = await Promise.all([runChild('A', A), runChild('B', B)]);
    const a = fs.existsSync(aResult) ? JSON.parse(fs.readFileSync(aResult, 'utf8')) : null;
    const b = fs.existsSync(bResult) ? JSON.parse(fs.readFileSync(bResult, 'utf8')) : null;
    await c.check('A 判定时锁确实是死锁（deadAtCheck=true）', () => {
      if (!a || a.deadAtCheck !== true) throw new Error(JSON.stringify(a));
    });
    await c.check('B 成功建立了自己的新锁', () => {
      if (!b || b.created !== true) throw new Error(JSON.stringify(b));
    });
    await c.check('**A 认领到的是 B 的活锁**（gotPid= B 的 pid，token=B-alive）', () => {
      if (!a || a.renamed !== true) throw new Error(JSON.stringify(a));
      if (a.gotPid !== b.pid || a.gotToken !== 'B-alive') throw new Error(`A 认领到 ${JSON.stringify(a)}，B 是 ${JSON.stringify(b)}`);
    });
    await c.check('两个子进程都正常退出', () => {
      if (ca.code !== 0 || cb.code !== 0) throw new Error(`${ca.code}/${cb.code} ${ca.err}${cb.err}`);
    });
  }

  c.section('4. 释放时 owner token 不匹配 → 不删（现有实现正确）');
  {
    const target = path.join(dir, 'token.json');
    const lockPath = `${target}.lock`;
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'dead', startedAt: 0 }), 'utf8');
    const { withFileLock } = await import('../src/file-lock.js');
    let inside = false;
    withFileLock(target, () => {
      inside = true;
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: 'other-owner', startedAt: 0 }), 'utf8');
    });
    await c.check('临界区执行了', () => {
      if (!inside) throw new Error('没进临界区');
    });
    await c.check('token 不匹配时锁文件保留（不误删）', () => {
      if (!fs.existsSync(lockPath)) throw new Error('锁被删了');
    });
  }

  c.section('5. PID 复用/身份无法确认：判活就不回收（安全方向）');
  {
    const { lockState } = await import('../src/file-lock.js');
    const target = path.join(dir, 'alive.json');
    fs.writeFileSync(`${target}.lock`, JSON.stringify({
      pid: process.pid, token: 'fake-but-pid-alive', startedAt: Date.now()
    }), 'utf8');
    const st = lockState(target);
    await c.check('holder pid 存活 → 判不陈旧（宁可等待也不误删）', () => {
      if (st.stale !== false) throw new Error(JSON.stringify(st));
      if (st.reason !== 'holder-alive') throw new Error(st.reason);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
