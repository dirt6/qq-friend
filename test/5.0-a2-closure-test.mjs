// 5.0-A2 Conversation Closure 纯逻辑专项。无生产数据、无发送、无 I/O。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createChecker } from './_harness.mjs';
import { assessConversationClosure } from '../src/autonomous/closure.js';

const c = createChecker('5.0-A2 Closure');
const src = fs.readFileSync(new URL('../src/autonomous/closure.js', import.meta.url), 'utf8');
const run = (input) => assessConversationClosure(input);
const user = (text, extra = {}) => ({ role: 'user', text, ...extra });
const bot = (text, extra = {}) => ({ role: 'assistant', text, ...extra });

try {
  c.section('1. 明确问题/求助/继续');
  await c.check('明确问题（未答）→ continue，并列入 unresolved', () => {
    const r = run({ messages: [user('这个功能怎么用？')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'user_asked_question');
    assert.equal(r.unresolvedRequests.length, 1);
  });
  await c.check('明确求助 → continue（不因轮数/时间收尾）', () => {
    const r = run({ now: '2026-11-04T23:00:00Z', conversation: { lastEffectiveAt: '2026-11-01T00:00:00Z' }, messages: [user('能不能帮我查一下这个报错')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'user_needs_help');
  });
  await c.check('用户表示还要继续 → continue', () => {
    const r = run({ messages: [bot('先到这里？'), user('继续，还有呢')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'user_requested_continue');
  });
  await c.check('感谢+追问 → 问题优先，不得收尾', () => {
    const r = run({ messages: [bot('已经修好了'), user('谢谢，那这个怎么弄？')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'user_asked_question');
  });

  c.section('2. 结束/感谢/确认');
  await c.check('问题已被答、用户感谢 → close', () => {
    const r = run({ messages: [user('怎么用？'), bot('这样用'), user('谢谢')] });
    assert.equal(r.decision, 'close');
    assert.equal(r.reason, 'user_thanks');
    assert.equal(r.unresolvedRequests.length, 0);
  });
  await c.check('只表达感谢 → close，nextOpening 可为空', () => {
    const r = run({ messages: [user('谢谢')] });
    assert.equal(r.decision, 'close');
    assert.equal(r.nextOpening, '');
    assert.ok(r.uncertainties.some((u) => u.code === 'no_next_opening'));
  });
  await c.check('简短确认 → close', () => {
    const r = run({ messages: [user('嗯')] });
    assert.equal(r.decision, 'close');
    assert.equal(r.reason, 'user_acknowledged');
  });
  await c.check('用户明确结束 → close', () => {
    const r = run({ messages: [user('先这样，晚安')] });
    assert.equal(r.decision, 'close');
    assert.equal(r.reason, 'user_ended');
  });

  c.section('3. 无新内容/无回复');
  await c.check('双方重复表达 → hold，不生成告别', () => {
    const r = run({ messages: [user('这句话重复了'), bot('这句话重复了')] });
    assert.equal(r.decision, 'hold');
    assert.equal(r.reason, 'repeated_content_no_new_info');
    assert.equal(r.nextOpening, '');
  });
  await c.check('用户没有回复 ≠ 同意结束 → hold', () => {
    const r = run({ messages: [user('我先说一件事'), bot('我在听')] });
    assert.equal(r.decision, 'hold');
    assert.equal(r.reason, 'user_has_not_replied');
    assert.notEqual(r.decision, 'close');
  });
  await c.check('已答但用户未确认 → hold，不自动 close', () => {
    const r = run({ messages: [user('这个怎么做？'), bot('这样做')] });
    assert.equal(r.decision, 'hold');
    assert.equal(r.reason, 'answered_but_awaiting_user_ack');
  });
  await c.check('仍有实质信息交换 → continue', () => {
    const r = run({ messages: [user('我刚发现日志里多了一段新的报错，想看一下')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'substantive_user_message_awaiting_reply');
  });

  c.section('4. 未解决请求');
  await c.check('显式未解决请求优先于感谢 → continue', () => {
    const r = run({ unresolvedRequests: [{ id: 'r1', text: '还没给我文件' }], messages: [user('谢谢')] });
    assert.equal(r.decision, 'continue');
    assert.equal(r.reason, 'unresolved_requests');
    assert.equal(r.unresolvedRequests[0].id, 'r1');
  });
  await c.check('answered=false 的消息 → unresolved', () => {
    const r = run({ messages: [user('帮我改一下', { answered: false }), bot('好')] });
    assert.equal(r.decision, 'continue');
    assert.ok(r.unresolvedRequests.length >= 1);
  });

  c.section('5. A1 purpose 只作上下文');
  await c.check('A1 高置信候选→ close 时可作为 nextOpening', () => {
    const r = run({
      messages: [user('谢谢')],
      purpose: { ok: true, candidates: [{ kind: 'advance_goal', title: '继续整理旅行计划', owner: 'user', confidence: 0.8 }] }
    });
    assert.equal(r.decision, 'close');
    assert.equal(r.nextOpening, '继续整理旅行计划');
  });
  await c.check('A1 无候选 → nextOpening 为空', () => {
    const r = run({ messages: [user('谢谢')], purpose: { ok: true, candidates: [] } });
    assert.equal(r.nextOpening, '');
  });
  await c.check('A1 低置信候选 → 不拿来当 nextOpening，标不确定性', () => {
    const r = run({ messages: [user('谢谢')], purpose: { candidates: [{ title: '不确定的事', confidence: 0.2 }] } });
    assert.equal(r.nextOpening, '');
    assert.ok(r.uncertainties.some((u) => u.code === 'low_purpose_confidence'));
  });
  await c.check('A1 不强制 continue/close（只读上下文）', () => {
    const withPurpose = run({ messages: [user('谢谢')], purpose: { candidates: [{ title: '某件事', confidence: 0.9 }] } });
    const without = run({ messages: [user('谢谢')] });
    assert.equal(withPurpose.decision, without.decision);
  });

  c.section('6. 缺失/乱序/不可判断');
  await c.check('空输入 → undetermined，不默认 close', () => {
    const r = run({});
    assert.equal(r.ok, true);
    assert.equal(r.decision, 'undetermined');
    assert.equal(r.reason, 'empty_conversation');
  });
  await c.check('非法输入（null/数组/字段类型错）→ INVALID_INPUT', () => {
    for (const bad of [null, [], { messages: 'x' }, { unresolvedRequests: {} }]) {
      const r = run(bad);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'INVALID_INPUT');
    }
  });
  await c.check('消息时间倒序 → 按时间排序并标记，不崩溃', () => {
    const r = run({ messages: [user('怎么弄？', { at: '2026-11-04T12:00:02Z' }), bot('先这样', { at: '2026-11-04T12:00:01Z' })] });
    assert.equal(r.diagnostics.order, 'out_of_order_sorted');
    assert.equal(r.decision, 'continue');
    assert.ok(r.uncertainties.some((u) => u.code === 'message_order'));
  });
  await c.check('缺时间 → 不据此推断结束，标 missing_time', () => {
    const r = run({ messages: [user('我先说一件事'), bot('我在听')] });
    assert.equal(r.decision, 'hold');
    assert.ok(r.uncertainties.some((u) => u.code === 'missing_time'));
  });
  await c.check('只有 assistant 消息 → undetermined（无法判断）', () => {
    const r = run({ messages: [bot('在吗')] });
    assert.equal(r.decision, 'undetermined');
    assert.equal(r.reason, 'no_user_message');
  });

  c.section('7. 纯度/不可变');
  await c.check('不修改输入（深比较）', () => {
    const input = { messages: [user('这个怎么用？'), bot('这样')], conversation: { userBusy: false }, purpose: { candidates: [] } };
    const before = JSON.stringify(input);
    run(input);
    assert.equal(JSON.stringify(input), before);
  });
  await c.check('源码无 I/O/发送/模型/系统时钟/随机/全局状态', () => {
    assert.ok(!/from ['"]node:|require\(|fetch\(|Date\.now|Math\.random|sendMessage|writeFile|appendFile|readFile/.test(src));
  });
  await c.check('无未解决请求且已结束时，nextOpening 可为空，不强制生成', () => {
    const r = run({ messages: [user('晚安')] });
    assert.equal(r.nextOpening, '');
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
}
process.exit(c.finish() ? 0 : 1);
