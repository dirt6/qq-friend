// 撤回定位逻辑的单元测试（技能 skills/moderation 的 recall_message）
//
// 背景（2026-10-13）：以前 recall_message 只收 messageId，模型不知道 id 时只能反复翻
// get_recent_messages —— 实测一次触发连发 5～10 次、113k token，还没撤成。
// 现在支持 messageId / keyword / lastN 三种定位方式，且**只往回看自己最近发的消息**
// （锚点 = 现在），不往前翻。这个测试锁住三件事：
//   ① 三种定位方式都能找到正确的那条
//   ② 关键词命中多条时**绝不撤回**（返回候选清单让模型指定）
//   ③ 撤别人消息的权限开关仍然生效
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.QQ_AGENT_DATA_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)), '..', 'data', '.tmp-recall-test'
);

let pass = 0; let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
}

const { registerTool, clearRegistry, listTools } = await import('../src/tool-registry.js');
const { executeTool } = await import('../src/tools.js');
const moderation = await import('../skills/moderation/index.js');

// ── 假 store：只实现 recent(chatKey, {mine, limit})，语义与真实 store 一致（尾部 = 最近）──
const T = (min) => Date.parse('2026-10-13T21:00:00+08:00') + min * 60000;
const SELF = '2029382488';
const OTHER = '1846383180';
const MESSAGES = [
  { mid: 1001, self: true, ts: T(0), text: '早' },
  { mid: 1002, self: false, ts: T(1), senderId: OTHER, senderName: '老大', text: '帮我看看' },
  { mid: 1003, self: true, ts: T(2), text: '手上有真权限 禁言撤回都能干' },
  { mid: 1004, self: false, ts: T(3), senderId: OTHER, senderName: '老大', text: '把我上面那条撤回' },
  { mid: 1005, self: true, ts: T(4), text: '可以 老大' },
  { mid: 1006, self: true, ts: T(5), text: '手上有真权限' },
  { mid: 1007, self: true, ts: T(6), text: '行' }
];
function makeStore(messages = MESSAGES) {
  return {
    recent(chatKey, { limit = 80, offset = 0, includeSelf = true, mine = false } = {}) {
      // mine 必须真的生效：生产代码 2026-10-17 之前漏了这个参数，
      // 于是"只往回看自己发的消息"其实是全部消息（会误撤别人的）。
      let all = includeSelf ? messages : messages.filter((m) => !m.self);
      if (mine) all = all.filter((m) => m.self === true);
      const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
      return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
    }
  };
}
const store = makeStore();

// ── 假 onebot：记录 delete_msg 调用，getMsg 返回消息归属 ──
function makeCtx({ kind = 'group', chatKey = 'group:103776782', messages = MESSAGES, getMsgFails = false } = {}) {
  const calls = [];
  return {
    calls,
    ctx: {
      kind,
      chatKey,
      chatId: chatKey.split(':')[1],
      selfId: SELF,
      store: makeStore(messages),
      onebot: {
        async getMsg(mid) {
          if (getMsgFails) throw new Error('not found');
          const m = messages.find((x) => String(x.mid) === String(mid));
          if (!m) throw new Error('not found');
          return { sender: { user_id: m.self ? SELF : OTHER } };
        },
        async call(action, params) {
          calls.push({ action, params });
          return { status: 'ok', retcode: 0, data: { message_id: params?.message_id } };
        }
      }
    }
  };
}

// 装载技能（api.config 返回我们的测试配置）
const rc = { recallOthers: true };
clearRegistry();
moderation.setup({
  config: () => rc,
  log: () => {},
  registerTool,
  onebot: null
});
const defs = listTools().filter((t) => /recall_message/.test(t.id));
ok('moderation 注册了 recall_message', defs.length === 1, `找到 ${defs.length} 个`);

const run = async (args, opts) => {
  const { calls, ctx } = makeCtx(opts);
  const r = await executeTool(defs, ctx, 'recall_message', JSON.stringify(args));
  const text = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? r);
  return { r, text, calls, isError: !!r?.isError };
};

// ── ① 直接给 messageId ──
{
  const { r, calls } = await run({ messageId: '#1005' });
  ok('① 直接给 messageId：撤回并去掉 # 前缀', calls.length === 1 && calls[0].params.message_id === 1005, JSON.stringify(calls));
  ok('① 返回里带 recalled=true 与 messageId', /"recalled":\s*true/.test(r.content) && /1005/.test(r.content));
}

