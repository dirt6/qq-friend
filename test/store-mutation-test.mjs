// W2 专项：锁内 mutation API 的单进程语义 + 失败路径（2026-11-03）。
//
// 覆盖：
//   · 11 个写方法在锁内读改写后的返回值/落盘语义与旧版一致；
//   · 同 mid 幂等（时间窗内重复投递只保留一条）；
//   · 同 mid 超出窗口 → 视为新消息（宁可重复，不可静默丢弃）；
//   · null mid 不参与判重；
//   · 锁被活进程持有时 → ELOCKTIMEOUT，且磁盘不变；
//   · 原子写失败 → 抛错，旧文件字节不变；
//   · 写前重读磁盘：外部写入的新消息不会被本进程的旧缓存覆盖。
//
// 只碰临时 DATA_DIR，不碰生产 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-mutation-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { ChatStore } = await import('../src/store.js');

const MESSAGES = path.join(dataDir, 'messages');
const c = createChecker('W2 锁内 mutation API');

const fileOf = (key) => path.join(MESSAGES, `${key.replace(':', '_')}.json`);
const readDisk = (key) => JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
const sha = (key) => {
  try { return fs.readFileSync(fileOf(key), 'utf8'); } catch { return null; }
};

function readChild(tag, body) {
  return new Promise((resolve) => {
    const outFile = path.join(dataDir, `${tag}.out`);
    const errFile = path.join(dataDir, `${tag}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
      cwd: process.cwd(), env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
      stdio: ['ignore', out, err], windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
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

try {
  c.section('1. appendIncoming / appendSelf：入库、id 递增、未读口径');
  {
    const store = new ChatStore(0);
    const e1 = await store.appendIncoming('group:1', { mid: 100, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '你好' });
    const e2 = await store.appendSelf('group:1', { mid: 101, text: '我是机器人', ts: Date.now() });
    await c.check('id 从 1 起递增', () => {
      if (e1.id !== 1 || e2.id !== 2) throw new Error(`id=${e1.id}/${e2.id}`);
    });
    await c.check('未读只算他人消息', () => {
      const meta = store.getChatMeta('group:1');
      if (meta.total !== 2) throw new Error(`total=${meta.total}`);
      if (meta.unread !== 1) throw new Error(`unread=${meta.unread}`);
    });
    await c.check('磁盘 nextLocalId 已推进', () => {
      const disk = readDisk('group:1');
      if (disk.nextLocalId !== 3) throw new Error(`nextLocalId=${disk.nextLocalId}`);
    });
  }

  c.section('2. 同 mid 幂等（窗口内）与超窗追加');
  {
    const store = new ChatStore(0);
    const ts = Date.now();
    const a = await store.appendIncoming('group:2', { mid: 500, ts, senderId: 'u1', senderName: '甲', text: '一条' });
    const mtime1 = fs.statSync(fileOf('group:2')).mtimeMs;
    const b = await store.appendIncoming('group:2', { mid: 500, ts: ts + 1000, senderId: 'u1', senderName: '甲', text: '一条' });
    await c.check('窗口内同 mid 只保留一条', () => {
      if (store.recent('group:2').length !== 1) throw new Error('条数不是 1');
    });
    await c.check('幂等命中返回同一个 id', () => {
      if (a.id !== b.id) throw new Error(`${a.id} vs ${b.id}`);
    });
    await c.check('幂等命中不重写磁盘（mtime 不变）', () => {
      const mtime2 = fs.statSync(fileOf('group:2')).mtimeMs;
      if (mtime2 !== mtime1) throw new Error(`${mtime1} -> ${mtime2}`);
    });
    const c1 = await store.appendIncoming('group:2', { mid: 500, ts: ts + 11 * 60 * 1000, senderId: 'u1', senderName: '甲', text: '一条' });
    await c.check('超窗同 mid 视为新消息（2 条）', () => {
      if (store.recent('group:2').length !== 2) throw new Error(`条数 ${store.recent('group:2').length}`);
      if (c1.id === a.id) throw new Error('id 没变');
    });
    await c.check('null mid 不参与判重（两条都在）', async () => {
      await store.appendIncoming('group:3', { mid: null, ts, senderId: 'u1', senderName: '甲', text: '[拍一拍]' });
      await store.appendIncoming('group:3', { mid: null, ts, senderId: 'u1', senderName: '甲', text: '[拍一拍]' });
      if (store.recent('group:3').length !== 2) throw new Error('条数不是 2');
    });
  }

  c.section('3. 读/写方法语义');
  {
    const store = new ChatStore(0);
    const t0 = Date.now() - 60000;
    await store.appendIncoming('group:4', { mid: 1, ts: t0, senderId: 'u1', senderName: '甲', text: 'a' });
    await store.appendIncoming('group:4', { mid: 2, ts: t0 + 1000, senderId: 'u2', senderName: '乙', text: 'b' });
    await store.appendIncoming('group:4', { mid: 3, ts: t0 + 2000, senderId: 'u2', senderName: '乙', text: 'c' });
    const drained = await store.drainUnread('group:4');
    await c.check('drainUnread 取走全部未读并清零', () => {
      if (drained.length !== 3) throw new Error(`drained=${drained.length}`);
      if (store.unreadCount('group:4') !== 0) throw new Error('未读没清零');
    });
    const n = await store.markUnreadInWindow('group:4', t0 + 500, t0 + 2500);
    await c.check('markUnreadInWindow 恢复窗口内 3 条（窗口向前放宽 5 分钟）', () => {
      if (n !== 3) throw new Error(`n=${n}`);
    });
    const marked = await store.markEntryRead('group:4', drained[0].id);
    await c.check('markEntryRead 单条标记', () => {
      if (marked !== true) throw new Error('没标上');
      if (store.unreadCount('group:4') !== 2) throw new Error(`unread=${store.unreadCount('group:4')}`);
    });
    const all = await store.markAllRead('group:4');
    await c.check('markAllRead 清零并返回条数', () => {
      if (all !== 2) throw new Error(`all=${all}`);
      if (store.unreadCount('group:4') !== 0) throw new Error('没清零');
    });
    await c.check('updateByMid 改文本', async () => {
      const ok = await store.updateByMid('group:4', 1, { text: '改过的' });
      if (!ok) throw new Error('返回 false');
      if (store.findByMid('group:4', 1).text !== '改过的') throw new Error('文本没改');
    });
    await c.check('updateByMid 不存在的 mid 不写盘', async () => {
      const before = sha('group:4');
      const ok = await store.updateByMid('group:4', 9999, { text: 'x' });
      if (ok !== false) throw new Error('应返回 false');
      if (sha('group:4') !== before) throw new Error('磁盘被改了');
    });
    await c.check('markRecalled 标记撤回并置已读', async () => {
      await store.markUnreadInWindow('group:4', 0, Date.now());
      const ok = await store.markRecalled('group:4', 2);
      const m = store.findByMid('group:4', 2);
      if (!ok || !m.recalled || !m.read) throw new Error(`ok=${ok} recalled=${m?.recalled} read=${m?.read}`);
    });
    await c.check('removeByLocalIds 精确删除', async () => {
      const target = store.recent('group:4', { limit: 10 })[0];
      const removed = await store.removeByLocalIds('group:4', [target.id]);
      if (removed !== 1) throw new Error(`removed=${removed}`);
      if (store.findByLocalId('group:4', target.id)) throw new Error('还能查到');
    });
    await c.check('clearChat 清空但保留 nextLocalId', async () => {
      const before = readDisk('group:4').nextLocalId;
      const removed = await store.clearChat('group:4');
      const disk = readDisk('group:4');
      if (removed === 0) throw new Error('没删');
      if (disk.messages.length !== 0) throw new Error('没清空');
      if (disk.nextLocalId !== before) throw new Error(`nextLocalId 变了 ${before} -> ${disk.nextLocalId}`);
    });
    await c.check('trim：超过上限裁掉最老的', async () => {
      const s = new ChatStore(5);
      for (let i = 0; i < 8; i++) await s.appendIncoming('group:5', { mid: 10 + i, ts: Date.now() + i, senderId: 'u', senderName: 'x', text: `m${i}` });
      const r = s.recent('group:5', { limit: 100 });
      if (r.length !== 5) throw new Error(`length=${r.length}`);
      if (r[0].text !== 'm3') throw new Error(`最老的应是 m3，实际 ${r[0].text}`);
    });
  }

  c.section('4. 写前重读磁盘：外部写入不被本进程缓存覆盖');
  {
    const store = new ChatStore(0);
    await store.appendIncoming('group:6', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '本进程写的' });
    // 模拟另一个进程直接往磁盘追加一条（绕过本进程缓存）
    const disk = readDisk('group:6');
    disk.messages.push({ id: disk.nextLocalId++, mid: 2, ts: Date.now(), senderId: 'u2', senderName: '乙', text: '别的进程写的', self: false, read: false, reply: null, media: [] });
    fs.writeFileSync(fileOf('group:6'), JSON.stringify(disk, null, 1), 'utf8');
    await store.appendSelf('group:6', { mid: 3, text: '我又说一句', ts: Date.now() });
    await c.check('磁盘上三条都在（外部消息没被覆盖）', () => {
      const after = readDisk('group:6');
      const texts = after.messages.map((m) => m.text);
      if (!texts.includes('别的进程写的')) throw new Error(`丢了：${texts.join('|')}`);
      if (after.messages.length !== 3) throw new Error(`条数 ${after.messages.length}`);
    });
    await c.check('本进程缓存同步为磁盘最新状态', () => {
      if (!store.recent('group:6', { limit: 10 }).some((m) => m.text === '别的进程写的')) throw new Error('缓存里没有');
    });
  }

  c.section('5. 锁超时：活进程持锁 → ELOCKTIMEOUT，磁盘不变');
  {
    const store = new ChatStore(0);
    await store.appendIncoming('group:7', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '底稿' });
    const before = sha('group:7');
    const lock = `${fileOf('group:7')}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'held-by-live-process', startedAt: Date.now(), host: '' }), 'utf8');
    const t0 = Date.now();
    let code = '';
    try {
      await store.appendSelf('group:7', { text: '写不进去', ts: Date.now() });
    } catch (e) {
      code = e.code;
    }
    const elapsed = Date.now() - t0;
    fs.unlinkSync(lock);
    await c.check('抛 ELOCKTIMEOUT', () => {
      if (code !== 'ELOCKTIMEOUT') throw new Error(`code=${code}`);
    });
    await c.check('等满预算（≈2 秒）而不是立刻放弃', () => {
      if (elapsed < 1500) throw new Error(`只等了 ${elapsed}ms`);
    });
    await c.check('磁盘字节不变（没绕过锁写）', () => {
      if (sha('group:7') !== before) throw new Error('磁盘被改了');
    });
    await c.check('没有残留 lock', () => {
      if (fs.existsSync(lock)) throw new Error('lock 还在');
    });
  }

  c.section('6. 原子写失败：抛错，旧文件字节不变');
  {
    const store = new ChatStore(0);
    await store.appendIncoming('group:8', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '旧内容' });
    const before = sha('group:8');
    const orig = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EBUSY: 文件被占用'); e.code = 'EBUSY'; throw e; };
    let threw = null;
    try {
      await store.appendSelf('group:8', { text: '写一半失败', ts: Date.now() });
    } catch (e) {
      threw = e;
    } finally {
      fs.renameSync = orig;
    }
    await c.check('写入抛错（不假装成功）', () => {
      if (!threw) throw new Error('没抛');
    });
    await c.check('旧文件字节完整', () => {
      if (sha('group:8') !== before) throw new Error('旧文件被改了');
    });
    await c.check('没有 .tmp 残留', () => {
      const leftovers = fs.readdirSync(MESSAGES).filter((f) => f.endsWith('.tmp'));
      if (leftovers.length) throw new Error(leftovers.join(','));
    });
    await c.check('恢复后能继续写', async () => {
      await store.appendSelf('group:8', { text: '恢复后写的', ts: Date.now() });
      if (readDisk('group:8').messages.length !== 2) throw new Error('没写进去');
    });
  }

  c.section('7. 损坏文件：写路径拒绝覆盖（衔接 W1）');
  {
    const store = new ChatStore(0);
    fs.writeFileSync(fileOf('group:9'), '{"messages": [ 半截', 'utf8');
    const before = sha('group:9');
    let code = '';
    try {
      await store.appendIncoming('group:9', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: 'x' });
    } catch (e) {
      code = e.code;
    }
    await c.check('appendIncoming 抛 ECHAT_CORRUPTED', () => {
      if (code !== 'ECHAT_CORRUPTED') throw new Error(`code=${code}`);
    });
    await c.check('原文件字节不变', () => {
      if (sha('group:9') !== before) throw new Error('被覆盖了');
    });
    await c.check('有备份', () => {
      if (!fs.readdirSync(MESSAGES).some((f) => f.startsWith('group_9.json.broken-'))) throw new Error('没有备份');
    });
  }

  c.section('8. 子进程也能写（锁文件跨进程互斥的最小验证）');
  {
    const store = new ChatStore(0);
    await store.appendIncoming('group:10', { mid: 1, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '主进程' });
    const body = `
const { ChatStore } = await import(${JSON.stringify(new URL('../src/store.js', import.meta.url).href)});
const s = new ChatStore(0);
await s.appendSelf('group:10', { text: '子进程', ts: Date.now() });
process.stdout.write('ok');
`;
    const r = await readChild('sub', body);
    await c.check('子进程写成功', () => {
      if (r.code !== 0 || r.out !== 'ok') throw new Error(`code=${r.code} out=${r.out} err=${r.err}`);
    });
    await c.check('主进程子进程两条都在', () => {
      const texts = readDisk('group:10').messages.map((m) => m.text);
      if (!texts.includes('主进程') || !texts.includes('子进程')) throw new Error(texts.join('|'));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
