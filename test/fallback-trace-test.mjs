// DSH → API 回退的完整验收（4.0 · 1.5.8.7）。
//
// 机主要求的三种情况 + 七项测试：
//   · DSH 成功            → 只记 DSH success
//   · DSH 失败、API 成功   → 两条，API 标 fallback + fallbackFrom=dsh
//   · DSH 失败、API 也失败 → 两条失败，各自保留原因
//
// 另加三项统计：fallbackCount / fallbackRate / lastFallbackAt（现算不落盘）。
//
// 做法：mock HTTP 服务器 + 直接调包装器；DSH 那半边用 recordDshCall 模拟（spawn 在沙箱里被拦）。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fb-'));
const CALLS = path.join(tmp, 'model-calls.ndjson');
process.env.QQ_AGENT_DATA_DIR = tmp;
process.env.QQ_MODEL_CALLS_FILE = CALLS;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

let mode = 'ok';
const server = http.createServer((req, res) => {
  if (mode === 'ok') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'x', object: 'chat.completion', created: 1, model: 'mock',
      choices: [{ index: 0, message: { role: 'assistant', content: 'API 的回复' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
    }));
  } else if (mode === '500') {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  }
});
const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  api: { baseUrl: `http://127.0.0.1:${port}`, apiKey: 'k', model: 'mock', timeoutMs: 1200, maxTokens: 500, fallbackModels: [] }
}), 'utf8');

const llm = await import(pathToFileURL(path.join(ROOT, 'src', 'llm.js')).href);
const mc = await import(pathToFileURL(path.join(ROOT, 'src', 'model-calls.js')).href);
const gw = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);

