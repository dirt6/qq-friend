// 自主活动的持久状态。
//
// 存 data/autonomous.json —— 和项目里其它插件（silence-ping）同一套路子：
// 原子写（先写 .tmp 再 rename）、读失败就备份重建、不因为一个坏文件让机器人静默。
//
// 为什么要持久化：进程重启/电脑重启后，得知道自己上次醒到哪、看过什么、分享过什么。
// 不然每次重启都会把同一批排行榜内容当新发现，重复分享、重复写日记。

import fs from 'node:fs';
import path from 'node:path';
// 4.0 / 1.5.3：单写者。读-改-写整体进同一把跨进程锁（见 src/state-store.js）。
import { withState } from '../../../src/state-store.js';

const MAX_SEEN = 3000;        // 已读内容最多记这么多条，超了按最久没见到的淘汰
const MAX_HISTORY = 200;      // 单轮活动记录保留条数
const MAX_SHARES = 500;

export function emptyState() {
  return {
    version: 1,
    lastWakeAt: 0,
    nextWakeAt: 0,
    status: 'IDLE',
    currentGoal: '',
    currentTopic: '',
    deadlineAt: 0,
    modelCallsUsed: 0,
    itemsExamined: 0,
    lastStopReason: '',
    pendingNextStep: '',
    consecutiveFailures: 0,
    calibration: 1,
    calibrationSamples: [],
    sourceHealth: {},
    seen: {},
    shares: [],
    history: []
  };
}

/** 读状态；文件不存在 → 空状态；损坏 → 备份成 .broken-<时间戳> 再重建。 */
export function readState(file, { onWarn = () => {} } = {}) {
  const st = readStateInner(file, { onWarn });
  // 4.0 / 1.5.3 验收修：记一份"读的时候长什么样"，writeState 用它做字段级 diff。
  // 不这样做的话，后写的进程会用自己那份旧快照把别人刚改的标量覆盖掉
  // （2026-11-01 验收实测：面板写的 pendingNextStep 被自主活动覆盖成空）。
  try {
    Object.defineProperty(st, '__base', {
      value: JSON.stringify(st), enumerable: false, writable: true, configurable: true
    });
  } catch { /* 极端情况下降级为整体覆盖 */ }
  return st;
}

function readStateInner(file, { onWarn = () => {} } = {}) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') throw new Error('不是对象');
    const base = emptyState();
    return {
      ...base,
      ...j,
      seen: j.seen && typeof j.seen === 'object' ? j.seen : {},
      shares: Array.isArray(j.shares) ? j.shares : [],
      history: Array.isArray(j.history) ? j.history : [],
      sourceHealth: j.sourceHealth && typeof j.sourceHealth === 'object' ? j.sourceHealth : {},
      calibrationSamples: Array.isArray(j.calibrationSamples) ? j.calibrationSamples : []
    };
  } catch (e) {
    if (e?.code !== 'ENOENT') {
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* ignore */ }
      onWarn?.(`自主活动存档损坏，已备份重建：${e?.message ?? e}`);
    }
    return emptyState();
  }
}

/** 原子写：先写临时文件再 rename，避免断电/杀进程留下半截 JSON。 */
/**
 * 把状态落盘（4.0 / 1.5.3 起是**单写者**：锁内重新读、合并、原子替换）。
 *
 * 为什么不能直接写：调用方通常是这样用的 ——
 *   const st = readState(file);  // 锁外读快照
 *   st.xxx = ...;                 // 慢慢改
 *   writeState(file, st);         // 写回
 * 中间隔了可能几分钟（自主活动一轮 30 分钟窗口）。这期间面板/trim 脚本
 * 如果也写了这个文件，直接写回就会把它们吃掉。
 *
 * 所以这里在锁内重新读一次当前文件，把**增量字段**合并进去：
 *   seen  → 取并集（谁看过就算看过）
 *   history / shares → 按时间键合并去重（两边的记录都保留）
 *   其余标量 → 用本轮的值（lastWakeAt/status/selfWake 这类"当下状态"本来就该覆盖）
 */
export function writeState(file, state) {
  // 写入前做容量裁剪，别让存档无限长
  state.seen = trimSeen(state.seen);
  if (state.history.length > MAX_HISTORY) state.history = state.history.slice(-MAX_HISTORY);
  if (state.shares.length > MAX_SHARES) state.shares = state.shares.slice(-MAX_SHARES);

  const r = withState(file, (cur) => {
    const curV = Number(cur._v) || 0;
    const myV = Number(state._v) || 0;
    if (curV > myV) {
      // 期间有人写过 → **字段级合并**：只覆盖本轮真正改过的字段
      let base = null;
      try { base = state.__base ? JSON.parse(state.__base) : null; } catch { base = null; }
      const mergedSeen = { ...(cur.seen || {}), ...(state.seen || {}) };
      // 4.0 / 2.6-B5c：history 的身份标识用 roundId（旧记录没有就回退 startedAt）。
      // 用 startedAt 会有个真实问题：两轮并发的 startedAt 可能是同一毫秒 → 被当成同一条丢掉一个。
      const mergedHistory = mergeByKey(cur.history, state.history, (r) => r?.roundId || r?.startedAt);
      const mergedShares = mergeByKey(cur.shares, state.shares, 'at');

      if (base) {
        for (const k of Object.keys(state)) {
          if (k === '_v' || k === '_updatedAt' || k === '__base') continue;
          const now = JSON.stringify(state[k]);
          const was = JSON.stringify(base[k]);
          if (now === was) continue;      // 本轮没碰这个字段 → 保留锁内别人写的值
          cur[k] = state[k];
        }
      } else {
        // 没有基线（老调用方）→ 退回整体覆盖，并记一笔
        Object.assign(cur, state);
      }
      // 增量字段始终合并（这两个是"只增不减"的账）
      cur.seen = mergedSeen;
      cur.history = mergedHistory;
      cur.shares = mergedShares;
    } else {
      Object.assign(cur, state);
    }
  }, { fallback: state });

  if (!r.ok) throw new Error(r.error || '状态写入失败');
  // 版本号回写给调用方，后续写入的并发判断才有效
  state._v = r.state._v;
  state._updatedAt = r.state._updatedAt;
  return state;
}

