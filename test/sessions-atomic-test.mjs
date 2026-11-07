// Session 原子写入的验收测试（4.0 · 1.5.5）。
//
// 机主列的七个场景：
//   ① 正常写入        内容完整
//   ② 写入中进程崩溃   旧文件仍可读取
//   ③ 两进程写同一 Session  不丢更新
//   ④ 两进程写不同 Session  正常并发
//   ⑤ Windows EPERM   退避重试后恢复
//   ⑥ 重试耗尽        明确报错，旧文件完整
//   ⑦ 重启恢复        能正常加载历史会话
//
// 特别提醒（机主 2026-11-01）：**原子替换 ≠ 并发安全**。
// 前半段验原子性（不写半截），后半段验并发一致性（不互相覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = pathToFileURL(path.join(ROOT, 'src', 'sessions.js')).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sessions-atomic-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const SDIR = path.join(tmp, 'sessions');
fs.mkdirSync(SDIR, { recursive: true });
const sessions = await import(MOD);
const W = sessions.writeSessionAtomic;

const mkSession = (id, extra = {}) => ({
  id, chatKey: 'private:1', startedAt: Date.now(), status: 'done',
  messages: [{ id: 1, text: 'hello', ts: Date.now() }],
  usage: { inputTokens: 10, outputTokens: 2 }, ...extra
});

