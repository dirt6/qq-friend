// 5.0-D 记忆治理专项。无存储、无生产数据、无 I/O。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { governMemory, canReadDomain } from '../src/autonomous/memory-governance.js';

const c = createChecker('5.0-D Memory');
const src = fs.readFileSync(new URL('../src/autonomous/memory-governance.js', import.meta.url), 'utf8');
const run = (x) => governMemory(x);
const intent = (extra = {}) => ({ id: 'i1', domain: 'learned', op: 'write', content: '用户喜欢猫', source: 'chat:1', owner: 'user', epistemicType: 'explicit', evidence: ['msg:1'], at: '2026-11-04T12:00:00Z', ...extra });
const existing = (extra = {}) => ({ id: 'e1', domain: 'learned', content: '旧内容', version: 1, ...extra });

try {
  c.section('1. 读取治理');
  await c.check('chat/autonomous 经 Hub/Core 读取允许', () => {
    assert.equal(canReadDomain({ requester: 'chat', domain: 'learned', purpose: '回答用户' }).ok, true);
    assert.equal(canReadDomain({ requester: 'autonomous', domain: 'diary', purpose: '找延续话题' }).ok, true);
  });
  await c.check('非法 requester/domain/无 purpose → 拒绝', () => {
    assert.equal(canReadDomain({ requester: 'other', domain: 'learned', purpose: 'x' }).ok, false);
    assert.equal(canReadDomain({ requester: 'chat', domain: 'unknown', purpose: 'x' }).ok, false);
    assert.equal(canReadDomain({ requester: 'chat', domain: 'learned', purpose: '' }).ok, false);
  });

  c.section('2. 写入字段治理');
  await c.check('正常写入 → accepted，路由回原领域（不写 Hub）', () => {
    const r = run({ intents: [intent()] });
    assert.equal(r.accepted.length, 1);
    assert.equal(r.accepted[0].routedTo, 'learned');
    assert.equal(r.accepted[0].status, 'accepted');
  });
  await c.check('chat 写入 → 拒绝 chatstore_owned，仍可读', () => {
    const r = run({ intents: [intent({ domain: 'chat', content: '聊天内容' })] });
    assert.equal(r.accepted.length, 0);
    assert.ok(r.rejected.some((x) => x.reason === 'chatstore_owned_read_only'));
  });
  await c.check('缺 source / inferred 缺证据 / 非法 owner → 拒绝', () => {
    for (const x of [intent({ source: '' }), intent({ epistemicType: 'inferred', evidence: [] }), intent({ owner: 'bad' })]) {
      const r = run({ intents: [x] });
      assert.equal(r.accepted.length, 0);
    }
  });
  await c.check('旧数据缺 version/corrections → 标记 legacy，不重写', () => {
    const r = run({ existing: [{ id: 'old', content: '旧' }] });
    assert.ok(r.uncertainties.some((u) => u.code === 'legacy_record'));
    assert.equal(r.accepted.length, 0);
  });

  c.section('3. 纠正保护');
  await c.check('纠正目标存在 → oldPreserved，历史保留', () => {
    const r = run({ existing: [existing()], intents: [intent({ id: 'c1', op: 'correct', correctsId: 'e1', content: '新内容' })] });
    assert.equal(r.corrections.length, 1);
    assert.equal(r.corrections[0].targetResolved, true);
    assert.equal(r.corrections[0].oldPreserved, true);
  });
  await c.check('目标缺失 → historicalUnresolved，不猜旧内容', () => {
    const r = run({ intents: [intent({ id: 'c1', op: 'correct', correctsId: 'missing', content: '新内容' })] });
    assert.equal(r.corrections[0].targetResolved, false);
    assert.equal(r.corrections[0].historicalUnresolved, true);
    assert.ok(r.uncertainties.some((u) => u.code === 'historical_unresolved'));
  });
  await c.check('用户已纠正的内容不能被 inferred 覆盖', () => {
    const r = run({ existing: [existing({ explicitCorrected: true })], intents: [intent({ op: 'correct', correctsId: 'e1', owner: 'inferred', epistemicType: 'observed', evidence: ['x'] })] });
    assert.equal(r.accepted.length, 0);
    assert.ok(r.rejected.some((x) => x.reason === 'correction_protected'));
  });
  await c.check('用户纠正可更新，旧内容仍保留', () => {
    const r = run({ existing: [existing({ explicitCorrected: true })], intents: [intent({ op: 'correct', correctsId: 'e1', owner: 'user', content: '再次纠正' })] });
    assert.equal(r.corrections[0].oldPreserved, true);
    assert.equal(r.accepted.length, 1);
  });
  await c.check('historicalUnresolved 不被清掉', () => {
    const r = run({ existing: [existing({ historicalUnresolved: true })], intents: [intent({ op: 'correct', correctsId: 'e1', content: '新' })] });
    assert.ok(r.uncertainties.some((u) => u.code === 'historical_unresolved_preserved'));
  });

  c.section('4. 生命周期');
  await c.check('重要日记不允许 archive', () => {
    const r = run({ intents: [intent({ domain: 'diary', op: 'archive', importance: 'high' })] });
    assert.ok(r.rejected.some((x) => x.reason === 'important_diary_archive_forbidden'));
  });
  await c.check('临时事项可 expire，且不标记 Goal 完成', () => {
    const r = run({ intents: [intent({ domain: 'companion', op: 'expire', temporary: true, kind: 'pending', content: '临时' })] });
    assert.equal(r.accepted.length, 1);
    assert.equal(r.lifecycle[0].goalCompleted, false);
    assert.equal(r.lifecycle[0].temporary, true);
  });
  await c.check('非临时事项 expire → 拒绝', () => {
    const r = run({ intents: [intent({ domain: 'companion', op: 'expire', temporary: false, content: '长期' })] });
    assert.ok(r.rejected.some((x) => x.reason === 'expire_requires_temporary'));
  });
  await c.check('Goal 生命周期不由 Hub 改 → 拒绝', () => {
    const r = run({ intents: [intent({ domain: 'companion', op: 'expire', kind: 'goal', temporary: true, content: '目标' })] });
    assert.ok(r.rejected.some((x) => x.reason === 'goal_lifecycle_domain_owned'));
  });
  await c.check('可变事实标记待复核', () => {
    const r = run({ intents: [intent({ volatile: true })] });
    assert.equal(r.accepted[0].needsReview, true);
    assert.ok(r.lifecycle.some((x) => x.needsReview === true));
  });
  await c.check('版本冲突 → 拒绝，不覆盖', () => {
    const r = run({ existing: [existing({ version: 2 })], intents: [intent({ expectedVersion: 1, targetId: 'e1' })] });
    assert.ok(r.rejected.some((x) => x.reason === 'version_conflict'));
  });

  c.section('5. 输入/纯度');
  await c.check('非法输入 → INVALID_INPUT', () => {
    for (const x of [null, [], { intents: 'x' }, { existing: {} }, { now: 'bad' }]) {
      const r = run(x); assert.equal(r.ok, false); assert.equal(r.code, 'INVALID_INPUT');
    }
  });
  await c.check('输入不可变（深比较）', () => {
    const x = { intents: [intent()], existing: [existing()] }; const before = JSON.stringify(x); run(x);
    assert.equal(JSON.stringify(x), before);
  });
  await c.check('源码无 I/O/模型/发送/系统时钟/随机/写入', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);
