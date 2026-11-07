// R6-C 实验清理与回滚（4.0 / R6-C0-D）。
//
// ── 机主的硬要求 ────────────────────────────────────────────────
//   · 清理脚本必须拒绝：生产路径、根目录、空路径、
//     以及**规范化后指向实验目录之外**的路径
//   · 不得在清理时触碰生产 DSH_HOME 或生产 Session
//   · 清理前二次确认
//   · 清理前后 hash 和文件清单
//
// ── 为什么清理这么小心 ──────────────────────────────────────────
//   清理脚本是"删除"操作，一旦误判就是不可逆的数据丢失。
//   所以这里采取**三重确认**：
//     ① 路径必须在系统临时目录内
//     ② 路径名必须带实验前缀（qq-r6c-）
//     ③ 目录里必须有我们写的 experiment.json（身份证明）
//   三条都满足才允许删。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isInside, productionPaths, snapshot, __internals as envInternals } from './env.mjs';

const PREFIX = envInternals.EXPERIMENT_PREFIX;

/**
 * 检查一个目录**能不能被安全删除**。
 *
 * @param {string} root
 * @returns {{ok:boolean, reason?:string, error?:string}}
 */
export function checkDeletable(root) {
  // ① 空路径
  if (!root || !String(root).trim()) {
    return { ok: false, reason: 'EMPTY', error: '路径为空，拒绝删除' };
  }

  // ② 必须存在
  let resolved;
  try {
    resolved = fs.realpathSync(root);       // 解析符号链接后再判断
  } catch {
    return { ok: false, reason: 'NOT_EXIST', error: `路径不存在：${root}` };
  }

  // ③ 不能是磁盘根 / 系统根
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) {
    return { ok: false, reason: 'IS_ROOT', error: `拒绝删除磁盘根目录：${resolved}` };
  }

  // ④ 必须在系统临时目录内
  if (!isInside(os.tmpdir(), resolved)) {
    return { ok: false, reason: 'NOT_IN_TMP', error: `只允许清理系统临时目录内的实验目录：${resolved}` };
  }

  // ⑤ 目录名必须带实验前缀
  if (!path.basename(resolved).startsWith(PREFIX)) {
    return {
      ok: false,
      reason: 'BAD_PREFIX',
      error: `目录名必须以 ${PREFIX} 开头（这看起来不像实验目录）：${path.basename(resolved)}`
    };
  }

  // ⑥ **绝不能**落在生产路径里
  const prod = productionPaths();
  for (const [k, v] of Object.entries(prod)) {
    if (!v) continue;
    if (isInside(v, resolved) || resolved === path.resolve(v)) {
      return { ok: false, reason: 'INSIDE_PRODUCTION', error: `拒绝删除生产路径 ${k} 内的目录：${resolved}` };
    }
  }

  // ⑦ 必须是我们写的实验目录（有 experiment.json 身份证明）
  const manifest = path.join(resolved, 'experiment.json');
  if (!fs.existsSync(manifest)) {
    return {
      ok: false,
      reason: 'NO_MANIFEST',
      error: `目录里没有 experiment.json，无法确认这是本工具创建的实验目录：${resolved}`
    };
  }
  try {
    const j = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (j?.version !== 1) {
      return { ok: false, reason: 'BAD_MANIFEST', error: `experiment.json 版本不对：${j?.version}` };
    }
  } catch (e) {
    return { ok: false, reason: 'BAD_MANIFEST', error: `experiment.json 读不了：${e?.message ?? e}` };
  }

  return { ok: true, resolved };
}

/**
 * 清理一个实验目录。
 *
 * @param {string} root
 * @param {object} [o]
 * @param {boolean} [o.dryRun] 只报告不删（默认 true —— **默认不删**）
 * @param {boolean} [o.confirm] 二次确认（必须显式传 true 才真删）
 * @returns {{ok:boolean, dryRun?:boolean, deleted?:boolean, before?:object, after?:object, error?:string, reason?:string}}
 */
