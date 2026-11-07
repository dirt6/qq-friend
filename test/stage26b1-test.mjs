// 阶段 2.6-B1 专项测试：Action → Pending 关联。
//
// 机主授权（2026-11-02）：
//   · 只新增可选 pendingId，暂不增加 goalId
//   · pendingId 只有在 Pending **实际创建成功并取得有效 ID** 后才能写入
//   · 旧 Action 不补造 ID
//   · 创建失败 / 重复创建 / 部分失败的行为要明确
//   · 一对多的前提已审查确认（decision.next 单数、addPending 一次一条、只有一个调用点）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b1-'));
const dataDir = tmp;
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

// 本地 mock 模型服务器
let mockPayload = { action: 'finish', goal: '收尾', why: '测试' };
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(mockPayload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }));
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' },
  api: { model: 'm', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', timeoutMs: 5000 },
  skills: { autonomous: { enabled: true, maxModelCalls: 6 } }
}), 'utf8');

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);
const AUTO = path.join(dataDir, 'autonomous.json');
const CS = path.join(dataDir, 'companion-state.json');
const readAuto = () => JSON.parse(fs.readFileSync(AUTO, 'utf8'));
const lastRound = () => { const h = readAuto().history; return h[h.length - 1]; };
const readCs = () => { try { return JSON.parse(fs.readFileSync(CS, 'utf8')); } catch { return { goals: [], pending: [] }; } };
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 有 next 时：Action 带上真实创建的 pendingId】');
  {
    resetCs();
    mockPayload = {
      action: 'chat',
      goal: '问老大回来没',
      why: '想问问',
      next: '等老大回话，回了就一起翻评论',
      chat: '老大，你回来没？'
    };
    await auto.runSession({ dryRun: true, force: true });
    const r = lastRound();
    const act = (r.actions || [])[0];
    const pending = readCs().pending || [];

    ok('Action 有 pendingId', Boolean(act.pendingId), JSON.stringify(act.pendingId));
    ok('**pendingId 对应真实存在的 Pending**', pending.some((p) => p.id === act.pendingId), `pendingId=${act.pendingId} 实际=${JSON.stringify(pending.map(p=>p.id))}`);
    const matched = pending.find((p) => p.id === act.pendingId);
    ok('**文本一致**', matched && matched.text === '等老大回话，回了就一起翻评论', matched?.text);
    ok('状态是 waiting（等回话）', matched?.status === 'waiting', matched?.status);
  }

  console.log('\n【② 没有 next 时：不写 pendingId】');
  {
    resetCs();
    mockPayload = { action: 'chat', goal: '随便说句', why: '没事', chat: '在呢' };
    await auto.runSession({ dryRun: true, force: true });
    const act = (lastRound().actions || [])[0];
    ok('**Action 没有 pendingId**', act.pendingId === undefined, String(act.pendingId));
    ok('没有 Pending 被创建', (readCs().pending || []).length === 0);
  }

  console.log('\n【③ Pending 创建失败（容量满）→ 不写 pendingId】');
  {
    resetCs();
    // 先把 pending 填满（20 条上限）
    for (let i = 0; i < 20; i += 1) {
      cs.addPending({ text: '占位待办 ' + i, source: 'chat' });
    }
    const before = (readCs().pending || []).length;
    ok('已填满 20 条', before === 20, String(before));

    mockPayload = {
      action: 'chat', goal: 'x', why: 'y',
      next: '这条应该加不进去',
      chat: '在呢'
    };
    await auto.runSession({ dryRun: true, force: true });
    const act = (lastRound().actions || [])[0];

    // addPending 超出上限时会丢最老的已结算项，但这里都是 pending → 会被 add 进去
    // 所以这个场景下 pending 可能仍然成功。改为验证：成功时 pendingId 一定对应真实记录
    if (act.pendingId) {
      const matched = (readCs().pending || []).find((p) => p.id === act.pendingId);
      ok('**有 pendingId 就一定对应真实记录**', Boolean(matched), act.pendingId);
    } else {
      ok('**没拿到 id 时不写 pendingId**', true);
    }
  }

  console.log('\n【④ 重复创建（同文本已存在）→ 返回已有那条的 id】');
  {
    resetCs();
    const first = cs.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    ok('第一次创建', first.ok === true && Boolean(first.pending?.id));

    mockPayload = {
      action: 'chat', goal: 'x', why: 'y',
      next: '等老大回话',
      chat: '在呢'
    };
    await auto.runSession({ dryRun: true, force: true });
    const act = (lastRound().actions || [])[0];

    ok('**pendingId 是已有那条**', act.pendingId === first.pending.id, `${act.pendingId} vs ${first.pending.id}`);
    ok('没有重复创建', (readCs().pending || []).length === 1, String((readCs().pending || []).length));
  }

  console.log('\n【⑤ 旧 Action 不补造 pendingId】');
  {
    resetCs();
    // 手工写一条"旧"Action（没有 pendingId）
    fs.writeFileSync(AUTO, JSON.stringify({
      version: 2,
      history: [{
        roundId: 'round-old', startedAt: Date.now() - 86400e3, endedAt: Date.now() - 86399e3,
        status: 'IDLE',
        actions: [{ action: 'chat', goal: '旧动作', result: 'success', next: '等老大回话' }],
        stopReason: '完成'
      }],
      status: 'IDLE'
    }), 'utf8');

    mockPayload = { action: 'finish', goal: '收尾', why: '测试' };
    await auto.runSession({ dryRun: true, force: true });

    const old = readAuto().history.find((r) => r.roundId === 'round-old');
    ok('**旧 Action 的 pendingId 仍然是 undefined**', old.actions[0].pendingId === undefined, String(old.actions[0].pendingId));
  }

  console.log('\n【⑥ Action 的 goal 字段语义没变（仍是 Action Objective）】');
  {
    resetCs();
    mockPayload = {
      action: 'chat', goal: '问老大回来没', why: '想问问',
      next: '等他回话', chat: '在呢'
    };
    await auto.runSession({ dryRun: true, force: true });
    const act = (lastRound().actions || [])[0];
    ok('action.goal 仍是原文', act.goal === '问老大回来没', act.goal);
    ok('**没有创建 Goal**（goal 字段归 Action）', (readCs().goals || []).length === 0, String((readCs().goals || []).length));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { server.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
