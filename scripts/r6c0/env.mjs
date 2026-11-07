// R6-C 实验环境隔离（4.0 / R6-C0-A）。
//
// ── 铁律 ────────────────────────────────────────────────────────
//   · **不复制生产数据**构造实验环境
//   · **不复用生产 Session ID**
//   · 所有写入路径必须**规范化后**确认在实验根目录内
//   · 启动前检查：路径指向生产 → 直接拒绝
//
// ── 为什么"规范化后检查"很重要 ─────────────────────────────────
//   相对路径（`./x`）、`..` 穿越、符号链接都可能让「看起来在实验目录里」
//   的路径实际指向生产。所以每次检查都要：
//     ① path.resolve 成绝对路径
//     ② 检查是否以实验根目录为前缀（且边界正确，避免 /exp 匹配 /exp2）
//     ③ 拒绝任何等于/位于生产目录内的路径
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 实验根目录名（放在系统临时目录下，绝不放在项目目录里）。 */
const EXPERIMENT_PREFIX = 'qq-r6c-';

/** 生产路径（**只读**，任何写入尝试都要被拒绝）。 */
export function productionPaths() {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dataDir = process.env.QQ_AGENT_DATA_DIR
    ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
    : path.join(appRoot, 'data');
  return {
    appRoot,
    dataDir,
    dshHome: path.join(dataDir, 'dsh-home'),
    sessions: path.join(dataDir, 'dsh-home', 'sessions'),
    companion: path.join(dataDir, 'companion-state.json'),
    learned: path.join(dataDir, 'learned.json'),
    autonomous: path.join(dataDir, 'autonomous.json')
  };
}

/**
 * 判断 child 是否在 parent 内部（**边界安全**）。
 *
 * 不能用 `child.startsWith(parent)` —— `/exp` 会匹配 `/exp2`。
 * 必须比较 `path.relative` 或者带分隔符的前缀。
 */
export function isInside(parent, child) {
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 创建一个**全新的**实验环境（不复制任何生产数据）。
 *
 * @param {object} [o]
 * @param {string} [o.tag] 可选标签（会进目录名，便于区分多轮实验）
 * @returns {{ok:boolean, root?:string, dirs?:object, error?:string}}
 */
export function createExperiment({ tag = '' } = {}) {
  const safeTag = String(tag || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 24);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), EXPERIMENT_PREFIX + (safeTag ? safeTag + '-' : '')));

  const dirs = {
    root,
    dshHome: path.join(root, 'dsh-home'),
    cwd: path.join(root, 'work'),
    logs: path.join(root, 'logs'),
    results: path.join(root, 'results'),
    tmp: path.join(root, 'tmp')
  };

  for (const d of [dirs.dshHome, dirs.cwd, dirs.logs, dirs.results, dirs.tmp]) {
    fs.mkdirSync(d, { recursive: true });
  }

  // 写一个 manifest，记录这次实验的身份（清理时据此确认"这确实是我的实验目录"）
  fs.writeFileSync(path.join(root, 'experiment.json'), JSON.stringify({
    created: new Date().toISOString(),
    tag: safeTag,
    dirs,
    version: 1
  }, null, 1), 'utf8');

  return { ok: true, root, dirs };
}

/**
 * 校验一个实验环境**确实是**实验环境，且没有指向生产。
 *
 * @param {object} dirs createExperiment 返回的 dirs
 * @returns {{ok:boolean, error?:string, reason?:string}}
 */
