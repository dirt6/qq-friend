// DSH 网关：把一次 QQ 对话交给 `dsh headless` 跑，拿回最终回复。
//
// 为什么这么做：QQ Agent 自己的模型调用是无状态的，上下文只有最近 80 条，
// 工具也只有聊天域那 58 个。而 DSH 是一个完整 agent 运行时——有工作区、
// 文件读写、shell、技能，会话还是持久化的。把对话转过去，她能记住更多、
// 也能真的碰到电脑上的东西（受 DSH 自己的权限策略约束）。
//
// 通信方式是子进程 + NDJSON：
//   dsh headless --json [--session-id <sid>] "<消息>"
// 事件流里 type=final 是最终回复，type=session 给 sessionId（存下来复用），
// type=status 的 step_end 带 usage。
//
// 未接入 orchestrator 之前，可以单独跑：
//   node scripts/dsh-ask.mjs "test" "你好"

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../src/config.js';

const SESSIONS_FILE = path.join(DATA_DIR, 'dsh-sessions.json');
const DEFAULT_TIMEOUT_MS = 180_000;

/** chatKey -> { sessionId, createdAt, lastUsedAt, turns } */
function loadSessions() {
  try {
    const j = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function saveSessions(map) {
  fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
  const tmp = `${SESSIONS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(map, null, 1), 'utf8');
  fs.renameSync(tmp, SESSIONS_FILE);
}

/** 同一会话的请求必须串行：DSH 的 session 不是并发安全的。 */
const queues = new Map();
function withQueue(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(key, next.catch(() => {}));
  return next;
}

/**
 * 让 DSH 处理一句话。
 * @param {string} sessionKey 逻辑会话键（建议用 chatKey，如 private:1846383180）
 * @param {string} text 用户消息（多人时带上说话人）
 * @param {object} [opts]
 * @returns {Promise<{ok:boolean, text?:string, sessionId?:string, usage?:object, error?:string, ms:number}>}
 */
export function ask(sessionKey, text, { timeoutMs = DEFAULT_TIMEOUT_MS, fresh = false } = {}) {
  const key = String(sessionKey || 'default');
  return withQueue(key, () => runOnce(key, text, { timeoutMs, fresh }));
}

function runOnce(key, text, { timeoutMs, fresh }) {
  const started = Date.now();
  const map = loadSessions();
  const prev = fresh ? null : map[key]?.sessionId;

  const args = ['headless', '--json'];
  if (prev) args.push('--session-id', prev);
  args.push(String(text));

  return new Promise((resolve) => {
    // dsh 在 Windows 上是个 .cmd/.ps1，直接 spawn 会失败，走 cmd /c
    const child = spawn('cmd', ['/c', 'dsh', ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let sessionId = prev || '';
    let finalText = '';
    let usage = null;
    let stderr = '';
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, ms: Date.now() - started });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: `DSH 超时（${timeoutMs}ms）` });
    }, timeoutMs);

    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'session' && ev.sessionId) {
          sessionId = ev.sessionId;
        } else if (ev.type === 'final' && typeof ev.text === 'string') {
          finalText = ev.text;
        } else if (ev.type === 'status' && ev.usage) {
          usage = ev.usage;
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      stderr += c;
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    child.on('close', (code) => {
      if (code !== 0 && !finalText) {
        finish({ ok: false, error: `dsh 退出码 ${code}：${stderr.trim().slice(-400)}` });
        return;
      }
      // 存对话映射
      if (sessionId) {
        const cur = loadSessions();
        cur[key] = {
          sessionId,
          createdAt: cur[key]?.createdAt || new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          turns: (Number(cur[key]?.turns) || 0) + 1
        };
        try { saveSessions(cur); } catch { /* ignore */ }
      }
      finish({ ok: true, text: finalText, sessionId, usage });
    });

    child.on('error', (err) => {
      finish({ ok: false, error: `起不来 dsh：${err?.message ?? err}` });
    });
  });
}

/** 读对话映射（给状态页/排查用）。 */
export function listSessions() {
  return loadSessions();
}

// 命令行直用：node scripts/dsh-ask.mjs <sessionKey> <text>
if (process.argv[1] && process.argv[1].endsWith('dsh-ask.mjs')) {
  const [, , sessionKey = 'test', ...rest] = process.argv;
  const text = rest.join(' ') || '你好';
  ask(sessionKey, text).then((r) => {
    process.stdout.write(JSON.stringify(r, null, 1) + '\n');
    process.exit(r.ok ? 0 : 1);
  });
}
