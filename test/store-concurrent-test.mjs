// W5 验收：双进程隔离下的并发安全（2026-11-03）。
//
// 机主验收清单（12 项）：
//   并发新增 / 同 mid 幂等 / null mid / 删除不复活 / 撤回并发 / clear 并发 /
//   修改并发 / 锁超时 / 坏文件保护 / 锁持有者异常退出 / 原子写失败 / 缓存外部失效
//
// 除第 11 项（原子写失败需要打桩 fs.renameSync，只能在本进程做）外，
// 全部用**两个独立子进程** + 隔离临时数据目录。不启动真实机器人、不碰生产 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-concurrent-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const MESSAGES = path.join(dataDir, 'messages');
fs.mkdirSync(MESSAGES, { recursive: true });

const { ChatStore } = await import('../src/store.js');
const STORE_MOD = new URL('../src/store.js', import.meta.url).href;
const LOCK_MOD = new URL('../src/file-lock.js', import.meta.url).href;

const c = createChecker('W5 双进程并发验收');

const fileOf = (key) => path.join(MESSAGES, `${key.replace(':', '_')}.json`);
const readDisk = (key) => JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
const seed = (key, messages = [], nextLocalId = 1) => {
  fs.writeFileSync(fileOf(key), JSON.stringify({ chatKey: key, nextLocalId, messages }, null, 1), 'utf8');
};
const msg = (id, mid, text, extra = {}) => ({
  id, mid, ts: 1700000000000 + id, senderId: 'u', senderName: 'u',
  text, self: false, read: true, reply: null, media: [], ...extra
});

