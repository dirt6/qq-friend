// P1 专项：消息判重与冲突保留（2026-11-03）。
//
// 规则（机主拍板）：
//   · 判重主键 = mid + senderId + self + 完整内容（text/media/reply/isPoke）；
//   · 同 mid 但身份/内容不同 → 两条都保留 + 冲突记录，不静默覆盖；
//   · null mid 永不参与判重；
//   · 冲突记录有界（50），容量满不丢正式消息；
//   · 不修改已有 localId。
//
// 只碰临时 DATA_DIR。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-dedup-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const MESSAGES = path.join(dataDir, 'messages');
fs.mkdirSync(MESSAGES, { recursive: true });

const { ChatStore } = await import('../src/store.js');

const c = createChecker('P1 判重与冲突保留');
const fileOf = (key) => path.join(MESSAGES, `${key.replace(':', '_')}.json`);
const readDisk = (key) => JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
const seed = (key, messages = [], nextLocalId = 1) => {
  fs.writeFileSync(fileOf(key), JSON.stringify({ chatKey: key, nextLocalId, messages }, null, 1), 'utf8');
};

try {
  c.section('1. 同 mid + 同发送者 + 同内容 + 短窗 → 幂等（只 1 条）');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    const a = await s.appendIncoming('d:1', { mid: 10, ts: t, senderId: 'u1', senderName: '甲', text: '你好' });
    const b = await s.appendIncoming('d:1', { mid: 10, ts: t + 3000, senderId: 'u1', senderName: '甲', text: '你好' });
    await c.check('只保留 1 条', () => {
      if (s.recent('d:1', { limit: 10 }).length !== 1) throw new Error('不是 1 条');
    });
    await c.check('返回同一个 id', () => {
      if (a.id !== b.id) throw new Error(`${a.id} vs ${b.id}`);
    });
    await c.check('没有冲突记录', () => {
      if ((readDisk('d:1').conflicts || []).length !== 0) throw new Error('不该有冲突');
    });
  }

  c.section('2. 同 mid 不同发送者 → 两条都保留 + 冲突（different-sender）');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    const a = await s.appendIncoming('d:2', { mid: 20, ts: t, senderId: 'u1', senderName: '甲', text: '同一句' });
    const b = await s.appendIncoming('d:2', { mid: 20, ts: t + 1000, senderId: 'u2', senderName: '乙', text: '同一句' });
    await c.check('两条都在且 id 不同', () => {
      const list = s.recent('d:2', { limit: 10 });
      if (list.length !== 2) throw new Error(`条数 ${list.length}`);
      if (a.id === b.id) throw new Error('id 相同');
    });
    await c.check('冲突记录 reason=different-sender', () => {
      const cs = readDisk('d:2').conflicts;
      if (!cs || cs.length !== 1) throw new Error(`conflicts=${JSON.stringify(cs)}`);
      if (cs[0].reason !== 'different-sender') throw new Error(cs[0].reason);
      if (cs[0].existingId !== a.id || cs[0].incomingId !== b.id) throw new Error(JSON.stringify(cs[0]));
    });
  }

  c.section('3. 同 mid 不同文本 → 两条 + different-content');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    await s.appendIncoming('d:3', { mid: 30, ts: t, senderId: 'u1', senderName: '甲', text: '第一句' });
    await s.appendIncoming('d:3', { mid: 30, ts: t + 1000, senderId: 'u1', senderName: '甲', text: '完全不同的第二句' });
    await c.check('两条都在', () => {
      if (s.recent('d:3', { limit: 10 }).length !== 2) throw new Error('不是 2 条');
    });
    await c.check('reason=different-content', () => {
      const cs = readDisk('d:3').conflicts;
      if (cs.length !== 1 || cs[0].reason !== 'different-content') throw new Error(JSON.stringify(cs));
    });
  }

  c.section('4. 同 mid 同文本但图片不同 → 两条 + different-content');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    await s.appendIncoming('d:4', { mid: 40, ts: t, senderId: 'u1', senderName: '甲', text: '[图片]', media: [{ kind: 'image', url: 'http://x/a.png' }] });
    await s.appendIncoming('d:4', { mid: 40, ts: t + 1000, senderId: 'u1', senderName: '甲', text: '[图片]', media: [{ kind: 'image', url: 'http://x/b.png' }] });
    await c.check('两条都在', () => {
      if (s.recent('d:4', { limit: 10 }).length !== 2) throw new Error('不是 2 条');
    });
    await c.check('冲突摘要记录了 media 数量', () => {
      const cs = readDisk('d:4').conflicts;
      if (cs.length !== 1) throw new Error('没有冲突');
      if (cs[0].incoming.mediaCount !== 1 || cs[0].existing.mediaCount !== 1) throw new Error(JSON.stringify(cs[0]));
    });
  }

  c.section('5. 同 mid 但 self 不同 → 两条 + different-self');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    await s.appendIncoming('d:5', { mid: 50, ts: t, senderId: 'u1', senderName: '甲', text: '同一句' });
    await s.appendSelf('d:5', { mid: 50, ts: t + 1000, text: '同一句' });
    await c.check('两条都在', () => {
      if (s.recent('d:5', { limit: 10 }).length !== 2) throw new Error('不是 2 条');
    });
    await c.check('reason=different-self', () => {
      const cs = readDisk('d:5').conflicts;
      if (cs.length !== 1 || cs[0].reason !== 'different-self') throw new Error(JSON.stringify(cs));
    });
  }

  c.section('6. null mid 连续追加 → 两条，不判重、不记冲突');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    await s.appendIncoming('d:6', { mid: null, ts: t, senderId: 'u1', senderName: '甲', text: '拍一拍' });
    await s.appendIncoming('d:6', { mid: null, ts: t, senderId: 'u1', senderName: '甲', text: '拍一拍' });
    await c.check('两条都在', () => {
      if (s.recent('d:6', { limit: 10 }).length !== 2) throw new Error('不是 2 条');
    });
    await c.check('没有冲突记录', () => {
      if ((readDisk('d:6').conflicts || []).length !== 0) throw new Error('不该有冲突');
    });
  }

  c.section('7. ts 缺失/异常 → 不崩、不误判');
  {
    const s = new ChatStore(0);
    await s.appendIncoming('d:7', { mid: 70, ts: null, senderId: 'u1', senderName: '甲', text: '无时间' });
    await s.appendIncoming('d:7', { mid: 70, ts: 'not-a-number', senderId: 'u1', senderName: '甲', text: '无时间' });
    await c.check('两条都追加（时间窗不成立）', () => {
      if (s.recent('d:7', { limit: 10 }).length !== 2) throw new Error('不是 2 条');
    });
    await c.check('有冲突记录（同 mid 不同 ts 无法判重）', () => {
      const cs = readDisk('d:7').conflicts;
      if (!cs || cs.length !== 1 || cs[0].reason !== 'time-gap') throw new Error(JSON.stringify(cs));
    });
  }

  c.section('8. 重连复用 mid：同内容但时间差超出短窗 → 两条 + time-gap（不吞）');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    await s.appendIncoming('d:8', { mid: 80, ts: t, senderId: 'u1', senderName: '甲', text: '同一句' });
    await s.appendIncoming('d:8', { mid: 80, ts: t + 5 * 60 * 1000, senderId: 'u1', senderName: '甲', text: '同一句' });
    await c.check('两条都保留', () => {
      if (s.recent('d:8', { limit: 10 }).length !== 2) throw new Error('被吞了');
    });
    await c.check('reason=time-gap', () => {
      const cs = readDisk('d:8').conflicts;
      if (cs.length !== 1 || cs[0].reason !== 'time-gap') throw new Error(JSON.stringify(cs));
    });
  }

  c.section('9. 冲突记录有界（50）：60 条冲突 → messages 60 / conflicts 50');
  {
    const s = new ChatStore(0);
    const t = Date.now();
    for (let i = 0; i < 60; i += 1) {
      await s.appendIncoming('d:9', { mid: 90, ts: t + i * 1000, senderId: 'u1', senderName: '甲', text: `第 ${i} 句` });
    }
    await c.check('正式消息 60 条一条不少', () => {
      if (s.recent('d:9', { limit: 100 }).length !== 60) throw new Error(`条数 ${s.recent('d:9', { limit: 100 }).length}`);
    });
    await c.check('冲突记录被截到 50', () => {
      const cs = readDisk('d:9').conflicts;
      if (cs.length !== 50) throw new Error(`conflicts=${cs.length}`);
    });
    await c.check('保留的是最近 50 条（最老的被挤掉）', () => {
      const cs = readDisk('d:9').conflicts;
      if (cs[0].incomingId !== 11) throw new Error(`第一条冲突 incomingId=${cs[0].incomingId}，应为 11`);
      if (cs[49].incomingId !== 60) throw new Error(`最后一条=${cs[49].incomingId}`);
    });
  }

  c.section('10. 不修改已有 localId、不全量重排');
  {
    const key = 'd:10';
    seed(key, [
      { id: 1, mid: 1, ts: 1, senderId: 'u1', senderName: '甲', text: '老一', self: false, read: true, reply: null, media: [] },
      { id: 2, mid: 2, ts: 2, senderId: 'u2', senderName: '乙', text: '老二', self: false, read: true, reply: null, media: [] }
    ], 3);
    const s = new ChatStore(0);
    await s.appendIncoming(key, { mid: 2, ts: Date.now(), senderId: 'u9', senderName: '丙', text: '冲突新消息' });
    await c.check('老 id 1/2 原样保留', () => {
      const d = readDisk(key);
      if (d.messages[0].id !== 1 || d.messages[1].id !== 2) throw new Error(d.messages.map((m) => m.id).join(','));
    });
    await c.check('新消息 id=3（只追加不重排）', () => {
      const d = readDisk(key);
      if (d.messages[2].id !== 3) throw new Error(`id=${d.messages[2]?.id}`);
      if (d.nextLocalId !== 4) throw new Error(`next=${d.nextLocalId}`);
    });
  }

  c.section('11. mid=0 / 空串不参与判重');
  {
    const s = new ChatStore(0);
    await s.appendIncoming('d:11', { mid: 0, ts: 1, senderId: 'u1', senderName: '甲', text: 'a' });
    await s.appendIncoming('d:11', { mid: 0, ts: 1, senderId: 'u1', senderName: '甲', text: 'a' });
    await s.appendIncoming('d:11', { mid: '', ts: 1, senderId: 'u1', senderName: '甲', text: 'a' });
    await c.check('三条都追加', () => {
      if (s.recent('d:11', { limit: 10 }).length !== 3) throw new Error('被误判重');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
