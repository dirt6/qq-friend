// D1-7C parity：旧 private_*.json 读取 vs Core.context.readPrivateHistory。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

const c = createChecker('D1-7C 私聊上下文 parity');
let OWN = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('d17c-');
  OWN = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
assertIsolatedPaths({ dataDir: DATA, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });
const msgDir = path.join(DATA, 'messages');
fs.mkdirSync(msgDir, { recursive: true });

const { ChatStore } = await import('../src/store.js');
const { createCompanionCore } = await import('../src/companion-core/index.js');
const { setChatStore, clearChatStore } = await import('../src/companion-core/context.js');

function legacy(chatKey, { limit = 40, all = false, since = 0 } = {}) {
  const file = path.join(msgDir, `${chatKey.replace(':', '_')}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(raw) ? raw : (raw.messages || []);
  const rows = (all ? list : list.slice(-Math.max(1, limit))).filter((m) => !since || Number(m.ts) >= since);
  return rows.map((m) => ({ self: Boolean(m.self), text: String(m.text ?? m.content ?? ''), ts: Number(m.ts) || 0 }));
}
const mapCore = (r) => r.messages.map((m) => ({ self: m.self, text: m.text, ts: m.ts }));
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

try {
  const store = new ChatStore(0);
  setChatStore(store);
  const core = createCompanionCore({ chatStore: store });

  c.section('1. 空/单条/多条');
  {
    const empty = core.context.readPrivateHistory('private:111');
    await c.check('空历史：ok + 空数组，旧路径同为空', () => {
      assert.equal(empty.ok, true);
      assert.equal(empty.messages.length, 0);
      fs.writeFileSync(path.join(msgDir, 'private_111.json'), JSON.stringify({ messages: [] }));
      assert.deepEqual(legacy('private:111'), []);
    });
    await store.appendIncoming('private:111', { mid: 1, ts: 1000, senderId: '1', senderName: 'A', text: '第一条' });
    await store.appendSelf('private:111', { text: '我回一句', ts: 2000, mid: 2 });
    await store.appendIncoming('private:111', { mid: 3, ts: 2000, senderId: '1', senderName: 'A', text: '同秒第二条' });
    const r = core.context.readPrivateHistory('private:111');
    await c.check('单/多条：数量/内容/顺序/ts 与旧路径一致', () => {
      assert.equal(r.ok, true);
      assert.ok(eq(mapCore(r), legacy('private:111')));
      assert.equal(r.messages.length, 3);
      assert.equal(r.messages[0].text, '第一条');
    });
    await c.check('同时间戳顺序保持插入顺序', () => {
      assert.deepEqual(r.messages.slice(1).map((m) => m.ts), [2000, 2000]);
      assert.equal(r.messages[1].self, true);
      assert.equal(r.messages[2].text, '同秒第二条');
    });
  }

  c.section('2. 截取与 since');
  {
    for (let i = 0; i < 5; i += 1) await store.appendIncoming('private:111', { mid: 10 + i, ts: 3000 + i, senderId: '1', senderName: 'A', text: `m${i}` });
    const lim = core.context.readPrivateHistory('private:111', { limit: 2 });
    await c.check('limit 取最后 N 条，与旧路径一致', () => {
      assert.ok(eq(mapCore(lim), legacy('private:111', { limit: 2 })));
      assert.deepEqual(mapCore(lim).map((m) => m.text), ['m3', 'm4']);
    });
    const all = core.context.readPrivateHistory('private:111', { all: true });
    await c.check('all 返回全部，与旧路径一致', () => assert.ok(eq(mapCore(all), legacy('private:111'))));
    const since = core.context.readPrivateHistory('private:111', { all: true, since: 3002 });
    await c.check('since 过滤 ts，与旧路径一致', () => assert.ok(eq(mapCore(since), legacy('private:111', { since: 3002 }))));
  }

  c.section('3. 不同 chatKey / 缺失 / 无效');
  {
    await store.appendIncoming('private:222', { mid: 20, ts: 5000, senderId: '2', senderName: 'B', text: '另一个私聊' });
    const other = core.context.readPrivateHistory('private:222');
    await c.check('不同 private chatKey 隔离且一致', () => assert.ok(eq(mapCore(other), legacy('private:222'))));
    const missing = core.context.readPrivateHistory('private:999');
    await c.check('缺失文件：Core 返回 ok 空；旧 helper 捕获后为空（一致）', () => {
      assert.equal(missing.ok, true);
      assert.equal(missing.messages.length, 0);
      let oldMissing = [];
      try { oldMissing = legacy('private:999'); } catch { oldMissing = []; }
      assert.deepEqual(oldMissing, []);
    });
    await c.check('非法 chatKey 明确失败（不伪装空历史）', () => {
      for (const k of ['private:abc', 'group:123', '../private_1', '']) {
        const r = core.context.readPrivateHistory(k);
        assert.equal(r.ok, false, k);
        assert.ok(r.error);
      }
    });
  }

  c.section('4. 损坏文件语义');
  {
    fs.writeFileSync(path.join(msgDir, 'private_333.json'), '{ bad json');
    const store2 = new ChatStore(0);
    const core2 = createCompanionCore({ chatStore: store2 });
    const r = core2.context.readPrivateHistory('private:333');
    await c.check('损坏：Core 明确失败；旧 helper 静默空（有意改进，已记录）', () => {
      assert.equal(r.ok, false);
      assert.match(String(r.error), /损坏/);
      let oldEmpty = [];
      try { oldEmpty = legacy('private:333'); } catch { oldEmpty = []; }
      assert.deepEqual(oldEmpty, []);
    });
  }

  c.section('6. autonomous 实际入口');
  c.section('5. 注入与并发');
  {
    clearChatStore();
    const core3 = createCompanionCore({});
    await c.check('未注入 ChatStore：明确失败', () => {
      const r = core3.context.readPrivateHistory('private:111');
      assert.equal(r.ok, false);
      assert.match(String(r.error), /chatStore/);
    });
    setChatStore(store);
    await Promise.all([
      store.appendIncoming('private:111', { mid: 30, ts: 7000, senderId: '1', senderName: 'A', text: '并发A' }),
      store.appendIncoming('private:111', { mid: 31, ts: 7001, senderId: '1', senderName: 'A', text: '并发B' })
    ]);
    const r = core.context.readPrivateHistory('private:111', { limit: 2 });
    await c.check('读取期间并发写入：不崩溃，返回一致快照', () => {
      assert.equal(r.ok, true);
      assert.equal(r.messages.length, 2);
      assert.deepEqual(r.messages.map((m) => m.text), ['并发A', '并发B']);
    });
  }

  c.section('6. autonomous 实际入口');
  {
    const { getConfig } = await import('../src/config.js');
    getConfig().persona.masterId = '111';
    const { lastUserMessageAt } = await import('../plugins/autonomous/index.js');
    await c.check('lastUserMessageAt 经 Core 读取（最大非 self ts）', () => {
      const got = lastUserMessageAt();
      assert.equal(got, 7001, `got=${got} master=${getConfig()?.persona?.masterId}`);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  clearChatStore();
  if (OWN) cleanupIsolation(OWN);
}

process.exit(c.finish() ? 0 : 1);
