// 5.0-C 分享判断专项。无发送、无生产数据、无 I/O。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { decideShare } from '../src/autonomous/sharing.js';

const c = createChecker('5.0-C Sharing');
const src = fs.readFileSync(new URL('../src/autonomous/sharing.js', import.meta.url), 'utf8');
const run = (x) => decideShare(x);
const discovery = (extra = {}) => ({ id: 'd1', title: '量子计算新突破', summary: '某团队展示了新的纠错方案', source: 'example.com', reliability: 0.8, relevance: 0.8, value: 0.7, sensitivity: 0, ...extra });
const base = (extra = {}) => ({ now: '2026-11-04T12:00:00Z', discovery: discovery(), user: {}, conversation: { closureDecision: 'close' }, recentShares: [], ...extra });

try {
  c.section('1. 高相关/低相关/可靠性');
  await c.check('高相关高价值可靠来源 → share_now，但 sendAuthorized=false', () => {
    const r = run(base());
    assert.equal(r.decision, 'share_now');
    assert.equal(r.sendAuthorized, false);
    assert.equal(r.needsConfirmation, false);
  });
  await c.check('低相关 → record_only', () => {
    const r = run(base({ discovery: discovery({ relevance: 0.2 }) }));
    assert.equal(r.decision, 'record_only');
    assert.equal(r.reason, 'low_relevance_or_value');
  });
  await c.check('不可靠来源 → record_only', () => {
    const r = run(base({ discovery: discovery({ reliability: 0.2 }) }));
    assert.equal(r.decision, 'record_only');
    assert.equal(r.reason, 'unreliable_source');
  });
  await c.check('低价值 → record_only', () => {
    const r = run(base({ discovery: discovery({ value: 0.2 }) }));
    assert.equal(r.decision, 'record_only');
  });

  c.section('2. 去重/边界');
  await c.check('同 fingerprint 已分享 → record_only duplicate', () => {
    const d = discovery();
    const first = run(base({ discovery: d }));
    const r = run(base({ discovery: d, recentShares: [{ fingerprint: first.fingerprint, source: d.source, title: d.title, at: '2026-11-04T11:00:00Z' }] }));
    assert.equal(r.decision, 'record_only');
    assert.equal(r.duplicate, true);
  });
  await c.check('轻微改写同来源 → 相似去重', () => {
    const d = discovery();
    const first = run(base({ discovery: d }));
    const r = run(base({
      discovery: discovery({ title: '量子计算的新突破', summary: '某团队展示了新的纠错方案（更新）' }),
      recentShares: [{ fingerprint: first.fingerprint, source: d.source, title: d.title, summary: d.summary, at: '2026-11-04T11:00:00Z' }]
    }));
    assert.equal(r.decision, 'record_only');
    assert.equal(r.duplicate, true);
  });
  await c.check('用户关闭自主分享/勿扰 → do_not_share', () => {
    assert.equal(run(base({ user: { allowAutonomousShare: false } })).decision, 'do_not_share');
    assert.equal(run(base({ user: { doNotDisturb: true } })).decision, 'do_not_share');
  });
  await c.check('屏蔽来源/话题 → do_not_share', () => {
    assert.equal(run(base({ user: { blockedSources: ['example.com'] } })).decision, 'do_not_share');
    assert.equal(run(base({ user: { blockedTopics: ['量子'] } })).decision, 'do_not_share');
  });
  await c.check('敏感内容 → do_not_share', () => {
    const r = run(base({ discovery: discovery({ sensitivity: 0.9 }) }));
    assert.equal(r.decision, 'do_not_share');
    assert.equal(r.risk, 'high');
  });
  await c.check('中等相关 → save_for_later', () => {
    const r = run(base({ discovery: discovery({ relevance: 0.55, value: 0.45 }) }));
    assert.equal(r.decision, 'save_for_later');
  });
  await c.check('频率上限 → save_for_later', () => {
    const r = run(base({ limits: { maxPerDay: 1 }, recentShares: [{ fingerprint: 'other', at: '2026-11-04T11:00:00Z' }] }));
    assert.equal(r.decision, 'save_for_later');
    assert.equal(r.reason, 'share_rate_limited');
  });

  c.section('3. A2 联动/求助');
  await c.check('A2 continue → 不分享，save_for_later', () => {
    const r = run(base({ conversation: { closureDecision: 'continue' } }));
    assert.equal(r.decision, 'save_for_later');
    assert.equal(r.reason, 'conversation_busy_or_active');
  });
  await c.check('用户求助 → save_for_later，不插入发现', () => {
    const r = run(base({ conversation: { closureDecision: 'close', userAskingForHelp: true } }));
    assert.equal(r.decision, 'save_for_later');
  });
  await c.check('A2 close 不等于自动分享；仅 close 时仍看质量', () => {
    const high = run(base({ conversation: { closureDecision: 'close' } }));
    const low = run(base({ discovery: discovery({ relevance: 0.1 }), conversation: { closureDecision: 'close' } }));
    assert.equal(high.decision, 'share_now');
    assert.equal(high.sendAuthorized, false);
    assert.equal(low.decision, 'record_only');
  });

  c.section('4. 冲突/缺失/输入');
  await c.check('来源可靠性冲突 → undetermined', () => {
    const r = run(base({ discovery: discovery({ sources: [{ reliability: 0.9 }, { reliability: 0.2 }] }) }));
    assert.equal(r.decision, 'undetermined');
    assert.equal(r.reason, 'conflicting_sources');
  });
  await c.check('缺标题/摘要 → undetermined', () => {
    const r = run(base({ discovery: { id: 'x' } }));
    assert.equal(r.decision, 'undetermined');
  });
  await c.check('非法输入 → INVALID_INPUT', () => {
    for (const x of [null, [], { discovery: 'x' }, { recentShares: {} }, { now: 'bad' }]) {
      const r = run(x); assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_INPUT');
    }
  });
  await c.check('输入不可变（深比较）', () => {
    const x = base(); const before = JSON.stringify(x); run(x);
    assert.equal(JSON.stringify(x), before);
  });
  await c.check('源码无 I/O/发送/模型/系统时钟/随机', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);
