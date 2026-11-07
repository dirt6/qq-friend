// 日记统一写入口（4.0 · 1.5.1 · 决策 D3）。
//
// ── 目标（机主 2026-11-01 定）──────────────────────────────────────
// 让所有模块通过同一个可靠入口写日记。**不改变她写什么、什么时候写、怎么分级。**
// 原有的 Markdown 格式、三级重要度、心情字段、「记住了」经验同步，一个字都不动。
//
// ── 写入顺序（顺序本身就是契约）────────────────────────────────────
//   检查幂等键 → 写日记 → 确认写入成功 → 发布事件 → 返回真实结果
//
//   · 日记写失败：不发成功事件，返回 ok:false；
//   · 事件发失败：不回滚已经成功的日记（事件只是账，不是真相）；
//   · 先写盘再发事件 —— 反过来的话，事件说写了但日记没写成，重放时会重复写。
//
// ── 幂等（跨进程、跨重启）──────────────────────────────────────────
// `data/diary-idempotency.json` 存每个 key 的状态：
//   pending（已开始写）/ done（确认成功）
// 崩溃在「写完但没标 done」之间时，重启后按内容 hash 回查当天日记：
// 找得到 → 标 done，不重写；找不到 → 重写。
//
// ── 不改的东西 ─────────────────────────────────────────────────────
// · 目录/文件名：`<root>/每日/YYYY-MM-DD.md`（root 仍从 config 读）；
// · 行格式：`- 心情：xx｜[重要] 正文`；
// · 去重：前 14 字相同视为同一条（命中时新内容更长就替换）；
// · mood 兜底：把误填成 mood 的等级词纠正回 importance。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR, getConfig } from '../config.js';
import { withFileLock, writeFileAtomic } from '../file-lock.js';
import { appendEvent, makeEventId } from '../companion/events.js';
import {
  beginOp, bodyDone, metaDone, finishOp, failOp, maybeFault,
  syncAppendMeta, syncRemoveMeta, syncRelevelMeta
} from './op.js';
import { splitParagraphs } from './meta.js';
import { assertDiaryWritePath } from './test-guard.js';
import { blockedResult } from '../reset-barrier.js';

const IMPORTANCE = ['一般', '重要', '非常重要'];

/** 正文文件 hash（恢复判定用；不存在记为 absent）。 */
function hashOfFile(file) {
  try {
    return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file, 'utf8'), 'utf8').digest('hex');
  } catch {
    return 'absent';
  }
}
const DEFAULT_IMPORTANCE = '一般';
const DEFAULT_MOOD = '平静';
const IDEMPOTENCY_FILE = path.join(DATA_DIR, 'diary-idempotency.json');
const IDEMPOTENCY_KEEP_DAYS = 30;

/** 日记根目录（和 skills/diary 用的是同一份配置）。 */
export function diaryRoot() {
  try {
    const c = getConfig();
    const r = c?.skills?.diary?.root || c?.skills?.diary?.settings?.root;
    if (r) return String(r);
  } catch { /* 配置未就绪 */ }
  return 'E:\\dsh\\本子\\日记';
}

export function diaryDir() {
  return path.join(diaryRoot(), '每日');
}

const pad = (n) => String(n).padStart(2, '0');
export function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function weekdayOf(key) {
  const t = Date.parse(`${key}T00:00:00`);
  return Number.isFinite(t) ? WEEK[new Date(t).getDay()] : '';
}

function diaryFile(day) {
  return path.join(diaryDir(), `${day}.md`);
}

/* ── 格式化（与 skills/diary 完全一致）────────────────────────────── */

const MOOD_PREFIX_RE = /^\s*心情\s*[：:]\s*[^｜|]{0,20}[｜|]\s*/;

/** 剥掉正文里自带的「心情：xx｜」前缀（最多 3 层）。 */
export function stripMoodPrefix(text) {
  let t = String(text ?? '').trim();
  for (let i = 0; i < 3 && MOOD_PREFIX_RE.test(t); i += 1) t = t.replace(MOOD_PREFIX_RE, '').trim();
  return t;
}