/**
 * 合并两个数组（按 key 去重）。
 *
 * 4.0 / 2.6-B5c：key 支持**函数** —— 因为 history 的身份标识应该是 `roundId`，
 * 而不是 `startedAt`（两轮并发的 startedAt 可能是同一毫秒，会被误判成同一条）。
 *
 * **空 key 的处理策略：全部保留，不合并。**
 * 宁可重复，也不要把「没有身份标识的记录」当成同一条静默丢掉。
 *
 * @param {Array} a
 * @param {Array} b
 * @param {string|((item:any)=>any)} key 字段名或取 key 的函数
 */
function mergeByKey(a, b, key) {
  const keyOf = typeof key === "function" ? key : (item) => item?.[key];
  const list = [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const k = String(keyOf(item) ?? "");
    if (k && seen.has(k)) continue;   // 只有非空 key 才去重
    if (k) seen.add(k);
    out.push(item);                    // 空 key 一律保留（宁可重复，不静默丢）
  }
  return out;
}

/**
 * 锁内读-改-写（4.0 / 1.5.3）。短操作用它，不要自己 readState + writeState。
 *
 *   mutateState(file, (st) => { st.lastWakeAt = Date.now(); });
 */
export function mutateState(file, fn, { fallback } = {}) {
  const r = withState(file, (st) => { fn(st); }, { fallback: fallback || emptyState() });
  if (!r.ok) throw new Error(r.error || '状态修改失败');
  return r.state;
}

/**
 * 删除 history 中的一轮（D1-3b B2）。
 *
 * 唯一领域入口：锁内重新读取最新状态 → 过滤 → 原子写回。
 * 并发新增/删除不会丢更新（withState 串行化读改写）。
 *
 * @returns {{ok:boolean, removed?:number, error?:string}}
 */
export function deleteHistoryRound(file, roundId) {
  const id = String(roundId || '').trim();
  if (!id) return { ok: false, error: 'roundId 不能为空' };
  let removed = 0;
  mutateState(file, (st) => {
    const hist = Array.isArray(st.history) ? st.history : [];
    const next = hist.filter((h) => String(h.roundId || '') !== id);
    removed = hist.length - next.length;
    if (removed > 0) st.history = next;
  });
  if (removed === 0) return { ok: false, error: '没这条记录（可能已被删除）' };
  return { ok: true, removed };
}

/** seen 超过上限时，丢掉「最久没再见到」的那些。 */
function trimSeen(seen) {
  const keys = Object.keys(seen || {});
  if (keys.length <= MAX_SEEN) return seen || {};
  const sorted = keys.sort((a, b) => (Number(seen[a]?.lastSeenAt) || 0) - (Number(seen[b]?.lastSeenAt) || 0));
  const drop = new Set(sorted.slice(0, keys.length - MAX_SEEN));
  const out = {};
  for (const k of keys) if (!drop.has(k)) out[k] = seen[k];
  return out;
}

/** 归一化去重键（由 sources.contentKeyOf 生成，这里只做兜底清洗）。 */
export function isSeen(state, key) {
  return Boolean(key && state?.seen?.[key]);
}

export function markSeen(state, key, item, now = Date.now()) {
  if (!key) return state;
  const prev = state.seen[key];
  state.seen[key] = {
    title: String(item?.title ?? '').slice(0, 120),
    source: String(item?.source ?? ''),
    url: String(item?.url ?? ''),
    firstSeenAt: prev?.firstSeenAt || now,
    lastSeenAt: now,
    shared: Boolean(prev?.shared)
  };
  return state;
}

export function markShared(state, key, item, now = Date.now()) {
  if (key && state.seen[key]) state.seen[key].shared = true;
  state.shares.push({
    url: String(item?.url ?? ''),
    title: String(item?.title ?? '').slice(0, 120),
    at: now,
    status: String(item?.status ?? 'sent')
  });
  return state;
}

export function pushHistory(state, record) {
  state.history.push(record);
  return state;
}

export function recordSourceHealth(state, sourceId, { ok, error = '' } = {}, now = Date.now()) {
  if (!state.sourceHealth[sourceId]) state.sourceHealth[sourceId] = {};
  const h = state.sourceHealth[sourceId];
  if (ok) {
    h.lastSuccessAt = now;
    h.lastError = '';
  } else {
    h.lastErrorAt = now;
    h.lastError = String(error).slice(0, 200);
  }
  return state;
}
