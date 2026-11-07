// 5.0-E5 G2/G3 隔离专项：记忆写入 + QQ 发送（Fake adapters/sender，无生产）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { createMemoryWriter } from '../src/autonomous/memory-writer.js';
import { sendShare } from '../src/autonomous/qq-sender.js';
import { createAuthorizationService } from '../src/autonomous/authorization.js';

const c = createChecker('5.0-E5 G2/G3');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e5-g2g3-'));
const nowMs = Date.parse('2026-11-05T01:00:00Z');
const key = 'z'.repeat(64);

try {
  c.section('1. G2 记忆写入');
  const calls = [];
  const adapters = {
    learned: { upsert: async (p) => { calls.push(p); return { ok: true }; } },
    diary: { write: async (p) => { calls.push(p); return { ok: true }; } },
    companion: { apply: async (p) => { calls.push(p); return { ok: true }; } }
  };
  const intents = [{ id: 'i1', domain: 'learned', op: 'write', content: '用户喜欢猫', source: 'chat:1', owner: 'user', epistemicType: 'explicit', evidence: ['m1'] }];
  const accepted = [{ intentId: 'i1', status: 'accepted' }];
  await c.check('单条写入 → 路由领域 adapter', async () => {
    const w = createMemoryWriter({ adapters, now: () => nowMs });
    const r = await w.execute({ intents, accepted, receiptId: 'r1' });
    assert.equal(r.written, 1); assert.equal(r.results[0].domain, 'learned');
    assert.equal(calls.length, 1); assert.equal(calls[0].content, '用户喜欢猫');
  });
  await c.check('重复写入 → duplicate，不重复调用 adapter', async () => {
    const w = createMemoryWriter({ adapters, now: () => nowMs });
    await w.execute({ intents, accepted, receiptId: 'r1' });
    const before = calls.length;
    const r2 = await w.execute({ intents, accepted, receiptId: 'r1' });
    assert.equal(r2.written, 0); assert.equal(r2.results[0].state, 'duplicate');
    assert.equal(calls.length, before);
  });
  await c.check('并发同一 key → adapter 只调用一次', async () => {
    const w = createMemoryWriter({ adapters, now: () => nowMs });
    const before = calls.length;
    const a = w.execute({ intents, accepted, receiptId: 'r2' });
    const b = w.execute({ intents, accepted, receiptId: 'r2' });
    await Promise.all([a, b]);
    assert.equal(calls.length, before + 1);
  });
  await c.check('adapter 抛错 → unknown，不自动重试', async () => {
    const w = createMemoryWriter({ adapters: { learned: { upsert: async () => { throw new Error('disk'); } } }, now: () => nowMs });
    const r = await w.execute({ intents, accepted, receiptId: 'r3' });
    assert.equal(r.results[0].state, 'unknown'); assert.equal(r.unknown, 1);
  });
  await c.check('明确 sideEffect=none 的失败 → failed；未声明 → unknown', async () => {
    const w1 = createMemoryWriter({ adapters: { learned: { upsert: async () => ({ ok: false, sideEffect: 'none', error: 'no' }) } }, now: () => nowMs });
    assert.equal((await w1.execute({ intents, accepted, receiptId: 'r4' })).results[0].state, 'failed');
    const w2 = createMemoryWriter({ adapters: { learned: { upsert: async () => ({ ok: false, error: 'maybe' }) } }, now: () => nowMs });
    assert.equal((await w2.execute({ intents, accepted, receiptId: 'r5' })).results[0].state, 'unknown');
  });
  await c.check('未接受/需确认 → 不写；adapter 缺失拒绝', async () => {
    const w = createMemoryWriter({ adapters, now: () => nowMs });
    const r = await w.execute({ intents: [{ ...intents[0], id: 'i2' }], accepted: [{ intentId: 'i2', status: 'needs_confirmation', requiresConfirmation: true }], receiptId: 'r6' });
    assert.equal(r.results[0].state, 'needs_confirmation');
    const r2 = await w.execute({ intents: [{ ...intents[0], id: 'i3', domain: 'memory' }], accepted: [{ intentId: 'i3', status: 'accepted' }], receiptId: 'r7' });
    assert.equal(r2.results[0].state, 'rejected');
  });

  c.section('2. G3 QQ 发送授权');
  const svc = createAuthorizationService({ keys: { k1: key }, keyId: 'k1', now: () => nowMs });
  let n = 0;
  const sign = (over = {}) => svc.sign({ receiptId: 'share1', planHash: 'share1', actionType: 'qq.send', target: 'private:1', params: { text: '你好' }, authorizedBy: 'owner', issuedAt: '2026-11-05T00:59:00Z', expiresAt: '2026-11-05T02:00:00Z', nonce: `n-0000000000000${String(n += 1).padStart(2, '0')}`, scope: 'send', ...over });
  const sender = { sent: 0, async send() { this.sent += 1; return { ok: true, sideEffect: 'occurred', messageId: 'm1' }; } };
  const base = { decision: { decision: 'share_now' }, shareId: 'share1', target: 'private:1', text: '你好', authorizationService: svc, sender, allowedTargets: ['private:1'], now: nowMs };
  await c.check('合法授权 → sent 一次', async () => {
    const r = await sendShare({ ...base, authorization: sign() });
    assert.equal(r.state, 'sent'); assert.equal(sender.sent, 1);
  });
  await c.check('未授权/目标替换/文本篡改/过期/重放 → 拒绝', async () => {
    assert.equal((await sendShare({ ...base, authorization: null })).state, 'blocked');
    const t = sign();
    assert.equal((await sendShare({ ...base, target: 'private:2', allowedTargets: ['private:2'], authorization: t })).state, 'blocked');
    assert.equal((await sendShare({ ...base, text: '篡改', authorization: sign() })).state, 'blocked');
    assert.equal((await sendShare({ ...base, authorization: sign({ expiresAt: '2026-11-05T00:00:00Z' }) })).state, 'blocked');
    const replay = sign();
    await sendShare({ ...base, authorization: replay });
    assert.equal((await sendShare({ ...base, authorization: replay })).state, 'blocked');
  });
  await c.check('重复消息/频率/暂停 → 不发', async () => {
    const first = await sendShare({ ...base, authorization: sign() });
    const dup = await sendShare({ ...base, authorization: sign(), recentSends: [{ fingerprint: first.fingerprint, at: '2026-11-05T00:59:00Z' }] });
    assert.equal(dup.state, 'duplicate');
    const paused = await sendShare({ ...base, paused: true, authorization: sign() });
    assert.equal(paused.state, 'paused');
    const rate = await sendShare({ ...base, authorization: sign(), recentSends: Array.from({ length: 3 }, (_, i) => ({ fingerprint: `other${i}`, at: '2026-11-05T00:30:00Z' })), maxPerDay: 3 });
    assert.equal(rate.state, 'rate_limited');
  });
  await c.check('sender 抛错/未知 → unknown，不重发', async () => {
    const s1 = { async send() { throw new Error('timeout'); } };
    const r1 = await sendShare({ ...base, sender: s1, authorization: sign() });
    assert.equal(r1.state, 'unknown');
    let calls = 0;
    const s2 = { async send() { calls += 1; return { ok: false, sideEffect: 'occurred' }; } };
    const r2 = await sendShare({ ...base, sender: s2, authorization: sign() });
    assert.equal(r2.state, 'unknown'); assert.equal(calls, 1);
  });
  await c.check('明确无副作用失败 → failed', async () => {
    const s = { async send() { return { ok: false, sideEffect: 'none', error: 'blocked' }; } };
    const r = await sendShare({ ...base, sender: s, authorization: sign() });
    assert.equal(r.state, 'failed');
  });
  await c.check('not_share_now / 未知目标白名单拒绝', async () => {
    assert.equal((await sendShare({ ...base, decision: { decision: 'record_only' }, authorization: sign() })).state, 'blocked');
    assert.equal((await sendShare({ ...base, target: 'group:9', allowedTargets: ['private:1'], authorization: sign() })).state, 'blocked');
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(c.finish() ? 0 : 1);
