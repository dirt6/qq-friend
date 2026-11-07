// 5.0 空闲目标循环账本（运行记录，不是记忆）。
//
// 只记录“这一轮醒来做了什么”，用于：
//   · 下一轮 think 的上下文（最近进展）；
//   · A3 activity 的 6h 冷却去重（recentActions）；
//   · 面板/接口观察真实运行。
// 不写 Memory Hub、不写日记、不是第二套记忆；损坏时安全降级为空账本。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const IDLE_GOAL_LOG_FILE = process.env.IDLE_GOAL_LOG_FILE || path.join(DATA_DIR, '5.0-goal-cycle.json');
const MAX_ENTRIES = 300;

function empty() { return { version: 1, entries: [] }; }

export function createIdleGoalLog({ file = IDLE_GOAL_LOG_FILE, now = () => Date.now(), max = MAX_ENTRIES } = {}) {
  const target = path.resolve(file);
  let state = empty();
  let healthy = true;
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf8'));
    if (raw && Array.isArray(raw.entries)) state = { version: 1, entries: raw.entries };
    else healthy = false;
  } catch (e) {
    // 文件不存在是正常的首次运行；解析失败/读失败标记不健康（不影响空闲继续跑）。
    if (e?.code !== 'ENOENT') healthy = false;
  }

  function save() {
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      state.entries = state.entries.slice(-max);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
      fs.renameSync(tmp, target);
      healthy = true;
    } catch { healthy = false; /* 写不了就只在内存里记，绝不影响表达 */ }
  }

  /**
   * 追加一条运行记录。
   * @param {{type?:string,title?:string,goalId?:string,pendingId?:string,action?:string,ok?:boolean,reason?:string,summary?:string,at?:number}} rec
   */
  function append(rec = {}) {
    const at = Number.isFinite(Number(rec.at)) ? Number(rec.at) : now();
    const entry = {
      at,
      type: String(rec.type || ''),
      title: String(rec.title || '').slice(0, 120),
      goalId: String(rec.goalId || ''),
      pendingId: String(rec.pendingId || ''),
      action: String(rec.action || ''),
      ok: rec.ok === true,
      // done=真的推进/执行了；sleep/none 允许但不推进，不参与 6h 冷却。
      done: rec.done === undefined ? rec.ok === true : rec.done === true,
      reason: String(rec.reason || '').slice(0, 200),
      summary: String(rec.summary || '').slice(0, 400),
      // R8-C 计划拆解：本轮结束后打算的下一步，下一轮 prompt 会带回来。
      next: String(rec.next || '').slice(0, 200)
    };
    state.entries.push(entry);
    save();
    return entry;
  }

  function recent({ limit = 10 } = {}) {
    const n = Math.max(1, Number(limit) || 10);
    return state.entries.slice(-n);
  }

  function last() { return state.entries.length ? state.entries[state.entries.length - 1] : null; }

  /** A3 需要的形状：{goalId,pendingId,target,result,at}。 */
  function recentActions({ limit = 30 } = {}) {
    return recent({ limit }).map((e) => ({
      goalId: e.goalId || undefined,
      pendingId: e.pendingId || undefined,
      target: e.title || undefined,
      result: e.ok && e.done !== false ? 'success' : 'failed',
      at: e.at
    }));
  }

  function status() {
    return { file: target, healthy, entries: state.entries.length, last: last() };
  }

  return { append, recent, recentActions, last, status };
}

export default createIdleGoalLog;
