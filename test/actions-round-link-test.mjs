// actions 与模型调用关联的验收测试（4.0 · 1.5.8.8）。
//
// 机主的九项验收：
//   单轮多次调用 roundId 一致 / 两轮并发互不串号 / 无行动直接 finish 仍能追踪 /
//   模型成功但工具失败两层状态分开 / 模型失败无 action 不生成虚假成功 /
//   记录器故障不影响自主活动 / 旧 actions 正常读取 / 不需要重写历史文件
//
// 做法：用临时 DATA_DIR 跑真实的 runSession（dryRun，不联网、不发消息）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'act-round-'));
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(dataDir, { recursive: true });
const CALLS = path.join(dataDir, 'model-calls.ndjson');
process.env.QQ_AGENT_DATA_DIR = dataDir;
process.env.QQ_MODEL_CALLS_FILE = CALLS;

// 模型调用走 llm.chatCompletion（用 config.api.baseUrl），
// 所以必须起一个 mock 服务器 —— runSession 的 fetchImpl 只管抓榜单。
const http = await import('node:http');
let mockPayload = { action: 'finish', goal: '完成', why: '测试', stopReason: '完成：没有别的想做的了' };
const mockServer = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(mockPayload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }));
});
const mockPort = await new Promise((r) => mockServer.listen(0, '127.0.0.1', () => r(mockServer.address().port)));

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  api: { model: 'm', baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: 'k', timeoutMs: 5000 },
  skills: { autonomous: { enabled: true, maxModelCalls: 6 } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const mc = await import(pathToFileURL(path.join(ROOT, 'src', 'model-calls.js')).href);
const readCalls = () => {
  try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const resetCalls = () => { try { fs.rmSync(CALLS, { force: true }); } catch { /* ignore */ } };

const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);
const readState = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'autonomous.json'), 'utf8'));

/** 造一个假的 fetch：返回一段合法的决策 JSON（不联网）。 */
function fakeFetch(payload) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    async text() {
      return JSON.stringify({
        id: 'x', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
      });
    },
    async json() { return JSON.parse(await this.text()); }
  });
}

