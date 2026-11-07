// 5.0 空闲定时器：每 3 小时开一个 30 分钟窗口，窗口内跑注册活动。
// 静默时段（00:00–08:00）不再强制只睡：她可以睡，也可以做不打扰人的事
// （写日记/本子、整理、只看不发的浏览）；公开动作仍由 idle-actions 的静默拦截。
import { IDLE_ACTIVITIES, runIdleActivity } from './idle-activities.js';
import { readSelfWake, consumeSelfWake } from './idle-wake.js';

const QUIET_END_HOUR = 8;

export function createIdleScheduler({
  enabled = false,
  intervalMs = 3 * 3600e3,
  windowMs = 30 * 60e3,
  activities = ['think'],
  dailyTimes = ['11:00', '23:00'],
  runner = runIdleActivity,
  log = () => {},
  now = () => Date.now()
} = {}) {
  const state = { enabled: enabled === true, running: false, lastStartedAt: null, lastFinishedAt: null, nextAt: null, last: null, timer: null, selfWake: null, dailyDay: '' };
  const allowed = new Set(IDLE_ACTIVITIES.map((x) => x.id));

  async function runOnce({ activities: override = null } = {}) {
    if (!state.enabled || state.running) return { ok: false, reason: state.running ? 'already_running' : 'disabled' };
    state.running = true;
    state.lastStartedAt = now();
    const started = state.lastStartedAt;
    const results = [];
    try {
      const hour = new Date(now()).getHours();
      const quiet = hour < QUIET_END_HOUR;
      // sleep 由 think 自己选；只有显式只注册 sleep 时才直接睡。
      const list = (override || activities).filter((x) => x !== 'sleep');
      const runnable = list.length ? list : ['sleep'];
      for (const id of runnable) {
        if (!allowed.has(id)) { results.push({ activity: id, ok: false, error: 'not_allowed' }); continue; }
        if (now() - started > windowMs) break;
        try {
          const r = await runner(id, { quiet });
          results.push({ ...r, activity: id, quiet });
        } catch (e) {
          results.push({ activity: id, ok: false, error: String(e?.message || e), quiet });
        }
      }
      state.last = { at: new Date(now()).toISOString(), quiet, results };
      log(`[idle] 窗口结束${quiet ? '（静默）' : ''}：${results.length} 个活动，成功 ${results.filter((x) => x.ok).length}`);
      return { ok: true, quiet, results };
    } finally {
      state.running = false;
      state.lastFinishedAt = now();
      state.nextAt = state.lastFinishedAt + intervalMs;
    }
  }

  function start() {
    if (!state.enabled || state.timer) return status();
    state.nextAt = now() + intervalMs;
    const tick = () => {
      const t = now();
      const w = readSelfWake(t);
      state.selfWake = w || null;
      if (state.running) return;
      // 每天 11:00 / 23:00：自动做一次「记录检查」（有要写的就写日记/本子）。
      const d = new Date(t);
      const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const dayKey = d.toLocaleDateString('en-CA');
      if (dailyTimes.includes(hhmm) && state.dailyDay !== dayKey) {
        state.dailyDay = dayKey;
        log(`[idle] 每日记录检查（${hhmm}）`);
        runOnce({ activities: ['daily_review'] }).catch((e) => log(`[idle] 记录检查异常：${e?.message || e}`));
        return;
      }
      if (w?.due) { consumeSelfWake(t); runOnce().catch((e) => log(`[idle] 自主醒来异常：${e?.message || e}`)); return; }
      if (t >= state.nextAt) runOnce().catch((e) => log(`[idle] 异常：${e?.message || e}`));
    };
    state.timer = setInterval(tick, 60e3);
    state.timer.unref?.();
    log(`[idle] 已启动：每 ${Math.round(intervalMs / 60000)} 分钟一次，窗口 ${Math.round(windowMs / 60000)} 分钟`);
    return status();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.enabled = false;
    return status();
  }

  function status() {
    return {
      enabled: state.enabled,
      running: state.running,
      intervalMinutes: Math.round(intervalMs / 60000),
      windowMinutes: Math.round(windowMs / 60000),
      activities: [...activities],
      quietHours: `00:00–0${QUIET_END_HOUR}:00`,
      lastStartedAt: state.lastStartedAt ? new Date(state.lastStartedAt).toISOString() : null,
      lastFinishedAt: state.lastFinishedAt ? new Date(state.lastFinishedAt).toISOString() : null,
      nextAt: state.nextAt ? new Date(state.nextAt).toISOString() : null,
      last: state.last,
      selfWake: state.selfWake
    };
  }

  return { runOnce, start, stop, status };
}
