// 日记 Markdown 解析（共享纯函数，5.0 星图 P0）。
//
// 为什么单独抽出来：
//   `/api/diary` 里原来内嵌一份正则，星图再做一份就会出现「面板看得见、星图看不见」。
//   这里只做「文本 → {day,title,entries}」的纯解析，不读配置、不碰写盘。
//   读目录也放这里，保证路由与星图用同一个文件名口径。
//
// 格式（与 skills/diary、diary/writer 逐字一致）：
//   # 2026-11-04 周三
//   - 心情：踏实｜软件修好之后……
//   - 心情：平静｜[重要] 今天有件事
import fs from 'node:fs';
import path from 'node:path';

/** 一条日记（只认这个前缀；`[重要]` 在正文前）。 */
export const ENTRY_RE = /^-\s*心情：([^｜]+)｜(.*)$/;
/** 日文件名（星图与路由共用）。 */
export const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * 解析一天的日记文本。
 *
 * @param {string} text Markdown 原文
 * @param {string} day  YYYY-MM-DD
 * @returns {{day:string, title:string, entries:Array<{mood:string,text:string,important:boolean,importance:string}>}}
 */
export function parseDiaryText(text, day) {
  const lines = String(text ?? '').split(/\r?\n/);
  const title = (lines[0] || '').replace(/^#\s*/, '').trim();
  const entries = [];
  for (const line of lines.slice(1)) {
    const m = ENTRY_RE.exec(line.trim());
    if (!m) continue;
    const raw = m[2].trim();
    const im = /^\[([^\]]+)\]\s*/.exec(raw);
    entries.push({
      mood: m[1].trim().slice(0, 12),
      // 完整正文留给星图算哈希；/api/diary 输出时自行截断，保持旧契约。
      text: raw.replace(/^\[([^\]]+)\]\s*/, ''),
      important: Boolean(im && /重要/.test(im[1])),
      importance: im ? im[1] : '一般'
    });
  }
  return { day, title, entries };
}

/**
 * 读 `<dir>/YYYY-MM-DD.md`，按日期**升序**返回。
 * 目录不存在不是异常：返回 ok:false + 空数组，由调用方决定文案。
 *
 * @param {object} o
 * @param {string} o.dir   `每日` 目录
 * @param {number} [o.limit] 只要最近 N 天（0 = 全部）
 * @returns {{ok:boolean, days:Array, dir:string, error?:string}}
 */
export function readDiaryFiles({ dir, limit = 0 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => DAY_FILE_RE.test(f));
  } catch {
    return { ok: false, days: [], dir, error: `日记目录还不存在：${dir}` };
  }
  files.sort();
  const picked = limit > 0 ? files.slice(-limit) : files;
  const days = [];
  for (const f of picked) {
    const day = f.slice(0, -3);
    let text = '';
    try { text = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
    days.push(parseDiaryText(text, day));
  }
  return { ok: true, days, dir };
}
