// 5.0-E5/G1：Electron 主进程只读运行服务。
// 仅 A1–D + Receipt + 审计；无 executor/模型/工具/业务写入/发送/自动调度。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildPurposeCandidates } from './autonomous/purpose.js';
import { assessConversationClosure } from './autonomous/closure.js';
import { selectActivity } from './autonomous/activity.js';
import { createDecisionReceipt } from './autonomous/receipt.js';

const VERSION = 1;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = (n) => new Date(n ?? Date.now()).toISOString();

function defaultState() {
  return { version: VERSION, paused: true, running: false, tickUsed: false, used: [], lastRun: null, degraded: false };
}

function readCommit(root) {
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) return fs.readFileSync(path.join(root, '.git', head.slice(5)), 'utf8').trim().slice(0, 40);
    return head.slice(0, 40);
  } catch { return 'unknown'; }
}

export function createG1Service({ core, dataDir, auditDir, tokenFile = '', root = process.cwd(), version = '', now = () => Date.now() } = {}) {
  if (!core || typeof core.readChatSnapshot !== 'function') throw new Error('G1 需要 Companion Core');
  if (!dataDir) throw new Error('G1 需要 dataDir');
  const expectedAudit = path.join(path.resolve(dataDir), '5.0-g1');
  const audit = path.resolve(auditDir || expectedAudit);
  if (audit !== path.resolve(expectedAudit)) throw new Error('G1 审计目录必须是 data/5.0-g1');
  const tokenPath = path.resolve(tokenFile || path.join(audit, 'token'));
  if (path.dirname(tokenPath) !== audit) throw new Error('G1 token 必须位于 data/5.0-g1');
  fs.mkdirSync(audit, { recursive: true });
  const stateFile = path.join(audit, 'state.json');
  let state = defaultState();
  try {
    if (fs.existsSync(stateFile)) {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state = { ...defaultState(), ...raw, used: Array.isArray(raw.used) ? raw.used : [] };
      // 进程重启时若上次 running，默认暂停并失败关闭。
      if (state.running) { state.paused = true; state.running = false; state.lastRun = { ...(state.lastRun || {}), status: 'unknown_after_restart' }; }
    }
  } catch { state = { ...defaultState(), degraded: true, paused: true }; }
  let lock = Promise.resolve();
  const withLock = (fn) => { const p = lock.then(fn, fn); lock = p.catch(() => {}); return p; };
  const save = () => {
    const tmp = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, stateFile);
  };
  const auditWrite = (obj) => {
    fs.appendFileSync(path.join(audit, 'g1-audit.ndjson'), `${JSON.stringify(obj)}\n`, 'utf8');
  };
  function readToken() {
    try {
      const t = fs.readFileSync(tokenPath, 'utf8').trim();
      return t.length >= 32 ? t : '';
    } catch { return ''; }
  }
  function authorize(req) {
    const expected = readToken();
    const supplied = String(req?.headers?.['x-g1-token'] || '');
    if (!expected || !supplied) return false;
    const a = Buffer.from(supplied); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  const status = () => ({
    paused: state.paused || state.degraded, running: state.running, degraded: state.degraded,
    version: String(version || ''), commit: readCommit(root), lastRun: state.lastRun,
    nonceCount: state.used.length, tokenConfigured: readToken() !== ''
  });

  async function run({ nonce, chatKey = 'private:1846383180' } = {}) {
    const nonceHash = nonce ? sha(nonce) : '';
    const start = now();
    return withLock(async () => {
      if (state.degraded) return { ok: false, code: 'STATE_CORRUPT', status: 503 };
      if (state.paused) return { ok: false, code: 'PAUSED', status: 423 };
      if (state.running) return { ok: false, code: 'ALREADY_RUNNING', status: 409 };
      if (state.tickUsed) return { ok: false, code: 'TICK_USED', status: 409 };
      if (!nonce || String(nonce).length < 16 || String(nonce).length > 128) return { ok: false, code: 'BAD_NONCE', status: 400 };
      if (state.used.includes(nonceHash)) return { ok: false, code: 'NONCE_REPLAY', status: 409 };
      state.used.push(nonceHash); state.running = true;
      state.lastRun = { startedAt: nowIso(start), nonceHash, status: 'running' };
      save();
      return { ok: true, nonceHash };
    }).then(async (claim) => {
      if (!claim.ok) return claim;
      try {
        const snap = core.readChatSnapshot({ chatKey, now: start, contextLimit: 20 });
        if (state.paused) throw Object.assign(new Error('paused'), { code: 'PAUSED' });
        const goals = snap.goals?.active ? [snap.goals.active] : [];
        const pending = Array.isArray(snap.pending) ? snap.pending : [];
        const messages = (snap.context || []).map((m) => ({ role: m.self ? 'assistant' : 'user', text: String(m.text || ''), at: m.ts }));
        const purpose = buildPurposeCandidates({ now: start, goals, pending, topics: messages.slice(-5).map((m) => ({ text: m.text })) });
        if (state.paused) throw Object.assign(new Error('paused'), { code: 'PAUSED' });
        const closure = assessConversationClosure({ now: start, messages });
        const activity = selectActivity({ now: start, closure, purpose, state: { goals, pending } });
        if (state.paused) throw Object.assign(new Error('paused'), { code: 'PAUSED' });
        const receipt = createDecisionReceipt({ now: start, purpose, closure, activity, inputRef: 'g1:main-process' });
        if (!receipt.ok) throw new Error(receipt.error || 'receipt_failed');
        return await withLock(async () => {
          if (state.paused) {
            state.running = false;
            state.lastRun = { ...state.lastRun, status: 'aborted_paused', finishedAt: nowIso() };
            save();
            auditWrite({ at: nowIso(), event: 'g1_aborted_paused', nonceHash });
            return { ok: false, code: 'PAUSED', status: 423 };
          }
          const r = {
            generatedAt: new Date(start).toISOString(), chatKey, counts: { goals: goals.length, pending: pending.length, messages: messages.length },
            purpose: { noAction: purpose.noAction, candidates: purpose.candidates.length },
            closure: { decision: closure.decision, reason: closure.reason },
            activity: { decision: activity.decision, type: activity.selectedActivity?.type || null },
            receipt: receipt.receipt,
            noExecutor: true, noModel: true, noBusinessWrite: true
          };
          fs.writeFileSync(path.join(audit, 'g1-receipt.json'), JSON.stringify(receipt.receipt, null, 1), 'utf8');
          fs.writeFileSync(path.join(audit, 'g1-audit.json'), JSON.stringify(r, null, 1), 'utf8');
          auditWrite({ at: nowIso(), event: 'g1_completed', receiptId: receipt.receipt.receiptId, nonceHash });
          state.running = false;
          state.tickUsed = true;
          state.lastRun = { startedAt: nowIso(start), finishedAt: nowIso(), status: 'completed', receiptId: receipt.receipt.receiptId, nonceHash };
          save();
          return { ok: true, result: r, status: 200 };
        });
      } catch (e) {
        return withLock(async () => {
          state.running = false;
          state.lastRun = { ...(state.lastRun || {}), status: e?.code === 'PAUSED' ? 'aborted_paused' : 'failed', error: String(e?.message || e), finishedAt: nowIso() };
          save();
          auditWrite({ at: nowIso(), event: e?.code === 'PAUSED' ? 'g1_aborted_paused' : 'g1_failed', nonceHash, error: String(e?.message || e) });
          return { ok: false, code: e?.code || 'G1_FAILED', status: e?.code === 'PAUSED' ? 423 : 500 };
        });
      }
    });
  }

  async function setPaused(paused) {
    return withLock(async () => {
      if (state.degraded && paused === false) return { ok: false, code: 'STATE_CORRUPT', status: 503 };
      state.paused = paused === true;
      if (!state.paused) state.tickUsed = false;
      if (state.paused && state.running) state.lastRun = { ...(state.lastRun || {}), pauseRequested: true };
      save();
      auditWrite({ at: nowIso(), event: state.paused ? 'g1_pause' : 'g1_resume' });
      return { ok: true, paused: state.paused, status: 200 };
    });
  }

  return { run, setPaused, status, authorize, tokenPath };
}

export default createG1Service;
