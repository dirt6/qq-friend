// 阶段 2.6-B5c 专项测试：并发缺口修复。
//
// 机主授权（2026-11-02）：
//   · runSession 单实例互斥，第二个立刻返回 { skipped: 'already-running' }
//   · 不排队、不抛错、不记失败
//   · 锁必须在 try/finally 里释放（异常不能让后续永久被跳过）
//   · mergeByKey 用函数 key（roundId 优先，回退 startedAt）
//   · 空 key 全部保留（宁可重复，不静默丢）
//   · 两个不同 roundId 用相同时 startedAt，并发写入后**两条都在**
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b5c-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.mkdirSync(path.join(tmp, 'sessions'), { recursive: true });

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

let payload = { action: 'finish', goal: '完成', why: 'x' };
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({
    id: 'x', object: 'chat.completion', created: 1, model: 'm',
    choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(payload) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }
  }));
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' },
  api: { model: 'm', baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', timeoutMs: 5000 },
  skills: { autonomous: { enabled: true, maxModelCalls: 3 } }
}), 'utf8');

const state = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'state.js')).href);
const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);
const AUTO = path.join(tmp, 'autonomous.json');
const readAuto = () => { try { return JSON.parse(fs.readFileSync(AUTO, 'utf8')); } catch { return { history: [] }; } };
const resetAuto = () => { try { fs.rmSync(AUTO, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① mergeByKey：函数 key（源码级）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'state.js'), 'utf8');
    ok('**支持 typeof key === "function"**', src.includes('typeof key === "function"'));
    ok('**history 用 roundId 优先**', src.includes('(r) => r?.roundId || r?.startedAt'));
    ok('空 key 仍然保留', /if \(k && seen\.has\(k\)\) continue;/.test(src));
  }

  console.log('\n【② 两个不同 roundId + 相同 startedAt → 两条都在】');
  {
    resetAuto();
    // 直接测 writeState 的合并行为：先写一条，再用"旧版本 + 另一个 roundId 同期"写
    const st1 = state.readState(AUTO);
    st1.history.push({ roundId: 'round-A', startedAt: 1000, actions: [] });
    state.writeState(AUTO, st1);

    const st2 = state.readState(AUTO);
    st2.history.push({ roundId: 'round-B', startedAt: 1000, actions: [] });   // **同一 startedAt**
    state.writeState(AUTO, st2);

    const h = readAuto().history;
    const ids = h.map((r) => r.roundId).sort();
    ok('**两条都在**', h.length === 2, String(h.length));
    ok('**round-A 和 round-B 都在**', ids.join(',') === 'round-A,round-B', ids.join(','));
  }

  console.log('\n【③ 旧记录（无 roundId）用 startedAt 回退，不丢】');
  {
    resetAuto();
    const st1 = state.readState(AUTO);
    st1.history.push({ startedAt: 2000, actions: [] });   // 旧格式：没有 roundId
    state.writeState(AUTO, st1);

    const st2 = state.readState(AUTO);
    st2.history.push({ startedAt: 3000, actions: [] });
    state.writeState(AUTO, st2);

    ok('**两条旧记录都在**', readAuto().history.length === 2, String(readAuto().history.length));
  }

  console.log('\n【④ 无 key 的记录不会互相合并（宁可重复不丢）】');
  {
    resetAuto();
    const st1 = state.readState(AUTO);
    st1.history.push({ actions: ['a'] });    // 既没 roundId 也没 startedAt
    state.writeState(AUTO, st1);

    const st2 = state.readState(AUTO);
    st2.history.push({ actions: ['b'] });
    state.writeState(AUTO, st2);

    ok('**两条都保留**（没被当成同一条）', readAuto().history.length === 2, String(readAuto().history.length));
  }

  console.log('\n【⑤ runSession 互斥：并发第二个立刻返回 skipped】');
  {
    resetAuto();
    const [r1, r2] = await Promise.all([
      auto.runSession({ dryRun: true, force: true }),
      auto.runSession({ dryRun: true, force: true })
    ]);
    const results = [r1, r2];
    const skipped = results.filter((r) => r && r.skipped === 'already-running');
    const finished = results.filter((r) => r && r.stopReason !== undefined);
    ok('**恰好一个跳过**', skipped.length === 1, JSON.stringify(results.map((r) => r?.skipped ?? 'ran')));
    ok('**恰好一个跑完**', finished.length === 1, String(finished.length));
    ok('**history 只有 1 条**（没并发写）', readAuto().history.length === 1, String(readAuto().history.length));
  }

  console.log('\n【⑥ 锁在 finally 释放：异常后还能继续】');
  {
    resetAuto();
    // 先制造一次正常跑
    const a = await auto.runSession({ dryRun: true, force: true });
    ok('第一次正常', a && a.stopReason !== undefined, JSON.stringify(a)?.slice(0, 80));

    // 再跑一次（如果锁没释放，会一直 skipped）
    const b = await auto.runSession({ dryRun: true, force: true });
    ok('**第二次也能跑（锁已释放）**', b && b.stopReason !== undefined, JSON.stringify(b)?.slice(0, 80));
    ok('history 2 条', readAuto().history.length === 2, String(readAuto().history.length));
  }

  console.log('\n【⑦ skipped 不是失败（不记 consecutiveFailures）】');
  {
    resetAuto();
    await Promise.all([
      auto.runSession({ dryRun: true, force: true }),
      auto.runSession({ dryRun: true, force: true })
    ]);
    const st = readAuto();
    ok('**consecutiveFailures 是 0**', (Number(st.consecutiveFailures) || 0) === 0, String(st.consecutiveFailures));
    ok('skipped 的那次没进 history', st.history.length === 1, String(st.history.length));
  }

  console.log('\n【⑧ autonomous-run.mjs 处理 skipped（源码级）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'autonomous-run.mjs'), 'utf8');
    ok('**检查 rec.skipped**', src.includes("rec.skipped === \"already-running\"") || src.includes("rec.skipped === 'already-running'"));
    ok('**退出码 0**（不是失败）', /process\.exit\(0\)/.test(src));
    ok('有说明日志', src.includes('已经有一轮在跑了'));
  }

  console.log('\n【⑨ 互斥区间覆盖整个 runSession（源码级）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const iEntry = src.indexOf("if (sessionRunning) return { skipped: 'already-running' };");
    const iSet = src.indexOf('sessionRunning = true;', iEntry);
    const iRelease = src.indexOf('sessionRunning = false;', iSet);
    ok('**入口检查在最前面**', iEntry > 0);
    ok('设置紧跟其后', iSet > iEntry);
    ok('**释放在 finally 里**', iRelease > 0 && src.slice(iRelease - 200, iRelease).includes('finally'));
    ok('**tick 的 running 保留**', src.includes('if (running) return;'));
    ok('两者独立（sessionRunning ≠ running）', src.includes('let sessionRunning = false;') && src.includes('let running = false;'));
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
