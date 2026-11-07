// 5.0-E5/G2：受控记忆写入执行器（仅注入领域适配器，无文件/网络）。
// D 负责治理/路由；本模块只把已接受的 intent 交给对应领域 adapter。
// 写入失败/抛错一律 unknown（不能证明未写入），不自动重试。
const DOMAIN_METHODS = {
  learned: { write: 'upsert' },
  diary: { write: 'write' },
  memory: { write: 'upsert' },
  companion: { write: null }
};

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const nowIso = (now) => new Date(now ?? Date.now()).toISOString();

function idemKey(intent, receiptId) {
  return `mem:${receiptId}:${intent.domain}:${intent.id || intent.intentId || 'intent'}`;
}

export function createMemoryWriter({ adapters, journal = null, now = () => Date.now() } = {}) {
  if (!adapters || typeof adapters !== 'object') throw new Error('memory writer 需要领域 adapters');
  const inflight = new Map();
  const done = new Set();

  async function writeOne(intent, { receiptId, accepted }) {
    if (!intent || typeof intent !== 'object') return { intentId: '', state: 'rejected', reason: 'malformed_intent' };
    const id = String(intent.id || intent.intentId || '');
    if (accepted && accepted.requiresConfirmation) return { intentId: id, state: 'needs_confirmation', reason: 'confirmation_required' };
    if (!accepted || accepted.status !== 'accepted') return { intentId: id, state: 'skipped', reason: 'not_accepted' };
    if (accepted.requiresConfirmation) return { intentId: id, state: 'needs_confirmation', reason: 'confirmation_required' };
    const domain = String(intent.domain || '');
    if (!DOMAIN_METHODS[domain]) return { intentId: id, state: 'rejected', reason: 'domain_not_allowed' };
    if (domain === 'companion') {
      // 领域函数由适配器按 kind/op 暴露；不直接写文件。
      if (intent.op === 'expire') return { intentId: id, state: 'skipped', reason: 'lifecycle_domain_owned' };
      if (!adapters.companion || typeof adapters.companion.apply !== 'function') return { intentId: id, state: 'rejected', reason: 'adapter_missing' };
    } else if (!adapters[domain] || typeof adapters[domain][DOMAIN_METHODS[domain].write] !== 'function') {
      return { intentId: id, state: 'rejected', reason: 'adapter_missing' };
    }
    const key = idemKey(intent, receiptId);
    if (done.has(key) || (journal && journal.has && journal.has(key))) return { intentId: id, state: 'duplicate', idempotencyKey: key };
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const payload = {
          id, content: textOf(intent.content), source: textOf(intent.source), owner: String(intent.owner || ''),
          epistemicType: String(intent.epistemicType || ''), evidence: intent.evidence || [], at: intent.at || nowIso(now()),
          receiptId, idempotencyKey: key, expectedVersion: intent.expectedVersion
        };
        let r;
        if (domain === 'companion') r = await adapters.companion.apply({ ...payload, op: intent.op, kind: intent.kind });
        else r = await adapters[domain][DOMAIN_METHODS[domain].write](payload);
        if (r && r.ok === false) {
          if (r.sideEffect === 'none') return { intentId: id, state: 'failed', reason: String(r.error || 'write_failed'), idempotencyKey: key };
          return { intentId: id, state: 'unknown', reason: String(r.error || 'write_outcome_unknown'), idempotencyKey: key };
        }
        done.add(key);
        if (journal && journal.add) journal.add(key);
        return { intentId: id, state: 'succeeded', domain, idempotencyKey: key };
      } catch (e) {
        // 抛错无法证明领域未写入 → unknown；不重试。
        return { intentId: id, state: 'unknown', reason: String(e?.message || e), idempotencyKey: key };
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  async function execute({ intents = [], accepted = [], receiptId } = {}) {
    if (!receiptId) return { ok: false, error: 'receiptId_required' };
    const byId = new Map(accepted.map((a) => [String(a.intentId || ''), a]));
    const results = [];
    for (const intent of intents) {
      const a = byId.get(String(intent.id || intent.intentId || '')) || null;
      results.push(await writeOne(intent, { receiptId, accepted: a }));
    }
    return { ok: true, results, written: results.filter((r) => r.state === 'succeeded').length, unknown: results.filter((r) => r.state === 'unknown').length };
  }
  return { execute };
}

export default createMemoryWriter;
