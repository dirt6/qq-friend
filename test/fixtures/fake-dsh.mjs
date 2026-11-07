// 假 dsh（B1 测试用）：按 FAKE_SCENARIO 输出预设的 JSON 事件流 + 退出码。
//
// 用法：由 dsh-gateway 通过 QQ_DSH_BIN 指向这个脚本，
//       它会被 spawn('cmd', ['/c', <这个文件>, ...args]) 调用。
//
// 场景通过环境变量 FAKE_SCENARIO 选。
import fs from 'node:fs';

const scenario = String(process.env.FAKE_SCENARIO || 'ok');
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// 顺便记录一下被怎么调用的（验证参数顺序 / cwd / DSH_HOME）
try {
  const dump = String(process.env.FAKE_DUMP || '');
  if (dump) {
    fs.writeFileSync(dump, JSON.stringify({
      argv: process.argv.slice(2),
      cwd: process.cwd(),
      dshHome: process.env.DSH_HOME || '',
      at: Date.now()
    }, null, 1), 'utf8');
  }
} catch { /* ignore */ }

// 读掉 stdin（gateway 会写任务文本）
try { fs.readFileSync(0, 'utf8'); } catch { /* ignore */ }

const SID = 'session-fake-0001';

switch (scenario) {
  // ── 正常成功 ──────────────────────────────────────────────
  case 'ok': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'status', phase: 'turn_start', turn: 1 });
    out({ type: 'status', phase: 'step_start', turn: 1, step: 1 });
    out({ type: 'status', phase: 'step_end', turn: 1, step: 1 });
    out({ type: 'status', phase: 'turn_end', turn: 1 });
    out({ type: 'final', text: '这是正常回复' });
    process.exit(0);
    break;
  }

  // ── 顶层 error 事件 + code=0（最危险：老代码会当成功） ──────
  case 'error-event-code0': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'error', message: '模拟的顶层错误', code: 'FAKE_ERROR' });
    out({ type: 'final', text: '' });
    process.exit(0);
    break;
  }

  // ── 顶层 error 事件 + code=1（实测常见） ────────────────────
  case 'error-event-code1': {
    out({ type: 'error', message: 'session "x" does not exist', code: 'SESSION_NOT_FOUND' });
    process.exit(1);
    break;
  }

  // ── 回合级错误（MISSING_CREDENTIAL 的形态）+ code=1 ─────────
  case 'turn-error-code1': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'status', phase: 'turn_start', turn: 1 });
    out({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { message: 'no API key', code: 'MISSING_CREDENTIAL' } }
    });
    out({ type: 'final', text: '' });
    process.exit(1);
    break;
  }

  // ── 回合级错误 + code=0（另一条危险路径） ───────────────────
  case 'turn-error-code0': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({
      type: 'status',
      phase: 'turn_end',
      turn: 1,
      reason: { kind: 'error', error: { message: '回合内部失败', code: 'INTERNAL' } }
    });
    out({ type: 'final', text: '看起来像成功但其实是错的' });
    process.exit(0);
    break;
  }

  // ── code=0 但没有任何 final ─────────────────────────────────
  case 'no-final-code0': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'status', phase: 'turn_start', turn: 1 });
    process.exit(0);
    break;
  }

  // ── 非零退出码 + 无 final + stderr 有内容 ───────────────────
  case 'exit-code1-stderr': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    process.stderr.write('这是 stderr 的诊断信息\n');
    process.exit(1);
    break;
  }

  // ── 多个 error 事件同时出现 ─────────────────────────────────
  case 'multi-error': {
    out({ type: 'error', message: '第一个错误', code: 'E1' });
    out({ type: 'error', message: '第二个错误', code: 'E2' });
    out({ type: 'error', message: '第三个错误', code: 'E3' });
    process.exit(1);
    break;
  }

  // ── 错误事件顺序：error 先、final 后 ────────────────────────
  case 'error-then-final': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'error', message: '先出现的错误', code: 'E_FIRST' });
    out({ type: 'final', text: '后出现的正常文本' });
    process.exit(0);
    break;
  }

  // ── 错误事件顺序：final 先、error 后 ────────────────────────
  case 'final-then-error': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'final', text: '先出现的正常文本' });
    out({ type: 'error', message: '后出现的错误', code: 'E_LAST' });
    process.exit(0);
    break;
  }

  // ── 超时（故意睡很久） ──────────────────────────────────────
  case 'timeout': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'status', phase: 'turn_start', turn: 1 });
    // 睡 10 秒，测试会把 timeoutMs 设成很小
    const end = Date.now() + 10000;
    while (Date.now() < end) { /* busy wait */ }
    process.exit(0);
    break;
  }

  // ── 空 final（正常完成但文本为空） ──────────────────────────
  case 'empty-final-code0': {
    out({ type: 'session', sessionId: SID, cwd: process.cwd() });
    out({ type: 'final', text: '' });
    process.exit(0);
    break;
  }

  default: {
    out({ type: 'error', message: '未知场景: ' + scenario });
    process.exit(1);
  }
}
