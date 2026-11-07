// 5.0-E5/P0：授权完整性（HMAC-SHA256）。
// 密钥由组合根/环境提供；无默认密钥、不写日志、不由模型/参数控制。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export function createAuthorizationService({ keys, keyId, now = () => Date.now(), nonceFile = '', revoked = [] } = {}) {
  if (!keys || typeof keys !== 'object') throw new Error('authorization 需要 keys');
  const keyMap = new Map(Object.entries(keys).map(([k, v]) => [String(k), String(v)]));
  if (!keyId || !keyMap.get(String(keyId))) throw new Error('authorization 需要有效 keyId');
  if ([...keyMap.values()].some((k) => k.length < 32)) throw new Error('authorization key 至少 32 字符');
  const used = new Set();
  const revokedSet = new Set((revoked || []).map(String));
  if (nonceFile && fs.existsSync(nonceFile)) {
    try {
      const j = JSON.parse(fs.readFileSync(nonceFile, 'utf8'));
      for (const n of j.used || []) used.add(String(n));
      for (const n of j.revoked || []) revokedSet.add(String(n));
    } catch { /* corrupt ledger → fail closed on consume? keep empty is unsafe; throw */ throw new Error('authorization nonce ledger corrupt'); }
  }
  function persist() {
    if (!nonceFile) return;
    fs.mkdirSync(path.dirname(nonceFile), { recursive: true });
    const tmp = `${nonceFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ used: [...used], revoked: [...revokedSet] }, null, 1), 'utf8');
    fs.renameSync(tmp, nonceFile);
  }
  const signPayload = (payload, kid) => crypto.createHmac('sha256', keyMap.get(String(kid))).update(canonical(payload)).digest('base64url');
  return {
    sign({ receiptId, planHash, actionType, target, params = {}, authorizedBy, expiresAt, nonce, issuedAt, scope = 'execute' } = {}) {
      const payload = {
        v: 1, receiptId: String(receiptId || ''), planHash: String(planHash || ''),
        actionType: String(actionType || ''), target: String(target || ''),
        paramsHash: crypto.createHash('sha256').update(canonical(params)).digest('hex'),
        params: params || {}, authorizedBy: String(authorizedBy || ''), scope: String(scope),
        issuedAt: String(issuedAt || new Date(now()).toISOString()),
        expiresAt: String(expiresAt || ''), nonce: String(nonce || '')
      };
      if (!payload.receiptId || !payload.planHash || !payload.actionType || !payload.authorizedBy || !payload.expiresAt || !payload.nonce) throw new Error('authorization payload incomplete');
      if (!Number.isFinite(Date.parse(payload.expiresAt))) throw new Error('authorization expiresAt invalid');
      const kid = String(keyId);
      return { keyId: kid, payload, sig: signPayload(payload, kid) };
    },
    verify(token, { expected = {}, consume = true } = {}) {
      if (!token || !token.payload || !token.sig) return { ok: false, error: 'token_missing' };
      const p = token.payload;
      const kid = String(token.keyId || '');
      if (!keyMap.has(kid)) return { ok: false, error: 'unknown_key' };
      const want = signPayload(p, kid);
      const a = Buffer.from(String(token.sig)); const b = Buffer.from(want);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'signature_invalid' };
      if (revokedSet.has(String(p.nonce))) return { ok: false, error: 'revoked' };
      if (used.has(String(p.nonce))) return { ok: false, error: 'replayed' };
      const at = now();
      const exp = Date.parse(p.expiresAt); const issued = Date.parse(p.issuedAt);
      if (!Number.isFinite(exp) || exp < at) return { ok: false, error: 'expired' };
      if (!Number.isFinite(issued) || issued > at + 60_000) return { ok: false, error: 'not_yet_valid' };
      for (const k of ['receiptId', 'planHash', 'actionType', 'target', 'scope']) {
        if (expected[k] !== undefined && String(p[k]) !== String(expected[k])) return { ok: false, error: `binding_mismatch:${k}` };
      }
      if (expected.params !== undefined) {
        const h = crypto.createHash('sha256').update(canonical(expected.params || {})).digest('hex');
        if (h !== p.paramsHash) return { ok: false, error: 'binding_mismatch:params' };
      }
      if (consume) { used.add(String(p.nonce)); persist(); }
      return { ok: true, payload: p };
    },
    revoke(nonce) { revokedSet.add(String(nonce)); persist(); return { ok: true }; },
    revokeToken(token) { return this.revoke(token?.payload?.nonce || ''); },
    usedCount() { return used.size; }
  };
}

export default createAuthorizationService;
