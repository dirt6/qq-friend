// 她的画：渲染、归档、索引、删除。
//
// 为什么单独一个模块：画图有两个入口 —— 聊天里的 qq_draw 工具（DSH 插件），
// 和空闲时的自主活动（Electron 主进程）。两边都要"渲染 + 存盘 + 记标题"，
// 各写一份必然漂移（一边有标题一边没有、一边会清理一边不会）。
//
// 数据布局：
//   data/drawings/draw-20261025-173000-ab12.png   图片本体
//   data/drawings/index.json                       元数据（标题/风格/来源/时间）
//
// 索引是**辅助**，不是真相：列表以磁盘上的 png 为准，索引只补标题这类
// 无法从文件名推出来的东西。这样手动删了图、或者索引写坏了，画廊都不会崩。

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ROOT, DATA_DIR } from './config.js';

const execFileP = promisify(execFile);

export const DRAW_DIR = path.join(DATA_DIR, 'drawings');
export const INDEX_FILE = path.join(DRAW_DIR, 'index.json');
/** 索引最多记这么多条；超了从最旧的裁（图不删，只是丢了标题）。 */
const MAX_INDEX = 600;
const PYTHON = process.env.QQ_DRAW_PYTHON || 'C:\\Program Files\\Python314\\python.exe';
const SCRIPT = path.join(ROOT, 'scripts', 'draw', 'render.py');

const p2 = (n) => String(n).padStart(2, '0');

