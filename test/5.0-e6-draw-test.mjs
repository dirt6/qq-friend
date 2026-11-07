// 5.0-E6：画画 preset + 本地 draw adapter + Runtime 开关隔离测试。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sceneFromPreset } from '../src/draw.js';
import { createDrawAdapter } from '../src/autonomous/draw-adapter.js';
import { createAutonomousRuntime } from '../src/autonomous/runtime.js';
import { createAuthorizationService } from '../src/autonomous/authorization.js';
import { planHashOf } from '../src/autonomous/coordinator.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e6-draw-'));
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass++; console.log(`OK    ${name}`); } catch (e) { fail++; console.log(`FAIL  ${name}: ${e?.message || e}`); } }

await check('五个 preset 有渐变/层次/画风，不再是少量图元', () => {
  for (const p of ['night', 'cat', 'flower', 'sky', 'day']) {
    const s = sceneFromPreset(p, { title: '测试' });
    assert.equal(s.width, 900);
    assert.equal(s.height, 600);
    assert.equal(s.style, 'picturebook');
    assert.equal(s.background.type, 'linear');
    assert.ok(s.shapes.length >= 18, `${p} shapes=${s.shapes.length}`);
    assert.ok(s.shapes.some((x) => x.type === 'text'));
  }
});

await check('draw adapter 成功只写本地，不发送', async () => {
  let recorded = null;
  const a = createDrawAdapter({
    render: async () => ({ ok: true, path: 'C:\\tmp\\draw-test.png', width: 900, height: 600, style: 'picturebook', bytes: 123 }),
    record: (m) => { recorded = m; return m; }
  });
  const r = await a.draw({ preset: 'cat', title: '猫' });
  assert.equal(r.ok, true);
  assert.equal(r.file, 'draw-test.png');
  assert.equal(recorded.source, 'autonomous');
});

await check('非法 preset 拒绝', async () => {
  const a = createDrawAdapter({ render: async () => ({ ok: true, path: 'x.png' }), record: () => ({}) });
  const r = await a.draw({ preset: '../evil' });
  assert.equal(r.ok, false);
  assert.equal(r.sideEffect, 'none');
});

await check('索引写失败 → UNKNOWN（图可能已生成，不重画）', async () => {
  const a = createDrawAdapter({ render: async () => ({ ok: true, path: 'x.png' }), record: () => { throw new Error('index fail'); } });
  const r = await a.draw({ preset: 'night' });
  assert.equal(r.sideEffect, 'unknown');
});

await check('Runtime 默认 draw disabled；启用后经 Coordinator 执行', async () => {
  const svc = createAuthorizationService({ keys: { k: 'k'.repeat(40) }, keyId: 'k' });
  let calls = 0;
  const draw = createDrawAdapter({ render: async () => { calls++; return { ok: true, path: 'C:\\tmp\\cat.png', width: 900, height: 600, style: 'picturebook', bytes: 1 }; }, record: () => ({}) });
  const rt = createAutonomousRuntime({ file: path.join(dir, 'exec.json'), stateFile: path.join(dir, 'state.json'), drawAdapter: draw, authorizationService: svc });
  await rt.setPaused(false);
  const purpose = { ok: true, candidates: [] };
  const closure = { ok: true, decision: 'close' };
  const activity = { ok: true, decision: 'interest_exploration', selectedActivity: { type: 'interest_exploration', title: '画画', risk: 'low' } };
  const plan = { kind: 'draw', tool: 'interest_exploration', target: '画画', params: { preset: 'cat', title: '猫' } };
  const tools = { interest_exploration: { schema: { type: 'object' }, maxRuns: 1 } };
  const off = await rt.run({ tickId: 'd0', purpose, closure, activity, executionPlan: plan, tools });
  assert.equal(off.reason, 'DRAW_DISABLED');
  rt.setEnabled('draw', true);
  const first = await rt.run({ tickId: 'd1', purpose, closure, activity, executionPlan: plan, tools });
  assert.equal(first.ok, true, JSON.stringify(first));
  const auth = svc.sign({ receiptId: first.receipt.receiptId, planHash: planHashOf(first.receipt), actionType: 'interest_exploration', target: '画画', params: plan.params, authorizedBy: 'owner', expiresAt: new Date(Date.now() + 3600e3).toISOString(), nonce: 'n-draw-1', scope: 'execute' });
  const second = await rt.run({ tickId: 'd1', purpose, closure, activity, executionPlan: plan, tools, authorization: auth });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.state, 'succeeded', JSON.stringify(second));
  assert.equal(calls, 1);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nE6 draw: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
