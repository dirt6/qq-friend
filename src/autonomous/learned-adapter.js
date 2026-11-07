// 5.0-G2：learned 领域真实适配器。
// 只包装 src/learned.js；不直接写文件、不另建记忆库。
// 规则：幂等键优先；用户明确纠正/用户原话优先；版本不一致不覆盖。
import {
  listAll as defaultListAll,
  addExperience as defaultAddExperience,
  similarity as defaultSimilarity
} from '../learned.js';

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const asTime = (v, now) => {
  const n = typeof v === 'number' ? v : Date.parse(String(v || ''));
  return Number.isFinite(n) ? n : now;
};

export function createLearnedAdapter({
  listAll = defaultListAll,
  addExperience = defaultAddExperience,
  similarity = defaultSimilarity,
  now = () => Date.now()
} = {}) {
  if (typeof listAll !== 'function' || typeof addExperience !== 'function') throw new Error('learned adapter 需要 listAll/addExperience');

  function items() {
    const r = listAll({});
    return Array.isArray(r) ? r : (Array.isArray(r?.items) ? r.items : []);
  }

  async function upsert(payload = {}) {
    const content = textOf(payload.content);
    if (content.length < 4) return { ok: false, sideEffect: 'none', error: 'content_too_short' };
    const idem = textOf(payload.idempotencyKey);
    if (!idem) return { ok: false, sideEffect: 'none', error: 'idempotency_key_required' };
    const all = items();

    // 1) 同一 action 重放：直接返回，不新增/不合并。
    const existing = all.find((x) => textOf(x?.origin?.ref) === idem);
    if (existing) return { ok: true, duplicate: true, id: existing.id, item: existing };

    // 2) 版本冲突：有 expectedVersion 时必须匹配目标条目。
    if (payload.expectedVersion !== undefined && payload.expectedVersion !== null) {
      const target = payload.id ? all.find((x) => String(x.id) === String(payload.id)) : null;
      if (!target) return { ok: false, sideEffect: 'none', error: 'version_target_missing' };
      if (String(target.updatedAt || '') !== String(payload.expectedVersion)) {
        return { ok: false, sideEffect: 'none', error: 'version_conflict' };
      }
    }

    // 3) 用户明确纠正/用户原话优先：近似条目不能被自主推断覆盖。
    const userOwned = all.find((x) => x.status !== 'archived'
      && textOf(x?.origin?.kind) === 'user_stated'
      && Number(similarity(content, String(x.text || ''))) >= 0.28);
    if (userOwned) return { ok: false, sideEffect: 'none', error: 'user_correction_wins', targetId: userOwned.id };

    const at = asTime(payload.at, now());
    const origin = {
      kind: 'autonomous',
      ref: idem,
      at: new Date(at).toISOString(),
      quote: textOf(payload.source || '')
    };
    const r = addExperience({
      text: content,
      tags: ['autonomous'],
      now: at,
      contentType: ['fact', 'preference', 'event', 'plan', 'other'].includes(payload.contentType) ? payload.contentType : 'other',
      epistemicType: ['direct', 'inferred', 'unknown'].includes(payload.epistemicType) ? payload.epistemicType : 'unknown',
      origin
    });
    if (!r?.ok) return { ok: false, sideEffect: 'none', error: String(r?.reason || 'learned_write_failed') };
    const item = items().find((x) => String(x.id) === String(r.id)) || null;
    return { ok: true, duplicate: false, merged: r.merged === true, id: r.id, item };
  }

  function readById(id) {
    return items().find((x) => String(x.id) === String(id)) || null;
  }

  function list() {
    return items();
  }

  return { upsert, readById, list };
}

export default createLearnedAdapter;