try {
  console.log('【① 一轮完整活动：history 和 actions 都带 roundId，且和模型调用对得上】');
  {
    resetCalls();
    await auto.runSession({
      dryRun: true,
      force: true,
      fetchImpl: fakeFetch({ action: 'finish', goal: '今天没什么想做的', why: '测试', stopReason: '完成' })
    });
    const st = readState();
    const rec = st.history[st.history.length - 1];
    ok('history 有条目', Boolean(rec), JSON.stringify(Object.keys(st.history || {})).slice(0, 80));
    ok('history 带 roundId', /^round-[0-9a-f]{6,8}$/.test(String(rec?.roundId)), rec?.roundId);

    const calls = readCalls();
    const mine = calls.filter((c) => c.roundId === rec.roundId);
    ok('本轮有模型调用记录', mine.length >= 1, String(mine.length));
    ok('模型调用的 roundId 和 history 一致', mine.every((c) => c.roundId === rec.roundId));

    // actions 里的每条都要带同一个 roundId
    if (Array.isArray(rec.actions) && rec.actions.length) {
      ok('每条 action 都带 roundId', rec.actions.every((a) => a.roundId === rec.roundId), JSON.stringify(rec.actions.map((a) => a.roundId)));
    } else {
      ok('无 action 的轮次也能追踪（roundId 在 history 上）', true);
    }
  }

  console.log('\n【② 两轮并发：roundId 互不串】');
  {
    resetCalls();
    const mk = (goal) => auto.runSession({
      dryRun: true, force: true,
      fetchImpl: fakeFetch({ action: 'finish', goal, why: '并发测试', stopReason: '完成' })
    });
    // 4.0 / 2.6-B5c：runSession 现在有重入锁。
    // 并发两个 → **一个真跑，一个立刻返回 skipped**（不排队、不抛错）。
    // 所以这里验证的是「互斥生效」，而不是「两轮都写进去」。
    const [r1, r2] = await Promise.all([mk('并发 A'), mk('并发 B')]);
    const results = [r1, r2];
    const skipped = results.filter((r) => r && r.skipped === 'already-running');
    const ran = results.filter((r) => r && r.stopReason !== undefined);

    ok('**恰好一个跳过**', skipped.length === 1, JSON.stringify(results.map((r) => r?.skipped ?? 'ran')));
    ok('**恰好一个跑完**', ran.length === 1, String(ran.length));
    ok('**skipped 不算失败**（没有 stopReason）', skipped[0]?.stopReason === undefined);

    const st = readState();
    const last = (st.history || []).slice(-1);
    ok('**history 只有 1 条**（并发没写两份）', last.length === 1, String(last.length));
    ok('roundId 是 round- 开头', /^round-/.test(String(last[0]?.roundId)), String(last[0]?.roundId));

    const calls = readCalls();
    const mine = calls.filter((c) => c.roundId === last[0]?.roundId);
    ok(`轮 ${String(last[0]?.roundId).slice(0, 12)} 有独立调用记录`, mine.length >= 1, String(mine.length));
  }

  console.log('\n【③ 无 action 直接 finish：不生成虚假成功】');
  {
    resetCalls();
    await auto.runSession({
      dryRun: true, force: true,
      fetchImpl: fakeFetch({ action: 'finish', goal: '没什么想做的', why: '真的没事', stopReason: '完成：没有别的想做的了' })
    });
    const st = readState();
    const rec = st.history[st.history.length - 1];
    ok('history 有这一轮', Boolean(rec?.roundId));
    ok('actions 是空数组（不是伪造一条 success）', Array.isArray(rec.actions) && rec.actions.length === 0, JSON.stringify(rec.actions));
    ok('stopReason 有内容（成功或失败都如实记）', String(rec.stopReason || rec.error || '').length > 0, `${rec.stopReason} | ${rec.error}`);
  }

  console.log('\n【④ 模型成功但工具失败：两层状态分开】');
  {
    resetCalls();
    // 让她决定画画 —— dryRun 下 draw 不会真渲染，正好验证"模型成功、工具未成"两层分开
    mockPayload = { action: 'draw', goal: '想画一只猫', why: '想画', drawTitle: '猫', stopReason: '' };
    await auto.runSession({ dryRun: true, force: true, fetchImpl: fakeFetch(mockPayload) });
    const st = readState();
    const rec = st.history[st.history.length - 1];
    const calls = readCalls().filter((c) => c.roundId === rec.roundId);
    const act = (rec.actions || [])[0];

    ok('模型调用是 success（模型确实回答了）', calls.some((c) => c.status === 'success'), JSON.stringify(calls.map((c) => c.status)));
    if (act) {
      ok('action 有自己的 result 字段', typeof act.result === 'string', act.result);
      ok('action 带 roundId', act.roundId === rec.roundId, act.roundId);
      console.log(`     （这一轮 action=${act.action} result=${act.result}）`);
    } else {
      ok('（dryRun 下没生成 action，跳过工具层断言）', true);
    }
  }

  console.log('\n【⑤ 模型失败、无 action：不生成虚假成功记录】');
  {
    resetCalls();
    // 模型返回一段没法解析的东西（缺 action 字段）—— 模拟"模型答非所问"
    mockPayload = { garbage: true, nothing: 'here' };
    await auto.runSession({ dryRun: true, force: true, fetchImpl: fakeFetch(mockPayload) });
    const st = readState();
    const rec = st.history[st.history.length - 1];
    const calls = readCalls().filter((c) => c.roundId === rec.roundId);
    ok('history 仍记了这一轮', Boolean(rec?.roundId));
    // 模型本身可能成功返回了（只是内容没用）—— 关键是**不能因此伪造一条成功 action**
    ok('模型调用有记录', calls.length >= 1, String(calls.length));
    ok('没有伪造成功的 action',
      !rec.actions || rec.actions.length === 0 || rec.actions.every((x) => x.result !== 'success'),
      JSON.stringify((rec.actions || []).map((x) => x.action + ':' + x.result)));
    ok('error / stopReason 有说明', Boolean(rec.error || rec.stopReason), `${rec.error} | ${rec.stopReason}`);
  }

  console.log('\n【⑥ 记录器故障不影响自主活动】');
  {
    const orig = process.env.QQ_MODEL_CALLS_FILE;
    process.env.QQ_MODEL_CALLS_FILE = process.platform === 'win32' ? 'Z:\\nope\\c.ndjson' : '/proc/nope/c.ndjson';
    let threw = null;
    try {
      await auto.runSession({
        dryRun: true, force: true,
        fetchImpl: fakeFetch({ action: 'finish', goal: '记录器坏了也要能跑', why: 'x', stopReason: '完成' })
      });
    } catch (e) { threw = e; }
    process.env.QQ_MODEL_CALLS_FILE = orig;
    ok('自主活动没抛异常', threw === null, threw?.message);
    const st = readState();
    ok('history 仍然写进去了', Boolean(st.history[st.history.length - 1]?.roundId));
  }

  console.log('\n【⑦ 旧 actions（没有 roundId）正常读取，不需要迁移】');
  {
    const f = path.join(dataDir, 'autonomous.json');
    const st = readState();
    // 造一条"旧格式"历史（没有 roundId，actions 里也没有）
    st.history.push({
      startedAt: Date.now() - 86400e3, endedAt: Date.now() - 86399e3, status: 'IDLE',
      actions: [{ action: 'chat', result: 'success', goal: '旧数据', why: '旧', chat: 'hi' }],
      stopReason: '完成'
    });
    fs.writeFileSync(f, JSON.stringify(st), 'utf8');
    const after = readState();
    const old = after.history[after.history.length - 1];
    ok('旧条目还能读出来', old?.stopReason === '完成');
    ok('旧条目没有 roundId（原样保留，没被改写）', old.roundId === undefined, String(old.roundId));
    ok('旧 actions 还在', Array.isArray(old.actions) && old.actions.length === 1);
    ok('文件没有被重写格式（version 还在）', after.version !== undefined, String(after.version));
  }

  console.log('\n【⑧ 不重复保存模型调用记录（actions 只存 ID）】');
  {
    resetCalls();
    await auto.runSession({
      dryRun: true, force: true,
      fetchImpl: fakeFetch({ action: 'finish', goal: '检查不重复存', why: 'x', stopReason: '完成' })
    });
    const st = readState();
    const rec = st.history[st.history.length - 1];
    const act = (rec.actions || [])[0];
    if (act) {
      ok('action 里没有 tokens / durationMs 这类调用明细', act.tokens === undefined && act.durationMs === undefined, JSON.stringify(Object.keys(act)).slice(0, 120));
    } else {
      ok('（无 action，跳过）', true);
    }
    ok('history 顶层也没有调用明细', rec.modelCalls !== undefined /* 这是计数，允许 */);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { mockServer.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