export function cleanupExperiment(root, { dryRun = true, confirm = false } = {}) {
  const chk = checkDeletable(root);
  if (!chk.ok) {
    return { ok: false, reason: chk.reason, error: chk.error };
  }

  const resolved = chk.resolved;
  const before = snapshot(resolved);

  // 默认演练：盘点但不删
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      deleted: false,
      before,
      message: `演练：将删除 ${resolved}（${before.count} 个文件，${before.totalBytes} 字节）`
    };
  }

  // 真删必须二次确认
  if (!confirm) {
    return {
      ok: false,
      reason: 'NO_CONFIRM',
      error: '真删需要 confirm: true（默认是演练模式）',
      before
    };
  }

  try {
    fs.rmSync(resolved, { recursive: true, force: false });
  } catch (e) {
    return { ok: false, reason: 'DELETE_FAILED', error: `删除失败：${e?.message ?? e}`, before };
  }

  const after = fs.existsSync(resolved) ? snapshot(resolved) : { count: 0, totalBytes: 0, hash: '', files: [] };
  return { ok: true, dryRun: false, deleted: !fs.existsSync(resolved), before, after };
}

/**
 * 列出所有实验目录（用于清理前的盘点）。
 *
 * @returns {Array<{root:string, tag:string, created:string, files:number, bytes:number, deletable:boolean, reason?:string}>}
 */
export function listExperiments() {
  const tmp = os.tmpdir();
  let ents = [];
  try { ents = fs.readdirSync(tmp, { withFileTypes: true }); } catch { return []; }

  const out = [];
  for (const e of ents) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith(PREFIX)) continue;
    const root = path.join(tmp, e.name);
    let tag = '';
    let created = '';
    try {
      const j = JSON.parse(fs.readFileSync(path.join(root, 'experiment.json'), 'utf8'));
      tag = String(j.tag || '');
      created = String(j.created || '');
    } catch { /* 没有 manifest 也列出来，但会被标成不可删 */ }

    let files = 0; let bytes = 0;
    try {
      const s = snapshot(root);
      files = s.count;
      bytes = s.totalBytes;
    } catch { /* ignore */ }

    const chk = checkDeletable(root);
    out.push({ root, tag, created, files, bytes, deletable: chk.ok, reason: chk.reason });
  }
  return out.sort((a, b) => a.created.localeCompare(b.created));
}

/**
 * 实验中断后的恢复说明（不自动执行，只输出指引）。
 *
 * @param {string} root
 * @returns {string}
 */
export function recoveryGuide(root) {
  return [
    '# 实验中断后的恢复指引',
    '',
    `实验目录：${root}`,
    '',
    '## 如果实验跑了一半',
    '1. **不要直接删目录** —— 先看 results/ 里有没有已完成的样本',
    '2. 看 logs/ 里最后一次失败在哪一步',
    '3. 生产数据完全没被碰过（实验用的是独立 DSH_HOME），不需要恢复',
    '',
    '## 如果要重跑',
    '1. 用 `createExperiment({ tag: "重跑" })` 建**新的**目录，不要复用旧的',
    '2. 旧目录留着对比（或按 listExperiments 的清单清理）',
    '',
    '## 如果实验进程还在跑',
    '1. 先 `taskkill /F /PID <pid>` 结束它',
    '2. 确认 DSH 子进程也退了（`Get-Process node`）',
    '3. 再清理目录',
    '',
    '## 生产数据检查',
    '实验**不应该**碰生产。如果怀疑碰了，用这三个 hash 对比：',
    '· data/companion-state.json',
    '· data/learned.json',
    '· data/autonomous.json',
    '',
    '## 清理',
    '```',
    `node scripts/r6c0/cleanup.mjs --list            # 列出所有实验目录`,
    `node scripts/r6c0/cleanup.mjs --dir <路径>        # 演练（默认不删）`,
    `node scripts/r6c0/cleanup.mjs --dir <路径> --yes  # 真删`,
    '```'
  ].join('\n');
}