/** 画作文件名带时间戳：排序、对账、人工翻目录都用得上。 */
export function makeFileName(prefix = 'draw') {
  const d = new Date();
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`
    + `-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const tag = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${stamp}-${tag}.png`;
}

export function ensureDir() {
  fs.mkdirSync(DRAW_DIR, { recursive: true });
  return DRAW_DIR;
}

/**
 * 文件名白名单：只认 drawings 目录里、扩展名是 png 的纯文件名。
 * 画廊和删除接口都会收到用户传来的名字，这里是唯一的安全闸。
 */
export function safeDrawingPath(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return null;
  // 只允许纯文件名：带路径分隔符、盘符、.. 的一律拒绝
  if (/[\\/]/.test(raw) || raw.includes('..') || /^[a-zA-Z]:/.test(raw)) return null;
  if (!/^[\w.-]+\.png$/i.test(raw)) return null;
  const abs = path.resolve(DRAW_DIR, raw);
  const rel = path.relative(DRAW_DIR, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function readIndexRaw() {
  try {
    const raw = fs.readFileSync(INDEX_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Array.isArray(j?.items) ? j.items : [];
  } catch {
    // 文件存在但读不动（半截写入 / 手工改坏）：先留一份备份再说。
    // 不留的话，下一次 recordDrawing 的 read-modify-write 会把整份索引无声覆盖 ——
    // 表现就是「所有画的标题突然全没了」，而且找不回来。
    try {
      if (fs.existsSync(INDEX_FILE) && fs.statSync(INDEX_FILE).size > 2) {
        fs.copyFileSync(INDEX_FILE, path.join(DRAW_DIR, 'index.broken.json'));
      }
    } catch { /* 备份失败也不能影响读取 */ }
    return [];
  }
}

function writeIndexRaw(items) {
  ensureDir();
  const tmp = `${INDEX_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 1), 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

/**
 * 渲染一张画。
 * @returns {Promise<{ok:boolean, path?:string, width?:number, height?:number, style?:string, bytes?:number, error?:string}>}
 */
export async function renderScene(scene, { outPath, timeoutMs = 60_000 } = {}) {
  ensureDir();
  const target = outPath ? path.resolve(outPath) : path.join(DRAW_DIR, makeFileName());
  const tmpDir = path.join(DATA_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const sceneFile = path.join(tmpDir, `scene-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}.json`);
  fs.writeFileSync(sceneFile, JSON.stringify(scene), 'utf8');
  try {
    const { stdout } = await execFileP(PYTHON, [SCRIPT, '--scene', sceneFile, '--out', target], {
      timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
    });
    const last = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop() || '';
    const parsed = JSON.parse(last);
    if (parsed?.ok !== true) return { ok: false, error: String(parsed?.error || '渲染器没有输出') };
    return {
      ok: true,
      path: String(parsed.path || target),
      width: Number(parsed.width) || 0,
      height: Number(parsed.height) || 0,
      style: String(parsed.style || ''),
      bytes: Number(parsed.bytes) || 0
    };
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (/ETIMEDOUT|timed out/i.test(msg)) return { ok: false, error: '渲染超时' };
    return { ok: false, error: msg.slice(0, 200) };
  } finally {
    try { fs.rmSync(sceneFile, { force: true }); } catch { /* ignore */ }
  }
}

/** 记一条元数据（按文件名 upsert，重复渲染同一个文件不会出现两条）。 */
export function recordDrawing(meta = {}) {
  const file = path.basename(String(meta.file || meta.path || ''));
  if (!file) return null;
  const entry = {
    file,
    title: String(meta.title ?? '').trim().slice(0, 60),
    note: String(meta.note ?? '').trim().slice(0, 200),
    style: String(meta.style ?? '').trim().slice(0, 20),
    source: String(meta.source ?? 'chat').slice(0, 20),
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    bytes: Number(meta.bytes) || 0,
    createdAt: String(meta.createdAt || new Date().toISOString())
  };
  const items = readIndexRaw().filter((x) => x && x.file !== file);
  items.push(entry);
  // 新的在前，超量的从尾部裁掉
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  writeIndexRaw(items.slice(0, MAX_INDEX));
  return entry;
}

function statOf(abs) {
  try { return fs.statSync(abs); } catch { return null; }
}

/** 文件名里的时间戳 → ISO；推不出来就用文件 mtime。 */
function timeFromName(file, fallback) {
  const m = /-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(file);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return fallback;
}

/**
 * 列出所有画作。以磁盘为准，索引补元数据。
 * @returns {{file:string, title:string, note:string, style:string, source:string,
 *            width:number, height:number, bytes:number, createdAt:string, hasTitle:boolean}[]}
 */
export function listDrawings({ limit = 300 } = {}) {
  ensureDir();
  const byFile = new Map();
  for (const entry of readIndexRaw()) {
    if (entry?.file) byFile.set(String(entry.file), entry);
  }
  let names = [];
  try {
    names = fs.readdirSync(DRAW_DIR).filter((f) => /\.png$/i.test(f));
  } catch {
    return [];
  }
  const items = [];
  for (const file of names) {
    const abs = path.join(DRAW_DIR, file);
    const st = statOf(abs);
    if (!st) continue;
    const meta = byFile.get(file) || {};
    const createdAt = meta.createdAt || timeFromName(file, st.mtime.toISOString());
    items.push({
      file,
      title: String(meta.title || '').trim(),
      note: String(meta.note || ''),
      style: String(meta.style || ''),
      source: String(meta.source || 'unknown'),
      width: Number(meta.width) || 0,
      height: Number(meta.height) || 0,
      bytes: Number(meta.bytes) || st.size,
      createdAt,
      hasTitle: Boolean(String(meta.title || '').trim())
    });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return items.slice(0, Math.max(1, limit));
}

/** 删一张画：图 + 索引条目一起清。 */
/**
 * 改一张画的标题/备注（图本身不动）。
 * 以当前索引为基线合并，避免只传 title 把 style/width/source 清空。
 */
export function updateDrawingTitle(file, title, { note = undefined, source = 'owner' } = {}) {
  const abs = safeDrawingPath(file);
  if (!abs) return { ok: false, error: '文件名不合法' };
  if (!fs.existsSync(abs)) return { ok: false, error: '这张画不存在' };
  const base = path.basename(abs);
  const current = listDrawings({ limit: 5000 }).find((x) => String(x.file) === base);
  if (!current) return { ok: false, error: '索引里没有这张画' };
  const clean = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const entry = recordDrawing({
    ...current,
    file: base,
    title: clean,
    note: note === undefined ? current.note : String(note).slice(0, 200),
    source: source || current.source || 'owner',
    createdAt: current.createdAt
  });
  return { ok: true, file: base, title: clean, entry };
}

export function deleteDrawing(file) {
  const abs = safeDrawingPath(file);
  if (!abs) return { ok: false, error: '文件名不合法' };
  if (!fs.existsSync(abs)) {
    // 图已经没了，顺手把索引里的脏条目清掉
    writeIndexRaw(readIndexRaw().filter((x) => x && x.file !== path.basename(abs)));
    return { ok: false, error: '这张画已经不在了' };
  }
  try {
    fs.rmSync(abs, { force: true });
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
  writeIndexRaw(readIndexRaw().filter((x) => x && x.file !== path.basename(abs)));
  return { ok: true, file: path.basename(abs) };
}

/** 统计：给面板/状态接口用。 */
export function drawingStats() {
  const items = listDrawings({ limit: 5000 });
  const totalBytes = items.reduce((n, x) => n + (Number(x.bytes) || 0), 0);
  return {
    count: items.length,
    totalBytes,
    titledCount: items.filter((x) => x.hasTitle).length,
    dir: DRAW_DIR,
    latest: items[0] || null
  };
}

/**
 * 现成的构图模板：自主活动里模型只给「画什么主题」，程序用这些兜底成场景，
 * 避免它临场编坐标编崩（也可能它压根不想给完整 scene）。
 *
 * 每个模板接受 { title, main, bg, accent }，只用 6~9 个图形，保证画得干净。
 */
export const PRESETS = {
  night: ({ title = '', main = '#ffe9a8', bg = '#1c2541', accent = '#f6a259' } = {}) => ({
    width: 900, height: 600,
    background: { type: 'linear', from: bg, to: '#070b18', angle: 90 },
    style: 'picturebook',
    shapes: [
      // 月亮与三层光晕
      { type: 'circle', cx: 660, cy: 150, r: 118, fill: '#ffe9a81f' },
      { type: 'circle', cx: 660, cy: 150, r: 92, fill: '#ffe9a83d' },
      { type: 'circle', cx: 660, cy: 150, r: 66, fill: main },
      { type: 'circle', cx: 638, cy: 132, r: 13, fill: '#e3cd8a66' },
      { type: 'circle', cx: 681, cy: 170, r: 9, fill: '#e3cd8a55' },
      { type: 'circle', cx: 672, cy: 126, r: 6, fill: '#e3cd8a55' },
      // 星点：大小/透明度错开
      { type: 'circle', cx: 110, cy: 92, r: 2.5, fill: '#ffffffcc' },
      { type: 'circle', cx: 190, cy: 170, r: 1.5, fill: '#ffffff88' },
      { type: 'circle', cx: 280, cy: 70, r: 2, fill: '#ffffffaa' },
      { type: 'circle', cx: 355, cy: 145, r: 1.2, fill: '#ffffff66' },
      { type: 'circle', cx: 470, cy: 92, r: 2.8, fill: '#ffffffdd' },
      { type: 'circle', cx: 770, cy: 78, r: 1.8, fill: '#ffffff99' },
      { type: 'circle', cx: 825, cy: 210, r: 2.2, fill: '#ffffffaa' },
      { type: 'circle', cx: 530, cy: 235, r: 1.5, fill: '#ffffff77' },
      // 远山、中景、湖面
      { type: 'polygon', points: [[0, 430], [170, 300], [310, 430], [430, 350], [560, 450], [0, 520]], fill: '#1a2440' },
      { type: 'polygon', points: [[380, 470], [540, 330], [680, 450], [800, 370], [900, 470], [900, 545], [380, 545]], fill: '#111a31' },
      { type: 'rect', x: 0, y: 500, w: 900, h: 100, fill: '#0b1429' },
      { type: 'ellipse', cx: 660, cy: 520, rx: 78, ry: 12, fill: '#ffe9a82b' },
      { type: 'line', points: [[610, 520], [700, 520]], stroke: '#ffe9a855', strokeWidth: 3 },
      { type: 'line', points: [[635, 535], [680, 535]], stroke: '#ffe9a833', strokeWidth: 2 },
      // 前景草坡
      { type: 'polygon', points: [[0, 565], [0, 600], [900, 600], [900, 560], [760, 548], [600, 568], [430, 552], [250, 572], [90, 555]], fill: '#070d1c' },
      { type: 'line', points: [[90, 560], [100, 535], [112, 558]], stroke: '#0d1a2a', strokeWidth: 3 },
      { type: 'line', points: [[150, 566], [164, 538], [176, 564]], stroke: '#0d1a2a', strokeWidth: 3 },
      { type: 'line', points: [[820, 558], [832, 532], [846, 556]], stroke: '#0d1a2a', strokeWidth: 3 },
      ...(title ? [{ type: 'text', x: 450, y: 40, text: title, size: 36, fill: main, anchor: 'mt' }] : [])
    ]
  }),
  cat: ({ title = '', main = '#f6a259', bg = '#1c2541', accent = '#ffe9a8' } = {}) => ({
    width: 900, height: 600,
    background: { type: 'linear', from: '#2a2440', to: '#151426', angle: 90 },
    style: 'picturebook',
    shapes: [
      // 窗光与地面
      { type: 'rect', x: 80, y: 80, w: 250, h: 300, fill: '#8ca6d72b', radius: 18 },
      { type: 'line', points: [[205, 80], [205, 380]], stroke: '#d8e3ff44', strokeWidth: 4 },
      { type: 'line', points: [[80, 230], [330, 230]], stroke: '#d8e3ff44', strokeWidth: 4 },
      { type: 'ellipse', cx: 470, cy: 535, rx: 240, ry: 34, fill: '#00000055' },
      { type: 'rect', x: 250, y: 455, w: 430, h: 105, fill: '#6d4b5e', radius: 30 },
      { type: 'rect', x: 275, y: 470, w: 380, h: 70, fill: '#8d6376', radius: 26 },
      // 猫身/头/耳
      { type: 'ellipse', cx: 450, cy: 415, rx: 112, ry: 120, fill: main },
      { type: 'polygon', points: [[370, 285], [392, 195], [445, 275]], fill: main },
      { type: 'polygon', points: [[455, 275], [508, 195], [530, 285]], fill: main },
      { type: 'polygon', points: [[388, 270], [400, 218], [430, 270]], fill: '#e58d6a' },
      { type: 'polygon', points: [[469, 270], [500, 218], [512, 270]], fill: '#e58d6a' },
      { type: 'circle', cx: 450, cy: 310, r: 88, fill: main },
      { type: 'ellipse', cx: 450, cy: 355, rx: 48, ry: 28, fill: '#ffe3c2' },
      // 眼睛、鼻子、嘴、胡须
      { type: 'ellipse', cx: 418, cy: 298, rx: 17, ry: 20, fill: '#24313d' },
      { type: 'ellipse', cx: 482, cy: 298, rx: 17, ry: 20, fill: '#24313d' },
      { type: 'circle', cx: 412, cy: 292, r: 5, fill: '#ffffffcc' },
      { type: 'circle', cx: 476, cy: 292, r: 5, fill: '#ffffffcc' },
      { type: 'polygon', points: [[438, 335], [462, 335], [450, 348]], fill: '#d9774f' },
      { type: 'line', points: [[450, 348], [450, 360], [434, 366]], stroke: '#5b3a34', strokeWidth: 3 },
      { type: 'line', points: [[450, 360], [466, 366]], stroke: '#5b3a34', strokeWidth: 3 },
      { type: 'line', points: [[390, 342], [335, 330]], stroke: '#5b3a34', strokeWidth: 2.5 },
      { type: 'line', points: [[392, 354], [338, 358]], stroke: '#5b3a34', strokeWidth: 2.5 },
      { type: 'line', points: [[510, 342], [565, 330]], stroke: '#5b3a34', strokeWidth: 2.5 },
      { type: 'line', points: [[508, 354], [562, 358]], stroke: '#5b3a34', strokeWidth: 2.5 },
      // 爪子与尾巴
      { type: 'ellipse', cx: 370, cy: 500, rx: 42, ry: 20, fill: '#ffe3c2' },
      { type: 'ellipse', cx: 530, cy: 500, rx: 42, ry: 20, fill: '#ffe3c2' },
      { type: 'line', points: [[548, 445], [635, 460], [665, 400], [650, 350]], stroke: main, strokeWidth: 30 },
      // 地毯上的小鲸鱼（旧画廊里的搭档）
      { type: 'ellipse', cx: 245, cy: 505, rx: 58, ry: 34, fill: '#8cc5ea' },
      { type: 'polygon', points: [[190, 505], [145, 477], [145, 533]], fill: '#8cc5ea' },
      { type: 'polygon', points: [[225, 485], [220, 450], [260, 480]], fill: '#6fb0dc' },
      { type: 'circle', cx: 218, cy: 498, r: 6, fill: '#24313d' },
      { type: 'ellipse', cx: 285, cy: 488, rx: 9, ry: 5, fill: '#b9e0f5' },
      ...(title ? [{ type: 'text', x: 450, y: 38, text: title, size: 36, fill: accent, anchor: 'mt' }] : [])
    ]
  }),
  flower: ({ title = '', main = '#ef7b6f', bg = '#f7f1e3', accent = '#9ed9c3' } = {}) => ({
    width: 900, height: 600,
    background: { type: 'linear', from: bg, to: '#e8dcc9', angle: 90 },
    style: 'picturebook',
    shapes: [
      // 太阳与云
      { type: 'circle', cx: 730, cy: 120, r: 105, fill: '#ffe9a844' },
      { type: 'circle', cx: 730, cy: 120, r: 62, fill: '#ffe9a8' },
      { type: 'ellipse', cx: 225, cy: 130, rx: 95, ry: 38, fill: '#ffffffcc' },
      { type: 'ellipse', cx: 285, cy: 118, rx: 72, ry: 44, fill: '#ffffffcc' },
      { type: 'ellipse', cx: 340, cy: 138, rx: 55, ry: 30, fill: '#ffffffaa' },
      // 花茎与叶
      { type: 'line', points: [[400, 540], [415, 380], [430, 250]], stroke: '#5d8a5a', strokeWidth: 11 },
      { type: 'line', points: [[560, 540], [545, 400], [530, 300]], stroke: '#5d8a5a', strokeWidth: 9 },
      { type: 'polygon', points: [[415, 430], [335, 380], [365, 455]], fill: '#7fb069' },
      { type: 'polygon', points: [[545, 430], [625, 380], [598, 455]], fill: '#8fbe77' },
      { type: 'polygon', points: [[420, 360], [355, 325], [380, 390]], fill: '#6fa45f' },
      // 主花：两层花瓣 + 花心
      { type: 'circle', cx: 430, cy: 230, r: 56, fill: main },
      { type: 'circle', cx: 365, cy: 265, r: 52, fill: main },
      { type: 'circle', cx: 495, cy: 265, r: 52, fill: main },
      { type: 'circle', cx: 390, cy: 325, r: 50, fill: main },
      { type: 'circle', cx: 470, cy: 325, r: 50, fill: main },
      { type: 'circle', cx: 430, cy: 278, r: 34, fill: accent },
      { type: 'circle', cx: 420, cy: 270, r: 4, fill: '#6b4b2a' },
      { type: 'circle', cx: 442, cy: 286, r: 4, fill: '#6b4b2a' },
      // 副花
      { type: 'circle', cx: 530, cy: 315, r: 32, fill: '#f3a6b8' },
      { type: 'circle', cx: 500, cy: 340, r: 30, fill: '#f3a6b8' },
      { type: 'circle', cx: 558, cy: 345, r: 30, fill: '#f3a6b8' },
      { type: 'circle', cx: 530, cy: 360, r: 28, fill: '#f3a6b8' },
      { type: 'circle', cx: 530, cy: 338, r: 18, fill: '#ffe9a8' },
      // 草地与蝴蝶
      { type: 'rect', x: 0, y: 535, w: 900, h: 65, fill: '#8fbe77' },
      { type: 'line', points: [[90, 540], [100, 505], [112, 538]], stroke: '#5d8a5a', strokeWidth: 4 },
      { type: 'line', points: [[160, 542], [174, 508], [186, 540]], stroke: '#5d8a5a', strokeWidth: 4 },
      { type: 'ellipse', cx: 720, cy: 380, rx: 22, ry: 14, fill: '#f6a259' },
      { type: 'ellipse', cx: 754, cy: 380, rx: 22, ry: 14, fill: '#f6a259' },
      { type: 'line', points: [[737, 380], [737, 392]], stroke: '#5b3a34', strokeWidth: 2 },
      ...(title ? [{ type: 'text', x: 450, y: 42, text: title, size: 36, fill: '#3f3328', anchor: 'mt' }] : [])
    ]
  }),
  sky: ({ title = '', main = '#8cc5ea', bg = '#eaf4fb', accent = '#ffe9a8' } = {}) => ({
    width: 900, height: 600,
    background: { type: 'linear', from: '#b9e0f5', to: '#f8e9c9', angle: 90 },
    style: 'picturebook',
    shapes: [
      // 太阳光晕
      { type: 'circle', cx: 680, cy: 150, r: 125, fill: '#ffe9a833' },
      { type: 'circle', cx: 680, cy: 150, r: 86, fill: '#ffe9a866' },
      { type: 'circle', cx: 680, cy: 150, r: 58, fill: accent },
      // 云层
      { type: 'ellipse', cx: 245, cy: 230, rx: 105, ry: 45, fill: '#ffffffdd' },
      { type: 'ellipse', cx: 315, cy: 218, rx: 82, ry: 55, fill: '#ffffffdd' },
      { type: 'ellipse', cx: 380, cy: 238, rx: 62, ry: 38, fill: '#ffffffbb' },
      { type: 'ellipse', cx: 535, cy: 175, rx: 75, ry: 32, fill: '#ffffffaa' },
      { type: 'ellipse', cx: 590, cy: 165, rx: 55, ry: 38, fill: '#ffffffaa' },
      // 远山、中山、近山
      { type: 'polygon', points: [[0, 470], [160, 300], [320, 470], [470, 360], [620, 480], [0, 540]], fill: '#a8c9dd' },
      { type: 'polygon', points: [[300, 500], [470, 280], [620, 460], [760, 340], [900, 500], [900, 570], [300, 570]], fill: '#7fa9c4' },
      { type: 'polygon', points: [[0, 540], [220, 430], [390, 545], [560, 460], [760, 560], [900, 520], [900, 600], [0, 600]], fill: '#5d8a7a' },
      { type: 'polygon', points: [[420, 340], [470, 280], [520, 350], [485, 340], [470, 360], [450, 342]], fill: '#f3f7f8' },
      // 飞鸟
      { type: 'line', points: [[150, 140], [170, 128], [190, 140]], stroke: '#4d6478', strokeWidth: 3 },
      { type: 'line', points: [[210, 175], [226, 165], [242, 175]], stroke: '#4d6478', strokeWidth: 2.5 },
      { type: 'line', points: [[80, 190], [94, 181], [108, 190]], stroke: '#4d6478', strokeWidth: 2 },
      // 前景草地与小花
      { type: 'rect', x: 0, y: 565, w: 900, h: 35, fill: '#4f7a68' },
      { type: 'line', points: [[90, 570], [96, 545], [104, 568]], stroke: '#3f6557', strokeWidth: 3 },
      { type: 'circle', cx: 98, cy: 546, r: 5, fill: '#ffe9a8' },
      ...(title ? [{ type: 'text', x: 450, y: 44, text: title, size: 36, fill: '#2b3a55', anchor: 'mt' }] : [])
    ]
  }),
  day: ({ title = '', main = '#f6a259', bg = '#fdf3d9', accent = '#8cc5ea' } = {}) => ({
    width: 900, height: 600,
    background: { type: 'linear', from: bg, to: '#d8ecf7', angle: 90 },
    style: 'picturebook',
    shapes: [
      // 窗外天空
      { type: 'rect', x: 70, y: 60, w: 500, h: 360, fill: '#c9e8f5', radius: 18 },
      { type: 'circle', cx: 420, cy: 140, r: 82, fill: '#ffe9a833' },
      { type: 'circle', cx: 420, cy: 140, r: 48, fill: '#ffe9a8' },
      { type: 'ellipse', cx: 180, cy: 150, rx: 78, ry: 28, fill: '#ffffffdd' },
      { type: 'ellipse', cx: 235, cy: 140, rx: 55, ry: 34, fill: '#ffffffdd' },
      { type: 'ellipse', cx: 285, cy: 158, rx: 42, ry: 24, fill: '#ffffffbb' },
      { type: 'line', points: [[300, 80], [312, 71], [324, 80]], stroke: '#6d8ca3', strokeWidth: 2.5 },
      { type: 'line', points: [[338, 94], [347, 87], [356, 94]], stroke: '#6d8ca3', strokeWidth: 2 },
      { type: 'polygon', points: [[70, 360], [185, 275], [290, 360], [395, 300], [520, 370], [520, 420], [70, 420]], fill: '#9fc7a4' },
      { type: 'polygon', points: [[70, 385], [160, 330], [250, 390], [340, 345], [440, 392], [520, 360], [520, 420], [70, 420]], fill: '#7fae8b' },
      // 窗框
      { type: 'line', points: [[320, 60], [320, 420]], stroke: '#f7f1e3', strokeWidth: 10 },
      { type: 'line', points: [[70, 240], [570, 240]], stroke: '#f7f1e3', strokeWidth: 10 },
      { type: 'rect', x: 58, y: 48, w: 524, h: 384, fill: 'transparent', stroke: '#f7f1e3', strokeWidth: 12, radius: 22 },
      // 窗帘
      { type: 'polygon', points: [[70, 60], [155, 60], [130, 420], [70, 420]], fill: '#e8a7a0' },
      { type: 'polygon', points: [[570, 60], [485, 60], [510, 420], [570, 420]], fill: '#e8a7a0' },
      { type: 'line', points: [[110, 70], [105, 410]], stroke: '#d68f88', strokeWidth: 3 },
      { type: 'line', points: [[530, 70], [535, 410]], stroke: '#d68f88', strokeWidth: 3 },
      // 窗台与光
      { type: 'rect', x: 48, y: 420, w: 544, h: 20, fill: '#d9b48f', radius: 6 },
      { type: 'polygon', points: [[95, 440], [540, 440], [680, 560], [60, 560]], fill: '#ffe9a82e' },
      // 书桌、腿、地毯
      { type: 'rect', x: 60, y: 500, w: 780, h: 32, fill: '#b9825f', radius: 8 },
      { type: 'line', points: [[110, 532], [110, 590]], stroke: '#8f6048', strokeWidth: 10 },
      { type: 'line', points: [[790, 532], [790, 590]], stroke: '#8f6048', strokeWidth: 10 },
      { type: 'rect', x: 0, y: 585, w: 900, h: 15, fill: '#d8c3a5' },
      // 植物
      { type: 'rect', x: 600, y: 440, w: 74, h: 64, fill: '#d9774f', radius: 10 },
      { type: 'rect', x: 592, y: 432, w: 90, h: 14, fill: '#c46842', radius: 6 },
      { type: 'line', points: [[636, 435], [630, 370], [650, 330]], stroke: '#5d8a5a', strokeWidth: 6 },
      { type: 'line', points: [[636, 400], [600, 365], [580, 370]], stroke: '#5d8a5a', strokeWidth: 5 },
      { type: 'line', points: [[638, 380], [675, 345], [692, 350]], stroke: '#5d8a5a', strokeWidth: 5 },
      { type: 'ellipse', cx: 650, cy: 325, rx: 26, ry: 12, fill: '#7fb069' },
      { type: 'ellipse', cx: 580, cy: 365, rx: 22, ry: 10, fill: '#8fbe77' },
      { type: 'ellipse', cx: 692, cy: 347, rx: 22, ry: 10, fill: '#8fbe77' },
      // 杯子与书
      { type: 'rect', x: 700, y: 455, w: 38, h: 45, fill: '#9ed9c3', radius: 8 },
      { type: 'line', points: [[738, 466], [752, 472], [752, 486], [738, 492]], stroke: '#6fa899', strokeWidth: 5 },
      { type: 'ellipse', cx: 719, cy: 455, rx: 19, ry: 5, fill: '#d8f3ec' },
      { type: 'rect', x: 300, y: 470, w: 110, h: 18, fill: '#8cc5ea', radius: 4 },
      { type: 'rect', x: 306, y: 486, w: 98, h: 14, fill: '#6fa8cc', radius: 4 },
      { type: 'line', points: [[300, 470], [300, 488]], stroke: '#4d6478', strokeWidth: 3 },
      ...(title ? [{ type: 'text', x: 450, y: 36, text: title, size: 36, fill: '#5b4636', anchor: 'mt' }] : [])
    ]
  })
};

/** 按名字取模板；不认识的返回 night。 */
export function sceneFromPreset(name, opts = {}) {
  const key = String(name || '').trim().toLowerCase();
  const fn = PRESETS[key] || PRESETS.night;
  return fn(opts);
}