/** 构造一行日记（格式与 addDiary 逐字相同）。 */
export function formatLine({ content, mood, importance }) {
  const imp = IMPORTANCE.includes(String(importance)) ? String(importance) : DEFAULT_IMPORTANCE;
  const text = stripMoodPrefix(String(content).replace(/\s+/g, ' ').trim());
  const m = String(mood || DEFAULT_MOOD).trim() || DEFAULT_MOOD;
  return `- 心情：${m}｜${imp === DEFAULT_IMPORTANCE ? '' : `[${imp}] `}${text}`;
}

/** 内容指纹：用于崩溃后判断"这条是不是已经写进去了"。 */
export function contentHash({ content, mood, importance }) {
  const imp = IMPORTANCE.includes(String(importance)) ? String(importance) : DEFAULT_IMPORTANCE;
  const m = String(mood || DEFAULT_MOOD).trim() || DEFAULT_MOOD;
  const text = stripMoodPrefix(String(content).replace(/\s+/g, ' ').trim());
  return crypto.createHash('sha1').update(`${m}|${imp}|${text}`).digest('hex').slice(0, 16);
}

/** 去重判据：前 14 个字相同（与 skills/diary 的 findSimilarDiaryLine 一致）。 */
function findSimilar(lines, content) {
  const norm = (s) => String(s ?? '').replace(/[\s，。！？、,.!?]/g, '');
  const t = norm(content);
  if (t.length < 8) return -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^- 心情：[^｜]*｜(?:\[[^\]]+\]\s*)?(.+)$/);
    if (!m) continue;
    const prev = norm(m[1]);
    if (prev.length < 8) continue;
    if (prev.slice(0, 14) === t.slice(0, 14)) return i;
  }
  return -1;
}

/* ── 幂等表 ────────────────────────────────────────────────────────── */

function loadIdem() {
  try {
    const raw = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, 'utf8'));
    if (raw && typeof raw.keys === 'object') return raw;
  } catch { /* 不存在/损坏 → 空表 */ }
  return { version: 1, keys: {} };
}

function saveIdem(table) {
  assertDiaryWritePath(IDEMPOTENCY_FILE);
  // 顺手清理过期键（30 天），避免无限增长
  const cutoff = Date.now() - IDEMPOTENCY_KEEP_DAYS * 86400e3;
  for (const [k, v] of Object.entries(table.keys)) {
    if (Number(v?.at) && Number(v.at) < cutoff) delete table.keys[k];
  }
  writeFileAtomic(IDEMPOTENCY_FILE, JSON.stringify(table));
}

/* ── 写入 ──────────────────────────────────────────────────────────── */

/**
 * 写一条日记。
 *
 * @param {object} o
 * @param {string} o.content 正文（必填）
 * @param {string} o.source 来源：'skills/diary' | 'autonomous' | 'qq-tools' | ...
 * @param {string} [o.importance] 一般 / 重要 / 非常重要
 * @param {string} [o.mood]
 * @param {string} [o.idempotencyKey] 不传则按 source+day+hash 自动生成
 * @param {string} [o.day] YYYY-MM-DD，默认今天
 * @param {string} [o.root] 日记根目录（默认读 config.skills.diary.root）；技能侧会传自己的 conf()
 * @returns {{ok:boolean, skipped?:boolean, merged?:boolean, file?:string, line?:string, event?:object, error?:string}}
 */
