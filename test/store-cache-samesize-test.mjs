// 审查补充：同大小快速替换时，mtime/size 缓存的边界（2026-11-03）。
//
// 机主要求：确认"同大小、快速连续替换"时缓存最终能发现变化；
// 同时明确 mtime/size 不是内容版本号。
//
// 结论写进 docs/roadmap/CHAT-SAVE-FOLLOWUP-AUDIT.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-samesize-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });

const { ChatStore } = await import('../src/store.js');

const KEY = 'group:samesize';
const FILE = path.join(dataDir, 'messages', 'group_samesize.json');

const c = createChecker('缓存边界：同大小替换');

/** 写一个「消息文本等长」的存档（JSON 总字节数相同）。 */
function writeText(text) {
  fs.writeFileSync(FILE, JSON.stringify({
    chatKey: KEY,
    nextLocalId: 2,
    messages: [{
      id: 1, mid: 11, ts: 1700000000000, senderId: 'u', senderName: 'n',
      text, self: false, read: true, reply: null, media: []
    }]
  }, null, 1), 'utf8');
  return fs.statSync(FILE);
}

try {
  c.section('1. 同大小、mtime 变化 → 能发现（快速连续替换）');
  {
    writeText('AAAA');
    const store = new ChatStore(0);
    await c.check('初始读到 AAAA', () => {
      if (store.recent(KEY, { limit: 5 })[0].text !== 'AAAA') throw new Error('不对');
    });
    writeText('BBBB');
    await c.check('同大小替换后读到 BBBB', () => {
      if (store.recent(KEY, { limit: 5 })[0].text !== 'BBBB') throw new Error(store.recent(KEY, { limit: 5 })[0].text);
    });
  }

  c.section('2. 连续 10 次同大小替换，最后一次必须可见');
  {
    writeText('C000');
    const store = new ChatStore(0);
    let last = '';
    for (let i = 0; i < 10; i += 1) {
      last = `C${String(i).padStart(3, '0')}`;   // 等长：C000..C009
      writeText(last);
      store.recent(KEY, { limit: 5 });           // 每次都读
    }
    await c.check('最后一次内容是最新', () => {
      const got = store.recent(KEY, { limit: 5 })[0].text;
      if (got !== last) throw new Error(`期望 ${last}，实际 ${got}`);
    });
  }

  c.section('3. 同大小 + mtime 被强制设回原值 → 指纹相同，检测不到（已知边界）');
  {
    // 用整秒时间，确保 utimes 后 stat 的 mtimeMs 与缓存值完全相等
    const t = new Date(Math.floor(Date.now() / 1000) * 1000);
    writeText('DDDD');
    fs.utimesSync(FILE, t, t);
    const m1 = fs.statSync(FILE);
    const store = new ChatStore(0);
    await c.check('先缓存 DDDD', () => {
      if (store.recent(KEY, { limit: 5 })[0].text !== 'DDDD') throw new Error('不对');
    });
    writeText('EEEE');            // 同大小替换
    fs.utimesSync(FILE, t, t);    // 把 mtime 设回原值
    const m2 = fs.statSync(FILE);
    await c.check('mtime/size 与替换前完全一致', () => {
      if (m1.size !== m2.size) throw new Error(`size ${m1.size} vs ${m2.size}`);
      if (m1.mtimeMs !== m2.mtimeMs) throw new Error(`mtime ${m1.mtimeMs} vs ${m2.mtimeMs}`);
    });
    await c.check('**已知边界**：此时读回旧内容 DDDD（mtime/size 不是内容版本号）', () => {
      const got = store.recent(KEY, { limit: 5 })[0].text;
      if (got !== 'DDDD') throw new Error(`实际读到 ${got}（若读到 EEEE，说明本机 mtime 精度与测试假设不同）`);
    });
    // 一旦 mtime 再次变化（正常写入都会），就应该恢复
    const t3 = new Date(Math.floor(Date.now() / 1000) * 1000 + 5000);
    fs.utimesSync(FILE, t3, t3);
    await c.check('mtime 恢复变化后读到新内容（缓存会恢复）', () => {
      const got = store.recent(KEY, { limit: 5 })[0].text;
      if (got !== 'EEEE') throw new Error(`实际读到 ${got}`);
    });
  }

  c.section('4. size 变化（不同长度）→ 必然发现');
  {
    writeText('FFFF');
    const store = new ChatStore(0);
    store.recent(KEY, { limit: 5 });
    writeText('GGGGGGGGGG');   // 更长，size 变
    await c.check('不同大小替换后读到新内容', () => {
      if (store.recent(KEY, { limit: 5 })[0].text !== 'GGGGGGGGGG') throw new Error('没发现');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
