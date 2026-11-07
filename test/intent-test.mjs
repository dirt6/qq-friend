// 意图阶段（自主活动 2.2）的单元测试。
//
// 这一层的目的不是"让她更会说话"，而是让"想做什么"在看内容之前定下来。
// 所以测试重点：意图解析要稳、意图信息要真的进到决策提示里、不认识的意图要降级。
import { makeIntentMessages, validateIntent, parseIntent, describeIntent, INTENT_KINDS, INTENT_NEEDS_CONTENT } from '../plugins/autonomous/lib/intent.js';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('【1. 意图白名单】');
{
  ok('7 种意图都在', INTENT_KINDS.size === 7, [...INTENT_KINDS].join(','));
  ok('explore/learn/continue 需要抓内容',
    ['explore', 'learn', 'continue'].every((k) => INTENT_NEEDS_CONTENT.has(k)));
  ok('create/reflect/communicate 不需要抓内容',
    ['create', 'reflect', 'communicate'].every((k) => !INTENT_NEEDS_CONTENT.has(k)));
  ok('finish 不需要抓内容', !INTENT_NEEDS_CONTENT.has('finish'));
}

console.log('\n【2. 解析与降级】');
{
  const a = validateIntent({ intent: 'create', goal: '画一只猫', why: '想画', topic: '猫', desiredOutcome: '画出来' });
  ok('合法意图原样保留', a.intent === 'create' && a.goal === '画一只猫', JSON.stringify(a));

  const b = validateIntent({ intent: '瞎写的', goal: '随便' });
  ok('不认识的 intent 降级成 explore', b.intent === 'explore', b.intent);

  const c = validateIntent(null);
  ok('null 不炸、降级 explore', c.intent === 'explore');

  const long = validateIntent({ intent: 'explore', goal: 'x'.repeat(200) });
  ok('超长 goal 被截断', long.goal.length <= 80, String(long.goal.length));

  const p = parseIntent('```json\n{"intent":"reflect","goal":"想想最近的事"}\n```');
  ok('包了 markdown 也能解析', p.ok && p.intent.intent === 'reflect', JSON.stringify(p));

  const bad = parseIntent('这不是 JSON');
  ok('非 JSON 返回 ok:false 而不是抛', bad.ok === false);
}

console.log('\n【3. 意图信息要真的进决策提示】');
{
  const msgs = makeIntentMessages({
    personaSnippet: '她很活泼', when: '2026-10-31 15:00', abilities: '翻榜单、画画',
    pending: '等老大回话', recentDiary: '今天很开心'
  });
  const sys = msgs[0].content;
  const user = msgs[1].content;
  ok('system 说明了"先想做什么"', sys.includes('先想清楚'));
  ok('system 列出了全部意图类型',
    ['explore', 'learn', 'create', 'reflect', 'communicate', 'continue', 'finish'].every((k) => sys.includes(k)));
  ok('system 明确可以 finish', sys.includes('想休息就 finish'));
  ok('user 带上了可用能力', user.includes('翻榜单'));
  ok('user 带上了上次留下的事', user.includes('等老大回话'));
  ok('user 带上了最近日记', user.includes('今天很开心'));
  ok('最后一句是问她想做什么', /想做什么/.test(user.slice(-40)), user.slice(-40));
}

console.log('\n【4. 一行描述（写日志用）】');
{
  ok('有 goal 时带 goal', describeIntent({ intent: 'learn', goal: '搞懂 DSH 部署' }).includes('搞懂 DSH 部署'));
  ok('有 topic 时带 topic', describeIntent({ intent: 'explore', goal: '翻翻', topic: '猫咪' }).includes('猫咪'));
  ok('没意图时给占位', describeIntent(null).includes('没生成'));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
