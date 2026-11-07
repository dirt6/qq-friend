// W4 专项：内存缓存失效与读路径一致性（2026-11-03）。
//
// 背景：`#state` 以前首次读盘后永不失效 —— 另一个进程写入/删除后，
// 本进程的展示与上下文一直是旧的（虽然写路径已经安全，但读路径会"复活"已删消息）。
// 现在每次读 stat 一次：mtime/size 变了就重读。
//
// 本测试用**子进程真写**来制造外部变化，只碰临时 DATA_DIR。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-cache-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const MESSAGES = path.join(dataDir, 'messages');
fs.mkdirSync(MESSAGES, { recursive: true });

const { ChatStore } = await import('../src/store.js');
const STORE_MOD = new URL('../src/store.js', import.meta.url).href;

const c = createChecker('W4 缓存失效');
const sharedStore = new ChatStore(0);

const fileOf = (key) => path.join(MESSAGES, `${key.replace(':', '_')}.json`);
const readDisk = (key) => JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
const seed = (key, messages = [], nextLocalId = 1) => {
  fs.writeFileSync(fileOf(key), JSON.stringify({ chatKey: key, nextLocalId, messages }, null, 1), 'utf8');
};
const backups = (key) => fs.readdirSync(MESSAGES).filter((f) => f.startsWith(`${key.replace(':', '_')}.json.broken-`));

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
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* ignore */ }
      try { fs.closeSync(err); } catch { /* ignore */ }
      resolve({
        code,
        out: (() => { try { return fs.readFileSync(outFile, 'utf8'); } catch { return ''; } })(),
        err: (() => { try { return fs.readFileSync(errFile, 'utf8').slice(0, 300); } catch { return ''; } })()
      });
    });
  });
}

try {
  c.section('1. 另一个进程新增 → 本进程读得到');
  {
    seed('group:1');
    const store = sharedStore;
    await c.check('初始 0 条（缓存空会话）', () => {
      if (store.recent('group:1', { limit: 10 }).length !== 0) throw new Error('不是 0');
    });
    const r = await runChild('add', `
const { ChatStore } = await import(${JSON.stringify(STORE_MOD)});
const s = new ChatStore(0);
await s.appendSelf('group:1', { text: '外部写的', ts: Date.now() });
process.stdout.write('ok');
`);
    await c.check('子进程写成功', () => {
      if (r.code !== 0 || r.out !== 'ok') throw new Error(`code=${r.code} err=${r.err}`);
    });
    await c.check('本进程 recent 立刻看到外部消息', () => {
      if (!store.recent('group:1', { limit: 10 }).some((m) => m.text === '外部写的')) throw new Error('没看到');
    });
    await c.check('getChatMeta 同步更新', () => {
      const meta = store.getChatMeta('group:1');
      if (meta.total !== 1) throw new Error(`total=${meta.total}`);
    });
  }

  c.section('2. 另一个进程删除文件 → 本进程读回空（不回退到旧缓存）');
  {
    fs.unlinkSync(fileOf('group:1'));
    await c.check('recent 返回空', () => {
      if (sharedStore.recent('group:1', { limit: 10 }).length !== 0) throw new Error('仍能看到旧消息');
    });
  }

  c.section('3. 另一个进程改文本 → 本进程读到新文本');
  {
    seed('group:2', [{ id: 1, mid: 11, ts: 1, senderId: 'u', senderName: 'n', text: '旧文本', self: false, read: true }], 2);
    const store = new ChatStore(0);
    await c.check('先缓存旧文本', () => {
      if (store.recent('group:2', { limit: 5 })[0].text !== '旧文本') throw new Error('不对');
    });
    const d = readDisk('group:2');
    d.messages[0].text = '被外部改过的文本';
    fs.writeFileSync(fileOf('group:2'), JSON.stringify(d, null, 1), 'utf8');
    await c.check('读到外部改动', () => {
      if (store.recent('group:2', { limit: 5 })[0].text !== '被外部改过的文本') throw new Error(store.recent('group:2', { limit: 5 })[0].text);
    });
  }

  c.section('4. 外部把文件写坏 → 读回空 + 只备份一次 + 原文件不动');
  {
    const key = 'group:3';
    const raw = '{ 外部写坏的 JSON';
    fs.writeFileSync(fileOf(key), raw, 'utf8');
    const store = new ChatStore(0);
    await c.check('读回空（不崩）', () => {
      if (store.recent(key, { limit: 5 }).length !== 0) throw new Error('不是空');
    });
    await c.check('备份 1 份', () => {
      if (backups(key).length !== 1) throw new Error(`备份数 ${backups(key).length}`);
    });
    store.recent(key, { limit: 5 });
    store.getChatMeta(key);
    await c.check('mtime 未变的重复读不产生新备份', () => {
      if (backups(key).length !== 1) throw new Error(`备份数 ${backups(key).length}`);
    });
    await c.check('原文件字节不变', () => {
      if (fs.readFileSync(fileOf(key), 'utf8') !== raw) throw new Error('被改了');
    });
  }

  c.section('5. 本进程写后缓存立即一致');
  {
    seed('group:4');
    const store = new ChatStore(0);
    await store.appendIncoming('group:4', { mid: 41, ts: Date.now(), senderId: 'u1', senderName: '甲', text: '自己写的' });
    await c.check('写后 recent 立刻可见', () => {
      if (!store.recent('group:4', { limit: 5 }).some((m) => m.text === '自己写的')) throw new Error('看不到');
    });
    await c.check('未读计数即时', () => {
      if (store.unreadCount('group:4') !== 1) throw new Error(`unread=${store.unreadCount('group:4')}`);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