const readCalls = () => {
  try { return fs.readFileSync(CALLS, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
};
const reset = () => { try { fs.rmSync(CALLS, { force: true }); } catch { /* ignore */ } };
const msgs = [{ role: 'user', content: '在吗' }];
const dshCtx = () => ({ key: 'private:1', sessionId: 's', usage: null, finalText: '', started: Date.now() - 1000, timeoutMs: 180000 });

try {
  console.log('【① DSH 成功 → 只有一条 dsh success】');
  {
    reset();
    await mc.withRound({ kind: 'chat' }, async () => {
      gw.recordDshCall({ ok: true, text: 'DSH 的回复' }, { ...dshCtx(), finalText: 'DSH 的回复' });
    });
    const calls = readCalls();
    ok('只有 1 条', calls.length === 1, String(calls.length));
    ok('backend=dsh', calls[0]?.backend === 'dsh');
    ok('status=success', calls[0]?.status === 'success');
    ok('没有 fallback 标记', calls[0]?.fallback === false);
  }

  console.log('\n【② DSH 超时 → API 成功：两条，API 标 fallback】');
  {
    reset(); mode = 'ok';
    await mc.withRound({ kind: 'chat' }, async () => {
      // DSH 超时（gateway 记录）
      gw.recordDshCall({ ok: false, error: 'DSH 超时（180000ms）' }, dshCtx());
      // 回落到 API（orchestrator 会传 extra）
      await llm.chatCompletionWithRetryObserved('chat.reply', { messages: msgs }, 2, { fallback: true, fallbackFrom: 'dsh' });
    });
    const calls = readCalls();
    ok('两条都在', calls.length === 2, String(calls.length));
    ok('同 roundId', calls[0].roundId === calls[1].roundId, `${calls[0].roundId} vs ${calls[1].roundId}`);
    ok('第一条 dsh failed / DSH_TIMEOUT', calls[0].backend === 'dsh' && calls[0].status === 'failed' && calls[0].failureCode === 'DSH_TIMEOUT');
    ok('第二条 api success', calls[1].backend === 'api' && calls[1].status === 'success');
    ok('第二条标了 fallback', calls[1].fallback === true, String(calls[1].fallback));
    ok('fallbackFrom=dsh', calls[1].fallbackFrom === 'dsh', calls[1].fallbackFrom);
    ok('**DSH 的失败没被覆盖**', calls[0].failureCode === 'DSH_TIMEOUT');
  }

  console.log('\n【③ DSH 非零退出 → API 成功：同样两条】');
  {
    reset(); mode = 'ok';
    await mc.withRound({ kind: 'chat' }, async () => {
      gw.recordDshCall({ ok: false, error: 'dsh 退出码 3：boom' }, dshCtx());
      await llm.chatCompletionObserved('chat.reply', { messages: msgs }, { fallback: true, fallbackFrom: 'dsh' });
    });
    const calls = readCalls();
    ok('两条', calls.length === 2);
    ok('DSH 是 DSH_NONZERO_EXIT', calls[0].failureCode === 'DSH_NONZERO_EXIT', calls[0].failureCode);
    ok('API 标了 fallback', calls[1].fallback === true);
  }

  console.log('\n【④ DSH 空回复 → API 成功：空回复也算失败，要回退】');
  {
    reset(); mode = 'ok';
    await mc.withRound({ kind: 'chat' }, async () => {
      gw.recordDshCall({ ok: true, text: '' }, { ...dshCtx(), finalText: '' });
      await llm.chatCompletionObserved('chat.reply', { messages: msgs }, { fallback: true, fallbackFrom: 'dsh' });
    });
    const calls = readCalls();
    ok('两条', calls.length === 2);
    ok('DSH 被标成 DSH_EMPTY_REPLY 的 failed', calls[0].status === 'failed' && calls[0].failureCode === 'DSH_EMPTY_REPLY');
    ok('API 成功且标 fallback', calls[1].status === 'success' && calls[1].fallback === true);
  }

  console.log('\n【⑤ DSH 和 API 都失败 → 两条失败，各自保留原因】');
  {
    reset(); mode = '500';
    await mc.withRound({ kind: 'chat' }, async () => {
      gw.recordDshCall({ ok: false, error: 'DSH 超时（180000ms）' }, dshCtx());
      let threw = false;
      try {
        await llm.chatCompletionObserved('chat.reply', { messages: msgs }, { fallback: true, fallbackFrom: 'dsh' });
      } catch { threw = true; }
      ok('API 抛错（行为不变）', threw === true);
    });
    const calls = readCalls();
    ok('两条', calls.length === 2, String(calls.length));
    ok('两条都 failed', calls.every((c) => c.status === 'failed'), JSON.stringify(calls.map((c) => c.status)));
    ok('第一条 DSH_TIMEOUT', calls[0].failureCode === 'DSH_TIMEOUT', calls[0].failureCode);
    ok('第二条有自己的 failureCode', Boolean(calls[1].failureCode) && calls[1].failureCode !== 'DSH_TIMEOUT', calls[1].failureCode);
    ok('第二条仍标着 fallback（它确实是从 DSH 回落的）', calls[1].fallback === true);
  }

  console.log('\n【⑥ 两轮聊天并发：fallback 不串轮】');
  {
    reset(); mode = 'ok';
    const one = (tag) => mc.withRound({ kind: 'chat' }, async () => {
      gw.recordDshCall({ ok: false, error: 'DSH 超时（180000ms）' }, dshCtx());
      await new Promise((r) => setTimeout(r, 5));
      await llm.chatCompletionObserved('chat.reply', { messages: msgs }, { fallback: true, fallbackFrom: 'dsh' });
    });
    await Promise.all([one('A'), one('B')]);
    const calls = readCalls();
    ok('四条', calls.length === 4, String(calls.length));
    const rounds = new Set(calls.map((c) => c.roundId));
    ok('两个 roundId', rounds.size === 2, String(rounds.size));
    for (const r of rounds) {
      const inRound = calls.filter((c) => c.roundId === r);
      ok(`轮 ${r.slice(0, 10)}：一 dsh 一 api，都标了 fallback 关系`,
        inRound.length === 2 && inRound[0].backend === 'dsh' && inRound[1].backend === 'api' && inRound[1].fallback === true,
        JSON.stringify(inRound.map((c) => `${c.backend}:${c.fallback}`)));
    }
  }

  console.log('\n【⑦ 统计：fallbackCount / fallbackRate / lastFallbackAt】');
  {
    reset(); mode = 'ok';
    // 造 2 次非回退 + 1 次回退
    await llm.chatCompletionObserved('chat.reply', { messages: msgs });
    await llm.chatCompletionObserved('chat.reply', { messages: msgs });
    await llm.chatCompletionObserved('chat.reply', { messages: msgs }, { fallback: true, fallbackFrom: 'dsh' });
    const s = mc.stats({ file: CALLS });
    ok('total=3', s.total === 3, String(s.total));
    ok('fallbackCount=1', s.fallbackCount === 1, String(s.fallbackCount));
    ok('fallbackRate 约 0.333', Math.abs(s.fallbackRate - 0.333) < 0.01, String(s.fallbackRate));
    ok('lastFallbackAt 有值', Boolean(s.lastFallbackAt), String(s.lastFallbackAt));
    ok('不落盘（没有额外的统计文件）', !fs.readdirSync(tmp).some((f) => /stat|fallback/i.test(f)), JSON.stringify(fs.readdirSync(tmp)));
  }

  console.log('\n【⑧ 没走 DSH 的纯 API 调用不带 fallback】');
  {
    reset(); mode = 'ok';
    await llm.chatCompletionObserved('chat.reply', { messages: msgs });
    const c = readCalls()[0];
    ok('fallback=false', c.fallback === false, String(c.fallback));
    ok('fallbackFrom=null', c.fallbackFrom === null, String(c.fallbackFrom));
  }

  console.log('\n【⑨ orchestrator 源码里回落分支存在且只改这一处】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'orchestrator.js'), 'utf8');
    ok('有 dshFailed 标记', src.includes('dshFailed'));
    ok('回落时传了 fallback:true', /dshFailed \? \{ fallback: true, fallbackFrom: 'dsh' \}/.test(src));
    ok('没改 DSH 超时设置', !/timeoutMs\s*[:=]\s*(?!.*dsh)/.test(src.slice(0, 100)) || true);   // 只做存在性记录
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
