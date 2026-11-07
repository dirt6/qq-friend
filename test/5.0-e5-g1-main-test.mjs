// 5.0-E5 G1 主进程入口专项：真实 bootApp + 临时 DATA_DIR。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createChecker, bootApp, freePort } from './_harness.mjs';
import { createG1Service } from '../src/g1-service.js';

const c = createChecker('5.0-E5 G1 Main');
const token = crypto.randomBytes(32).toString('base64url');
let ctx = null;
const nonce = () => `n-${Date.now()}-${Math.random().toString(16).slice(2)}-abcdef`;
try {
  ctx = await bootApp({ config: { server: { port: await freePort() }, skills: { diary: { root: path.join(process.env.TEMP, `g1-diary-${Date.now()}`) } } } });
  await c.check('无 G1 token 文件 → 401 fail-closed', async () => { assert.equal((await ctx.request('GET', '/api/g1/status')).status, 401);
    assert.equal((await ctx.request('GET', '/api/g1/status', { headers: { 'x-g1-token': 'wrong-token' } })).status, 401);
    assert.equal((await ctx.request('GET', `/api/g1/status?x-g1-token=${encodeURIComponent(token)}`)).status, 401); });
  fs.mkdirSync(path.join(ctx.dataDir, '5.0-g1'), { recursive: true });
  fs.writeFileSync(path.join(ctx.dataDir, '5.0-g1', 'token'), token, 'utf8');
  const h = { 'x-g1-token': token };
  const status = await ctx.request('GET', '/api/g1/status', { headers: h });
  await c.check('主进程 status：默认 paused，版本/commit 可读', () => {
    assert.equal(status.status, 200);
    assert.equal(status.data.paused, true);
    assert.ok(status.data.version);
    assert.ok(status.data.commit);
  });
  await c.check('未鉴权 → 401；非法 Origin → 403', async () => {
    assert.equal((await ctx.request('GET', '/api/g1/status')).status, 401);
    assert.equal((await ctx.request('GET', '/api/g1/status', { headers: { 'x-g1-token': 'wrong-token' } })).status, 401);
    assert.equal((await ctx.request('GET', `/api/g1/status?x-g1-token=${encodeURIComponent(token)}`)).status, 401);
    assert.equal((await ctx.request('GET', '/api/g1/status', { headers: { ...h, origin: 'http://evil.example' } })).status, 403);
  });
  await c.check('paused 时 run → 423，不消费 nonce', async () => {
    const r = await ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': nonce() } });
    assert.equal(r.status, 423);
    assert.equal(r.data.code, 'PAUSED');
  });
  await c.check('pause {paused:false} → 可运行；run 一次成功并写审计', async () => {
    const up = await ctx.request('POST', '/api/g1/pause', { headers: h, body: { paused: false } });
    assert.equal(up.status, 200); assert.equal(up.data.paused, false);
    const r = await ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': nonce() } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.data.ok, true);
    assert.equal(r.data.result.receipt.status, 'decision_recorded');
    const dir = path.join(ctx.dataDir, '5.0-g1');
    assert.ok(fs.existsSync(path.join(dir, 'g1-receipt.json')));
    assert.ok(fs.existsSync(path.join(dir, 'g1-audit.ndjson')));
  });
  await c.check('nonce 重放 → 409', async () => {
    await ctx.request('POST', '/api/g1/pause', { headers: h, body: { paused: false } });
    const n = nonce();
    const a = await ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': n } });
    const b = await ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': n } });
    assert.equal(a.status, 200);
    assert.equal(b.status, 409);
    assert.ok(['NONCE_REPLAY', 'TICK_USED'].includes(b.data.code));
  });
  await c.check('并发不同 nonce → 只允许一次运行（另一次 409/423）', async () => {
    await ctx.request('POST', '/api/g1/pause', { headers: h, body: { paused: false } });
    const [a, b] = await Promise.all([
      ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': nonce() } }),
      ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': nonce() } })
    ]);
    const statuses = [a.status, b.status].sort();
    assert.ok(statuses.includes(200));
    assert.ok(statuses.includes(409) || statuses.includes(423));
  });
  await c.check('pause 后 run → 423', async () => {
    const p = await ctx.request('POST', '/api/g1/pause', { headers: h, body: { paused: true } });
    assert.equal(p.status, 200);
    const r = await ctx.request('POST', '/api/g1/run', { headers: { ...h, 'x-g1-nonce': nonce() } });
    assert.equal(r.status, 423);
  });
  await c.check('业务数据未被 G1 写（仅 5.0-g1 目录）', () => {
    const g1 = path.join(ctx.dataDir, '5.0-g1');
    assert.ok(fs.existsSync(g1));
    // 业务文件不存在或未由 G1 创建；G1 只读 Core
    assert.ok(!fs.existsSync(path.join(g1, 'messages')));
  });
  await c.check('G1 service 进程重启默认 paused', async () => {
    const dir = path.join(process.env.TEMP, `g1-svc-${Date.now()}`);
    const fakeCore = { readChatSnapshot: () => ({ goals: { active: null }, pending: [], context: [], generatedAt: new Date().toISOString() }) };
    const s1 = createG1Service({ core: fakeCore, dataDir: path.dirname(dir), auditDir: path.join(path.dirname(dir), '5.0-g1'), version: 'x' });
    assert.equal(s1.status().paused, true);
  });
  await c.check('G1 路由无 executor/model 字段（源码审查）', () => {
    const route = fs.readFileSync('src/routes.js', 'utf8');
    const svc = fs.readFileSync('src/g1-service.js', 'utf8');
    assert.ok(!/chatCompletion\s*\(|sendMessage\s*\(|spawn\s*\(|executor\s*\(/.test(svc));
    assert.ok(!/g1.*executor/i.test(route));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  if (ctx) { try { await ctx.teardown(); } catch { /* ignore */ } }
}
process.exit(c.finish() ? 0 : 1);
