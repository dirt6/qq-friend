// 阶段 2.5 验收测试：注入 + waiting 结算。
//
// 机主列的 11 项：
//   DSH/API 都注入 / 空状态不加内容 / 读失败不影响聊天 / 两条路径同一快照 /
//   waiting 只在老大后续消息时结算 / pending 不结算 / 迁移记录仍能结算 /
//   不重复结算 / 多条 waiting 正确 / patch 不重写 / 内容 < 300 字且不命令
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage25-'));
const dataDir = tmp;
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' },
  api: { model: 'm', baseUrl: 'http://127.0.0.1:9', apiKey: 'k' },
  skills: { autonomous: { enabled: true } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);
const gw = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);

const CS = path.join(dataDir, 'companion-state.json');
const MSG = path.join(dataDir, 'messages', 'private_10001.json');
const writeCs = (o) => fs.writeFileSync(CS, JSON.stringify(o), 'utf8');
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };
const readCs = () => JSON.parse(fs.readFileSync(CS, 'utf8'));

/** 造一条老大发来的消息。 */
function userSaid(text, ts) {
  let list = [];
  try { list = JSON.parse(fs.readFileSync(MSG, 'utf8')).messages || []; } catch { /* 新文件 */ }
  list.push({ id: list.length + 1, mid: 1000 + list.length, ts, text, self: false, senderId: '10001', senderName: '老大' });
  fs.writeFileSync(MSG, JSON.stringify({ messages: list }), 'utf8');
}
function resetMsgs() { try { fs.rmSync(MSG, { force: true }); } catch { /* ignore */ } }

