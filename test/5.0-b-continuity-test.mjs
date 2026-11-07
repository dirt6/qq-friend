// 5.0-B 连续性与恢复专项。无生产数据、无执行/写入。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { buildContinuityContext } from '../src/autonomous/continuity.js';

const c = createChecker('5.0-B Continuity');
const src = fs.readFileSync(new URL('../src/autonomous/continuity.js', import.meta.url), 'utf8');
const run = (x) => buildContinuityContext(x);
const goal = (id, status = 'active') => ({ id, text: `目标${id}`, status });
const pending = (id, status = 'pending', extra = {}) => ({ id, text: `事项${id}`, status, ...extra });
const action = (id, state, extra = {}) => ({ actionId: id, state, title: `动作${id}`, ...extra });

try {
  c.section('1. 跨 Round 延续');
  await c.check('active Goal → advance_goal 候选', () => {
    const r = run({ goals: [goal('g1')], rounds: [{ roundId: 'r1' }, { roundId: 'r2' }] });
    assert.equal(r.ok, true);
    assert.ok(r.resumeCandidates.some((x) => x.kind === 'advance_goal' && x.sourceId === 'g1'));
  });
  await c.check('active Pending → continue_pending 候选', () => {
    const r = run({ pending: [pending('p1')] });
    assert.ok(r.resumeCandidates.some((x) => x.kind === 'continue_pending' && x.sourceId === 'p1'));
  });
  await c.check('Action 成功 → completedItems，且 Pending 不重复执行', () => {
    const r = run({ pending: [pending('p1')], actions: [action('a1', 'success', { targetPendingId: 'p1' })] });
    assert.ok(r.completedItems.some((x) => x.sourceId === 'p1'));
    assert.ok(!r.resumeCandidates.some((x) => x.sourceId === 'p1'));
    assert.ok(r.blocked.some((x) => x.reason === 'already_completed_action'));
  });
  await c.check('Action 失败且 safeToRetry → retry_action', () => {
    const r = run({ pending: [pending('p1')], actions: [action('a1', 'failed', { targetPendingId: 'p1', safeToRetry: true, attempts: 0 })] });
    assert.ok(r.resumeCandidates.some((x) => x.kind === 'retry_action' && x.sourceId === 'a1'));
  });
  await c.check('Action 失败但不可安全重试 → 阻塞', () => {
    const r = run({ pending: [pending('p1')], actions: [action('a1', 'failed', { targetPendingId: 'p1', safeToRetry: false })] });
    assert.ok(!r.resumeCandidates.some((x) => x.kind === 'retry_action'));
    assert.ok(r.blocked.some((x) => x.reason === 'retry_not_safe'));
  });

  c.section('2. 未知/执行中/未执行');
  await c.check('结果未知 → blocked，不盲目重试', () => {
    const r = run({ actions: [action('a1', 'unknown', { targetPendingId: 'p1' })] });
    assert.ok(r.blocked.some((x) => x.reason === 'outcome_unknown_no_retry'));
    assert.ok(!r.resumeCandidates.some((x) => x.kind === 'retry_action'));
  });
  await c.check('执行中/进程中断 → blocked outcome_unknown_running', () => {
    const r = run({ actions: [action('a1', 'started', { targetPendingId: 'p1' })] });
    assert.ok(r.blocked.some((x) => x.reason === 'outcome_unknown_running'));
    assert.ok(r.context.unfinishedActionIds.includes('a1'));
  });
  await c.check('已授权但未执行 → 阻塞 not_started，不当作 unknown', () => {
    const r = run({ actions: [action('a1', 'authorized', { targetPendingId: 'p1' })] });
    assert.ok(r.blocked.some((x) => x.reason === 'not_started_requires_execution_authorization'));
    assert.ok(!r.blocked.some((x) => x.reason === 'outcome_unknown_running'));
  });

  c.section('3. 状态/过期/新证据');
  await c.check('Goal paused/terminal → 不复活', () => {
    const r = run({ goals: [goal('g1', 'paused'), goal('g2', 'completed')] });
    assert.equal(r.resumeCandidates.length, 0);
    assert.ok(r.blocked.some((x) => x.reason === 'goal_paused'));
    assert.ok(r.blocked.some((x) => x.reason === 'goal_completed'));
  });
  await c.check('Pending 过期 → 不进入候选', () => {
    const r = run({ now: '2026-11-05T00:00:00Z', pending: [pending('p1', 'pending', { expiresAt: '2026-11-04T00:00:00Z' })] });
    assert.ok(r.context.expiredPendingIds.includes('p1'));
    assert.ok(!r.resumeCandidates.some((x) => x.sourceId === 'p1'));
  });
  await c.check('已处理 Pending + 新证据 → 允许继续', () => {
    const r = run({ pending: [pending('p1')], processedKeys: ['cont:pending:p1:'], newEvidence: [{ id: 'p1', text: '新信息' }] });
    assert.ok(r.resumeCandidates.some((x) => x.sourceId === 'p1'));
  });
  await c.check('多个相似 Pending → 按 ID 分开，不按标题合并', () => {
    const r = run({ pending: [{ id: 'p1', text: '同一个事项', status: 'pending' }, { id: 'p2', text: '同一个事项', status: 'pending' }] });
    assert.equal(r.resumeCandidates.filter((x) => x.kind === 'continue_pending').length, 2);
    assert.ok(r.uncertainties.some((u) => u.code === 'similar_pending_items'));
  });

  c.section('4. 重复/中断/历史');
  await c.check('重复 tick → duplicateTick，不清空历史', () => {
    const r = run({ tickId: 't1', processedTicks: ['t1'], goals: [goal('g1')] });
    assert.equal(r.duplicateTick, true);
    assert.equal(r.resumeCandidates.length, 0);
  });
  await c.check('重复读取/已处理 key → blocked already_processed', () => {
    const r = run({ goals: [goal('g1')], processedKeys: ['cont:goal:g1:'] });
    assert.ok(!r.resumeCandidates.some((x) => x.sourceId === 'g1'));
    assert.ok(r.blocked.some((x) => x.reason === 'already_processed'));
  });
  await c.check('历史 Action 缺关联 ID → 保守阻塞 legacy_missing_link', () => {
    const r = run({ actions: [{ actionId: '', state: 'success', title: '旧动作' }] });
    assert.ok(r.blocked.some((x) => x.reason === 'legacy_missing_link'));
    assert.ok(r.uncertainties.some((u) => u.code === 'legacy_unlinked_action'));
  });
  await c.check('重试次数达到上限 → 不再重试', () => {
    const r = run({ actions: [action('a1', 'failed', { targetPendingId: 'p1', safeToRetry: true, attempts: 2 })], limits: { maxRetries: 1 } });
    assert.ok(r.blocked.some((x) => x.reason === 'retry_limit'));
  });

  c.section('5. 纯度/输入');
  await c.check('非法输入 → INVALID_INPUT', () => {
    for (const x of [null, [], { goals: 'x' }, { actions: {} }, { now: 'bad' }]) {
      const r = run(x); assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_INPUT');
    }
  });
  await c.check('输入不可变（深比较）', () => {
    const x = { goals: [goal('g1')], pending: [pending('p1')], actions: [action('a1', 'failed', { targetPendingId: 'p1', safeToRetry: true })], rounds: [{ roundId: 'r1' }] };
    const before = JSON.stringify(x);
    run(x);
    assert.equal(JSON.stringify(x), before);
  });
  await c.check('源码无 I/O/模型/发送/系统时钟/随机/写入', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);
