// 5.0-E6：只读空闲路径隔离测试（fake fetch，不联网、不写业务、不发送）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createReadonlyAdapter } from '../src/autonomous/readonly-adapter.js';
import { createAutonomousRuntime } from '../src/autonomous/runtime.js';
import { planHashOf } from '../src/autonomous/coordinator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e6-readonly-'));
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass += 1; console.log(`OK    ${name}`); } catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); } }
const sample = { code: 0, data: { list: [
  { bvid: 'BV1safe', title: '一个安全视频', desc: '普通内容', tname: '科技' },
  { bvid: 'BV1bad', title: '赌博广告', desc: '博彩', tname: '广告' },
  { bvid: 'BV2safe', title: '另一个视频', desc: '旅行', tname: '生活' }
] } };
function fakeFetch(json = sample) { return async () => ({ ok: true, status: 200, json: async () => json }); }

await check('只读 B 站适配器过滤不安全内容', async () => {
  const a = createReadonlyAdapter({ fetchImpl: fakeFetch(), timeoutMs: 500 });
  const r = await a.read({ limit: 8 });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 2);
  assert.equal(r.items.some((x) => x.title.includes('赌博')), false);
});

await check('公开搜索只读可用且过滤不安全结果', async () => {
  const searchJson = { code: 0, data: { result: [
    { bvid: 'BVsearch1', title: '猫猫视频', description: '可爱', tag: '猫', author: 'A' },
    { bvid: 'BVsearch2', title: '赌博广告', description: '博彩', tag: '广告' }
  ] } };
  const a = createReadonlyAdapter({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => searchJson }), timeoutMs: 500 });
  const r = await a.search({ keyword: '猫' });
  assert.equal(r.ok, true);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].contentId, 'BVsearch1');
});
await check('网络失败返回 ok=false，不抛异常', async () => {
  const a = createReadonlyAdapter({ fetchImpl: async () => ({ ok: false, status: 429 }), timeoutMs: 500 });
  const r = await a.read();
  assert.equal(r.ok, false);
  assert.match(r.error, /http_429/);
});

await check('Runtime 默认 readonly disabled', async () => {
  const rt = createAutonomousRuntime({ file: path.join(dir, 'exec-default.json'), stateFile: path.join(dir, 'state-default.json'), readonlyAdapter: createReadonlyAdapter({ fetchImpl: fakeFetch() }) });
  await rt.setPaused(false);
  assert.equal(rt.status().readonlyEnabled, false);
  const r = await rt.run({ executionPlan: { kind: 'readonly' } });
  assert.equal(r.reason, 'READONLY_DISABLED');
});

await check('启用 readonly 后经 Coordinator 只读执行，不写业务/不发送', async () => {
  const file = path.join(dir, 'exec.json');
  const rt = createAutonomousRuntime({ file, stateFile: path.join(dir, 'state.json'), readonlyAdapter: createReadonlyAdapter({ fetchImpl: fakeFetch() }) });
  await rt.setPaused(false); rt.setEnabled('readonly', true);
  const purpose = { ok: true, candidates: [] };
  const closure = { ok: true, decision: 'close' };
  const activity = { ok: true, decision: 'interest_exploration', selectedActivity: { type: 'interest_exploration', title: '探索', risk: 'low' } };
  const plan = { kind: 'readonly', tool: 'interest_exploration', target: '探索', params: {} };
  const tools = { interest_exploration: { schema: { type: 'object' } } };
  const first = await rt.run({ tickId: 'ro-1', purpose, closure, activity, executionPlan: plan, tools });
  assert.equal(first.ok, true, JSON.stringify(first));
  const auth = { receiptId: first.receipt.receiptId, planHash: planHashOf(first.receipt), actionType: 'interest_exploration', target: '探索', params: {}, authorizedBy: 'owner', expiresAt: new Date(Date.now() + 3600e3).toISOString() };
  const second = await rt.run({ tickId: 'ro-1', purpose, closure, activity, executionPlan: plan, tools, authorization: auth });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.state, 'succeeded');
  assert.equal(fs.existsSync(path.join(dir, 'data')), false);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nE6 readonly: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