function runChild(tag, body) {
  return new Promise((resolve) => {
    const outFile = path.join(tmp, `${tag}.out`);
    const errFile = path.join(tmp, `${tag}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const script = `const S = await import(${JSON.stringify(MOD)});\n${body}\nprocess.exit(0);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
      stdio: ['ignore', out, err],
      windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 120000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out) } catch { /* ignore */ }
      try { fs.closeSync(err) } catch { /* ignore */ }
      let stdout = ''; let stderr = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { stderr = fs.readFileSync(errFile, 'utf8').slice(0, 400); } catch { /* ignore */ }
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  console.log('【① 正常写入：内容完整】');
  {
    const f = path.join(SDIR, 's1.json');
    W(f, mkSession('s1', { big: 'x'.repeat(50000) }));
    const back = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('文件可解析', back.id === 's1');
    ok('大字段完整（50 KB）', back.big.length === 50000);
    ok('没有残留 .tmp', fs.readdirSync(tmp).filter((x) => x.endsWith('.tmp')).length === 0);
    ok('写入了统计', sessions.sessionWriteStats.some((s) => s.label === 'session' && s.ok));
  }

  console.log('\n【② 写入中崩溃：旧文件仍可读，不留半截 JSON】');
  {
    const f = path.join(SDIR, 's2.json');
    W(f, mkSession('s2', { marker: 'before' }));
    const before = fs.readFileSync(f, 'utf8');
    // 让 rename 永远失败 —— 模拟"写完 tmp 后进程挂了/替换失败"
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EIO'); e.code = 'EIO'; throw e; };
    let threw = null;
    try { W(f, mkSession('s2', { marker: 'after' })); } catch (e) { threw = e; } finally { fs.renameSync = orig; }
    const after = fs.readFileSync(f, 'utf8');
    ok('写入抛错（不假装成功）', threw !== null);
    ok('旧文件字节级完整', after === before);
    ok('旧文件能解析', JSON.parse(after).id === 's2');
    for (const x of fs.readdirSync(tmp)) if (x.endsWith('.tmp')) fs.unlinkSync(path.join(tmp, x));
  }

  console.log('\n【③ 两进程写同一个 Session：不丢更新】');
  {
    const f = path.join(SDIR, 's3.json');
    W(f, mkSession('s3', { counter: 0, appended: [] }));
    // 每个子进程：读 → 改 → 写，做 20 次
    const body = `
const FILE = ${JSON.stringify(f)};
for (let i = 0; i < 20; i += 1) {
  // 关键：读-改-写整体在锁内。写在外面读就会互相覆盖（机主强调的那个点）。
  S.mutateSessionAtomic(FILE, (s) => { s.counter = (s.counter || 0) + 1; }, { label: 'race' });
}
process.stdout.write('done');
`;
    const [a, b] = await Promise.all([runChild('r1', body), runChild('r2', body)]);
    ok('两个子进程都跑完', a.code === 0 && b.code === 0 && a.stdout === 'done' && b.stdout === 'done',
      `${a.code}/${b.code} ${a.stderr}${b.stderr}`);
    const final = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok('counter = 40（一笔不丢）', final.counter === 40, `实际 ${final.counter}`);
    ok('文件没坏', final.id === 's3');
  }

  console.log('\n【④ 两进程写不同 Session：正常并发】');
  {
    const f1 = path.join(SDIR, 's4a.json');
    const f2 = path.join(SDIR, 's4b.json');
    W(f1, mkSession('s4a', { n: 0 }));
    W(f2, mkSession('s4b', { n: 0 }));
    const body = (file) => `
const FILE = ${JSON.stringify(file)};
for (let i = 0; i < 15; i += 1) {
  S.mutateSessionAtomic(FILE, (s) => { s.n = (s.n || 0) + 1; }, { label: 'parallel' });
}
process.stdout.write('ok');
`;
    const t0 = Date.now();
    const [a, b] = await Promise.all([runChild('p1', body(f1)), runChild('p2', body(f2))]);
    const elapsed = Date.now() - t0;
    ok('两个子进程都跑完', a.code === 0 && b.code === 0, `${a.code}/${b.code}`);
    ok('两边都 +15', JSON.parse(fs.readFileSync(f1, 'utf8')).n === 15 && JSON.parse(fs.readFileSync(f2, 'utf8')).n === 15);
    ok('并发没串成一条（耗时合理）', elapsed < 30000, `${elapsed}ms`);
  }

  console.log('\n【⑤ Windows EPERM：退避重试后恢复】');
  {
    const f = path.join(SDIR, 's5.json');
    W(f, mkSession('s5', { v: 1 }));
    // 前 3 次 rename 抛 EPERM，之后放行
    const orig = fs.renameSync;
    let calls = 0;
    fs.renameSync = (...args) => {
      calls += 1;
      if (calls <= 3) { const e = new Error('EPERM: 临时占用'); e.code = 'EPERM'; throw e; }
      return orig(...args);
    };
    let threw = null;
    try { W(f, mkSession('s5', { v: 2 })); } catch (e) { threw = e; } finally { fs.renameSync = orig; }
    ok('前 3 次 EPERM 后成功', threw === null, threw?.message);
    ok('新内容落盘了', JSON.parse(fs.readFileSync(f, 'utf8')).v === 2);
    ok('确实重试过', calls >= 4, `rename 调了 ${calls} 次`);
  }

  console.log('\n【⑥ 重试耗尽：明确报错，旧文件完整】');
  {
    const f = path.join(SDIR, 's6.json');
    W(f, mkSession('s6', { marker: 'keep' }));
    const before = fs.readFileSync(f, 'utf8');
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EPERM: 一直占用'); e.code = 'EPERM'; throw e; };
    let threw = null;
    try { W(f, mkSession('s6', { marker: 'lost' })); } catch (e) { threw = e; } finally { fs.renameSync = orig; }
    ok('抛错而不是静默', threw !== null, threw?.message?.slice(0, 60));
    ok('旧文件完整', fs.readFileSync(f, 'utf8') === before);
    ok('失败被记进统计', sessions.sessionWriteStats.some((s) => !s.ok), JSON.stringify(sessions.sessionWriteStats.filter((s) => !s.ok).slice(-1)));
    for (const x of fs.readdirSync(tmp)) if (x.endsWith('.tmp')) fs.unlinkSync(path.join(tmp, x));
  }

  console.log('\n【⑦ 重启恢复：能正常加载历史会话】');
  {
    // 造 3 个会话文件 + 一个孤立的 .tmp 残留
    for (let i = 0; i < 3; i += 1) {
      W(path.join(SDIR, `hist${i}.json`), mkSession(`hist${i}`, { n: i }));
    }
    fs.writeFileSync(path.join(SDIR, 'hist0.json.99999.tmp'), '{ 半截', 'utf8');
    // 用 SessionRegistry 重建索引（启动时会扫目录）
    const reg = new sessions.SessionRegistry();
    const list = reg.list ? reg.list() : (reg.index || []);
    ok('加载到了历史会话', list.length >= 3, `实际 ${list.length}`);
    ok('孤立的 .tmp 没被当成会话', !list.some((x) => String(x.id).includes('.tmp')), JSON.stringify(list.map((x) => x.id)));
    ok('每条都有 id 和 chatKey', list.every((x) => x.id && x.chatKey));
    fs.unlinkSync(path.join(SDIR, 'hist0.json.99999.tmp'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