// ── ② lastN 默认 1 = 我刚发的那条 ──
{
  const { r, calls } = await run({});
  ok('② 不给参数：默认撤自己最后一条（#1007）', calls.length === 1 && calls[0].params.message_id === 1007, JSON.stringify(calls));
  ok('② 回显撤的是哪条内容', /行/.test(r.content), r.content.slice(0, 120));
}

// ── ③ lastN=3 = 自己倒数第 3 条（自己序列：1001,1003,1005,1006,1007 → 倒数第3 = 1005）──
{
  const { calls } = await run({ lastN: 3 });
  ok('③ lastN=3 定位到自己倒数第 3 条（#1005）', calls.length === 1 && calls[0].params.message_id === 1005, JSON.stringify(calls));
}

// ── ④ 关键词唯一命中 ──
{
  const { calls } = await run({ keyword: '禁言撤回都能干' });
  ok('④ 关键词唯一命中 -> 撤回 #1003', calls.length === 1 && calls[0].params.message_id === 1003, JSON.stringify(calls));
}

// ── ⑤ 关键词命中多条 -> 绝不撤回，返回候选 ──
{
  const { r, text, calls, isError } = await run({ keyword: '手上' });
  ok('⑤ 命中多条时不调用 delete_msg', calls.length === 0, JSON.stringify(calls));
  ok('⑤ 返回候选清单且是错误态', isError && /匹配到\s*2\s*条/.test(text), text.slice(0, 160));
  ok('⑤ 候选里列出两条 id', /1003/.test(text) && /1006/.test(text));
}

// ── ⑥ 关键词无命中 / 负数 offset 语义不适用（这里是 span 越界）──
{
  const { r, text, calls, isError } = await run({ keyword: '这句话根本不存在' });
  ok('⑥ 无命中时不撤回', calls.length === 0);
  ok('⑥ 无命中时给出可操作提示（建议给 messageId）', isError && /messageId/.test(text), text.slice(0, 160));
}

// ── ⑦ 撤别人的消息：开关关掉时必须拒绝 ──
rc.recallOthers = false;
{
  const { text, calls, isError } = await run({ messageId: 1004 });
  ok('⑦ recallOthers=false 时拒绝撤别人的消息', isError && calls.length === 0 && /只能撤自己/.test(text), text.slice(0, 140));
}
rc.recallOthers = true;
{
  const { calls } = await run({ messageId: 1004 });
  ok('⑦ 开关打开后可以撤别人的（走原逻辑）', calls.length === 1 && calls[0].params.message_id === 1004, JSON.stringify(calls));
}

// ── ⑧ 参数写错时的提示要能自我纠正 ──
{
  const { text, isError } = await run({ messageId: '刚才那条' });
  ok('⑧ messageId 非数字时给出正确用法', isError && /keyword|lastN/.test(text), text.slice(0, 160));
}

// ── ⑨ 私聊：撤自己发的（2026-10-17 放开私聊）──
{
  const { calls } = await run({ lastN: 1 }, { kind: 'private', chatKey: 'private:1846383180' });
  ok('⑨ 私聊 lastN=1 撤自己最后一条', calls.length === 1 && calls[0].params.message_id === 1007, JSON.stringify(calls));
}

// ── ⑩ 私聊：撤对方的消息必须拒绝（即使 recallOthers=true）──
{
  const { text, calls, isError } = await run({ messageId: 1004 }, { kind: 'private', chatKey: 'private:1846383180' });
  ok('⑩ 私聊里拒绝撤对方的消息', isError && calls.length === 0 && /私聊里只能撤你自己/.test(text), text.slice(0, 160));
}

// ── ⑪ 私聊：查不到归属时按自己的处理，别把正常撤回卡死 ──
{
  const { calls } = await run({ messageId: 9999 }, { kind: 'private', chatKey: 'private:1846383180', getMsgFails: true });
  ok('⑪ 私聊查不到归属仍可撤回', calls.length === 1 && calls[0].params.message_id === 9999, JSON.stringify(calls));
}

// ── ⑫ mine 过滤真生效：群聊里最后一条是别人时，lastN=1 仍撤自己的 ──
{
  const withOtherTail = [...MESSAGES, { mid: 1008, self: false, ts: T(7), senderId: OTHER, senderName: '老大', text: '在吗' }];
  const { calls } = await run({ lastN: 1 }, { messages: withOtherTail });
  ok('⑫ 最后一条是别人时，lastN=1 撤的是自己的（#1007）', calls.length === 1 && calls[0].params.message_id === 1007, JSON.stringify(calls));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
