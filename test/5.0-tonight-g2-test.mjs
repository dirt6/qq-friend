// 5.0 今晚 G2：真实 learned 适配器隔离测试（临时 DATA_DIR，不碰生产）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g2-learned-'));
process.env.QQ_AGENT_DATA_DIR = dir;
let pass = 0; let fail = 0;
async function check(name, fn) {
  try { await fn(); pass += 1; console.log(`OK    ${name}`); }
  catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); }
}

const { createLearnedAdapter } = await import('../src/autonomous/learned-adapter.js');
const learned = await import('../src/learned.js');
const adapter = createLearnedAdapter();
const key = 'receipt:test:1:learned:intent-1';

await check('真实 learned 写入并保留 autonomous 来源/幂等键', async () => {
  const r = await adapter.upsert({ content: '用户喜欢在深夜写代码', source: 'autonomous', idempotencyKey: key, epistemicType: 'direct', contentType: 'preference' });
  assert.equal(r.ok, true);
  assert.ok(r.id);
  const item = learned.listAll({}).find((x) => x.id === r.id);
  assert.equal(item.origin.kind, 'autonomous');
  assert.equal(item.origin.ref, key);
});

await check('同一幂等键重放不新增', async () => {
  const before = learned.listAll({}).length;
  const r = await adapter.upsert({ content: '用户喜欢在深夜写代码', source: 'autonomous', idempotencyKey: key, epistemicType: 'direct' });
  assert.equal(r.duplicate, true);
  assert.equal(learned.listAll({}).length, before);
});

await check('写入后可从 Memory Hub 读到', async () => {
  const { readLearned } = await import('../src/memory-hub/adapters.js');
  const r = readLearned({ query: '深夜', limit: 10 });
  assert.ok(JSON.stringify(r).includes('深夜'));
});

await check('用户原话优先：自主近似条目不能覆盖', async () => {
  const u = learned.addExperience({
    text: '老大明确说过出门要带伞', now: Date.now(),
    origin: { kind: 'user_stated', ref: 'owner-1', at: new Date().toISOString(), quote: '' }
  });
  assert.equal(u.ok, true);
  const r = await adapter.upsert({ content: '老大明确说过出门要带伞', source: 'autonomous', idempotencyKey: 'idem-user-priority', epistemicType: 'inferred', evidence: ['guess'] });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'user_correction_wins');
});

await check('版本冲突不静默覆盖', async () => {
  const item = adapter.list()[0];
  const r = await adapter.upsert({ id: item.id, content: '用户不喜欢深夜写代码', source: 'autonomous', idempotencyKey: 'idem-version', expectedVersion: 'not-the-real-version', epistemicType: 'direct' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'version_conflict');
});

await check('写入失败返回 sideEffect none 或 unknown，不能伪装成功', async () => {
  const { createLearnedAdapter: create } = await import('../src/autonomous/learned-adapter.js');
  const bad = create({ listAll: () => [], addExperience: () => { throw new Error('disk fail'); } });
  await assert.rejects(() => bad.upsert({ content: '测试失败路径内容', source: 'autonomous', idempotencyKey: 'idem-fail' }), /disk fail/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nG2 learned adapter: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