export function write({ content, source = 'unknown', importance = '', mood = '', idempotencyKey = '', day = '', root = '' } = {}) {
  // reset 删除期间阻止日记写入（协作式屏障）。
  const blocked = blockedResult('日记写入');
  if (blocked) return blocked;
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, error: 'content 不能为空' };
  if (text.length > 2000) return { ok: false, error: 'content 太长（>2000 字）' };

  const key = day || dateKey();
  // root 可注入：技能那边用的是它自己 conf() 的目录（测试也会 mock），
  // 不传才回落到全局配置 —— 否则测试会写到生产日记里（2026-11-01 真踩过）。
  const file = root ? path.join(String(root), `${key}.md`) : diaryFile(key);
  assertDiaryWritePath(file);
  const hash = contentHash({ content: text, mood, importance });
  // 自动幂等键**不含 source**：同一件事从 skills/diary、autonomous、qq-tools
  // 三个入口写进来时必须是同一个 key —— 否则同一条经历会记三行
  // （机主 2026-11-01 要求：不同来源不能让同一事件写出两条日记）。
  const idemKey = String(idempotencyKey || `auto:${key}:${hash}`);

  // mood 兜底：她偶尔把等级塞进 mood 字段（2026-10-27/29 各一次）。
  // 注意 importance 的默认值必须是空串 —— 旧 addDiary 收到的是 undefined，
  // 这里若默认成「一般」，兜底判断会把「没传」误当成「显式传了一般」，行为就变了。
  let imp = String(importance || '').trim();
  let mo = String(mood || '').trim();
  if (IMPORTANCE.includes(mo)) {
    if (!IMPORTANCE.includes(imp)) imp = mo;
    mo = '';
  }

  let writeResult = null;
  try {
    writeResult = withFileLock(file, () => {
      // ① 先登记操作意图（失败则绝不改正文）
      const op = beginOp({ op: 'append', dateKey: key, match: text.slice(0, 40), expectedSourceHash: hashOfFile(file) });
      if (!op.ok) return { ok: false, error: `登记失败，正文未改：${op.error}` };
      const table = loadIdem();
      const seen = table.keys[idemKey];

      // 1) 已确认写过 → 跳过，但**先验证日记里真有这一行**。
      //    只信账本会出岔子：日记被人工清理过、或者换了目录，账本还在说"写过"，
      //    于是一条也写不进去（2026-11-01 真踩过：清理了测试行，幂等表还记着 done）。
      if (seen?.state === 'done') {
        const existing = readLines(file);
        const stillThere = seen.line ? existing.includes(seen.line) : false;
        if (stillThere) {
          return { ok: true, skipped: true, reason: 'idempotent', file: `${key}.md`, line: seen.line || '' };
        }
        // 账本说写过、文件里没有 → 以文件为准，清掉这条记录继续写
        delete table.keys[idemKey];
        saveIdem(table);
      }

      // 2) pending（上次崩在中途）→ 回查日记里有没有这条
      if (seen?.state === 'pending') {
        const lines = readLines(file);
        const hit = lines.findIndex((l) => l.includes(text.slice(0, 20)) && l.startsWith('- 心情'));
        if (hit >= 0) {
          table.keys[idemKey] = { ...seen, state: 'done', at: Date.now(), day: key, line: lines[hit].slice(0, 200) };
          saveIdem(table);
          return { ok: true, skipped: true, reason: 'recovered', file: `${key}.md`, line: lines[hit].slice(0, 200) };
        }
        // 没查到 → 当作没写过，继续走正常写入
      }

      // 3) 记 pending（先落盘，再写正文 —— 崩了能靠 hash 回查）
      table.keys[idemKey] = { state: 'pending', at: Date.now(), source, day: key, hash };
      saveIdem(table);

      // 4) 写日记（读-改-写，锁内）
      maybeFault('before-body');
      const r = appendLine({ file, key, text, mood: mo, importance: imp });
      if (!r.ok) return { ok: false, error: r.error };

      // 5) 确认写入：读回来找这一行
      const after = readLines(file);
      const confirmed = after.some((l) => l === r.line) || (r.merged && after.some((l) => l.includes(text.slice(0, 20))));

      // 6) 标 done
      table.keys[idemKey] = {
        state: confirmed ? 'done' : 'pending',
        at: Date.now(),
        source,
        day: key,
        hash,
        line: r.line.slice(0, 200),
        merged: Boolean(r.merged)
      };
      saveIdem(table);

      // ② 正文完成 → ③ meta（用 writer 生成的身份，不重新读正文猜段落）→ ④ 完成
      bodyDone(op.id);
      let meta = { ok: true, skipped: true };
      if (!r.merged) {
        const rawAfter = fs.readFileSync(file, 'utf8');
        const paras = splitParagraphs(rawAfter);
        const needle = text.replace(/\s+/g, ' ').trim().slice(0, 12);
        const hits = paras.filter((p) => String(p.text).replace(/\s+/g, ' ').includes(needle));
        if (hits.length === 1) {
          const identity = {
            dateKey: key,
            paragraphIndex: hits[0].index,
            quoteHash: hits[0].hash,
            quote: String(hits[0].text).slice(0, 60),
            sourceHashAfter: 'sha256:' + crypto.createHash('sha256').update(rawAfter, 'utf8').digest('hex'),
            operationId: op.id
          };
          meta = syncAppendMeta({ dateKey: key, text, root, identity });
        } else {
          meta = { ok: false, error: `段落身份不唯一（hits=${hits.length}）`, metaState: 'failed' };
        }
      }
      if (!meta.ok) {
        failOp(op.id, meta.error);
        return { ok: confirmed, merged: Boolean(r.merged), file: `${key}.md`, line: r.line, confirmed, pendingSync: true, metaError: meta.error };
      }
      if (!meta.skipped) metaDone(op.id);
      finishOp(op.id, meta.metaState || 'skipped_disabled');
      return { ok: confirmed, merged: Boolean(r.merged), file: `${key}.md`, line: r.line, confirmed, pendingSync: false };
    });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  if (!writeResult?.ok) return writeResult || { ok: false, error: '写入失败' };

  // 7) 发事件（日记已经写成功了；事件失败绝不回滚）
  let event = null;
  try {
    // 事件也是间接写入：测试模式下同样过门禁
    assertDiaryWritePath(path.join(DATA_DIR, 'companion-events', 'active.ndjson'));
    event = appendEvent({
      eventId: makeEventId('diary.written', `${key}:${hash}`),
      type: 'diary.written',
      source: String(source),
      day: key,
      hash,
      importance: imp,
      mood: mo,
      merged: Boolean(writeResult.merged),
      summary: text.slice(0, 120)
    });
  } catch (e) {
    event = { ok: false, error: String(e?.message ?? e) };
  }

  return { ...writeResult, event };
}

