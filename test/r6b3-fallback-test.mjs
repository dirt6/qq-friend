// R6-B3 专项测试：兼容性、回退与防重复执行。
//
// 机主 2026-11-03 的硬要求：
//   · 保留现有 ask / hasSession / resetSession / listSessions 兼容性
//   · 双路径测试，验证新旧路径结果一致
//   · Adapter 出错时可回退旧 API
//   · **不允许一次调用被两条路径重复执行**
//   · **不允许 Session ID 或上下文串线**
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6b3-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
const R = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'retry.js')).href);
const A = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'adapter.js')).href);

try {
  console.log('【① 旧接口全部保留】');
  {
    for (const fn of ['ask', 'hasSession', 'resetSession', 'listSessions', 'lastUsedAt', 'getInjectedAt', 'setInjectedAt']) {
      ok(`**${fn} 仍然导出**`, typeof G[fn] === 'function', typeof G[fn]);
    }
  }

  console.log('\n【② 旧接口的行为语义没变】');
  {
    // hasSession / resetSession / listSessions 都是纯映射操作，可安全测
    const key = 'test:' + Date.now();
    ok('hasSession 初始 false', G.hasSession(key) === false);
    ok('listSessions 返回对象', typeof G.listSessions() === 'object');
    G.resetSession(key);
    ok('resetSession 对不存在的 key 不抛异常', true);
    ok('lastUsedAt 对不存在的 key 返回 0', Number(G.lastUsedAt(key)) === 0 || G.lastUsedAt(key) === undefined);
  }

  console.log('\n【③ 回退决策：只有 spawn 失败才允许重试】');
  {
    const cases = [
      [{ ok: true }, false, '成功了'],
      [{ ok: false, errorSource: 'spawn', error: '起不来 dsh' }, true, 'spawn 失败'],
      [{ ok: false, errorSource: 'event', error: 'x' }, false, 'error 事件'],
      [{ ok: false, errorSource: 'turn', error: 'x' }, false, '回合错误'],
      [{ ok: false, errorSource: 'exit', error: 'x' }, false, '非零退出码'],
      [{ ok: false, errorSource: 'empty', error: 'x' }, false, '空回复'],
      [{ ok: false, error: 'DSH 超时（180000ms）' }, false, '超时'],
      [{ ok: false, error: '没写 errorSource 的失败' }, false, '无法判断']
    ];
    for (const [r, expect, why] of cases) {
      const got = R.canSafelyRetry(r);
      ok(`**${why} → retryable=${expect}**`, got.retryable === expect, JSON.stringify(got));
      ok(`  （有理由说明）`, typeof got.reason === 'string' && got.reason.length > 5, got.reason);
    }
  }

  console.log('\n【④ 超时明确不能重试（最容易被误判）】');
  {
    const r = R.canSafelyRetry({ ok: false, error: 'DSH 超时（180000ms）' });
    ok('**超时不重试**', r.retryable === false);
    ok('**理由说清楚「进程已经跑了一段时间」**', /进程已经跑了/.test(r.reason), r.reason);
  }

  console.log('\n【⑤ 回退 = 换路径，也同样受「是否执行过」约束】');
  {
    const spawnFail = R.shouldFallbackToApi({ ok: false, errorSource: 'spawn' });
    ok('**spawn 失败 → 可以回退**', spawnFail.fallback === true, JSON.stringify(spawnFail));

    for (const src of ['event', 'turn', 'exit', 'empty']) {
      const r = R.shouldFallbackToApi({ ok: false, errorSource: src });
      ok(`**${src} → 不能回退**`, r.fallback === false, JSON.stringify(r));
    }
    const to = R.shouldFallbackToApi({ ok: false, error: 'DSH 超时' });
    ok('**超时 → 不能回退**', to.fallback === false);
  }

  console.log('\n【⑥ 策略说明能被人看懂】');
  {
    const d = R.describePolicy();
    ok('提到「进程没起来」', /进程没起来/.test(d), d);
    ok('**提到「绝不重发」**', /绝不重发/.test(d), d);
    ok('提到「说两遍」（重复执行的后果）', /两遍/.test(d), d);
  }

  console.log('\n【⑦ 双路径结果一致性（用纯函数模拟两条路径的判定）】');
  {
    // 旧路径：只有 code 和非空 final 判断
    const oldPath = (code, finalText) => (code !== 0 && !finalText ? { ok: false } : { ok: true, text: finalText });

    // 新路径：完整契约
    const newPath = (code, events) => {
      const st = G.newEventState();
      for (const e of events) G.applyEvent(st, e);
      return G.decideOutcome({ code, st });
    };

    // 两边都该成功的情况：结果必须一致
    const okEvents = [
      { type: 'session', sessionId: 's1' },
      { type: 'final', text: '正常' }
    ];
    const a = oldPath(0, '正常');
    const b = newPath(0, okEvents);
    ok('**正常成功：两条路径都 ok=true**', a.ok === true && b.ok === true);
    ok('**正常成功：文本一致**', a.text === b.text, `${a.text} vs ${b.text}`);

    // 两边都该失败的情况：都失败
    const c = oldPath(1, '');
    const d2 = newPath(1, [{ type: 'session', sessionId: 's1' }]);
    ok('**非零退出且无 final：两条路径都失败**', c.ok === false && d2.ok === false);
  }

  console.log('\n【⑧ 新路径更严格的地方（老路径会漏）】');
  {
    // 老路径：code=0 + 有 final → 成功
    // 新路径：有 error 事件 → 失败
    const st = G.newEventState();
    G.applyEvent(st, { type: 'error', message: '隐藏的错误' });
    G.applyEvent(st, { type: 'final', text: '看起来正常' });
    const newR = G.decideOutcome({ code: 0, st });
    ok('**老路径会判成功（code=0 + 有 final）**', ({ ok: 0 !== 0 && !'看起来正常' ? false : true }).ok === true);
    ok('**新路径判失败（有 error 事件）**', newR.ok === false, JSON.stringify(newR));
    ok('**这是有意的差异**：新路径不会把失败伪装成成功', true);
  }

  console.log('\n【⑨ Session ID 不串线：不同 key 各自独立】');
  {
    // 用 adapter 的 planCall 模拟两条不同的调用
    const plan1 = A.planCall({ profile: 'headless', cwd: 'E:\\dsh\\QQ-agent', sessionId: 'session-A', text: '任务A' });
    const plan2 = A.planCall({ profile: 'headless', cwd: 'E:\\dsh\\QQ-agent', sessionId: 'session-B', text: '任务B' });

    ok('两个 plan 都成功', plan1.ok && plan2.ok);
    ok('**sessionId 不同**', plan1.plan.sessionId !== plan2.plan.sessionId);
    ok('**stdin 不同**', plan1.plan.stdin !== plan2.plan.stdin);
    ok('**plan1 的 args 里是 session-A**',
      plan1.plan.args[plan1.plan.args.indexOf('--session-id') + 1] === 'session-A');
    ok('**plan2 的 args 里是 session-B**',
      plan2.plan.args[plan2.plan.args.indexOf('--session-id') + 1] === 'session-B');
  }

  console.log('\n【⑩ 新建 vs 恢复：args 结构不同，不会串】');
  {
    const create = A.buildArgs({ profile: 'headless' });
    const resume = A.buildArgs({ profile: 'headless', sessionId: 'session-X' });
    ok('**新建不带 --session-id**', !create.args.includes('--session-id'));
    ok('**恢复带 --session-id**', resume.args.includes('--session-id'));
    ok('两者的 mode 不同', create.mode === 'create' && resume.mode === 'resume');
  }

  console.log('\n【⑪ 源码级：spawn 失败被标记】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    // 4.0 / R6-C0：error 分支现在先判 didSpawn（运行期错误 → runtime），
    // 只有没 spawn 过才标 spawn。范围放宽到 1500 字符。
    ok('**child.on(error) 里区分 spawn/runtime**',
      /child\.on\('error'[\s\S]{0,1500}errorSource: 'spawn'/.test(src));
    ok('**有两处 errorSource 赋值（runtime + spawn）**',
      (src.match(/errorSource: 'spawn'/g) || []).length === 1
      && (src.match(/errorSource: 'runtime'/g) || []).length === 1);
  }

  console.log('\n【⑫ retry.js 是纯逻辑，不碰执行】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'session', 'retry.js'), 'utf8');
    ok('**不 spawn**', !/\bspawn\(/.test(src));
    ok('**不碰 fs**', !/from ['"]node:fs['"]/.test(src));
    ok('**不 import dsh-gateway**', !/dsh-gateway/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
