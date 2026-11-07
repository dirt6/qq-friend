// R6-B1 专项测试：错误事件解析与错误契约。
//
// 机主 2026-11-03 明确要求：
//   · 显式处理 type:error
//   · 处理已实测的 status.kind:error
//   · 落实错误契约（error 事件 / 非零退出码 / 空 final / stderr / 异常退出 / 超时）
//   · **不得将失败伪装成成功或空回复**
//   · 测试多个错误同时出现、错误事件顺序变化
//   · 不改变正常成功响应的既有语义
//
// ⚠️ 方法说明：spawn 在沙箱下会 EPERM，所以**不测 spawn 路径**，
//    改测从 runOnce 里抽出来的纯函数（newEventState / applyEvent / decideOutcome）。
//    spawn 路径的稳定性由 R6-C 的真实凭据测试覆盖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6b1-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  skills: { autonomous: { enabled: false } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);

/** 便捷：喂一串事件 + 退出码，拿判定结果。 */
function run(events, code, stderr = '') {
  const st = G.newEventState();
  for (const e of events) G.applyEvent(st, e);
  return G.decideOutcome({ code, stderr, st });
}

try {
  console.log('【① 正常成功：不改变既有语义】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1', cwd: 'E:\\dsh\\QQ-agent' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      { type: 'status', phase: 'turn_end', turn: 1 },
      { type: 'final', text: '这是正常回复' }
    ], 0);
    ok('ok === true', r.ok === true);
    ok('**text 是正常回复**', r.text === '这是正常回复', JSON.stringify(r.text));
    ok('sessionId 有值', r.sessionId === 'sid-1', r.sessionId);
    ok('**成功时不带 errorSource**', r.errorSource === undefined, String(r.errorSource));
    ok('**成功时不带 diagnostics**', r.diagnostics === undefined, String(r.diagnostics));
  }

  console.log('\n【② 顶层 error 事件 + code=0 → **必须失败**（老代码会当成功）】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'error', message: '模拟的顶层错误', code: 'FAKE_ERROR' },
      { type: 'final', text: '' }
    ], 0);
    ok('**ok === false**', r.ok === false, JSON.stringify(r));
    ok('**errorSource === event**', r.errorSource === 'event', r.errorSource);
    ok('**error 是事件里的 message**', r.error === '模拟的顶层错误', r.error);
    ok('**errorCode 有值**', r.errorCode === 'FAKE_ERROR', r.errorCode);
    ok('**没有返回 text**', r.text === undefined, JSON.stringify(r.text));
  }

  console.log('\n【③ 顶层 error 事件 + code=1（实测常见形态）】');
  {
    const r = run([
      { type: 'error', message: 'session "x" does not exist', code: 'SESSION_NOT_FOUND' }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('errorSource === event', r.errorSource === 'event', r.errorSource);
    ok('error 含 does not exist', /does not exist/.test(r.error || ''), r.error);
  }

  console.log('\n【④ 回合级错误 turn_end.kind=error + code=1（MISSING_CREDENTIAL 形态）】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'status', phase: 'turn_start', turn: 1 },
      {
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } }
      },
      { type: 'final', text: '' }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('**errorSource === turn**', r.errorSource === 'turn', r.errorSource);
    ok('**error 是 no API key**', r.error === 'no API key', r.error);
    ok('errorCode === MISSING_CREDENTIAL', r.errorCode === 'MISSING_CREDENTIAL', r.errorCode);
  }

  console.log('\n【⑤ 回合级错误 + code=0 + 有非空 final（最危险）】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      {
        type: 'status',
        phase: 'turn_end',
        turn: 1,
        reason: { kind: 'error', error: { message: '回合内部失败', code: 'INTERNAL' } }
      },
      { type: 'final', text: '看起来像成功但其实是错的' }
    ], 0);
    ok('**ok === false**（有非空 final 也失败）', r.ok === false, JSON.stringify({ ok: r.ok, text: r.text }));
    ok('errorSource === turn', r.errorSource === 'turn', r.errorSource);
    ok('**没有把那个错误的文本返回出去**', r.text === undefined, JSON.stringify(r.text));
  }

  console.log('\n【⑥ code=0 但没有 final → **必须失败**，不能当空回复】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'status', phase: 'turn_start', turn: 1 }
    ], 0);
    ok('**ok === false**', r.ok === false, JSON.stringify(r));
    ok('**errorSource === empty**', r.errorSource === 'empty', r.errorSource);
    ok('**error 说清楚「没有收到任何回复文本」**', /没有收到任何回复文本/.test(r.error || ''), r.error);
  }

  console.log('\n【⑦ 空 final + code=0（正常完成但文本为空）】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'final', text: '' }
    ], 0);
    ok('**ok === false**（空回复也算失败）', r.ok === false, JSON.stringify(r));
    ok('errorSource === empty', r.errorSource === 'empty', r.errorSource);
  }

  console.log('\n【⑧ 非零退出码 + stderr 诊断】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' }
    ], 1, '这是 stderr 的诊断信息\n还有第二行');
    ok('ok === false', r.ok === false);
    ok('**errorSource === exit**', r.errorSource === 'exit', r.errorSource);
    ok('**error 里有退出码**', /退出码/.test(r.error || ''), r.error);
    ok('**diagnostics.stderrTail 保留了 stderr 内容**',
      /stderr 的诊断信息/.test(r.diagnostics?.stderrTail || ''), r.diagnostics?.stderrTail);
    ok('**stderrTail 里的换行被压成空格**', !/[\r\n]/.test(r.diagnostics?.stderrTail || ''), r.diagnostics?.stderrTail);
  }

  console.log('\n【⑨ 多个 error 事件同时出现】');
  {
    const r = run([
      { type: 'error', message: '第一个错误', code: 'E1' },
      { type: 'error', message: '第二个错误', code: 'E2' },
      { type: 'error', message: '第三个错误', code: 'E3' }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('**errorCount === 3**', r.errorCount === 3, String(r.errorCount));
    ok('**error 是第一个**', r.error === '第一个错误', r.error);
    ok('diagnostics.events.errors === 3', r.diagnostics?.events?.errors === 3, String(r.diagnostics?.events?.errors));
  }

  console.log('\n【⑩ 错误事件顺序：error 先、final 后】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'error', message: '先出现的错误', code: 'E_FIRST' },
      { type: 'final', text: '后出现的正常文本' }
    ], 0);
    ok('**ok === false**（error 优先）', r.ok === false, JSON.stringify({ ok: r.ok, text: r.text }));
    ok('errorSource === event', r.errorSource === 'event', r.errorSource);
    ok('**没有返回后面的 final 文本**', r.text === undefined, JSON.stringify(r.text));
  }

  console.log('\n【⑪ 错误事件顺序：final 先、error 后】');
  {
    const r = run([
      { type: 'session', sessionId: 'sid-1' },
      { type: 'final', text: '先出现的正常文本' },
      { type: 'error', message: '后出现的错误', code: 'E_LAST' }
    ], 0);
    ok('**ok === false**（顺序不影响：有 error 就失败）', r.ok === false, JSON.stringify({ ok: r.ok, text: r.text }));
    ok('errorSource === event', r.errorSource === 'event', r.errorSource);
  }

  console.log('\n【⑫ 多个回合级错误】');
  {
    const r = run([
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: '第一回合失败', code: 'T1' } } },
      { type: 'status', phase: 'turn_end', turn: 2, reason: { kind: 'error', error: { message: '第二回合失败', code: 'T2' } } }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('**errorCount === 2**', r.errorCount === 2, String(r.errorCount));
    ok('error 是第一回合的', r.error === '第一回合失败', r.error);
  }

  console.log('\n【⑬ 顶层 error + 回合级 error 同时出现 → 顶层优先】');
  {
    const r = run([
      { type: 'error', message: '顶层错误', code: 'TOP' },
      { type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'error', error: { message: '回合错误', code: 'TURN' } } }
    ], 1);
    ok('ok === false', r.ok === false);
    ok('**errorSource === event（顶层优先）**', r.errorSource === 'event', r.errorSource);
    ok('error 是顶层那条', r.error === '顶层错误', r.error);
  }

  console.log('\n【⑭ applyEvent 的健壮性】');
  {
    const st = G.newEventState();
    G.applyEvent(st, null);
    G.applyEvent(st, undefined);
    G.applyEvent(st, {});
    G.applyEvent(st, { type: 'unknown', foo: 1 });
    ok('**非法输入不抛异常**', true);
    ok('**unknown 类型被忽略**', st.errorEvents.length === 0 && st.finalText === '');

    // status 但没有 usage 也不该崩
    const st2 = G.newEventState();
    G.applyEvent(st2, { type: 'status', phase: 'step_start' });
    ok('status 无 usage 不崩', st2.usage === null);
  }

  console.log('\n【⑮ 源码级：契约的四条判断都在】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('**解析 type:error**', /ev\.type === 'error'/.test(src));
    ok('**解析 turn_end.kind=error**', /ev\.reason\?\.kind === 'error'/.test(src));
    ok('**① errorEvents.length 判断**', /if \(st\.errorEvents\.length\)/.test(src));
    ok('**② turnErrors.length 判断**', /if \(st\.turnErrors\.length\)/.test(src));
    ok('**③ code !== 0 && !st.finalText**', /code !== 0 && !st\.finalText/.test(src));
    ok('**④ code === 0 && !st.finalText（新增）**', /code === 0 && !st\.finalText/.test(src));
    ok('**errorSource 四种都有**',
      src.includes("'event'") && src.includes("'turn'") && src.includes("'exit'") && src.includes("'empty'"));
    ok('**纯函数已导出**',
      /export function newEventState/.test(src)
      && /export function applyEvent/.test(src)
      && /export function decideOutcome/.test(src));
  }

  console.log('\n【⑯ runOnce 确实调用了纯函数】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'dsh-gateway.js'), 'utf8');
    ok('**有 newEventState()**', /const evState = newEventState\(\)/.test(src));
    ok('**有 applyEvent(evState, parsed)**', /applyEvent\(evState, parsed\)/.test(src));
    ok('**有 decideOutcome({ code, stderr, st: parsed })**', /decideOutcome\(\{ code, stderr, st: parsed \}\)/.test(src));
    ok('**成功路径仍返回 text/sessionId/usage/actions**',
      /text: outcome\.text[\s\S]{0,200}actions: drainOutbox\(callId\)/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