/** 读某天的行（文件不存在 → 空数组）。 */
export function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

/** 读某天原文（只读；不解析、不格式化，保持字节）。 */
export function readRawDay(day = dateKey(), root = '') {
  try {
    return fs.readFileSync(root ? path.join(root, `${String(day)}.md`) : diaryFile(day), 'utf8');
  } catch {
    return '';
  }
}

/** 读某天全部条目（给面板/测试用）。root 可传「每日」目录（可选）。 */
export function readDay(day = dateKey(), root = '') {
  const lines = readLines(root ? path.join(root, `${String(day)}.md`) : diaryFile(day));
  const out = [];
  for (const l of lines) {
    const m = l.match(/^- 心情：([^｜]*)｜(?:\[([^\]]+)\]\s*)?(.+)$/);
    if (!m) continue;
    out.push({ mood: (m[1] || '').trim(), importance: (m[2] || '一般').trim(), text: (m[3] || '').trim() });
  }
  return out;
}

/**
 * 真正的落盘：与 skills/diary 的 addDiary 逐字同构。
 * 保留：文件头、`## 记录` 段定位、去重替换、尾部空行整理。
 */
function appendLine({ file, key, text, mood, importance }) {
  try {
    if (!fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `# ${key} ${weekdayOf(key)}\n\n## 记录\n\n`, 'utf8');
    }
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    let at = lines.findIndex((l) => l.trim() === '## 记录');
    if (at < 0) {
      lines.push('', '## 记录');
      at = lines.length - 1;
    }
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i += 1) {
      if (lines[i].startsWith('## ')) { end = i; break; }
    }
    let insert = end;
    while (insert > at + 1 && lines[insert - 1].trim() === '') insert -= 1;

    const line = formatLine({ content: text, mood, importance });
    const dup = findSimilar(lines, text);
    if (dup >= 0) {
      const prevText = (lines[dup].match(/｜(?:\[[^\]]+\]\s*)?(.+)$/) || [])[1] || '';
      if (text.length > prevText.length) lines[dup] = line;
      const outText = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
      fs.writeFileSync(file, outText, 'utf8');
      return { ok: true, merged: true, line };
    }
    lines.splice(insert, 0, line);
    const out = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
    fs.writeFileSync(file, out, 'utf8');
    return { ok: true, merged: false, line };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 删除一条日记正文（D1-2a 收口）。
 *
 * 安全边界（与旧 autonomous 实现一致）：
 *   · 只删**唯一匹配**的那一行；命中多条返回候选、不猜
 *   · 锁内重读并复核唯一性；写前备份到 `<日记根>/.trash/`
 *   · 原子替换；写失败不覆盖原文件
 *
 * @param {{match:string, day?:string, root?:string}} o
 * @returns {{ok:boolean, removed?:string, file?:string, reason?:string, candidates?:string[]}}
 */
