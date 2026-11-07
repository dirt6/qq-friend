// 5.0-E1：执行状态持久化（文件由调用方指定；无默认生产路径）。
// 原子写 + 文件锁 + 事件幂等 + 审计版本；unknown 需显式对账。
import fs from 'node:fs';
import path from 'node:path';
import { withFileLockAsync, writeFileAtomic } from '../file-lock.js';
import { canTransition, EXEC_STATES, isTerminal } from './execution-state.js';

const VERSION = 1;
const empty = () => ({ version: VERSION, paused: false, pauseReason: '', records: {}, seenEvents: {}, audit: [] });
const nowIso = (now) => new Date(now ?? Date.now()).toISOString();

function normalize(raw) {
  const b = empty();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return b;
  b.paused = raw.paused === true;
  b.pauseReason = String(raw.pauseReason || '');
  b.records = raw.records && typeof raw.records === 'object' ? raw.records : {};
  b.seenEvents = raw.seenEvents && typeof raw.seenEvents === 'object' ? raw.seenEvents : {};
  b.audit = Array.isArray(raw.audit) ? raw.audit.slice(-1000) : [];
  return b;
}

export function createExecutionStore({ file } = {}) {
  if (!file || typeof file !== 'string') throw new Error('execution store 需要显式 file（禁止默认生产路径）');
  const load = () => {
    try { return normalize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return empty(); }
  };
  const save = (st) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, JSON.stringify(st, null, 1));
  };
  const mutate = async (fn) => withFileLockAsync(file, async () => {
    const st = load();
    const ret = await fn(st);
    if (ret?.write !== false) save(st);
    return ret?.value;
  });

  return {
    file,
    async list() { return load(); },
    async get(receiptId) { return load().records[String(receiptId)] || null; },
    async recordReceipt(receipt, { now } = {}) {
      if (!receipt?.receiptId) return { ok: false, error: 'receiptId_required' };
      return mutate((st) => {
        if (st.records[receipt.receiptId]) return { value: { ok: true, duplicate: true, record: st.records[receipt.receiptId] } };
        const rec = {
          receiptId: receipt.receiptId, version: 1, state: 'decision_recorded', attempts: 0,
          createdAt: nowIso(now), updatedAt: nowIso(now), authorizedAt: null, startedAt: null,
          finishedAt: null, lastError: '', evidence: '', history: [], receipt
        };
        st.records[receipt.receiptId] = rec;
        st.audit.push({ at: rec.createdAt, receiptId: rec.receiptId, from: '', to: rec.state, action: 'record_receipt' });
        return { value: { ok: true, duplicate: false, record: rec } };
      });
    },
    async apply(receiptId, { eventId, to, reason = '', evidence = '', now, meta } = {}) {
      if (!eventId) return { ok: false, error: 'eventId_required' };
      return mutate((st) => {
        if (st.seenEvents[eventId]) return { value: { ok: true, duplicate: true } };
        const rec = st.records[String(receiptId)];
        if (!rec) return { value: { ok: false, error: 'receipt_not_found' } };
        if (isTerminal(rec.state)) return { value: { ok: false, error: 'terminal_state' } };
        const tr = canTransition(rec.state, to, { reason, evidence, attempts: rec.attempts, maxRetries: meta?.maxRetries ?? 1 });
        if (!tr.ok) return { value: { ok: false, error: tr.error } };
        const from = rec.state;
        rec.state = to;
        rec.updatedAt = nowIso(now);
        if (to === 'authorized') rec.authorizedAt = rec.updatedAt;
        if (to === 'started') rec.startedAt = rec.updatedAt;
        if (['succeeded', 'failed', 'cancelled'].includes(to)) rec.finishedAt = rec.updatedAt;
        if (to === 'failed') { rec.attempts += 1; rec.lastError = String(meta?.error || reason || ''); }
        if (evidence) rec.evidence = String(evidence);
        rec.history.push({ at: rec.updatedAt, eventId, from, to, reason, evidence: String(evidence || ''), meta: meta || null });
        st.seenEvents[eventId] = rec.updatedAt;
        st.audit.push({ at: rec.updatedAt, receiptId: rec.receiptId, from, to, action: reason || 'transition' });
        return { value: { ok: true, record: rec } };
      });
    },
    async authorize(receiptId, { eventId, authorization, now } = {}) {
      if (!authorization || String(authorization.receiptId) !== String(receiptId)) return { ok: false, error: 'authorization_receipt_mismatch' };
      const exp = Date.parse(authorization.expiresAt || '');
      if (!Number.isFinite(exp) || exp < (now ?? Date.now())) return { ok: false, error: 'authorization_expired' };
      if (!authorization.planHash || !authorization.authorizedBy) return { ok: false, error: 'authorization_incomplete' };
      const rec = await this.get(receiptId);
      if (!rec) return { ok: false, error: 'receipt_not_found' };
      if (rec.state === 'decision_recorded') {
        const first = await this.apply(receiptId, { eventId: `${eventId}:pending`, to: 'authorization_pending', reason: 'authorization_received', now });
        if (!first.ok) return first;
      } else if (rec.state !== 'authorization_pending') {
        return { ok: false, error: `authorization_state:${rec.state}` };
      }
      return this.apply(receiptId, { eventId, to: 'authorized', reason: 'authorization_valid', now, meta: { authorization } });
    },
    async pause(reason = '', { now } = {}) {
      return mutate((st) => { st.paused = true; st.pauseReason = String(reason); st.audit.push({ at: nowIso(now), action: 'pause', reason: String(reason) }); return { value: { ok: true } }; });
    },
    async resume({ now } = {}) {
      return mutate((st) => { st.paused = false; st.pauseReason = ''; st.audit.push({ at: nowIso(now), action: 'resume' }); return { value: { ok: true } }; });
    },
    async recover({ now } = {}) {
      return mutate((st) => {
        const recovered = [];
        for (const rec of Object.values(st.records)) {
          if (rec.state === 'started') {
            const from = rec.state; rec.state = 'unknown'; rec.updatedAt = nowIso(now);
            rec.history.push({ at: rec.updatedAt, from, to: 'unknown', reason: 'process_restart', evidence: 'started_without_terminal_state' });
            st.audit.push({ at: rec.updatedAt, receiptId: rec.receiptId, from, to: 'unknown', action: 'recover_unknown' });
            recovered.push(rec.receiptId);
          }
        }
        return { value: { ok: true, recovered } };
      });
    },
    async reconcile(receiptId, { eventId, to, evidence, now } = {}) {
      if (!['succeeded', 'failed'].includes(to)) return { ok: false, error: 'reconcile_only_terminal' };
      return this.apply(receiptId, { eventId, to, reason: 'reconciled', evidence, now });
    },
    EXEC_STATES
  };
}