export function validateExperiment(dirs) {
  if (!dirs || !dirs.root) {
    return { ok: false, error: '实验目录不存在', reason: 'NO_ROOT' };
  }

  const root = path.resolve(dirs.root);
  const prod = productionPaths();

  // ① 根目录必须存在
  if (!fs.existsSync(root)) {
    return { ok: false, error: `实验根目录不存在：${root}`, reason: 'ROOT_MISSING' };
  }

  // ② 根目录名必须带实验前缀（防止误传一个随便的目录）
  if (!path.basename(root).startsWith(EXPERIMENT_PREFIX)) {
    return {
      ok: false,
      error: `实验根目录名必须以 ${EXPERIMENT_PREFIX} 开头：${path.basename(root)}`,
      reason: 'BAD_PREFIX'
    };
  }

  // ③ 根目录必须在系统临时目录内（不放在项目目录里）
  if (!isInside(os.tmpdir(), root)) {
    return { ok: false, error: `实验根目录必须在系统临时目录内：${root}`, reason: 'NOT_IN_TMP' };
  }

  // ④ **绝不能**落在生产目录的任何位置
  for (const [k, v] of Object.entries(prod)) {
    if (!v) continue;
    if (isInside(v, root) || root === path.resolve(v)) {
      return { ok: false, error: `实验根目录落在生产路径 ${k} 里：${root}`, reason: 'INSIDE_PRODUCTION' };
    }
  }

  // ⑤ 每个子目录都必须存在且在根内
  for (const key of ['dshHome', 'cwd', 'logs', 'results', 'tmp']) {
    const d = dirs[key];
    if (!d) return { ok: false, error: `缺少子目录定义：${key}`, reason: 'MISSING_DIR' };
    if (!fs.existsSync(d)) return { ok: false, error: `子目录不存在：${d}`, reason: 'DIR_MISSING' };
    if (!isInside(root, d)) {
      return { ok: false, error: `子目录 ${key} 不在实验根内：${d}`, reason: 'DIR_OUTSIDE_ROOT' };
    }
  }

  return { ok: true };
}

/**
 * 断言一个写入路径**安全**（在实验根内，且不在生产里）。
 *
 * @param {object} dirs
 * @param {string} target 要写入的路径
 * @returns {{ok:boolean, resolved?:string, error?:string}}
 */
export function assertSafeWrite(dirs, target) {
  if (!target || !String(target).trim()) {
    return { ok: false, error: '写入路径为空' };
  }
  const v = validateExperiment(dirs);
  if (!v.ok) return { ok: false, error: `实验环境无效：${v.error}` };

  const root = path.resolve(dirs.root);
  // **先规范化再判断** —— 挡住 `..`、相对路径、符号链接
  const resolved = fs.existsSync(target)
    ? fs.realpathSync(target)          // 存在时解析符号链接
    : path.resolve(target);

  if (!isInside(root, resolved)) {
    return { ok: false, error: `拒绝写入实验根之外的路径：${resolved}`, resolved };
  }

  const prod = productionPaths();
  for (const [k, v2] of Object.entries(prod)) {
    if (!v2) continue;
    if (isInside(v2, resolved)) {
      return { ok: false, error: `拒绝写入生产路径 ${k}：${resolved}`, resolved };
    }
  }

  return { ok: true, resolved };
}

/** 收集一组目录的文件清单 + hash（用于实验前后对比）。 */
export function snapshot(dir) {
  const out = { dir: path.resolve(dir), files: [], totalBytes: 0, hash: '' };
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      try {
        const st = fs.statSync(p);
        const buf = fs.readFileSync(p);
        out.files.push({
          path: path.relative(out.dir, p),
          size: st.size,
          mtime: st.mtimeMs,
          sha256: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)
        });
        out.totalBytes += st.size;
      } catch { /* 读不了就跳过 */ }
    }
  };
  walk(out.dir);
  out.files.sort((a, b) => a.path.localeCompare(b.path));
  out.hash = crypto.createHash('sha256')
    .update(out.files.map((f) => `${f.path}:${f.size}:${f.sha256}`).join('\n'))
    .digest('hex')
    .slice(0, 16);
  out.count = out.files.length;
  return out;
}

/** 实验环境的一句话摘要（日志用）。 */
export function describe(dirs) {
  return `实验根=${dirs.root}  DSH_HOME=${dirs.dshHome}  cwd=${dirs.cwd}`;
}

export const __internals = { EXPERIMENT_PREFIX };