export function removeLine({ match, day = '', root = '' } = {}) {
  const blocked = blockedResult('日记删除');
  if (blocked) return { ...blocked, reason: blocked.error };
  const needle = String(match ?? '').trim();
  if (needle.length < 2) return { ok: false, reason: '要删的内容太短，至少给两个字' };
  const dir = root || diaryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse();
  } catch {
    return { ok: false, reason: '读不到日记目录' };
  }
  if (day) names = names.filter((n) => n === `${day}.md`);

  const hits = [];
  for (const name of names.slice(0, 30)) {
    const file = path.join(dir, name);
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    lines.forEach((line, index) => {
      if (line.includes(needle)) hits.push({ file, name, index, line });
    });
  }
  if (!hits.length) return { ok: false, reason: `没找到含「${needle}」的日记` };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `有 ${hits.length} 条都含「${needle}」，把 match 写具体点再删`,
      candidates: hits.slice(0, 5).map((h) => h.line.trim().slice(0, 60))
    };
  }

  const h = hits[0];
  assertDiaryWritePath(h.file);
  const dateKey = h.name.replace(/\.md$/, '');
  try {
    return withFileLock(h.file, () => {
      const lines = fs.readFileSync(h.file, 'utf8').split('\n');
      const matched = lines.filter((l) => l.includes(needle));
      if (matched.length !== 1) {
        return { ok: false, reason: '锁内复核失败：匹配已变化（可能被并发修改），请重试' };
      }
      const idx = lines.findIndex((l) => l.includes(needle));
      const before = lines[idx];
      // 删除前算受影响的段落起点（删除后索引前移，事后算不出来）
      const beforeIndex = splitParagraphs(lines.join('\n')).findIndex((p) => String(p.text).includes(needle));
      // ① 先登记（失败不改正文）
      const op = beginOp({ op: 'remove', dateKey, match: needle, expectedSourceHash: hashOfFile(h.file), paragraphIndex: beforeIndex >= 0 ? beforeIndex : null });
      if (!op.ok) return { ok: false, reason: `登记失败，正文未改：${op.error}` };
      maybeFault('before-body');
      try {
        const trash = path.join(path.dirname(dir), '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.copyFileSync(h.file, path.join(trash, `${h.name}.${Date.now()}.bak`));
      } catch { /* 备份失败不阻塞删除 */ }
      lines.splice(idx, 1);
      const outText = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
      writeFileAtomic(h.file, outText);
      // ② 正文完成 → ③ meta → ④ 完成
      bodyDone(op.id);
      const meta = syncRemoveMeta({ dateKey, match: needle, beforeIndex, root: dir });
      if (!meta.ok) {
        failOp(op.id, meta.error);
        return { ok: true, removed: before.trim(), file: h.name, pendingSync: true, metaError: meta.error };
      }
      if (!meta.skipped) metaDone(op.id);
      finishOp(op.id, meta.metaState || 'skipped_disabled');
      return { ok: true, removed: before.trim(), file: h.name, pendingSync: false };
    });
  } catch (e) {
    return { ok: false, reason: `写不回去：${e?.message ?? e}` };
  }
}

/**
 * 修改一条日记的等级（D1-2a 收口）。
 *
 * 只动 `[一般|重要|非常重要]` 标记，正文和心情不碰；唯一匹配；锁内复核；原子写。
 */
