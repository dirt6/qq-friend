// 5.0-E6：生产 app 启动集成（临时 DATA_DIR，真实 bootApp）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, freePort } from './_harness.mjs';

let ctx = null;
let pass = 0; let fail = 0;
async function check(name, fn) { try { await fn(); pass += 1; console.log(`OK    ${name}`); } catch (e) { fail += 1; console.log(`FAIL  ${name}: ${e?.message || e}`); } }
try {
  ctx = await bootApp({ config: { server: { token: '', port: await freePort() }, skills: { autonomous: { enabled: false }, 'silence-ping': { enabled: false } } } });
  const g1Token = 'g'.repeat(43);
  const runtimeToken = 'r'.repeat(43);
  fs.mkdirSync(path.join(ctx.dataDir, '5.0-g1'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dataDir, '5.0-g1', 'token'), g1Token, 'utf8');
  fs.mkdirSync(path.join(ctx.dataDir, '5.0-runtime'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dataDir, '5.0-runtime', 'control-token'), runtimeToken, 'utf8');

  await check('5.0 Runtime 无 token → 401', async () => {
    assert.equal((await ctx.request('GET', '/api/5.0/status')).status, 401);
    assert.equal((await ctx.request('GET', '/api/5.0/status', { headers: { 'x-5.0-token': 'bad' } })).status, 401);
  });
  await check('启动后 G1 paused / Runtime paused / G2/G3 disabled', async () => {
    const g1 = await ctx.request('GET', '/api/g1/status', { headers: { 'x-g1-token': g1Token } });
    assert.equal(g1.status, 200);
    assert.equal(g1.data.paused, true);
    const rt = await ctx.request('GET', '/api/5.0/status', { headers: { 'x-5.0-token': runtimeToken } });
    assert.equal(rt.status, 200);
    assert.equal(rt.data.paused, true);
    assert.equal(rt.data.g2Enabled, false);
    assert.equal(rt.data.g3Enabled, false);
    assert.equal(rt.data.readonlyEnabled, false);
    assert.equal(rt.data.drawEnabled, false);
    assert.equal(rt.data.tokenConfigured, true);
  });
  await check('paused 时 5.0 run → 423，无模型/发送', async () => {
    const r = await ctx.request('POST', '/api/5.0/run', { headers: { 'x-5.0-token': runtimeToken }, body: { executionPlan: { kind: 'learned' } } });
    assert.equal(r.status, 423);
    assert.equal(ctx.llm.state.requests.length, 0);
    assert.equal(ctx.onebotHttp.state.sends.length, 0);
  });

  await check('G2/G3 开关独立，默认保持 disabled', async () => {
    let r = await ctx.request('POST', '/api/5.0/features', { headers: { 'x-5.0-token': runtimeToken }, body: { g2: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.g2Enabled, true);
    assert.equal(r.data.g3Enabled, false);
    r = await ctx.request('POST', '/api/5.0/features', { headers: { 'x-5.0-token': runtimeToken }, body: { g2: false, g3: false } });
    assert.equal(r.data.g2Enabled, false);
    assert.equal(r.data.g3Enabled, false);
  });
  await check('5.0 控制 token 与 G1 token 分离', async () => {
    assert.equal((await ctx.request('GET', '/api/5.0/status', { headers: { 'x-g1-token': g1Token } })).status, 401);
    assert.equal((await ctx.request('GET', '/api/g1/status', { headers: { 'x-5.0-token': runtimeToken } })).status, 401);
  });
} finally {
  if (ctx) await ctx.teardown();
}
console.log(`\nE6 startup: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
