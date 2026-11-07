// W1 专项：聊天存档损坏保护（2026-11-03）。
//
// 机主拍板的边界：
//   · 文件不存在与文件损坏必须区别处理；
//   · 坏文件备份失败时必须停止写入；
//   · 所有失败路径都必须验证不会覆盖原有聊天记录。
//
// 本测试只碰临时 DATA_DIR，不碰生产 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-corrupt-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { ChatStore, loadChat, loadChatForWrite } = await import('../src/store.js');

const MESSAGES = path.join(dataDir, 'messages');
fs.mkdirSync(MESSAGES, { recursive: true });

const c = createChecker('W1 聊天存档损坏保护');

const fileOf = (chatKey) => path.join(MESSAGES, `${chatKey.replace(':', '_')}.json`);
const sha = (f) => {
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
};

/** 该会话的全部 .broken-* 备份。 */
const backups = (chatKey) => fs.readdirSync(MESSAGES)
  .filter((f) => f.startsWith(`${chatKey.replace(':', '_')}.json.broken-`));

try {
  c.section('1. 文件不存在（ENOENT）→ 空会话，不是损坏');
  await c.check('loadChat 返回空状态', () => {
    const st = loadChat('group:1');
    if (!st || st.nextLocalId !== 1 || st.messages.length !== 0) throw new Error(JSON.stringify(st));
  });
  await c.check('没有产生 .broken 备份', () => {
    const n = backups('group:1').length;
    if (n !== 0) throw new Error(`产生了 ${n} 个备份`);
  });
  await c.check('loadChatForWrite 也返回空（新会话可写）', () => {
    const st = loadChatForWrite('group:1');
    if (!st || st.messages.length !== 0) throw new Error(JSON.stringify(st));
  });

  c.section('2. 坏 JSON（读路径）→ 备份 + 空会话 + 原文件不动');
  {
    const key = 'group:2';
    const file = fileOf(key);
    const raw = '{ 这不是 JSON，半截文件';
    fs.writeFileSync(file, raw, 'utf8');
    const store = new ChatStore(0);
    await c.check('recent() 返回空而不是崩溃', () => {
      const list = store.recent(key, { limit: 10 });
      if (list.length !== 0) throw new Error(`返回了 ${list.length} 条`);
    });
    await c.check('生成了 .broken 备份', () => {
      const b = backups(key);
      if (b.length !== 1) throw new Error(`备份数 ${b.length}`);
      if (fs.readFileSync(path.join(MESSAGES, b[0]), 'utf8') !== raw) throw new Error('备份内容不一致');
    });
    await c.check('原文件字节未变（没有被空状态覆盖）', () => {
      if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('原文件被改了');
    });
    await c.check('同 mtime 重复读不产生第二个备份', () => {
      const store2 = new ChatStore(0);
      store2.recent(key, { limit: 10 });
      const b = backups(key);
      if (b.length !== 1) throw new Error(`备份数 ${b.length}`);
    });
  }

  c.section('3. 结构错误（messages 不是数组）→ 同样按损坏处理');
  {
    const key = 'group:3';
    const file = fileOf(key);
    const raw = JSON.stringify({ chatKey: key, nextLocalId: 5, messages: 'nope' });
    fs.writeFileSync(file, raw, 'utf8');
    const store = new ChatStore(0);
    await c.check('读路径当空会话', () => {
      if (store.recent(key).length !== 0) throw new Error('不是空');
    });
    await c.check('产生备份且原文件不变', () => {
      if (backups(key).length !== 1) throw new Error(`备份数 ${backups(key).length}`);
      if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('原文件被改了');
    });
  }

  c.section('4. 坏 JSON（写路径）→ 抛 ECHAT_CORRUPTED，禁止覆盖');
  {
    const key = 'group:4';
    const file = fileOf(key);
    const raw = '{"messages":[{"id":1}] BAD';
    fs.writeFileSync(file, raw, 'utf8');
    await c.expectThrow('loadChatForWrite 抛 ECHAT_CORRUPTED', () => loadChatForWrite(key), /损坏/);
    await c.check('错误码是 ECHAT_CORRUPTED', () => {
      let code = '';
      try { loadChatForWrite(key); } catch (e) { code = e.code; }
      if (code !== 'ECHAT_CORRUPTED') throw new Error(`code=${code}`);
    });
    await c.check('原文件字节未变', () => {
      if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('原文件被改了');
    });
    await c.check('备份只产生一份', () => {
      const b = backups(key);
      if (b.length !== 1) throw new Error(`备份数 ${b.length}`);
    });
  }

  c.section('5. 备份失败 → 停止写入（ECHAT_BACKUP_FAILED）');
  {
    const key = 'group:5';
    const file = fileOf(key);
    const raw = 'not-json-at-all';
    fs.writeFileSync(file, raw, 'utf8');
    const origCopy = fs.copyFileSync;
    fs.copyFileSync = () => { const e = new Error('ENOSPC: 空间不足'); e.code = 'ENOSPC'; throw e; };
    let code = '';
    try {
      loadChatForWrite(key);
    } catch (e) {
      code = e.code;
    } finally {
      fs.copyFileSync = origCopy;
    }
    await c.check('抛 ECHAT_BACKUP_FAILED', () => {
      if (code !== 'ECHAT_BACKUP_FAILED') throw new Error(`code=${code}`);
    });
    await c.check('原文件字节未变（没有写入）', () => {
      if (fs.readFileSync(file, 'utf8') !== raw) throw new Error('原文件被改了');
    });
    await c.check('没有留下 .broken 备份（备份本身失败了）', () => {
      if (backups(key).length !== 0) throw new Error('不该有备份');
    });
  }

  c.section('6. 正常文件照常读');
  {
    const key = 'group:6';
    const file = fileOf(key);
    const raw = JSON.stringify({ chatKey: key, nextLocalId: 3, messages: [
      { id: 1, mid: 11, ts: 1, senderId: 'u', senderName: 'n', text: '甲', self: false, read: true },
      { id: 2, mid: 12, ts: 2, senderId: 'u', senderName: 'n', text: '乙', self: false, read: false }
    ] });
    fs.writeFileSync(file, raw, 'utf8');
    const store = new ChatStore(0);
    await c.check('读回 2 条', () => {
      if (store.recent(key).length !== 2) throw new Error('条数不对');
    });
    await c.check('没有产生备份', () => {
      if (backups(key).length !== 0) throw new Error('不该有备份');
    });
  }

  c.section('7. 权限错误不吞（不是 ENOENT 就必须抛）');
  {
    const key = 'group:7';
    fs.writeFileSync(fileOf(key), '{"messages":[]}', 'utf8');
    const origRead = fs.readFileSync;
    fs.readFileSync = function patched(f, ...rest) {
      if (String(f).endsWith('group_7.json')) { const e = new Error('EACCES: 无权限'); e.code = 'EACCES'; throw e; }
      return origRead.call(fs, f, ...rest);
    };
    let code = '';
    try { loadChat(key); } catch (e) { code = e.code; }
    finally { fs.readFileSync = origRead; }
    await c.check('EACCES 原样抛出', () => {
      if (code !== 'EACCES') throw new Error(`code=${code}`);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