export function relevelLine({ match, importance, day = '', root = '' } = {}) {
  const blocked = blockedResult('日记改级');
  if (blocked) return { ...blocked, reason: blocked.error };
  const LEVELS = ['一般', '重要', '非常重要'];
  const needle = String(match ?? '').trim();
  if (needle.length < 2) return { ok: false, reason: '要改的内容太短，至少给两个字' };
  const imp = String(importance ?? '').trim();
  if (!LEVELS.includes(imp)) return { ok: false, reason: `等级只能是：${LEVELS.join(' / ')}` };

  const dir = root || diaryDir();
  let names = [];
  try {
    names = fs.readdirSync(dir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n))
      .sort()
      .reverse();
  } catch {
    return { ok: false, reason: '读不到日记目录' };
  }
  if (day) names = names.filter((n) => n === `${day}.md`);

  const hits = [];
  for (const name of names.slice(0, 30)) {
    const file = path.join(dir, name);
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split('\n'); } catch { continue; }
    lines.forEach((line, index) => {
      if (line.trim().startsWith('- 心情：') && line.includes(needle)) hits.push({ file, name, index, line });
    });
  }
  if (!hits.length) return { ok: false, reason: `没找到含「${needle}」的日记` };
  if (hits.length > 1) {
    return {
      ok: false,
      reason: `有 ${hits.length} 条都含「${needle}」，把 match 写具体点再改`,
      candidates: hits.slice(0, 5).map((h) => h.line.trim().slice(0, 60))
    };
  }

  const h = hits[0];
  assertDiaryWritePath(h.file);
  const dateKey = h.name.replace(/\.md$/, '');
  try {
    return withFileLock(h.file, () => {
      const lines = fs.readFileSync(h.file, 'utf8').split('\n');
      const matched = lines.filter((l) => l.trim().startsWith('- 心情：') && l.includes(needle));
      if (matched.length !== 1) {
        return { ok: false, reason: '锁内复核失败：匹配已变化（可能被并发修改），请重试' };
      }
      const idx = lines.findIndex((l) => l.trim().startsWith('- 心情：') && l.includes(needle));
      const before = lines[idx];
      const m = /^(\s*-\s*心情：)([^｜|]*)([｜|])([\s\S]*)$/.exec(before);
      if (!m) return { ok: false, reason: '这条日记格式不对，读不出来' };
      const body = m[4].replace(/^\s*\[(一般|重要|非常重要)\]\s*/, '');
      const after = `${m[1]}${m[2]}${m[3]}${imp === '一般' ? body : `[${imp}] ${body}`}`;
      if (after === before) {
        return { ok: true, changed: false, reason: '本来就是这个等级', file: h.name, line: before.trim() };
      }
      // ① 先登记（失败不改正文）
      const op = beginOp({ op: 'relevel', dateKey, match: needle, importance: imp, expectedSourceHash: hashOfFile(h.file) });
      if (!op.ok) return { ok: false, reason: `登记失败，正文未改：${op.error}` };
      maybeFault('before-body');
      try {
        const trash = path.join(path.dirname(dir), '.trash');
        fs.mkdirSync(trash, { recursive: true });
        fs.copyFileSync(h.file, path.join(trash, `${h.name}.${Date.now()}.bak`));
      } catch { /* 备份失败不阻塞改级 */ }
      lines[idx] = after;
      const outText = `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '')}\n`;
      writeFileAtomic(h.file, outText);
      // ② 正文完成 → ③ meta → ④ 完成
      bodyDone(op.id);
      const meta = syncRelevelMeta({ dateKey, match: needle, importance: imp, root: dir });
      if (!meta.ok) {
        failOp(op.id, meta.error);
        return { ok: true, changed: true, file: h.name, before: before.trim(), after: after.trim(), importance: imp, pendingSync: true, metaError: meta.error };
      }
      if (!meta.skipped) metaDone(op.id);
      finishOp(op.id, meta.metaState || 'skipped_disabled');
      return { ok: true, changed: true, file: h.name, before: before.trim(), after: after.trim(), importance: imp, pendingSync: false };
    });
  } catch (e) {
    return { ok: false, reason: `写不回去：${e?.message ?? e}` };
  }
}

export const __internals = { IDEMPOTENCY_FILE, diaryFile, loadIdem, findSimilar };
