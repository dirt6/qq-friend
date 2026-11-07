// 5.0-E1 执行状态持久化专项。仅临时目录，不触碰生产。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { canTransition } from '../src/autonomous/execution-state.js';
import { createExecutionStore } from '../src/autonomous/execution-store.js';

const c = createChecker('5.0-E1 Execution');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e1-exec-'));
const file = path.join(dir, 'exec.json');
const receipt = { receiptId: 'rcpt:t1', status: 'decision_recorded', execution: { state: 'decision_recorded' } };
let store = createExecutionStore({ file });

try {
  c.section('1. 状态迁移');
  await c.check('合法迁移/非法跳跃/unknown 必须显式对账', () => {
    assert.equal(canTransition('decision_recorded', 'authorization_pending').ok, true);
    assert.equal(canTransition('decision_recorded', 'started').ok, false);
    assert.equal(canTransition('started', 'succeeded').ok, true);
    assert.equal(canTransition('unknown', 'succeeded').ok, false);
    assert.equal(canTransition('unknown', 'succeeded', { reason: 'reconciled', evidence: 'provider confirmed' }).ok, true);
  });
  await c.check('failed 重试需授权且未超限', () => {
    assert.equal(canTransition('failed', 'authorization_pending', { reason: 'retry_authorized', attempts: 0, maxRetries: 1 }).ok, true);
    assert.equal(canTransition('failed', 'authorization_pending', { reason: 'x', attempts: 0, maxRetries: 1 }).ok, false);
    assert.equal(canTransition('failed', 'authorization_pending', { reason: 'retry_authorized', attempts: 1, maxRetries: 1 }).ok, false);
  });

  c.section('2. 持久化/幂等');
  await c.check('record → decision_recorded，重复 record 幂等', async () => {
    const a = await store.recordReceipt(receipt, { now: '2026-11-04T15:00:00Z' });
    const b = await store.recordReceipt(receipt, { now: '2026-11-04T15:01:00Z' });
    assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
    assert.equal((await store.get('rcpt:t1')).state, 'decision_recorded');
  });
  await c.check('事件 eventId 重复 → duplicate，不重复迁移', async () => {
    await store.apply('rcpt:t1', { eventId: 'e1', to: 'authorization_pending', reason: 'auth_requested', now: '2026-11-04T15:02:00Z' });
    const b = await store.apply('rcpt:t1', { eventId: 'e1', to: 'authorized', reason: 'x' });
    assert.equal(b.duplicate, true);
    assert.equal((await store.get('rcpt:t1')).state, 'authorization_pending');
  });
  await c.check('授权 token 绑定 receipt/plan/expiry', async () => {
    const bad = await store.authorize('rcpt:t1', { eventId: 'e2', authorization: { receiptId: 'other', planHash: 'p', authorizedBy: 'x', expiresAt: '2026-11-04T16:00:00Z' }, now: Date.parse('2026-11-04T15:00:00Z') });
    assert.equal(bad.ok, false);
    const ok = await store.authorize('rcpt:t1', { eventId: 'e2', authorization: { receiptId: 'rcpt:t1', planHash: 'p', authorizedBy: 'owner', expiresAt: '2026-11-04T16:00:00Z' }, now: Date.parse('2026-11-04T15:00:00Z') });
    assert.equal(ok.ok, true);
    assert.equal((await store.get('rcpt:t1')).state, 'authorized');
  });
  await c.check('started → unknown（进程恢复），不自动 failed/succeeded', async () => {
    await store.apply('rcpt:t1', { eventId: 'e3', to: 'started', reason: 'start' });
    await store.recover({ now: '2026-11-04T15:10:00Z' });
    const rec = await store.get('rcpt:t1');
    assert.equal(rec.state, 'unknown');
    assert.equal(rec.finishedAt, null);
  });
  await c.check('unknown 不能通过普通 apply 变 succeeded；必须 reconcile+证据', async () => {
    const bad = await store.apply('rcpt:t1', { eventId: 'e4', to: 'succeeded', reason: 'guess' });
    assert.equal(bad.ok, false);
    const ok = await store.reconcile('rcpt:t1', { eventId: 'e4', to: 'succeeded', evidence: 'external ledger confirms', now: '2026-11-04T15:11:00Z' });
    assert.equal(ok.ok, true);
    assert.equal((await store.get('rcpt:t1')).state, 'succeeded');
  });
  await c.check('重启后从文件恢复记录/审计/seenEvents', async () => {
    const s2 = createExecutionStore({ file });
    const rec = await s2.get('rcpt:t1');
    assert.equal(rec.state, 'succeeded');
    assert.ok(rec.history.length >= 4);
    assert.ok((await s2.list()).audit.length >= 4);
  });

  c.section('3. 暂停/错误');
  await c.check('pause/resume 持久化', async () => {
    await store.pause('maintenance'); assert.equal((await store.list()).paused, true);
    await store.resume(); assert.equal((await store.list()).paused, false);
  });
  await c.check('不存在的 receipt → 明确失败', async () => {
    const r = await store.apply('missing', { eventId: 'x', to: 'started' });
    assert.equal(r.ok, false); assert.equal(r.error, 'receipt_not_found');
  });
  await c.check('terminal 后拒绝再迁移', async () => {
    const r = await store.apply('rcpt:t1', { eventId: 'e5', to: 'cancelled' });
    assert.equal(r.ok, false); assert.equal(r.error, 'terminal_state');
  });
  await c.check('文件是完整 JSON（原子写）', () => {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.ok(raw.records['rcpt:t1']);
  });
  await c.check('未传 file 拒绝（禁止默认生产路径）', () => {
    assert.throws(() => createExecutionStore({}), /显式 file/);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
process.exit(c.finish() ? 0 : 1);
