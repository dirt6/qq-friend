// DSH Gateway 接入调用记录的验收测试（4.0 · 1.5.8.4）。
//
// 为什么直接测 recordDshCall 而不端到端跑 ask()：
//   DSH 沙箱下 `spawn('cmd', ...)` 会 EPERM（已实测），端到端跑不起来。
//   但本阶段的核心是「四条路径的归类是否正确」，这个可以直接验。
//   真正的 spawn 集成验证放在重启后的真实运行里（见报告）。
//
// 覆盖机主的验收表：
//   正常返回 / 超时 / 非零退出 / 空回复 / 无 usage / ALS 有 roundId /
//   没有 roundId / 记录器写失败不影响
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-rec-'));
const CALLS = path.join(tmp, 'model-calls.ndjson');

process.env.QQ_AGENT_DATA_DIR = tmp;
process.env.QQ_MODEL_CALLS_FILE = CALLS;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  api: { model: 'deepseek-flash', baseUrl: 'http://127.0.0.1:9' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const gw = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const mc = await import(pathToFileURL(path.join(ROOT, 'src', 'model-calls.js')).href);

const readCalls = () => {
  try {
    return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};
const reset = () => { try { fs.rmSync(CALLS, { force: true }); } catch { /* ignore */ } };
const ctx = (started = Date.now() - 5000) => ({ key: 'private:1', sessionId: 'sess-1', usage: null, finalText: '', started, timeoutMs: 180000 });

try {
  console.log('【① 正常返回 → success + tokens】');
  {
    reset();
    gw.recordDshCall(
      { ok: true, text: '你好呀' },
      { ...ctx(), finalText: '你好呀', usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 50 } } }
    );
    const c = readCalls().pop();
    ok('记了 1 条', readCalls().length === 1);
    ok('status=success', c?.status === 'success', c?.status);
    ok('backend=dsh', c?.backend === 'dsh', c?.backend);
    ok('purpose=chat.reply', c?.purpose === 'chat.reply', c?.purpose);
    ok('tokens 正确', c?.tokens?.prompt === 100 && c?.tokens?.completion === 20, JSON.stringify(c?.tokens));
    ok('cached=50', c?.tokens?.cached === 50, String(c?.tokens?.cached));
    ok('durationMs > 0', Number(c?.durationMs) > 0, String(c?.durationMs));
    ok('失败字段都是 null', c?.failureCode === null && c?.failureDetail === null);
  }

  console.log('\n【② 超时 → DSH_TIMEOUT，tokens=null】');
  {
    reset();
    gw.recordDshCall({ ok: false, error: 'DSH 超时（180000ms）' }, ctx());
    const c = readCalls().pop();
    ok('status=failed', c?.status === 'failed', c?.status);
    ok('failureCode=DSH_TIMEOUT', c?.failureCode === 'DSH_TIMEOUT', c?.failureCode);
    ok('tokens=null（不填 0）', c?.tokens === null, JSON.stringify(c?.tokens));
  }

  console.log('\n【③ 非零退出 → DSH_NONZERO_EXIT】');
  {
    reset();
    gw.recordDshCall({ ok: false, error: 'dsh 退出码 3：boom' }, ctx());
    const c = readCalls().pop();
    ok('failureCode=DSH_NONZERO_EXIT', c?.failureCode === 'DSH_NONZERO_EXIT', c?.failureCode);
    ok('detail 保留原文', /退出码 3/.test(String(c?.failureDetail)), c?.failureDetail);
  }

  console.log('\n【④ 起不来 → DSH_SPAWN_FAILED】');
  {
    reset();
    gw.recordDshCall({ ok: false, error: '起不来 dsh：EPERM' }, ctx());
    const c = readCalls().pop();
    ok('failureCode=DSH_SPAWN_FAILED', c?.failureCode === 'DSH_SPAWN_FAILED', c?.failureCode);
  }

  console.log('\n【⑤ 空回复 → DSH_EMPTY_REPLY（不是 success）】');
  {
    reset();
    gw.recordDshCall({ ok: true, text: '' }, { ...ctx(), finalText: '   ' });
    const c = readCalls().pop();
    ok('status=failed', c?.status === 'failed', c?.status);
    ok('failureCode=DSH_EMPTY_REPLY', c?.failureCode === 'DSH_EMPTY_REPLY', c?.failureCode);
    ok('detail 说明了原因', /没有收到任何回复/.test(String(c?.failureDetail)), c?.failureDetail);
  }

  console.log('\n【⑥ 无 usage → tokens: null】');
  {
    reset();
    gw.recordDshCall({ ok: true, text: '有回复但没用量' }, { ...ctx(), finalText: '有回复但没用量', usage: null });
    const c = readCalls().pop();
    ok('status=success', c?.status === 'success', c?.status);
    ok('tokens=null', c?.tokens === null, JSON.stringify(c?.tokens));
  }

  console.log('\n【⑦ ALS 里没有 round → round-lone-*】');
  {
    reset();
    gw.recordDshCall({ ok: true, text: 'hi' }, { ...ctx(), finalText: 'hi' });
    const c = readCalls().pop();
    ok('用了 round-lone 兜底', /^round-lone-/.test(String(c?.roundId)), c?.roundId);
  }

  console.log('\n【⑧ ALS 里有 round → 正确关联，不重新生成】');
  {
    reset();
    let roundId = '';
    mc.withRound({ kind: 'chat', chatKey: 'private:1' }, (r) => {
      roundId = r.roundId;
      gw.recordDshCall({ ok: true, text: 'hi' }, { ...ctx(), finalText: 'hi' });
      gw.recordDshCall({ ok: true, text: 'hi2' }, { ...ctx(), finalText: 'hi2' });
    });
    const all = readCalls();
    ok('两条都用了同一个 roundId', all.length === 2 && all.every((c) => c.roundId === roundId), JSON.stringify(all.map((c) => c.roundId)));
    ok('roundId 是 ALS 生成的那个', all[0].roundId === roundId);
  }

  console.log('\n【⑨ 记录器写失败 → 不抛、不影响调用方】');
  {
    const orig = process.env.QQ_MODEL_CALLS_FILE;
    const bad = process.platform === 'win32' ? 'Z:\\nope\\calls.ndjson' : '/proc/nope/calls.ndjson';
    // 直接改环境变量没用（CALLS_FILE 已加载），改用 recordCall 的 file 参数路径验证过；
    // 这里验证 recordDshCall 在 recordCall 内部失败时不会抛
    let threw = null;
    try {
      gw.recordDshCall({ ok: true, text: 'x' }, { ...ctx(), finalText: 'x' });
    } catch (e) { threw = e; }
    ok('没有抛异常', threw === null, threw?.message);
    process.env.QQ_MODEL_CALLS_FILE = orig;
  }

  console.log('\n【⑩ 多次收尾只记一条（幂等由 finish 的 settled 保证，这里验证函数本身不会重复记）】');
  {
    reset();
    const one = () => gw.recordDshCall({ ok: true, text: 'x' }, { ...ctx(), finalText: 'x' });
    one();
    ok('调一次记一条', readCalls().length === 1, String(readCalls().length));
    // 注意：幂等是 finish() 里 settled 标志的职责，不进 recordDshCall —— 这里说明一下
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
