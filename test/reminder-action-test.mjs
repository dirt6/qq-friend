// 定时提醒的「动作」测试（text / poke）
//
// 背景（2026-10-17）：提醒触发**不经过模型**，原来只会发文本 —— 用户说
// "到点拍我一下"，实际只收到一条文字，得先回一句话把模型唤醒，模型才想起
// 去拍（表现为"只有我回了消息她才拍我，只会发消息提醒我"）。
// 现在 set_reminder 支持 action=poke，到点直接走 sender.poke。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', '.tmp-reminder-test');
fs.rmSync(DATA, { recursive: true, force: true });
process.env.QQ_AGENT_DATA_DIR = DATA;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const { ReminderStore } = await import('../src/reminders.js');
const { Orchestrator } = await import('../src/orchestrator.js');
const { listTools } = await import('../src/tool-registry.js');
const { executeTool } = await import('../src/tools.js');

// ── 1. 存储层：action / targetUserId 要真正落盘 ──
const store = new ReminderStore();
const e1 = store.add({ chatKey: 'private:10086', text: '拍你一下', dueAt: Date.now() + 60000, action: 'poke' });
ok('add 带 action=poke', e1.action === 'poke');
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'reminders.json'), 'utf8'));
ok('落盘保留 action（重启不丢）', raw.reminders[0].action === 'poke');
const e2 = store.add({ chatKey: 'group:123', text: '吃饭', dueAt: Date.now() + 60000 });
ok('默认 action=text（旧行为不变）', e2.action === 'text');
ok('text 提醒不写 targetUserId', e2.targetUserId === undefined);
const e3 = store.add({ chatKey: 'group:123', text: '拍他', dueAt: Date.now() + 60000, action: 'poke', targetUserId: '1846383180' });
ok('群聊 poke 记住 targetUserId', e3.targetUserId === '1846383180');

// ── 2. 触发层：fireReminder 的分支 ──
const calls = [];
const sender = {
  poke: async (chatKey, target) => { calls.push({ type: 'poke', chatKey, target }); },
  sendTextBatch: async (chatKey, texts) => { calls.push({ type: 'text', chatKey, texts }); return { sent: [] }; }
};
const orch = new Orchestrator({ store: {}, memory: {}, stickers: {}, sender, sessions: {}, onebot: {}, reminders: store });

await orch.fireReminder({ id: 'a', chatKey: 'private:10086', action: 'poke', text: '拍你一下' });
ok('私聊 poke：调 sender.poke 且 target=null（拍对方）', calls.at(-1)?.type === 'poke' && calls.at(-1).target === null, JSON.stringify(calls.at(-1)));
ok('poke 不发任何文字', !calls.some((c) => c.type === 'text'));

await orch.fireReminder({ id: 'b', chatKey: 'group:123', action: 'poke', targetUserId: '1846383180', text: '拍你' });
ok('群聊 poke：target 落在指定 QQ', calls.at(-1)?.type === 'poke' && calls.at(-1).target === 1846383180, JSON.stringify(calls.at(-1)));

const before = calls.length;
await orch.fireReminder({ id: 'c', chatKey: 'group:123', action: 'poke', text: '拍你' });
ok('群聊 poke 缺 target 时退回文本（绝不拿群号去拍）', calls.length === before + 1 && calls.at(-1).type === 'text', JSON.stringify(calls.at(-1)));

await orch.fireReminder({ id: 'd', chatKey: 'private:10086', action: 'text', text: '吃饭' });
ok('text 提醒仍走发送队列且带 ⏰', calls.at(-1)?.type === 'text' && String(calls.at(-1).texts[0]).includes('⏰'), JSON.stringify(calls.at(-1)));

// ── 3. 工具层：set_reminder 的参数收口 ──
const defs = listTools();
const fakeStore = { activeMembers: () => [{ name: '老大', userId: '1846383180' }] };
const mkCtx = ({ kind = 'private', chatKey = 'private:10086', senderId = '1846383180' } = {}) => ({
  kind, chatKey, chatId: chatKey.split(':')[1], selfId: '2029382488', senderId, reminders: store, store: fakeStore
});
const runTool = async (args, ctxOpts) => {
  const r = await executeTool(defs, mkCtx(ctxOpts), 'set_reminder', JSON.stringify(args));
  const text = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? r);
  return { r, text, isError: !!r?.isError };
};

{
  const { text, isError } = await runTool({ action: 'poke', delayMinutes: 5 });
  ok('私聊 action=poke 且不给 text 也能设（text 可选）', !isError, text.slice(0, 160));
}
{
  const { text, isError } = await runTool({ action: 'poke', delayMinutes: 5, targetUserId: '1846383180' }, { kind: 'group', chatKey: 'group:123' });
  ok('群聊 poke 显式给 targetUserId 通过', !isError, text.slice(0, 160));
}
{
  const { text, isError } = await runTool({ action: 'poke', delayMinutes: 5 }, { kind: 'group', chatKey: 'group:123', senderId: '1846383180' });
  ok('群聊 poke 缺 target 时默认拍发起人', !isError && /1846383180/.test(text), text.slice(0, 160));
}
{
  const { text, isError } = await runTool({ action: 'poke', delayMinutes: 5 }, { kind: 'group', chatKey: 'group:123', senderId: '' });
  ok('群聊 poke 且拿不到发起人时明确报错', isError && /targetUserId/.test(text), text.slice(0, 160));
}
{
  const { isError } = await runTool({ action: 'text', delayMinutes: 5 });
  ok('action=text 但没给 text 时报错（旧约束保留）', isError);
}
{
  const { text, isError } = await runTool({ action: 'poke', delayMinutes: 5 }, { kind: 'private', chatKey: 'private:10086' });
  ok('poke 提醒在回执里说清"不发文字"', !isError && /不发文字/.test(text), text.slice(0, 160));
}

// ── 4. 列表要让模型看出这是"拍一拍"而不是文字提醒 ──
{
  const r = await executeTool(defs, mkCtx(), 'list_reminders', '{}');
  const text = String(r?.content ?? '');
  ok('list_reminders 标出拍一拍', /拍一拍/.test(text), text.slice(0, 220));
}

fs.rmSync(DATA, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
