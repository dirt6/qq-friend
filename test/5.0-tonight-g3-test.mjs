// 5.0 今晚 G3：QQ 单目标发送适配器隔离测试（fake SendQueue，不发送）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQQAdapter } from '../src/autonomous/qq-adapter.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g3-qq-'));
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass += 1; console.log(`OK    ${name}`); } catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); } }
function fakeSender(result = { sent: [{ messageId: 1001 }] }) {
  const calls = [];
  return {
    calls,
    async sendTextBatch(chatKey, messages) {
      calls.push({ chatKey, messages });
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(chatKey, messages);
      return result;
    }
  };
}
const file = path.join(dir, 'journal.json');

await check('dry-run 不调用 sender', async () => {
  const s = fakeSender();
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: file, dryRun: true });
  const r = await a.send({ target: '1846383180', text: 'hello' });
  assert.equal(r.state, 'dry_run');
  assert.equal(s.calls.length, 0);
});

await check('成功发送写 journal 并返回 messageId', async () => {
  const s = fakeSender();
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: file });
  const r = await a.send({ target: '1846383180', text: '晚点睡' });
  assert.equal(r.ok, true);
  assert.equal(r.state, 'sent');
  assert.equal(r.messageId, '1001');
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].chatKey, 'private:1846383180');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(Object.values(j.intents).some((x) => x.state === 'sent'), true);
});

await check('同 fingerprint 重放不重复发送', async () => {
  const s = fakeSender();
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: file });
  const r = await a.send({ target: '1846383180', text: '晚点睡' });
  assert.equal(r.state, 'duplicate');
  assert.equal(s.calls.length, 0);
});

await check('目标替换拒绝', async () => {
  const s = fakeSender();
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: file });
  const r = await a.send({ target: '999', text: 'x' });
  assert.equal(r.state, 'blocked');
  assert.equal(s.calls.length, 0);
});

await check('pause 状态拒绝', async () => {
  const s = fakeSender();
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: file, paused: () => true });
  const r = await a.send({ target: '1846383180', text: 'x' });
  assert.equal(r.state, 'paused');
  assert.equal(s.calls.length, 0);
});

await check('抛错 → UNKNOWN，第二次不再发送', async () => {
  const s = fakeSender(new Error('socket hang up'));
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: path.join(dir, 'unknown.json') });
  const r1 = await a.send({ target: '1846383180', text: '可能已发' });
  assert.equal(r1.state, 'unknown');
  const r2 = await a.send({ target: '1846383180', text: '可能已发' });
  assert.equal(r2.state, 'unknown');
  assert.equal(s.calls.length, 1);
});

await check('部分失败 → UNKNOWN，不重发', async () => {
  const s = fakeSender({ sent: [], failed: [{ text: 'x', error: 'timeout' }] });
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: path.join(dir, 'partial.json') });
  const r1 = await a.send({ target: '1846383180', text: '部分失败' });
  assert.equal(r1.state, 'unknown');
  const r2 = await a.send({ target: '1846383180', text: '部分失败' });
  assert.equal(r2.state, 'unknown');
  assert.equal(s.calls.length, 1);
});

await check('发送结果空 → UNKNOWN', async () => {
  const s = fakeSender({ sent: [], failed: [] });
  const a = createQQAdapter({ sender: s, target: '1846383180', journalFile: path.join(dir, 'empty.json') });
  const r = await a.send({ target: '1846383180', text: '空结果' });
  assert.equal(r.state, 'unknown');
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nG3 QQ adapter: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
