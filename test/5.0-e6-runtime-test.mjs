// 5.0-E6：Runtime 状态/权限/恢复隔离测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAutonomousRuntime } from '../src/autonomous/runtime.js';
import { createQQAdapter } from '../src/autonomous/qq-adapter.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e6-runtime-'));
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass += 1; console.log(`OK    ${name}`); } catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); } }
const stateFile = path.join(dir, 'state.json');
const execFile = path.join(dir, 'exec.json');
const tokenFile = path.join(dir, 'control-token');
const learnedStub = { upsert: async () => ({ ok: true }) };
const base = { file: execFile, stateFile, tokenFile, learnedAdapter: learnedStub };

await check('默认 paused、G2/G3 disabled、无控制 token', async () => {
  const r = createAutonomousRuntime(base);
  const s = r.status();
  assert.equal(s.paused, true);
  assert.equal(s.g2Enabled, false);
  assert.equal(s.g3Enabled, false);
  assert.equal(s.tokenConfigured, false);
  assert.equal(r.authorize({ headers: {} }), false);
});

await check('控制 token 独立文件才生效', async () => {
  fs.writeFileSync(tokenFile, 't'.repeat(43), 'utf8');
  const r = createAutonomousRuntime(base);
  assert.equal(r.authorize({ headers: { 'x-5.0-token': 'wrong' } }), false);
  assert.equal(r.authorize({ headers: { 'x-5.0-token': 't'.repeat(43) } }), true);
});

await check('开关持久化但重启 fail-closed：paused+G2/G3 disabled', async () => {
  const r = createAutonomousRuntime(base);
  await r.setPaused(false);
  r.setEnabled('g2', true);
  assert.equal(r.status().paused, false);
  const r2 = createAutonomousRuntime(base);
  assert.equal(r2.status().paused, true);
  assert.equal(r2.status().g2Enabled, false);
  assert.equal(r2.status().g3Enabled, false);
});

await check('state 损坏 → degraded/paused，不允许 run', async () => {
  fs.writeFileSync(stateFile, '{bad json', 'utf8');
  const r = createAutonomousRuntime(base);
  assert.equal(r.status().degraded, true);
  assert.equal(r.status().paused, true);
  const out = await r.run({});
  assert.equal(out.reason, 'STATE_CORRUPT');
});

await check('预算持久化：超过 actions 上限拒绝', async () => {
  fs.rmSync(stateFile, { force: true });
  const r = createAutonomousRuntime({ ...base, budgetLimits: { maxActionsPerDay: 1, maxSendsPerDay: 1 } });
  await r.setPaused(false);
  r.setEnabled('g2', true);
  const input = {
    tickId: 'budget-1', purpose: { ok: true, candidates: [] }, closure: { ok: true, decision: 'close' },
    activity: { ok: true, decision: 'memory_maintenance', selectedActivity: { type: 'memory_maintenance', title: 'x' } },
    executionPlan: { kind: 'learned', tool: 'memory_maintenance', target: 'x', params: {}, intents: [], accepted: [] },
    tools: { memory_maintenance: { schema: { type: 'object' } } }
  };
  const a = await r.run(input);
  assert.notEqual(a.reason, 'BUDGET_ACTIONS');
  const b = await r.run(input);
  assert.equal(b.reason, 'BUDGET_ACTIONS');
});

await check('执行中 started 恢复 → UNKNOWN', async () => {
  const exec = path.join(dir, 'recover-exec.json');
  fs.writeFileSync(exec, JSON.stringify({
    version: 1, paused: false, records: { r1: { receiptId: 'r1', state: 'started', history: [], attempts: 0 } }, seenEvents: {}, audit: []
  }), 'utf8');
  const r = createAutonomousRuntime({ ...base, file: exec, stateFile: path.join(dir, 'recover-state.json') });
  await r.recover();
  const rec = await r.store.get('r1');
  assert.equal(rec.state, 'unknown');
});

await check('G3 sending intent 恢复 → UNKNOWN，不重发', async () => {
  const jf = path.join(dir, 'g3.json');
  let calls = 0;
  const sender = { async sendTextBatch() { calls += 1; return { sent: [{ messageId: 1 }] }; } };
  const a = createQQAdapter({ sender, target: '1846383180', journalFile: jf });
  fs.writeFileSync(jf, JSON.stringify({ version: 1, intents: { fp1: { state: 'sending', at: new Date().toISOString(), target: '1846383180' } } }), 'utf8');
  const rec = await a.recover();
  assert.deepEqual(rec.recovered, ['fp1']);
  const out = await a.send({ target: '1846383180', text: 'x', fingerprint: 'fp1' });
  assert.equal(out.state, 'unknown');
  assert.equal(calls, 0);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nE6 Runtime: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
