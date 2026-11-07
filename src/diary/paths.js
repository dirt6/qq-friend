// 日记路径契约（D1-2c-2a）。
//
// 统一区分两种路径：
//   · diaryRoot —— 日记根目录（如 E:\dsh\本子\日记）
//   · dayFile   —— 某一天的正文绝对路径（<diaryRoot>/每日/YYYY-MM-DD.md）
//
// 所有拼路径都必须经过这里，writer / meta / 测试不在各自模块里重复推导。
import path from 'node:path';

/** 日记根下的「每日」目录。 */
export function dailyDirOf(diaryRoot) {
  return path.join(String(diaryRoot), '每日');
}

/** 日记根 + 日期 → 当天正文绝对路径（唯一拼路径入口）。 */
export function dayFileOf(diaryRoot, dateKey) {
  return path.join(dailyDirOf(diaryRoot), `${String(dateKey)}.md`);
}

/** 「每日」目录 + 日期 → 当天正文路径（writer 的 root 语义）。 */
export function dayFileIn(dayDir, dateKey) {
  return path.join(String(dayDir), `${String(dateKey)}.md`);
}

/** 从「每日」目录反推日记根（writer 的 root → diaryRoot）。 */
export function diaryRootFromDayDir(dayDir) {
  return path.dirname(String(dayDir));
}