function runChild(tag, body) {
  return new Promise((resolve) => {
    const outFile = path.join(dataDir, `${tag}.out`);
    const errFile = path.join(dataDir, `${tag}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
      cwd: process.cwd(), env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
      stdio: ['ignore', out, err], windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 120000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* ignore */ }
      try { fs.closeSync(err); } catch { /* ignore */ }
      resolve({
        code,
        out: (() => { try { return fs.readFileSync(outFile, 'utf8'); } catch { return ''; } })(),
        err: (() => { try { return fs.readFileSync(errFile, 'utf8').slice(0, 400); } catch { return ''; } })()
      });
    });
  });
}

/** 子进程脚本：导入 ChatStore，sleep 一小段让两个进程真正同场，再执行 actions。 */
const worker = (actions) => `
const { ChatStore } = await import(${JSON.stringify(STORE_MOD)});
const s = new ChatStore(0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(40);
${actions}
process.stdout.write('ok');
`;

try {
  c.section('① 并发新增：A/B 各 50 条，一条不丢');
  {
    seed('group:c1');
    const [a, b] = await Promise.all([
      runChild('c1a', worker(`
for (let i = 0; i < 50; i++) await s.appendIncoming('group:c1', { mid: i + 1, ts: Date.now() + i, senderId: 'a', senderName: 'A', text: 'A-' + i });`)),
      runChild('c1b', worker(`
for (let i = 0; i < 50; i++) await s.appendIncoming('group:c1', { mid: 100 + i, ts: Date.now() + i, senderId: 'b', senderName: 'B', text: 'B-' + i });`))
    ]);
    await c.check('两个子进程都正常退出', () => {
      if (a.code !== 0 || b.code !== 0 || a.out !== 'ok' || b.out !== 'ok') throw new Error(`${a.code}/${b.code} ${a.err}${b.err}`);
    });
    await c.check('总数 100', () => {
      if (readDisk('group:c1').messages.length !== 100) throw new Error(`len=${readDisk('group:c1').messages.length}`);
    });
    await c.check('id 连续 1..100 无重复', () => {
      const ids = readDisk('group:c1').messages.map((m) => m.id).sort((x, y) => x - y);
      for (let i = 0; i < 100; i++) if (ids[i] !== i + 1) throw new Error(`第 ${i} 位是 ${ids[i]}`);
    });
    await c.check('A/B 各 50 条都在', () => {
      const texts = readDisk('group:c1').messages.map((m) => m.text);
      if (texts.filter((t) => t.startsWith('A-')).length !== 50) throw new Error('A 不全');
      if (texts.filter((t) => t.startsWith('B-')).length !== 50) throw new Error('B 不全');
    });
  }

  c.section('② 同 mid 幂等：两进程同时收到同一条事件');
  {
    seed('group:c2');
    const body = worker(`await s.appendIncoming('group:c2', { mid: 999, ts: 1700000001000, senderId: 'x', senderName: 'X', text: '同一条' });`);
    const [a, b] = await Promise.all([runChild('c2a', body), runChild('c2b', body)]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code} ${a.err}${b.err}`);
    });
    await c.check('只保留 1 条', () => {
      if (readDisk('group:c2').messages.length !== 1) throw new Error(`len=${readDisk('group:c2').messages.length}`);
    });
  }

  c.section('③ null mid：不参与判重，两条都追加');
  {
    seed('group:c3');
    const [a, b] = await Promise.all([
      runChild('c3a', worker(`await s.appendIncoming('group:c3', { mid: null, ts: 1700000002000, senderId: 'a', senderName: 'A', text: '拍一拍A' });`)),
      runChild('c3b', worker(`await s.appendIncoming('group:c3', { mid: null, ts: 1700000002000, senderId: 'b', senderName: 'B', text: '拍一拍B' });`))
    ]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code}`);
    });
    await c.check('两条都在', () => {
      if (readDisk('group:c3').messages.length !== 2) throw new Error(`len=${readDisk('group:c3').messages.length}`);
    });
  }

  c.section('④ 删除不复活：A 删 1-10，B 同时追加 5 条');
  {
    seed('group:c4', Array.from({ length: 50 }, (_, i) => msg(i + 1, i + 1, `old-${i + 1}`)), 51);
    const [a, b] = await Promise.all([
      runChild('c4a', worker(`await s.removeByLocalIds('group:c4', [1,2,3,4,5,6,7,8,9,10]);`)),
      runChild('c4b', worker(`
for (let i = 0; i < 5; i++) await s.appendIncoming('group:c4', { mid: 1001 + i, ts: Date.now() + i, senderId: 'b', senderName: 'B', text: 'new-' + i });`))
    ]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code} ${a.err}${b.err}`);
    });
    await c.check('被删的 1-10 没有复活', () => {
      const ids = readDisk('group:c4').messages.map((m) => m.id);
      for (let i = 1; i <= 10; i++) if (ids.includes(i)) throw new Error(`id ${i} 复活`);
    });
    await c.check('总数 45（40 旧 + 5 新）', () => {
      if (readDisk('group:c4').messages.length !== 45) throw new Error(`len=${readDisk('group:c4').messages.length}`);
    });
    await c.check('B 的 5 条新消息都在', () => {
      const texts = readDisk('group:c4').messages.map((m) => m.text);
      if (texts.filter((t) => t.startsWith('new-')).length !== 5) throw new Error('新消息不全');
    });
  }

  c.section('⑤ 撤回并发：A 撤回 mid=5，B 同时追加');
  {
    seed('group:c5', Array.from({ length: 10 }, (_, i) => msg(i + 1, i + 1, `m-${i + 1}`)), 11);
    const [a, b] = await Promise.all([
      runChild('c5a', worker(`await s.markRecalled('group:c5', 5);`)),
      runChild('c5b', worker(`
for (let i = 0; i < 5; i++) await s.appendIncoming('group:c5', { mid: 2001 + i, ts: Date.now() + i, senderId: 'b', senderName: 'B', text: 'late-' + i });`))
    ]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code}`);
    });
    await c.check('mid=5 仍标记撤回', () => {
      const m = readDisk('group:c5').messages.find((x) => String(x.mid) === '5');
      if (!m || m.recalled !== true) throw new Error(JSON.stringify(m));
    });
    await c.check('新消息 5 条都在', () => {
      const texts = readDisk('group:c5').messages.map((m) => m.text);
      if (texts.filter((t) => t.startsWith('late-')).length !== 5) throw new Error('新消息不全');
    });
  }

  c.section('⑥ clear 并发：A 清空，B 同时追加（不变量：旧消息不可能残留）');
  {
    seed('group:c6', Array.from({ length: 50 }, (_, i) => msg(i + 1, i + 1, `old-${i + 1}`)), 51);
    const [a, b] = await Promise.all([
      runChild('c6a', worker(`await s.clearChat('group:c6');`)),
      runChild('c6b', worker(`
for (let i = 0; i < 3; i++) await s.appendIncoming('group:c6', { mid: 3001 + i, ts: Date.now() + i, senderId: 'b', senderName: 'B', text: 'after-' + i });`))
    ]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code}`);
    });
    await c.check('旧消息一条都不剩', () => {
      const texts = readDisk('group:c6').messages.map((m) => m.text);
      if (texts.some((t) => t.startsWith('old-'))) throw new Error(texts.join('|'));
    });
    await c.check('B 的 3 条在 0~3 之间（取决于与 clear 的先后）', () => {
      const n = readDisk('group:c6').messages.filter((m) => m.text.startsWith('after-')).length;
      if (n > 3) throw new Error(`n=${n}`);
    });
    await c.check('nextLocalId 没被重置', () => {
      if (readDisk('group:c6').nextLocalId < 51) throw new Error(`next=${readDisk('group:c6').nextLocalId}`);
    });
  }

  c.section('⑦ 修改并发：A 改 text，B 补 media（各改各的字段）');
  {
    seed('group:c7', [msg(1, 7, '旧文本')], 2);
    const [a, b] = await Promise.all([
      runChild('c7a', worker(`await s.updateByMid('group:c7', 7, { text: 'A改的文本' });`)),
      runChild('c7b', worker(`await s.updateByMid('group:c7', 7, { appendMedia: [{ kind: 'image', url: 'http://x/1.png', summary: '[图片]' }] });`))
    ]);
    await c.check('两个都跑完', () => {
      if (a.code !== 0 || b.code !== 0) throw new Error(`${a.code}/${b.code}`);
    });
    await c.check('text 与 media 都保留', () => {
      const m = readDisk('group:c7').messages[0];
      if (m.text !== 'A改的文本') throw new Error(`text=${m.text}`);
      if (!Array.isArray(m.media) || m.media.length !== 1) throw new Error(`media=${JSON.stringify(m.media)}`);
    });
  }

  c.section('⑧ 锁超时：子进程持锁 5 秒，主进程 2 秒超时且不写盘');
  {
    const key = 'group:c8';
    seed(key);
    const heldFile = path.join(dataDir, 'c8.held');
    const body = `
const { withFileLock } = await import(${JSON.stringify(LOCK_MOD)});
const fs = await import('node:fs');
withFileLock(${JSON.stringify(fileOf(key))}, () => {
  fs.writeFileSync(${JSON.stringify(heldFile)}, 'held');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000);
});`;
    const holder = runChild('c8h', body);
    // 等它真的拿到锁
    const t0 = Date.now();
    while (!fs.existsSync(heldFile) && Date.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const store = new ChatStore(0);
    const before = fs.readFileSync(fileOf(key), 'utf8');
    let code = '';
    try {
      await store.appendSelf(key, { text: '写不进去', ts: Date.now() });
    } catch (e) {
      code = e.code;
    }
    await c.check('主进程抛 ELOCKTIMEOUT', () => {
      if (code !== 'ELOCKTIMEOUT') throw new Error(`code=${code}`);
    });
    await c.check('磁盘字节不变', () => {
      if (fs.readFileSync(fileOf(key), 'utf8') !== before) throw new Error('被写了');
    });
    const r = await holder;
    await c.check('持锁子进程正常结束', () => {
      if (r.code !== 0) throw new Error(`code=${r.code} ${r.err}`);
    });
    await c.check('锁已释放', () => {
      if (fs.existsSync(`${fileOf(key)}.lock`)) throw new Error('lock 还在');
    });
  }

  c.section('⑨ 坏文件保护：两个进程同时写 → 都拒绝，原文件不动');
  {
    const key = 'group:c9';
    const raw = '{ 坏掉的存档';
    fs.writeFileSync(fileOf(key), raw, 'utf8');
    const body = `
const { ChatStore } = await import(${JSON.stringify(STORE_MOD)});
const s = new ChatStore(0);
try {
  await s.appendIncoming('group:c9', { mid: 1, ts: 1, senderId: 'x', senderName: 'X', text: 'x' });
  process.stdout.write('WROTE');
} catch (e) {
  process.stdout.write('ERR:' + e.code);
}`;
    const [a, b] = await Promise.all([runChild('c9a', body), runChild('c9b', body)]);
    await c.check('两个都报 ECHAT_CORRUPTED', () => {
      if (a.out !== 'ERR:ECHAT_CORRUPTED' || b.out !== 'ERR:ECHAT_CORRUPTED') throw new Error(`${a.out}/${b.out}`);
    });
    await c.check('原文件字节不变', () => {
      if (fs.readFileSync(fileOf(key), 'utf8') !== raw) throw new Error('被覆盖');
    });
    await c.check('只产生 1 份备份', () => {
      const n = fs.readdirSync(MESSAGES).filter((f) => f.startsWith('group_c9.json.broken-')).length;
      if (n !== 1) throw new Error(`备份数 ${n}`);
    });
  }

  c.section('⑩ 锁持有者异常退出：A 拿锁后 exit(9)，B 回收陈旧锁继续写');
  {
    const key = 'group:c10';
    seed(key);
    const body = `
const { withFileLock } = await import(${JSON.stringify(LOCK_MOD)});
withFileLock(${JSON.stringify(fileOf(key))}, () => { process.exit(9); });`;
    const a = await runChild('c10a', body);
    await c.check('A 以非 0 退出（模拟崩溃）', () => {
      if (a.code === 0) throw new Error('没崩');
    });
    await c.check('锁文件残留（崩溃没跑 finally）', () => {
      if (!fs.existsSync(`${fileOf(key)}.lock`)) throw new Error('没有 lock');
    });
    const store = new ChatStore(0);
    await c.check('B 能回收陈旧锁并写入', async () => {
      await store.appendSelf(key, { text: '崩溃后写的', ts: Date.now() });
      if (readDisk(key).messages.length !== 1) throw new Error('没写进去');
    });
    await c.check('没有残留 lock', () => {
      if (fs.existsSync(`${fileOf(key)}.lock`)) throw new Error('lock 还在');
    });
  }

  c.section('⑪ 原子写失败：抛错，旧文件字节不变（本进程打桩 rename）');
  {
    const key = 'group:c11';
    seed(key, [msg(1, 1, '旧内容')], 2);
    const store = new ChatStore(0);
    const before = fs.readFileSync(fileOf(key), 'utf8');
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EBUSY: 文件被占用'); e.code = 'EBUSY'; throw e; };
    let threw = null;
    try {
      await store.appendSelf(key, { text: '写不进去', ts: Date.now() });
    } catch (e) {
      threw = e;
    } finally {
      fs.renameSync = orig;
    }
    await c.check('写入抛错', () => {
      if (!threw) throw new Error('没抛');
    });
    await c.check('旧文件字节完整', () => {
      if (fs.readFileSync(fileOf(key), 'utf8') !== before) throw new Error('被改了');
    });
    await c.check('没有 .tmp 残留', () => {
      const n = fs.readdirSync(MESSAGES).filter((f) => f.endsWith('.tmp')).length;
      if (n) throw new Error(`残留 ${n}`);
    });
  }

  c.section('⑫ 缓存外部失效：本进程读 → 子进程写 → 本进程读到（衔接 W4）');
  {
    const key = 'group:c12';
    seed(key);
    const store = new ChatStore(0);
    await c.check('先读到空', () => {
      if (store.recent(key, { limit: 5 }).length !== 0) throw new Error('不是空');
    });
    const r = await runChild('c12', worker(`await s.appendSelf('group:c12', { text: '外部', ts: Date.now() });`));
    await c.check('子进程写成功', () => {
      if (r.code !== 0) throw new Error(String(r.code));
    });
    await c.check('本进程立刻读到', () => {
      if (!store.recent(key, { limit: 5 }).some((m) => m.text === '外部')) throw new Error('没看到');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
