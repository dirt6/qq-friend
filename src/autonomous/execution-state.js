// 5.0-E1：执行状态机（纯逻辑）。
// unknown 只能显式对账，不得自动变 failed/succeeded。
export const EXEC_STATES = Object.freeze([
  'decision_recorded', 'authorization_pending', 'authorized', 'started',
  'succeeded', 'failed', 'unknown', 'cancelled'
]);
const NEXT = {
  decision_recorded: ['authorization_pending', 'authorized', 'cancelled'],
  authorization_pending: ['authorized', 'cancelled'],
  authorized: ['started', 'cancelled'],
  started: ['succeeded', 'failed', 'unknown'],
  unknown: ['succeeded', 'failed'],
  failed: ['authorization_pending', 'cancelled'],
  succeeded: [],
  cancelled: []
};
const TERMINAL = new Set(['succeeded', 'cancelled']);

export function canTransition(from, to, { reason = '', evidence = '', attempts = 0, maxRetries = 1 } = {}) {
  if (!EXEC_STATES.includes(from) || !EXEC_STATES.includes(to)) return { ok: false, error: 'unknown_state' };
  if (!NEXT[from]?.includes(to)) return { ok: false, error: `illegal_transition:${from}->${to}` };
  if (from === 'unknown' && !(reason === 'reconciled' && String(evidence).trim())) {
    return { ok: false, error: 'unknown_requires_explicit_reconciliation' };
  }
  if (from === 'failed' && to === 'authorization_pending') {
    if (Number(attempts) >= Number(maxRetries)) return { ok: false, error: 'retry_limit' };
    if (reason !== 'retry_authorized') return { ok: false, error: 'retry_requires_authorization' };
  }
  return { ok: true };
}

export function isTerminal(state) { return TERMINAL.has(state); }
export default canTransition;
