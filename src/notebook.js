// 小鲸鱼的私人本子：只允许固定路径，不进面板、不进记忆 Hub。
import fs from 'node:fs';
import path from 'node:path';

export const NOTEBOOK_FILE = 'E:/dsh/本子/小鲸鱼的本子.md';
const MAX = 12000;

export function notebookPath(file = NOTEBOOK_FILE) {
  return path.resolve(String(file));
}

export function readNotebook({ file = NOTEBOOK_FILE, chars = 3000 } = {}) {
  const p = notebookPath(file);
  try {
    const text = fs.readFileSync(p, 'utf8');
    return { ok: true, text: text.slice(-Math.max(200, Math.min(MAX, chars))), file: p };
  } catch (e) {
    return { ok: false, error: `读不到本子：${String(e?.message || e)}`, file: p };
  }
}

export function appendNotebook({ text, title = '', file = NOTEBOOK_FILE } = {}) {
  const body = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!body) return { ok: false, error: '内容不能为空' };
  if (body.length > 3000) return { ok: false, error: '单次最多 3000 字' };
  const p = notebookPath(file);
  const head = String(title || '').trim().slice(0, 80);
  const entry = `\n## ${head || '随手记'} · ${new Date().toISOString()}\n\n${body}\n`;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, entry, 'utf8');
    return { ok: true, file: p, chars: body.length };
  } catch (e) {
    return { ok: false, error: `写不进本子：${String(e?.message || e)}` };
  }
}

/** 本子的删除备份目录（只备份，不自动清理）。 */
export const NOTEBOOK_TRASH = 'E:/dsh/本子/.trash-notebook';

function readFull(file) {
  const p = notebookPath(file);
  return { p, text: fs.readFileSync(p, 'utf8') };
}

function writeAtomic(p, text) {
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, p);
}

function occurrences(full, needle) {
  const out = [];
  let i = full.indexOf(needle);
  while (i >= 0) { out.push(i); i = full.indexOf(needle, i + needle.length); }
  return out;
}

/** 定位包含 pos 的条目块（`## ` 开头到下一个 `## `）；标题区返回 start=-1。 */
function entryRange(full, pos) {
  const re = /^## .*$/gm;
  let start = -1;
  let m;
  while ((m = re.exec(full))) {
    if (m.index <= pos) start = m.index;
    else return { start, end: m.index };
  }
  return { start, end: full.length };
}

/**
 * 改本子里的一段：match 必须唯一命中，否则拒绝（不猜她指哪段）。
 * @returns {{ok:boolean, file?:string, before?:string, after?:string, error?:string}}
 */
export function editNotebook({ match, text, file = NOTEBOOK_FILE } = {}) {
  const m = String(match ?? '').trim();
  const body = String(text ?? '').trim();
  if (!m) return { ok: false, error: 'match 不能为空' };
  if (!body) return { ok: false, error: '新内容不能为空' };
  if (body.length > 3000) return { ok: false, error: '单次最多 3000 字' };
  let full;
  let p;
  try { ({ p, text: full } = readFull(file)); } catch (e) { return { ok: false, error: `读不到本子：${String(e?.message || e)}` }; }
  const hits = occurrences(full, m);
  if (!hits.length) return { ok: false, error: '找不到这段内容' };
  if (hits.length > 1) return { ok: false, error: `匹配到 ${hits.length} 处，请给更精确的片段` };
  const next = full.slice(0, hits[0]) + body + full.slice(hits[0] + m.length);
  try { writeAtomic(p, next); } catch (e) { return { ok: false, error: `写不进本子：${String(e?.message || e)}` }; }
  return { ok: true, file: p, before: m.slice(0, 120), after: body.slice(0, 120) };
}

/**
 * 删本子里的一整条（包含 match 的 `## ` 条目）：唯一命中才删。
 * 2026-11-05 机主：默认不备份（备份不必）。需要备份时显式传 backupDir。
 */
export function deleteNotebook({ match, file = NOTEBOOK_FILE, backupDir = '', now = Date.now() } = {}) {
  const m = String(match ?? '').trim();
  if (!m) return { ok: false, error: 'match 不能为空' };
  let full;
  let p;
  try { ({ p, text: full } = readFull(file)); } catch (e) { return { ok: false, error: `读不到本子：${String(e?.message || e)}` }; }
  const hits = occurrences(full, m);
  if (!hits.length) return { ok: false, error: '找不到这段内容' };
  if (hits.length > 1) return { ok: false, error: `匹配到 ${hits.length} 处，请给更精确的片段` };
  const { start, end } = entryRange(full, hits[0]);
  if (start < 0) return { ok: false, error: '只能删条目，不能删本子标题' };
  let backup = '';
  if (backupDir) {
    try {
      const dir = path.resolve(backupDir);
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
      backup = path.join(dir, `${stamp}.md`);
      fs.writeFileSync(backup, full, 'utf8');
    } catch (e) {
      return { ok: false, error: `备份失败，未删除：${String(e?.message || e)}` };
    }
  }
  const removed = full.slice(start, end);
  let next = full.slice(0, start) + full.slice(end);
  next = next.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n');
  try { writeAtomic(p, next); } catch (e) { return { ok: false, error: `写不进本子：${String(e?.message || e)}` }; }
  return { ok: true, file: p, backup, removed: removed.trim().slice(0, 200) };
}
