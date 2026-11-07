// 5.0-E5/G3：QQ 分享发送执行器（仅注入 sender，无真实网络）。
// share_now 不等于发送授权；每次发送独立验 HMAC、目标/内容绑定、暂停/频率/去重。
import crypto from 'node:crypto';

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
const fpOf = ({ target, text }) => `msg:${hash(`${target}|${textOf(text)}`).slice(0, 32)}`;

export async function sendShare({
  decision, shareId = '', target = '', text = '', authorization = null, authorizationService = null,
  sender = null, allowedTargets = [], paused = false, recentSends = [], now = Date.now(),
  minIntervalMs = 5 * 60e3, maxPerDay = 3
} = {}) {
  if (paused) return { ok: false, state: 'paused', reason: 'paused' };
  if (!decision || decision.decision !== 'share_now') return { ok: false, state: 'blocked', reason: 'not_share_now' };
  if (!sender || typeof sender.send !== 'function') return { ok: false, state: 'blocked', reason: 'no_sender' };
  if (!textOf(text) || !target) return { ok: false, state: 'blocked', reason: 'target_or_text_required' };
  if (Array.isArray(allowedTargets) && allowedTargets.length && !allowedTargets.includes(String(target))) return { ok: false, state: 'blocked', reason: 'target_not_whitelisted' };
  const fingerprint = fpOf({ target, text });
  if ((recentSends || []).some((s) => String(s.fingerprint || '') === fingerprint)) return { ok: false, state: 'duplicate', reason: 'recent_send_duplicate' };
  const recent = (recentSends || []).filter((s) => Number(now) - Date.parse(s.at || 0) <= 86400e3);
  if (recent.length >= maxPerDay) return { ok: false, state: 'rate_limited', reason: 'max_per_day' };
  if (recent.some((s) => Number(now) - Date.parse(s.at || 0) < minIntervalMs)) return { ok: false, state: 'rate_limited', reason: 'min_interval' };
  if (!authorization || !authorizationService) return { ok: false, state: 'blocked', reason: 'authorization_required' };
  const expected = { receiptId: String(shareId || ''), planHash: String(shareId || ''), actionType: 'qq.send', target: String(target), params: { text }, scope: 'send' };
  const v = authorizationService.verify(authorization, { expected });
  if (!v.ok) return { ok: false, state: 'blocked', reason: `authorization_${v.error}` };
  let outcome;
  try {
    outcome = await sender.send({ target, text, fingerprint, authorization: v.payload });
  } catch (e) {
    return { ok: false, state: 'unknown', reason: 'send_exception_unknown', fingerprint };
  }
  if (!outcome || outcome.unknown === true) return { ok: false, state: 'unknown', reason: 'send_result_unknown', fingerprint };
  if (outcome.ok === true) return { ok: true, state: 'sent', fingerprint, messageId: outcome.messageId || '' };
  if (outcome.sideEffect === 'none') return { ok: false, state: 'failed', reason: String(outcome.error || 'send_failed'), fingerprint };
  return { ok: false, state: 'unknown', reason: 'send_failure_side_effect_unknown', fingerprint };
}

export default sendShare;
