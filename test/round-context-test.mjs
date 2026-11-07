// 轮次上下文的并发隔离测试（4.0 · 1.5.8.6）。
//
// 机主的三个目标 + 五条验证：
//   ① 自主活动建立独立 roundId（意图/决策/日记回顾同一轮）
//   ② 辅助调用建立自己的上下文（不挂到别的轮次）
//   ③ 并发隔离：两个自主轮不串、自主与聊天不串、同轮一致
//
// 做法：直接测 enterRound / withRound 的隔离性 + 真实模块里的接线。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'round-iso-'));
const CALLS = path.join(tmp, 'model-calls.ndjson');
process.env.QQ_AGENT_DATA_DIR = tmp;
process.env.QQ_MODEL_CALLS_FILE = CALLS;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' }, api: { model: 'm' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const mc = await import(pathToFileURL(path.join(ROOT, 'src', 'model-calls.js')).href);
const readCalls = () => {
  try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const reset = () => { try { fs.rmSync(CALLS, { force: true }); } catch { /* ignore */ } };
const brief = (c) => `${c.purpose}:${c.roundId.slice(0, 12)}`;

try {
  console.log('【① 一轮自主活动里三次调用同一个 roundId】');
  {
    reset();
    await mc.withRound({ kind: 'autonomous' }, async () => {
      mc.recordCall({ purpose: 'autonomous.intent', backend: 'api', status: 'success' });
      await new Promise((r) => setTimeout(r, 5));
      mc.recordCall({ purpose: 'autonomous.decision', backend: 'api', status: 'success' });
      await new Promise((r) => setTimeout(r, 5));
      mc.recordCall({ purpose: 'autonomous.diary_review', backend: 'api', status: 'success' });
    });
    const calls = readCalls();
    ok('三条都记了', calls.length === 3, String(calls.length));
    ok('roundId 完全一致', new Set(calls.map((c) => c.roundId)).size === 1, JSON.stringify(calls.map(brief)));
    ok('purpose 各不相同', new Set(calls.map((c) => c.purpose)).size === 3, JSON.stringify(calls.map((c) => c.purpose)));
  }

  console.log('\n【② 两个自主轮次并发：ID 不串】');
  {
    reset();
    const runOne = (tag) => mc.withRound({ kind: 'autonomous' }, async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 3));
        mc.recordCall({ purpose: 'autonomous.decision', backend: 'api', status: 'success', failureDetail: tag });
      }
    });
    await Promise.all([runOne('A'), runOne('B')]);
    const calls = readCalls();
    ok('六条都记了', calls.length === 6, String(calls.length));
    const rounds = new Set(calls.map((c) => c.roundId));
    ok('只有两个 roundId', rounds.size === 2, String(rounds.size));
    // 每轮 3 条
    const counts = {};
    for (const c of calls) counts[c.roundId] = (counts[c.roundId] || 0) + 1;
    ok('每轮各 3 条（没串）', Object.values(counts).every((n) => n === 3), JSON.stringify(counts));
  }

  console.log('\n【③ 自主与聊天同时跑：ID 不串】');
  {
    reset();
    const chat = mc.withRound({ kind: 'chat', chatKey: 'private:1' }, async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 4));
        mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success' });
      }
    });
    const auto = mc.withRound({ kind: 'autonomous' }, async () => {
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => setTimeout(r, 4));
        mc.recordCall({ purpose: 'autonomous.intent', backend: 'api', status: 'success' });
      }
    });
    await Promise.all([chat, auto]);
    const calls = readCalls();
    ok('六条都记了', calls.length === 6, String(calls.length));
    const chatRounds = new Set(calls.filter((c) => c.purpose === 'chat.reply').map((c) => c.roundId));
    const autoRounds = new Set(calls.filter((c) => c.purpose === 'autonomous.intent').map((c) => c.roundId));
    ok('聊天的 3 条同一个 round', chatRounds.size === 1, String(chatRounds.size));
    ok('自主的 3 条同一个 round', autoRounds.size === 1, String(autoRounds.size));
    ok('两个 round 不相等（没串）', [...chatRounds][0] !== [...autoRounds][0]);
  }

  console.log('\n【④ enterRound 只影响自己，不污染调用者】');
  {
    reset();
    // 外层设一个 round
    await mc.withRound({ kind: 'outer' }, async (outer) => {
      mc.recordCall({ purpose: 'chat.aux', backend: 'api', status: 'success' });
      // 内层 enterRound 换一个
      mc.enterRound({ kind: 'inner' });
      mc.recordCall({ purpose: 'memory.consolidate', backend: 'api', status: 'success' });
      const calls = readCalls();
      const aux = calls.find((c) => c.purpose === 'chat.aux');
      const cons = calls.find((c) => c.purpose === 'memory.consolidate');
      ok('外层那条用的是 outer', aux?.roundId === outer.roundId, `${aux?.roundId} vs ${outer.roundId}`);
      ok('内层那条换了新 round', cons?.roundId !== outer.roundId, `${cons?.roundId} vs ${outer.roundId}`);
    });
  }

  console.log('\n【⑤ 失败调用也有 roundId（不会因为失败丢归属）】');
  {
    reset();
    await mc.withRound({ kind: 'autonomous' }, async (r) => {
      mc.recordCall({ purpose: 'autonomous.intent', backend: 'api', status: 'failed', failureCode: 'API_429', failureDetail: '限频' });
      const calls = readCalls();
      ok('失败记录有 roundId', calls[0]?.roundId === r.roundId, calls[0]?.roundId);
      ok('failureCode 保留', calls[0]?.failureCode === 'API_429');
    });
  }

  console.log('\n【⑥ 记录器故障不影响业务（round 也不受影响）】');
  {
    reset();
    let innerRan = false;
    await mc.withRound({ kind: 'chat' }, async () => {
      const bad = path.join(tmp, 'sub', '\u0000bad.ndjson');
      const r = mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: bad });
      ok('recordCall 返回失败不抛', r.ok === false, JSON.stringify(r).slice(0, 60));
      innerRan = true;
    });
    ok('业务逻辑照常执行', innerRan === true);
  }

  console.log('\n【⑦ 真实模块接线：orchestrator / autonomous 有 enterRound】');
  {
    const orch = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
    ok('orchestrator.wake 里调了 enterRound', /async wake\([^)]*\) \{[\s\S]{0,300}?enterRound\(\{ kind: 'chat'/.test(orch));
    ok('consolidateMemoryForChat 用了 memory 轮', /consolidateMemoryForChat[\s\S]{0,300}?enterRound\(\{ kind: 'memory'/.test(orch));
    const auto = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    // 4.0 / 2.6-B5c：runSession 开头加了互斥（约 30 行注释），窗口放宽到 1200。
ok('runSession 里调了 enterRound', /export async function runSession\([\s\S]{0,1200}?enterRound\(\{ kind: 'autonomous'/.test(auto));
  }

  console.log('\n【⑧ 同一轮里 DSH 与 API 混用也能归到一起（为 1.5.8.7 铺路）】');
  {
    reset();
    await mc.withRound({ kind: 'chat' }, async (r) => {
      mc.recordCall({ purpose: 'chat.reply', backend: 'dsh', status: 'failed', failureCode: 'DSH_TIMEOUT' });
      mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', fallback: true, fallbackFrom: 'dsh' });
      const calls = readCalls();
      ok('两条同 roundId', calls.every((c) => c.roundId === r.roundId), JSON.stringify(calls.map(brief)));
      ok('一 dsh 一 api', calls[0].backend === 'dsh' && calls[1].backend === 'api');
      ok('fallback 标记在', calls[1].fallback === true && calls[1].fallbackFrom === 'dsh');
    });
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
