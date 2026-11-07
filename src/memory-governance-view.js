// R9：记忆治理只读视图（不写、不删、不改状态）。
//
// 目的：让“经验/待办现在是什么状态、哪些被纠正过、来源是哪天”一眼可见，
// 具体修改仍走已有的 /api/learned/* 写入口（带确认与审计）。
const statusOf = (x) => String(x?.status || 'unknown');
const atOf = (x) => String(x?.updatedAt || x?.createdAt || x?.at || '');

export function buildGovernanceView({ learned = [], pending = [], hubStats = null, now = Date.now(), recentLimit = 8 } = {}) {
  const byStatus = {};
  const sourceDays = new Set();
  let corrections = 0;
  const changed = [];

  for (const it of learned) {
    const st = statusOf(it);
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (Number(it?.correction?.count) > 0 || Number(it?.corrections) > 0) corrections += 1;
    if (it?.sourceDay) sourceDays.add(String(it.sourceDay));
    changed.push({ id: String(it?.id || ''), status: st, at: atOf(it), sourceDay: String(it?.sourceDay || '') });
  }
  changed.sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));

  const pendingByStatus = {};
  let expired = 0;
  for (const p of pending) {
    const st = statusOf(p);
    pendingByStatus[st] = (pendingByStatus[st] || 0) + 1;
    if (st === 'expired') expired += 1;
    const exp = Date.parse(String(p?.expiresAt || ''));
    if (st !== 'expired' && Number.isFinite(exp) && exp < now) expired += 1;
  }

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    learned: {
      total: learned.length,
      byStatus,
      corrections,
      sourceDays: sourceDays.size,
      recent: changed.slice(0, Math.max(1, Number(recentLimit) || 8))
    },
    pending: {
      total: pending.length,
      byStatus: pendingByStatus,
      expired
    },
    hub: hubStats || null
  };
}

export default buildGovernanceView;
