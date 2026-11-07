// 单写者状态文件的 Windows 故障专项测试（4.0 · 1.5.3）。
//
// 机主列的五个场景：
//   ① 两个进程同时修改，不丢更新
//   ② 进程持锁期间崩溃（锁没释放）
//   ③ 陈旧锁识别与恢复
//   ④ 原子替换失败，旧文件仍然完整
//   ⑤ 锁超时有明确错误，不静默吞掉
//
// 全部在临时目录跑，不碰生产 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = pathToFileURL(path.join(ROOT, 'src', 'state-store.js')).href;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'state-store-'));
const stateFile = path.join(tmp, 'state.json');
fs.writeFileSync(stateFile, JSON.stringify({ counter: 0, seen: {}, history: [], shares: [] }), 'utf8');

/** 在子进程里跑一段脚本（stdio 走文件 fd —— 沙箱里 pipe 会 EPERM）。 */
function runChild(body, { tag = 'c', timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const outFile = path.join(tmp, `${tag}-${Date.now()}.out`);
    const errFile = path.join(tmp, `${tag}-${Date.now()}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const script = `
const { withState } = await import(${JSON.stringify(MOD)});
const fs = await import('node:fs');
const FILE = ${JSON.stringify(stateFile)};
${body}
process.exit(0);
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT, stdio: ['ignore', out, err], windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out) } catch { /* ignore */ }
      try { fs.closeSync(err) } catch { /* ignore */ }
      let stdout = '';
      let stderr = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { stderr = fs.readFileSync(errFile, 'utf8').slice(0, 300); } catch { /* ignore */ }
      resolve({ code, stdout, stderr });
    });
  });
}

const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

try {
  console.log('【① 两个进程同时改，不丢更新】');
  {
    const body = `
let fails = 0; const errs = [];
for (let i = 0; i < 100; i += 1) {
  const r = withState(FILE, (st) => { st.counter = (Number(st.counter) || 0) + 1; });
  if (!r.ok) { fails += 1; if (errs.length < 2) errs.push(r.error); }
}
process.stdout.write(JSON.stringify({ fails, errs }));
`;
    const before = read().counter;
    const [a, b] = await Promise.all([runChild(body, { tag: 'a' }), runChild(body, { tag: 'b' })]);
    ok('两个子进程都正常退出', a.code === 0 && b.code === 0, `${a.code}/${b.code} ${a.stderr}${b.stderr}`);
    const after = read().counter;
    ok('计数 = 200（一笔不丢）', after - before === 200, `${before} → ${after}`);
  }

  console.log('\n【② 持锁期间崩溃 → 锁没释放也能恢复】');
  {
    // 子进程拿锁后直接 process.exit（模拟崩溃，不执行 finally 的解锁）
    const body = `
withState(FILE, (st) => { st.crashed = true; process.exit(9); });
`;
    const r = await runChild(body, { tag: 'crash', timeoutMs: 20000 });
    ok('子进程以非 0 退出（模拟崩溃）', r.code !== 0, String(r.code));
    ok('锁文件留在磁盘上', fs.existsSync(`${stateFile}.lock`), '没有 .lock');
    // 把锁的 mtime 改老，模拟"崩溃已经过去一会儿"
    const old = new Date(Date.now() - 30_000);
    fs.utimesSync(`${stateFile}.lock`, old, old);
    const { withState } = await import('../src/state-store.js');
    const r2 = withState(stateFile, (st) => { st.recovered = true; });
    ok('陈旧锁被清掉，能继续写', r2.ok === true, JSON.stringify(r2));
    ok('清理后没有残留锁', !fs.existsSync(`${stateFile}.lock`));
    ok('新写入生效', read().recovered === true);
  }

  console.log('\n【③ 陈旧锁识别（3 秒内不误判）】');
  {
    const { withState } = await import('../src/state-store.js');
    // 新锁（刚创建）不应该被当成陈旧锁清掉
    fs.writeFileSync(`${stateFile}.lock`, 'someone', 'utf8');
    const t0 = Date.now();
    // retries/waitMs 必须放在 lock 里才会传给 withFileLock（放顶层会被忽略）
    const r = withState(stateFile, (st) => { st.waited = true; }, { lock: { retries: 5, waitMs: 20, staleMs: 60_000 } });
    const elapsed = Date.now() - t0;
    ok('新锁不会被误清（等满重试后报超时）', r.ok === false && elapsed >= 80, `${r.ok} ${elapsed}ms`);
    ok('超时错误明确带 ELOCKTIMEOUT', r.code === 'ELOCKTIMEOUT' || /超时/.test(r.error || ''), JSON.stringify(r));
    fs.unlinkSync(`${stateFile}.lock`);
  }

  console.log('\n【④ 原子替换失败 → 旧文件仍然完整】');
  {
    const { withState } = await import('../src/state-store.js');
    const good = read();
    const origRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EBUSY: 文件被占用'); e.code = 'EBUSY'; throw e; };
    let r;
    try {
      r = withState(stateFile, (st) => { st.shouldNotLand = true; });
    } finally {
      fs.renameSync = origRename;
    }
    ok('写入报错而不是假装成功', r.ok === false, JSON.stringify(r));
    const after = read();
    ok('旧文件内容完整（没被写坏）', JSON.stringify(after) === JSON.stringify(good), JSON.stringify(after).slice(0, 120));
    ok('字段没落进去', after.shouldNotLand === undefined);
    // 清理可能残留的 tmp
    for (const f of fs.readdirSync(tmp)) if (f.endsWith('.tmp')) fs.unlinkSync(path.join(tmp, f));
  }

  console.log('\n【⑤ 锁超时明确报错，不静默】');
  {
    const { withState } = await import('../src/state-store.js');
    fs.writeFileSync(`${stateFile}.lock`, 'stuck', 'utf8');
    const r = withState(stateFile, (st) => { st.nope = true; }, { lock: { retries: 3, waitMs: 10, staleMs: 600_000 } });
    ok('返回 ok:false', r.ok === false, JSON.stringify(r));
    ok('错误信息里有"超时"', /超时/.test(r.error || ''), r.error);
    ok('带 ELOCKTIMEOUT 码', r.code === 'ELOCKTIMEOUT', r.code);
    ok('数据没被改', read().nope === undefined);
    fs.unlinkSync(`${stateFile}.lock`);
  }

  console.log('\n【⑥ 坏文件：备份重建而不是静默清空】');
  {
    const { withState } = await import('../src/state-store.js');
    fs.writeFileSync(stateFile, '{ 这不是 json', 'utf8');
    const warnings = [];
    const r = withState(stateFile, (st) => { st.rebuilt = true; }, { fallback: { rebuilt: false }, onWarn: (m) => warnings.push(m) });
    ok('写入成功（用空状态继续）', r.ok === true, JSON.stringify(r));
    ok('给了警告而不是静默', warnings.length >= 1, JSON.stringify(warnings));
    const broken = fs.readdirSync(tmp).filter((f) => f.includes('.broken-'));
    ok('坏文件被备份保留', broken.length >= 1, JSON.stringify(broken));
    ok('新文件可用', read().rebuilt === true);
  }

  console.log('\n【⑦ 版本号递增（并发判断的依据）】');
  {
    const { withState } = await import('../src/state-store.js');
    const v1 = read()._v;
    withState(stateFile, (st) => { st.touch = 1; });
    const v2 = read()._v;
    ok('每次写版本 +1', Number(v2) === Number(v1) + 1, `${v1} → ${v2}`);
    ok('带更新时间戳', typeof read()._updatedAt === 'string');
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