try {
  console.log('【① 注入内容：短、不命令】');
  {
    resetCs();
    ok('空状态 → 空串', cs.promptSection() === '');

    // 4.0 / 2.6-P1-1：'chat' 不再合法
    cs.setGoal('继续完善小镇游戏的故事', { source: 'user_directed' });
    cs.setTopic('警察助手的人设', { source: 'chat' });
    cs.addPending({ text: '等老大有空聊警察助手', source: 'chat', status: 'waiting' });
    const s = cs.promptSection();
    ok('有内容', s.length > 0);
    // 4.0 / P0：waiting 不再混进"还没做完的"，单独进"在等他回的"段
  ok('包含三段', /方向/.test(s) && /在聊/.test(s) && /在等他回的/.test(s), s);
    ok('**不超过 300 字**', s.length < 300, String(s.length));
    ok('**没有命令式措辞**', !/请|必须|应该|需要你|逐条|务必/.test(s), s);
    ok('开场是【你现在】', s.startsWith('【你现在】'), s.slice(0, 20));
  }

  console.log('\n【② waiting 判定：六个用例】');
  {
    const cases = [
      ['等老大回应', true], ['等你回一句，再继续', true], ['等老大有空回复', true],
      ['明天查查资料', false], ['等活动开始', false], ['等资料更新后再处理', false]
    ];
    for (const [t, expect] of cases) {
      ok(`「${t}」→ ${expect ? 'waiting' : 'pending'}`, auto.isWaitingForReply(t) === expect, String(auto.isWaitingForReply(t)));
    }
  }

  console.log('\n【③ 结算：waiting 要老大后续消息，pending 不动】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [
        { id: 'p-wait', text: '等老大回一句', status: 'waiting', source: 'autonomous', at: new Date(past).toISOString() },
        { id: 'p-todo', text: '明天查查资料', status: 'pending', source: 'autonomous', at: new Date(past).toISOString() }
      ]
    });
    ok('没有用户消息 → 不结算', auto.settleChatPending() === false);

    userSaid('在吗', Date.now());
    ok('有用户消息 → 结算', auto.settleChatPending() === true);
    const after = readCs().pending;
    ok('waiting 变 done', after.find((p) => p.id === 'p-wait').status === 'done');
    ok('**pending 不动**', after.find((p) => p.id === 'p-todo').status === 'pending');
    ok('done 的有 settledAt', Boolean(after.find((p) => p.id === 'p-wait').settledAt));
  }

  console.log('\n【④ 不结算"创建晚于用户消息"的 waiting】');
  {
    resetCs(); resetMsgs();
    const now = Date.now();
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [
        { id: 'p-old', text: '早前的等回话', status: 'waiting', source: 'autonomous', at: new Date(now - 3600e3).toISOString() },
        { id: 'p-new', text: '刚创建的等回话', status: 'waiting', source: 'autonomous', at: new Date(now + 60_000).toISOString() }
      ]
    });
    userSaid('在吗', now);
    auto.settleChatPending();
    const after = readCs().pending;
    ok('早的那条被结算', after.find((p) => p.id === 'p-old').status === 'done');
    ok('**晚于用户消息的不结算**', after.find((p) => p.id === 'p-new').status === 'waiting', after.find((p) => p.id === 'p-new').status);
  }

  console.log('\n【⑤ 迁移记录仍能通过 migrationTag 结算】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-legacy', text: '等老大回应', status: 'pending',   // 注意是 pending
        source: 'autonomous', at: new Date(past).toISOString(),
        migrationTag: 'chat-wait-reply'
      }]
    });
    userSaid('在吗', Date.now());
    ok('迁移那条能结算', auto.settleChatPending() === true);
    ok('状态变 done', readCs().pending.find((p) => p.id === 'p-legacy').status === 'done');
  }

  console.log('\n【⑥ 幂等：不重复结算、不覆盖 settledAt】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{ id: 'p-1', text: '等老大回话', status: 'waiting', source: 'autonomous', at: new Date(past).toISOString() }]
    });
    userSaid('在吗', Date.now());
    auto.settleChatPending();
    const t1 = readCs().pending[0].settledAt;
    // 再来一条用户消息
    userSaid('还在吗', Date.now() + 1000);
    const again = auto.settleChatPending();
    ok('第二次不结算（已经 done 了）', again === false, String(again));
    ok('settledAt 没被覆盖', readCs().pending[0].settledAt === t1);
  }

  console.log('\n【⑦ DSH 与 API 同一份快照（源码级）】');
  {
    const orch = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
    ok('wake 里只算一次 companionText', (orch.match(/companionPromptSection\(\)/g) || []).length === 1);
    ok('DSH 路径收到 companionText', /#askDsh\(\{ chatKey, messages, triggerEntries, companionText \}\)/.test(orch));
    ok('API 路径收到 companionText', /id: 'companion-state'[\s\S]{0,80}content: companionText/.test(orch));
    ok('两条路径用的是同一个变量', /let companionText = '';/.test(orch));

    const gws = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('personaPatchFile 接收并拼进 sections', /function personaPatchFile\([^)]*companionText/.test(gws) && /companionText,/.test(gws));
    // 4.0 / R6-B 补：runOnce 多了 deps 参数（测试注入假 spawn 用），透传关系不变
  ok('ask → runOnce 透传', /runOnce\(key, text, preface, hotNote, contextHint, timeoutMs, companionText(?:, deps)?\)/.test(gws));
  }

  console.log('\n【⑧ 读失败不影响：注入为空串，聊天照常】');
  {
    resetCs();
    let got = 'X';
    try { got = cs.promptSection(); } catch { got = 'THREW'; }
    ok('文件不存在时返回空串（不抛）', got === '', String(got));

    fs.writeFileSync(CS, '{ 坏的', 'utf8');
    let got2 = 'X';
    try { got2 = cs.promptSection(); } catch { got2 = 'THREW'; }
    ok('文件损坏时返回空串（不抛）', got2 === '', String(got2));
    ok('**没有自动初始化并覆盖坏文件**', fs.readFileSync(CS, 'utf8') === '{ 坏的');
  }

  console.log('\n【⑨ 注入为空时 prompt 不增加多余内容】');
  {
    resetCs();
    const s = cs.promptSection();
    ok('空串', s === '');
    // DSH 侧：companionText 为空时，sections 里是空串，filter(Boolean) 会去掉
    const gws = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('sections 用 filter(Boolean) 过滤空段', /\].filter\(Boolean\)/.test(gws));
    // API 侧：三元判断
    const orch = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
    ok('extraSections 用 condition ? [...] : [] 判断', /companionText\s*\r?\n\s*\? \[\{ id: 'companion-state'/.test(orch));
  }

  console.log('\n【⑩ 多进程并发的 waiting 结算（不串）】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [
        { id: 'p-a', text: '等老大回话 A', status: 'waiting', source: 'autonomous', at: new Date(past).toISOString() },
        { id: 'p-b', text: '等老大回话 B', status: 'waiting', source: 'autonomous', at: new Date(past + 1000).toISOString() },
        { id: 'p-c', text: '明天查资料', status: 'pending', source: 'autonomous', at: new Date(past + 2000).toISOString() }
      ]
    });
    userSaid('在吗', Date.now());
    auto.settleChatPending();
    const after = readCs().pending;
    ok('两条 waiting 都结算', after.filter((p) => p.status === 'done').length === 2, String(after.filter((p) => p.status === 'done').length));
    ok('pending 那条没动', after.find((p) => p.id === 'p-c').status === 'pending');
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
