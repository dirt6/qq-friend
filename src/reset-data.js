// reset-data 领域模块（D1-3b-B4）。
//
// 定位：**分阶段的跨目录重置，不是跨文件原子事务。**
//   data  scope：备份 DATA_DIR → 校验 → 删除子项（跳过 qq-agent.lock）→ 校验
//   diary scope：只备份日记根 → 删除完成后重算正文 hash 对比（**正文不删除**）
//
// 硬约束：
//   · 有未完成日记操作 / pending.json 损坏 / idempotency pending → 拒绝（fail-closed）
//   · 备份逐文件 SHA256 校验；删除前再校验一次源文件，任何不一致立即中止
//   · manifest 是唯一事实来源（schemaVersion/backupId/规范化路径/双边备份/hash/状态/时间/失败原因/自校验）
//   · 崩溃后按 status 恢复；**不把两个目录描述成原子事务**（manifest.atomic 恒为 false）
//   · 删除不可回滚；备份是唯一恢复来源；不自动删除/整理历史备份
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeFileAtomic, withFileLockAsync } from './file-lock.js';
import { beginResetBarrier, endResetBarrier } from './reset-barrier.js';

export const SCHEMA = 2;
export const BACKUP_SUFFIX = '.reset-backups';
const LOCK_NAME = 'qq-agent.lock';
const PENDING_REL = 'diary-meta/pending.json';
const IDEM_NAME = 'diary-idempotency.json';

/** 显式阶段状态（B4-3）。崩溃后靠它判断“备份到哪、删到没删”。 */
export const STATUS = {
  PREPARED: 'prepared',
  BACKUP_IN_PROGRESS: 'backup_in_progress',
  BACKUP_VERIFIED: 'backup_verified',
  DELETE_IN_PROGRESS: 'delete_in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed',
  NEEDS_MANUAL: 'needs_manual_recovery'
};
const UNFINISHED_STATUSES = new Set([STATUS.DELETE_IN_PROGRESS, STATUS.NEEDS_MANUAL]);

const nowIso = () => new Date().toISOString();
const sha256Text = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

/** 稳定 JSON（递归按 key 排序），用于 manifest 自校验，不受字段顺序/缩进影响。 */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function manifestChecksumOf(manifest) {
  const { manifestChecksum, ...rest } = manifest;
  return crypto.createHash('sha256').update(canonicalJson(rest)).digest('hex');
}

/** 备份根：默认与 DATA_DIR 同级；测试可用 QQ_AGENT_RESET_BACKUP_DIR 覆盖。 */
export function defaultBackupRoot(dataDir) {
  const override = String(process.env.QQ_AGENT_RESET_BACKUP_DIR || '').trim();
  if (override) return path.resolve(override);
  return path.resolve(String(dataDir)) + BACKUP_SUFFIX;
}

/** 解析真实路径：不存在的尾段拼到最近存在祖先的 realpath 上。 */
function realish(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const rest = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const rp = fs.realpathSync.native(cur);
      return rest.length ? path.join(rp, ...rest.reverse()) : rp;
    } catch (e) {
      const code = e?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`路径解析失败（${code ?? 'UNKNOWN'}）：${cur}`);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error(`无法可靠解析路径：${abs}`);
}

const norm = (p) => realish(p).replace(/[\\/]+/g, '\\').toLowerCase();
const isUnder = (child, parent) => child === parent || child.startsWith(parent + '\\');

// Windows 上 junction 的 lstat().isSymbolicLink() 是 false（会被当成普通目录），
// 必须用 realpath 是否偏离自身来识别，否则备份会跟随复制、删除会递归删到根外。
const normReal = (p) => path.resolve(String(p)).toLowerCase();
function isReparsePoint(p, st) {
  if (st.isSymbolicLink()) return true;
  try {
    return normReal(fs.realpathSync.native(p)) !== normReal(p);
  } catch (e) {
    if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return true; // 断链：按链接处理，不递归
    throw new Error(`无法判定是否为链接（${e?.code ?? 'UNKNOWN'}），拒绝继续：${p}`);
  }
}

/** 测试隔离门禁：DIARY_TEST_GUARD=1 时，所有路径必须位于 DIARY_TEST_TMP 内。 */
function assertTestIsolation(paths) {
  if (String(process.env.DIARY_TEST_GUARD || '') !== '1') return;
  const tmp = String(process.env.DIARY_TEST_TMP || '');
  if (!tmp) throw new Error('EResetGuard: 未设置 DIARY_TEST_TMP（测试启动器缺失）');
  const root = norm(tmp);
  for (const [key, value] of Object.entries(paths)) {
    if (!value) continue;
    if (!isUnder(norm(value), root)) {
      throw new Error(`EResetGuard: ${key} 不在测试临时根内：${value}`);
    }
  }
}

function newOpId() {
  return `${nowIso().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
}

/* ── 路径解析与前置校验 ─────────────────────────────────────────────── */

/**
 * 解析并校验三个路径。返回 refusals 而不是直接抛（常见配置错误要能展示给用户）。
 * 测试门禁违规仍然抛出（fail-closed）。
 */
export function resolveResetPaths({ dataDir, diaryRoot = '', backupRoot = '' } = {}) {
  const rawData = String(dataDir || '').trim();
  if (!rawData) throw new Error('缺少 dataDir（拒绝在未指定数据目录时重置）');
  const data = path.resolve(rawData);
  const diary = String(diaryRoot || '').trim() ? path.resolve(String(diaryRoot)) : '';
  const backup = path.resolve(String(backupRoot || defaultBackupRoot(data)));

  assertTestIsolation({ dataDir: data, diaryRoot: diary, backupRoot: backup });

  const refusals = [];
  let dataStat = null;
  try {
    dataStat = fs.statSync(data);
  } catch (e) {
    refusals.push(`数据目录不存在或不可访问：${data}（${e?.code ?? 'UNKNOWN'}）`);
  }
  if (dataStat && !dataStat.isDirectory()) refusals.push(`数据目录不是目录：${data}`);
  if (path.parse(data).root === data) refusals.push(`拒绝重置磁盘根目录：${data}`);

  let dataReal = '';
  let diaryReal = '';
  let backupReal = '';
  try {
    dataReal = realish(data);
    if (diary) diaryReal = realish(diary);
    backupReal = realish(backup);
  } catch (e) {
    refusals.push(String(e?.message ?? e));
  }

  if (dataReal && diaryReal) {
    if (isUnder(diaryReal, dataReal)) {
      refusals.push(`日记根位于数据目录内，重置会连带删除正文，已拒绝：${diary}`);
    }
  }
  if (dataReal && backupReal) {
    if (isUnder(backupReal, dataReal)) {
      refusals.push(`备份目录位于数据目录内，删除 data 会连备份一起删掉，已拒绝：${backup}`);
    }
  }
  if (diaryReal && backupReal && isUnder(backupReal, diaryReal)) {
    refusals.push(`备份目录位于日记根内，日记备份会自我递归，已拒绝：${backup}`);
  }

  return {
    dataDir: data,
    diaryRoot: diary,
    backupRoot: backup,
    dataDirReal: dataReal,
    diaryRootReal: diaryReal,
    backupRootReal: backupReal,
    dataExists: Boolean(dataStat?.isDirectory?.()),
    refusals
  };
}

/* ── pending / idempotency 严格读取（损坏必须拒绝，不能当成空） ─────── */

export function readPendingState(dataDir) {
  const file = path.join(dataDir, 'diary-meta', 'pending.json');
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, file, exists: false, unfinished: [], sha256: '' };
    return { ok: false, file, error: `pending.json 不可读（${e?.code ?? 'UNKNOWN'}），拒绝重置：${file}` };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, file, error: `pending.json 损坏，拒绝重置（请先人工核对）：${file}` };
  }
  if (!json || typeof json !== 'object' || !json.items || typeof json.items !== 'object') {
    return { ok: false, file, error: `pending.json 结构不合法，拒绝重置：${file}` };
  }
  const unfinished = Object.entries(json.items)
    .filter(([, it]) => it && it.stage !== 'completed')
    .map(([id, it]) => ({
      id,
      op: String(it.op ?? ''),
      dateKey: String(it.dateKey ?? ''),
      stage: String(it.stage ?? '')
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, file, exists: true, unfinished, sha256: sha256Text(raw) };
}

export function readIdempotencyState(dataDir) {
  const file = path.join(dataDir, IDEM_NAME);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: true, file, exists: false, pending: [], sha256: '' };
    return { ok: false, file, error: `diary-idempotency.json 不可读（${e?.code ?? 'UNKNOWN'}），拒绝重置：${file}` };
  }
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, file, error: `diary-idempotency.json 损坏，拒绝重置（请先人工核对）：${file}` };
  }
  if (!json || typeof json !== 'object' || !json.keys || typeof json.keys !== 'object') {
    return { ok: false, file, error: `diary-idempotency.json 结构不合法，拒绝重置：${file}` };
  }
  const pending = Object.entries(json.keys)
    .filter(([, v]) => v && v.state === 'pending')
    .map(([key, v]) => ({ key, day: String(v.day ?? '') }))
    .sort((a, b) => a.key.localeCompare(b.key));
  return { ok: true, file, exists: true, pending, sha256: sha256Text(raw) };
}

/* ── manifest 读写 ─────────────────────────────────────────────────── */

export function manifestPathOf(backupDir) {
  return path.join(backupDir, 'manifest.json');
}

let manifestWriteCount = 0;

/** 测试注入：DIARY_TEST_GUARD=1 且 QQ_RESET_TEST_FAIL_MANIFEST_AT=N 时，第 N 次写 manifest 抛错。 */
function maybeFailManifestWrite() {
  if (String(process.env.DIARY_TEST_GUARD || '') !== '1') return;
  const at = Number(process.env.QQ_RESET_TEST_FAIL_MANIFEST_AT || 0);
  if (at > 0 && manifestWriteCount === at) throw new Error(`manifest 写入失败（测试注入，第 ${at} 次）`);
}

function writeManifest(backupDir, manifest) {
  manifestWriteCount += 1;
  maybeFailManifestWrite();
  manifest.manifestChecksum = manifestChecksumOf(manifest);
  writeFileAtomic(manifestPathOf(backupDir), JSON.stringify(manifest, null, 1));
}

/** v1（上一版）→ v2 视图，便于旧备份仍可核验/恢复。 */
function normalizeLegacyManifest(m) {
  const stage = m?.stages?.data?.stage || '';
  let status = STATUS.PREPARED;
  if (stage === 'completed') status = STATUS.COMPLETED;
  else if (stage === 'deleted' || stage === 'removing') status = STATUS.DELETE_IN_PROGRESS;
  else if (stage === 'backed_up') status = STATUS.BACKUP_VERIFIED;
  else if (stage === 'failed') status = STATUS.FAILED;
  const files = m?.files || {};
  const dataFiles = Array.isArray(files.data) ? files.data : [];
  const diaryFiles = Array.isArray(files.diary) ? files.diary : [];
  return {
    ...m,
    schemaVersion: 1,
    backupId: m.opId,
    status,
    sourceRoots: [
      { id: 'data', path: m?.paths?.dataDir || '', realPath: m?.paths?.dataDirReal || '', files: dataFiles.length, bytes: dataFiles.reduce((s, f) => s + Number(f.size || 0), 0), skipped: [LOCK_NAME] },
      ...(m?.paths?.diaryRoot ? [{ id: 'diary', path: m.paths.diaryRoot, realPath: m.paths.diaryRootReal || '', files: diaryFiles.length, bytes: diaryFiles.reduce((s, f) => s + Number(f.size || 0), 0), skipped: [] }] : [])
    ],
    totals: {
      files: dataFiles.length + diaryFiles.length,
      bytes: [...dataFiles, ...diaryFiles].reduce((s, f) => s + Number(f.size || 0), 0)
    },
    legacy: true
  };
}

/**
 * 读 manifest。返回 { ok, manifest, checksumOk }。
 * schema 1（旧）自动升级视图；schema 不匹配或 JSON 损坏 → ok:false（fail-closed）。
 */
export function readManifest(backupDir) {
  let m;
  try {
    m = JSON.parse(fs.readFileSync(manifestPathOf(backupDir), 'utf8'));
  } catch (e) {
    return { ok: false, error: `manifest 不可读：${String(e?.message ?? e)}` };
  }
  if (!m || m.kind !== 'reset' || !(m.schemaVersion || m.schema) || !(m.backupId || m.opId)) {
    return { ok: false, error: 'manifest 不完整或 schema 不匹配' };
  }
  if (m.schemaVersion === 1 || m.schema === 1) {
    return { ok: true, manifest: normalizeLegacyManifest(m), checksumOk: true, legacy: true };
  }
  if (m.schemaVersion !== SCHEMA) {
    return { ok: false, error: `manifest schemaVersion 不支持：${m.schemaVersion}` };
  }
  const checksumOk = typeof m.manifestChecksum === 'string' && m.manifestChecksum === manifestChecksumOf(m);
  return { ok: true, manifest: m, checksumOk, legacy: false };
}

/** 列出 backupRoot 下所有可识别 manifest（按 createdAt 倒序）。 */
export function listResetOps({ backupRoot } = {}) {
  const root = path.resolve(String(backupRoot || defaultBackupRoot(process.cwd())));
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const dir = path.join(root, name);
    const r = readManifest(dir);
    if (!r.ok) {
      // manifest 存在但损坏/不可读：不能当作“没有备份”，要能被 preflight 看见。
      let hasManifest = false;
      try { hasManifest = fs.existsSync(manifestPathOf(dir)); } catch { /* ignore */ }
      if (hasManifest) {
        out.push({
          opId: name, backupDir: dir, createdAt: '', finishedAt: '', result: '', status: 'invalid',
          atomic: false, dataDir: '', diaryRoot: '', dataStage: '', diaryStage: '',
          files: { data: 0, diary: 0 }, error: r.error, checksumOk: false, unfinished: true, invalid: true
        });
      }
      continue;
    }
    const m = r.manifest;
    const id = m.backupId || m.opId;
    out.push({
      opId: id,
      backupId: id,
      backupDir: dir,
      createdAt: m.createdAt,
      finishedAt: m.finishedAt || '',
      status: m.status || '',
      result: m.result || '',
      atomic: m.atomic === true,
      dataDir: m?.paths?.dataDir || '',
      diaryRoot: m?.paths?.diaryRoot || '',
      dataStage: m?.stages?.data?.stage || '',
      diaryStage: m?.stages?.diary?.stage || '',
      files: {
        data: (m.files?.data || []).length,
        diary: (m.files?.diary || []).length,
        total: Number(m?.totals?.files || 0)
      },
      bytes: Number(m?.totals?.bytes || 0),
      legacy: Boolean(r.legacy),
      checksumOk: r.checksumOk !== false,
      error: m.error || '',
      unfinished: isUnfinishedManifest(m, r.checksumOk)
    });
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 删除可能已开始、结果不明、或 manifest 自校验失败 → 视为未完成（需要 resume/人工）。 */
function isUnfinishedManifest(m, checksumOk = true) {
  if (checksumOk === false) return true;
  const status = m?.status || '';
  if (UNFINISHED_STATUSES.has(status)) return true;
  if (status === STATUS.FAILED && Number(m?.deleted?.entries || 0) > 0) return true;
  const stage = m?.stages?.data?.stage || '';
  if (stage === 'removing' || stage === 'deleted') return true;
  if (m?.result === 'failed' && Number(m?.deleted?.entries || 0) > 0) return true;
  return false;
}

export function findUnfinishedResets({ backupRoot, dataDir } = {}) {
  const target = norm(dataDir);
  return listResetOps({ backupRoot }).filter((op) => op.unfinished && norm(op.dataDir) === target);
}

/* ── 预检 ──────────────────────────────────────────────────────────── */

async function statTree(root, skipRoot = []) {
  let files = 0;
  let bytes = 0;
  const walk = async (dir, isRoot = false) => {
    let ents = [];
    try { ents = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (isRoot && skipRoot.includes(e.name)) continue;
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (isReparsePoint(p, st)) continue; // 链接/junction 不跟随、不计数
      if (st.isDirectory()) await walk(p);
      else if (st.isFile()) { files += 1; bytes += st.size; }
    }
  };
  await walk(root, true);
  return { files, bytes };
}

/**
 * 只读预检：能不能重置、会删什么、备份到哪、为什么拒绝。
 * 不创建目录、不写文件。
 */
export async function preflightReset({ dataDir, diaryRoot = '', backupRoot = '' } = {}) {
  const refusals = [];
  let paths;
  try {
    paths = resolveResetPaths({ dataDir, diaryRoot, backupRoot });
  } catch (e) {
    return { ok: false, canReset: false, refusals: [String(e?.message ?? e)], paths: null };
  }
  refusals.push(...paths.refusals);

  const pending = paths.dataExists ? readPendingState(paths.dataDir) : { ok: true, exists: false, unfinished: [] };
  if (!pending.ok) refusals.push(pending.error);
  else if (pending.unfinished.length) {
    const ids = pending.unfinished.slice(0, 10).map((it) => `${it.id}(${it.op}/${it.dateKey}/${it.stage})`);
    refusals.push(`存在 ${pending.unfinished.length} 个未完成日记操作（stage≠completed），请先对账：${ids.join('，')}${pending.unfinished.length > 10 ? '…' : ''}`);
  }

  const idem = paths.dataExists ? readIdempotencyState(paths.dataDir) : { ok: true, exists: false, pending: [] };
  if (!idem.ok) refusals.push(idem.error);
  else if (idem.pending.length) {
    refusals.push(`存在 ${idem.pending.length} 个未确认的日记幂等键（state=pending），请先人工核对：${idem.pending.slice(0, 10).map((k) => k.key).join('，')}`);
  }

  let unfinishedResets = [];
  if (paths.dataExists) {
    try {
      unfinishedResets = findUnfinishedResets({ backupRoot: paths.backupRoot, dataDir: paths.dataDir });
      if (unfinishedResets.length) {
        refusals.push(`存在未完成的 reset 操作（删除阶段可能已开始），请先 resume 或人工处理：${unfinishedResets.map((o) => o.opId).join('，')}`);
      }
    } catch (e) {
      refusals.push(`无法检查历史 reset manifest：${String(e?.message ?? e)}`);
    }
  }

  let dataStats = { files: 0, bytes: 0 };
  let diaryStats = { exists: false, files: 0, bytes: 0 };
  if (paths.dataExists) dataStats = await statTree(paths.dataDir, [LOCK_NAME]);
  if (paths.diaryRoot && fs.existsSync(paths.diaryRoot)) {
    diaryStats = { exists: true, ...(await statTree(paths.diaryRoot)) };
  }

  return {
    ok: true,
    schema: SCHEMA,
    canReset: refusals.length === 0,
    refusals,
    paths: {
      dataDir: paths.dataDir,
      diaryRoot: paths.diaryRoot,
      backupRoot: paths.backupRoot
    },
    data: dataStats,
    diary: diaryStats,
    pending: { file: pending.file || PENDING_REL, exists: Boolean(pending.exists), count: (pending.unfinished || []).length },
    idem: { file: idem.file || IDEM_NAME, exists: Boolean(idem.exists), count: (idem.pending || []).length },
    unfinishedResets: unfinishedResets.map((o) => o.opId)
  };
}

/* ── 复制 + 逐文件校验 ─────────────────────────────────────────────── */

async function hashFile(file) {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) h.update(chunk);
  return h.digest('hex');
}

async function copyAndVerify(src, dst, rel, hooks) {
  if (hooks && typeof hooks.failFileRel === 'string' && hooks.failFileRel === rel) {
    throw new Error(`备份失败（测试注入）：${rel}`);
  }
  const srcHash = await hashFile(src);
  await fsp.copyFile(src, dst);
  const dstHash = await hashFile(dst);
  if (srcHash !== dstHash) throw new Error(`备份校验失败：${rel}`);
  const st = await fsp.stat(dst);
  return { sha256: srcHash, size: st.size };
}

/**
 * 递归复制目录到 dst；记录文件 hash / 目录 / 链接。
 * 重解析点只记录 target，不跟随复制；未知类型直接失败（不静默漏备份）。
 */
async function copyTree({ src, dst, scope, skipRoot = [], hooks }) {
  const files = [];
  const dirs = [];
  const links = [];
  await fsp.mkdir(dst, { recursive: true });
  const walk = async (abs, rel) => {
    const ents = await fsp.readdir(abs, { withFileTypes: true });
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      if (!rel && skipRoot.includes(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const from = path.join(abs, e.name);
      const to = path.join(dst, ...childRel.split('/'));
      const st = await fsp.lstat(from);
      if (isReparsePoint(from, st)) {
        let target = '';
        try { target = await fsp.readlink(from); } catch { target = ''; }
        links.push({ scope, rel: childRel, target });
        continue;
      }
      if (st.isDirectory()) {
        dirs.push(childRel);
        await fsp.mkdir(to, { recursive: true });
        await walk(from, childRel);
        continue;
      }
      if (st.isFile()) {
        files.push({ rel: childRel, ...(await copyAndVerify(from, to, childRel, hooks)) });
        continue;
      }
      throw new Error(`不支持的条目类型，拒绝备份（避免静默漏备份）：${scope}/${childRel}`);
    }
  };
  await walk(src, '');
  return { files, dirs, links };
}

/* ── 源目录与 manifest 比对（删除前 / 恢复前） ─────────────────────── */

function walkCurrent(root, skipRoot = []) {
  const files = new Map();
  const links = new Map();
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (!rel && skipRoot.includes(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (isReparsePoint(p, st)) {
        let target = '';
        try { target = fs.readlinkSync(p); } catch { target = ''; }
        links.set(childRel, target);
        continue;
      }
      if (st.isDirectory()) { walk(p, childRel); continue; }
      if (st.isFile()) files.set(childRel, { size: st.size });
    }
  };
  walk(root, '');
  return { files, links };
}

/**
 * 对比当前目录与 manifest。
 * @param {'before_delete'|'resume'} mode before_delete 要求完全一致；resume 允许已删除
 */
export async function compareWithManifest({ root, entries, links = [], skipRoot = [], mode = 'before_delete' }) {
  const current = walkCurrent(root, skipRoot);
  const recorded = new Map(entries.map((f) => [f.rel, f]));
  const changed = [];
  const missing = [];
  const extra = [];
  for (const [rel, rec] of recorded) {
    const cur = current.files.get(rel);
    if (!cur) {
      if (mode === 'before_delete') missing.push(rel);
      continue;
    }
    const h = await hashFile(path.join(root, ...rel.split('/')));
    if (h !== rec.sha256 || cur.size !== rec.size) changed.push(rel);
  }
  for (const rel of current.files.keys()) if (!recorded.has(rel)) extra.push(rel);
  const recordedLinks = new Map(links.map((l) => [l.rel, l.target]));
  const linkChanged = [];
  for (const [rel, target] of recordedLinks) {
    if (!current.links.has(rel)) continue;           // 已删/不存在不算失败
    if (current.links.get(rel) !== target) linkChanged.push(rel);
  }
  for (const rel of current.links.keys()) if (!recordedLinks.has(rel)) extra.push(rel);
  const ok = changed.length === 0 && missing.length === 0 && extra.length === 0 && linkChanged.length === 0;
  return { ok, changed, missing, extra, linkChanged };
}

/* ── 删除 ──────────────────────────────────────────────────────────── */

// 只删链接本身：junction/目录符号链接用 rmdir，文件链接用 unlink。
function removeLink(p, st) {
  if (st.isDirectory()) {
    fs.rmdirSync(p);
    return;
  }
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'EISDIR') {
      fs.rmdirSync(p);
      return;
    }
    throw e;
  }
}

export function removeDataChildren(dataDir, { stopAfterFirst = false } = {}) {
  const removed = [];
  const failed = [];
  let names = [];
  try {
    names = fs.readdirSync(dataDir);
  } catch (e) {
    return { removed, failed: [{ rel: '.', error: `${e?.code ?? ''} ${e?.message ?? e}`.trim() }] };
  }
  for (const name of names.sort()) {
    if (name === LOCK_NAME) continue;
    const p = path.join(dataDir, name);
    try {
      const st = fs.lstatSync(p);
      if (isReparsePoint(p, st)) removeLink(p, st);
      else if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      removed.push(name);
      if (stopAfterFirst && removed.length === 1) crashIfRequested('delete_first');
    } catch (e) {
      failed.push({ rel: name, error: `${e?.code ?? ''} ${e?.message ?? e}`.trim() });
    }
  }
  return { removed, failed };
}

/* ── 日记正文删除后校验 ────────────────────────────────────────────── */

async function checkDiaryUnchanged({ diaryRoot, entries, links }) {
  if (!entries.length && !links.length) return { stage: 'absent', changed: [], extra: [], missing: [] };
  if (!fs.existsSync(diaryRoot)) return { stage: 'changed', changed: [], extra: [], missing: ['<日记根不存在>'] };
  // 日记要“没被删、没被改”，所以缺文件也算异常（不能用 resume 语义）。
  const cmp = await compareWithManifest({ root: diaryRoot, entries, links, mode: 'before_delete' });
  if (cmp.changed.length || cmp.missing.length) {
    return { stage: 'changed', changed: cmp.changed, extra: cmp.extra, missing: cmp.missing };
  }
  return { stage: 'verified', changed: [], extra: cmp.extra, missing: [] };
}

/* ── 主流程 ────────────────────────────────────────────────────────── */

function assertHooksAllowed(hooks) {
  if (!hooks) return;
  if (String(process.env.DIARY_TEST_GUARD || '') !== '1') {
    throw new Error('拒绝使用测试注入 hooks（仅测试守卫下允许）');
  }
}

function crashIfRequested(stage) {
  if (String(process.env.DIARY_TEST_GUARD || '') !== '1') return;
  if (String(process.env.QQ_RESET_TEST_STOP_AFTER || '') === stage) process.exit(97);
}

function buildManifest({ opId, paths, backupDir, pending, idem }) {
  const sourceRoots = [
    {
      id: 'data',
      path: paths.dataDir,
      realPath: paths.dataDirReal,
      files: 0,
      bytes: 0,
      skipped: [LOCK_NAME]
    }
  ];
  if (paths.diaryRoot) {
    sourceRoots.push({
      id: 'diary',
      path: paths.diaryRoot,
      realPath: paths.diaryRootReal,
      files: 0,
      bytes: 0,
      skipped: []
    });
  }
  return {
    schemaVersion: SCHEMA,
    kind: 'reset',
    backupId: opId,
    opId, // 兼容既有调用方/测试（与 backupId 相同）
    // 显式声明：data 与 diary 各自分阶段，跨目录**不是**原子事务。
    atomic: false,
    scope: ['data', 'diary'],
    status: STATUS.PREPARED,
    createdAt: nowIso(),
    finishedAt: '',
    sourceRoots,
    paths: {
      dataDir: paths.dataDir,
      dataDirReal: paths.dataDirReal,
      diaryRoot: paths.diaryRoot,
      diaryRootReal: paths.diaryRootReal,
      backupRoot: paths.backupRoot,
      backupDir,
      manifest: manifestPathOf(backupDir)
    },
    stages: {
      data: { stage: 'planned', at: nowIso(), error: '' },
      diary: { stage: 'planned', at: nowIso(), error: '' }
    },
    files: { data: [], diary: [] },
    dirs: { data: [], diary: [] },
    links: [],
    totals: { files: 0, bytes: 0 },
    pendingSnapshot: {
      file: pending.file || '',
      exists: Boolean(pending.exists),
      sha256: pending.sha256 || '',
      unfinished: (pending.unfinished || []).length,
      idemFile: idem.file || '',
      idemPending: (idem.pending || []).length
    },
    deleted: { entries: 0, failed: [] },
    result: '',
    error: '',
    notes: [
      'data 与 diary 分别分阶段执行，不是跨目录原子事务',
      '日记正文不删除；只做备份与删除后 hash 对比',
      '删除不可回滚，备份是唯一恢复来源'
    ]
  };
}

/** 备份完成后回填 sourceRoots 计数/字节数与 totals，保证 manifest 可独立核对。 */
function updateTotals(manifest) {
  for (const root of manifest.sourceRoots || []) {
    const list = manifest.files?.[root.id] || [];
    root.files = list.length;
    root.bytes = list.reduce((sum, f) => sum + Number(f.size || 0), 0);
  }
  const all = [...(manifest.files?.data || []), ...(manifest.files?.diary || [])];
  manifest.totals = { files: all.length, bytes: all.reduce((sum, f) => sum + Number(f.size || 0), 0) };
}

/**
 * 执行 reset：预检 → 双目录备份 → 校验 → 删除 data → 校验。
 * 返回 { ok, opId, backupDir, manifestPath, result, stages, ... } 或拒绝/失败信息。
 */
export async function resetData({ dataDir, diaryRoot = '', backupRoot = '', opId = '', hooks = null } = {}) {
  assertHooksAllowed(hooks);
  const pre = await preflightReset({ dataDir, diaryRoot, backupRoot });
  if (!pre.canReset) {
    return { ok: false, refused: true, refusals: pre.refusals, paths: pre.paths };
  }
  const paths = resolveResetPaths({ dataDir, diaryRoot, backupRoot });
  const pending = readPendingState(paths.dataDir);
  const idem = readIdempotencyState(paths.dataDir);

  fs.mkdirSync(paths.backupRoot, { recursive: true });
  // withFileLockAsync 会自动追加 `.lock`，这里传不带后缀的基名（实际锁文件 = .reset.lock）。
  const lockFile = path.join(paths.backupRoot, '.reset');

  let locked;
  try {
    locked = await withFileLockAsync(lockFile, async () => {
    // 拿锁后再检查一次：等锁期间可能有人做完了 reset
    const again = await preflightReset({ dataDir, diaryRoot, backupRoot });
    if (!again.canReset) return { ok: false, refused: true, refusals: again.refusals, paths: again.paths };

    const id = String(opId || '').trim() || newOpId();
    const backupDir = path.join(paths.backupRoot, id);
    if (fs.existsSync(backupDir)) return { ok: false, error: `备份目录已存在，拒绝覆盖：${backupDir}` };
    fs.mkdirSync(backupDir, { recursive: true });

    // B4-3 写入屏障：删除期间阻止领域写入（协作式；未接入的写入由删除前后校验兜底）。
    try {
      beginResetBarrier({ opId: id, backupRoot: paths.backupRoot });
    } catch (e) {
      return { ok: false, refused: true, error: `无法建立 reset 写入屏障：${String(e?.message ?? e)}` };
    }
    try {

    const manifest = buildManifest({ opId: id, paths, backupDir, pending, idem });
    manifestWriteCount = 0; // 测试注入从本次操作的第 1 次写开始计数
    try {
      writeManifest(backupDir, manifest);
    } catch (e) {
      return { ok: false, error: `manifest 初始写入失败，未做任何备份/删除：${String(e?.message ?? e)}`, opId: id, backupDir };
    }

    const fail = (error, { manual = false } = {}) => {
      manifest.status = manual ? STATUS.NEEDS_MANUAL : STATUS.FAILED;
      manifest.result = 'failed';
      manifest.error = error;
      manifest.finishedAt = '';
      try { writeManifest(backupDir, manifest); } catch { /* 状态写不进去时保留上一次 manifest */ }
      return {
        ok: false,
        opId: id,
        backupDir,
        manifestPath: manifestPathOf(backupDir),
        status: manifest.status,
        result: 'failed',
        error,
        stages: manifest.stages
      };
    };

    // ① 日记备份
    manifest.status = STATUS.BACKUP_IN_PROGRESS;
    writeManifest(backupDir, manifest);
    if (paths.diaryRoot && fs.existsSync(paths.diaryRoot)) {
      try {
        const res = await copyTree({ src: paths.diaryRoot, dst: path.join(backupDir, 'diary'), scope: 'diary', hooks });
        manifest.files.diary = res.files;
        manifest.dirs.diary = res.dirs;
        manifest.links.push(...res.links);
        manifest.stages.diary = { stage: 'backed_up', at: nowIso(), error: '' };
      } catch (e) {
        const msg = `日记备份失败：${String(e?.message ?? e)}`;
        manifest.stages.diary = { stage: 'failed', at: nowIso(), error: msg };
        return fail(msg);
      }
    } else {
      manifest.stages.diary = { stage: 'absent', at: nowIso(), error: '' };
    }
    updateTotals(manifest);
    writeManifest(backupDir, manifest);
    crashIfRequested('diary_backup');

    // ② data 备份（跳过 lock）
    try {
      const res = await copyTree({ src: paths.dataDir, dst: path.join(backupDir, 'data'), scope: 'data', skipRoot: [LOCK_NAME], hooks });
      manifest.files.data = res.files;
      manifest.dirs.data = res.dirs;
      manifest.links.push(...res.links);
      manifest.stages.data = { stage: 'backed_up', at: nowIso(), error: '' };
    } catch (e) {
      const msg = `data 备份失败：${String(e?.message ?? e)}`;
      manifest.stages.data = { stage: 'failed', at: nowIso(), error: msg };
      return fail(msg);
    }
    updateTotals(manifest);
    try {
      writeManifest(backupDir, manifest);
    } catch (e) {
      return fail(`备份完成后 manifest 写入失败（未删除任何东西）：${String(e?.message ?? e)}`);
    }
    crashIfRequested('data_backup');
    if (typeof hooks?.afterDataBackup === 'function') await hooks.afterDataBackup({ manifest, backupDir });

    // ③ 回读校验：manifest 自校验 + 备份 hash + 源文件未变
    const reread = readManifest(backupDir);
    if (!reread.ok || reread.checksumOk === false) {
      return fail(`manifest 自校验失败（未删除任何东西）：${reread.error || 'checksum 不匹配'}`);
    }
    const backupCheck = await verifyBackupFiles(manifest, backupDir);
    if (!backupCheck.ok) {
      return fail(`备份校验失败（未删除任何东西）：${backupCheck.problems.slice(0, 10).join('；')}`);
    }

    // ③ 删除前再校验：备份完整 + 当前源文件未被并发改动
    let cmp;
    try {
      cmp = await compareWithManifest({
        root: paths.dataDir,
        entries: manifest.files.data,
        links: manifest.links.filter((l) => l.scope === 'data'),
        skipRoot: [LOCK_NAME],
        mode: 'before_delete'
      });
    } catch (e) {
      return fail(`删除前校验无法完成（未删除任何东西）：${String(e?.message ?? e)}`);
    }
    if (!cmp.ok) {
      return fail(`删除前校验失败（拒绝删除）：${
        JSON.stringify({ changed: cmp.changed.slice(0, 20), missing: cmp.missing.slice(0, 20), extra: cmp.extra.slice(0, 20) })
      }`);
    }

    // 备份与源文件都核验通过 → 记录 backup_verified（崩溃后可据此跳过备份）
    manifest.status = STATUS.BACKUP_VERIFIED;
    writeManifest(backupDir, manifest);
    crashIfRequested('backup_verified');

    // ④ 删除
    manifest.status = STATUS.DELETE_IN_PROGRESS;
    manifest.stages.data = { stage: 'removing', at: nowIso(), error: '' };
    writeManifest(backupDir, manifest);
    crashIfRequested('removing');
    const del = removeDataChildren(paths.dataDir, { stopAfterFirst: true });
    manifest.deleted = { entries: del.removed.length, failed: del.failed };
    if (del.failed.length) {
      return fail(`删除阶段失败（已删 ${del.removed.length} 项，备份保留）：${
        del.failed.slice(0, 20).map((f) => `${f.rel}: ${f.error}`).join('；')
      }`, { manual: true });
    }
    try { writeManifest(backupDir, manifest); } catch { /* 删除结果由后续状态写补 */ }
    const left = fs.readdirSync(paths.dataDir).filter((n) => n !== LOCK_NAME);
    if (left.length) {
      return fail(`删除后仍有残留：${left.slice(0, 20).join('，')}`, { manual: true });
    }
    manifest.stages.data = { stage: 'deleted', at: nowIso(), error: '' };
    writeManifest(backupDir, manifest);
    crashIfRequested('deleted');

    // ⑤ 日记正文删除后对比（正文不删除，只验证未被误改）
    let diaryCheck;
    let diaryError = '';
    try {
      diaryCheck = await checkDiaryUnchanged({
        diaryRoot: paths.diaryRoot,
        entries: manifest.files.diary,
        links: manifest.links.filter((l) => l.scope === 'diary')
      });
    } catch (e) {
      diaryError = `删除后日记校验无法完成：${String(e?.message ?? e)}`;
      diaryCheck = { stage: 'failed', changed: [], extra: [], missing: [] };
    }
    manifest.diaryCheck = {
      stage: diaryCheck.stage,
      changed: diaryCheck.changed.slice(0, 50),
      extra: diaryCheck.extra.slice(0, 50),
      missing: diaryCheck.missing.slice(0, 50)
    };
    manifest.stages.diary = { stage: diaryCheck.stage, at: nowIso(), error: diaryError };

    manifest.stages.data = { stage: 'completed', at: nowIso(), error: '' };
    manifest.status = STATUS.COMPLETED;
    manifest.result = ['verified', 'absent'].includes(diaryCheck.stage) ? 'ok' : 'ok_with_warnings';
    manifest.finishedAt = nowIso();
    writeManifest(backupDir, manifest);

    return {
      ok: true,
      opId: id,
      backupId: id,
      backupDir,
      manifestPath: manifestPathOf(backupDir),
      status: manifest.status,
      result: manifest.result,
      atomic: false,
      stages: manifest.stages,
      totals: manifest.totals,
      sourceRoots: manifest.sourceRoots,
      files: { data: manifest.files.data.length, diary: manifest.files.diary.length },
      deleted: manifest.deleted,
      diaryCheck: manifest.diaryCheck,
      paths: manifest.paths
    };
    } finally {
      endResetBarrier();
    }
    }, { retries: 150, waitMs: 20 });
  } catch (e) {
    if (e?.code === 'ELOCKTIMEOUT') {
      return { ok: false, error: '另一个重置正在进行（等锁超时），请稍后再试或先核验上次操作' };
    }
    throw e;
  }
  return locked;
}

/* ── 备份校验 / 恢复 ────────────────────────────────────────────────── */

async function verifyBackupFiles(manifest, backupDir) {
  const problems = [];
  let checked = 0;
  for (const scope of ['data', 'diary']) {
    for (const f of manifest.files?.[scope] || []) {
      const file = path.join(backupDir, scope, ...String(f.rel).split('/'));
      let h = '';
      try { h = await hashFile(file); } catch { problems.push(`${scope}/${f.rel}：备份文件缺失`); continue; }
      let size = -1;
      try { size = (await fsp.stat(file)).size; } catch { /* 上面已处理缺失 */ }
      if (h !== f.sha256 || size !== f.size) problems.push(`${scope}/${f.rel}：hash/大小不一致`);
      checked += 1;
    }
  }
  return { ok: problems.length === 0, checked, problems };
}

function manifestPathsMatch(manifest, paths) {
  const problems = [];
  const mData = manifest?.paths?.dataDirReal || manifest?.paths?.dataDir || '';
  if (!mData || norm(mData) !== norm(paths.dataDir)) problems.push(`数据目录与 manifest 不一致：${paths.dataDir}`);
  const mDiary = manifest?.paths?.diaryRootReal || manifest?.paths?.diaryRoot || '';
  if (mDiary && !paths.diaryRoot) {
    problems.push(`manifest 记录的日记根与当前不一致（当前未配置）：${mDiary}`);
  } else if (mDiary && paths.diaryRoot && norm(mDiary) !== norm(paths.diaryRoot)) {
    problems.push(`日记根与 manifest 不一致：${paths.diaryRoot}`);
  }
  return problems;
}

/**
 * 只读核验：备份是否完整、当前 data/日记 处于什么状态。
 */
export async function verifyResetOp({ opId, dataDir, diaryRoot = '', backupRoot = '' } = {}) {
  const paths = resolveResetPaths({ dataDir, diaryRoot, backupRoot });
  const backupDir = path.join(paths.backupRoot, String(opId || ''));
  const r = readManifest(backupDir);
  if (!r.ok) return { ok: false, error: r.error, opId };
  const m = r.manifest;
  const id = m.backupId || m.opId;
  const checksumOk = r.checksumOk !== false;
  const pathProblems = manifestPathsMatch(m, paths);
  if (!checksumOk) pathProblems.push('manifest 自校验失败（manifestChecksum 不匹配）');
  const backup = await verifyBackupFiles(m, backupDir);
  let dataLeft = { files: 0, bytes: 0 };
  if (fs.existsSync(paths.dataDir)) dataLeft = await statTree(paths.dataDir);
  const expectedFiles = (m.files?.data?.length || 0) + (m.files?.diary?.length || 0);
  const totalsOk = Number(m?.totals?.files || 0) === expectedFiles;
  if (!totalsOk) pathProblems.push(`manifest totals 不一致：记录 ${m?.totals?.files ?? 0}，实际 ${expectedFiles}`);
  return {
    ok: pathProblems.length === 0 && backup.ok,
    opId: id,
    backupId: id,
    status: m.status || '',
    backupDir,
    manifest: m,
    checksumOk,
    totalsOk,
    pathProblems,
    backup,
    dataPresent: dataLeft,
    totals: m.totals,
    sourceRoots: m.sourceRoots,
    stages: m.stages,
    result: m.result || '',
    legacy: Boolean(r.legacy)
  };
}

/** 恢复审计（追加写；审计失败不掩盖恢复结果）。 */
function auditRestore(record) {
  try {
    const file = path.join(path.dirname(String(record.backupDir)), 'restore-audit.jsonl');
    fs.appendFileSync(file, JSON.stringify({ at: nowIso(), ...record }) + '\n', 'utf8');
  } catch { /* ignore */ }
}

/**
 * 从备份恢复（B4-4）。**不在生产演练**；只做可证明安全的最小恢复：
 *   · 先校验 manifest 自校验、路径、全部备份 hash；
 *   · 只恢复到 manifest 记录的 data/日记根；
 *   · 任何目标文件已存在（新数据）→ 整体拒绝，不覆盖；
 *   · 恢复后逐文件 hash 复核；失败保留备份与现场。
 */
export async function restoreResetBackup({ opId, dataDir, diaryRoot = '', backupRoot = '', scope = 'all', hooks = null } = {}) {
  assertHooksAllowed(hooks);
  const paths = resolveResetPaths({ dataDir, diaryRoot, backupRoot });
  if (paths.refusals.length) return { ok: false, error: paths.refusals.join('；') };
  const backupDir = path.join(paths.backupRoot, String(opId || '').trim());
  const r = readManifest(backupDir);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.checksumOk === false) return { ok: false, error: 'manifest 自校验失败（可能被改动），拒绝恢复' };
  const m = r.manifest;
  const id = m.backupId || m.opId;

  const scopes = scope === 'all' ? ['data', 'diary'] : [scope];
  if (!scopes.length || !scopes.every((s) => s === 'data' || s === 'diary')) return { ok: false, error: `scope 不合法：${scope}` };

  const pathProblems = manifestPathsMatch(m, paths);
  if (pathProblems.length) return { ok: false, error: pathProblems.join('；') };
  const backup = await verifyBackupFiles(m, backupDir);
  if (!backup.ok) {
    return { ok: false, error: `备份不完整，拒绝恢复：${backup.problems.slice(0, 10).join('；')}`, problems: backup.problems };
  }

  const roots = { data: paths.dataDir, diary: paths.diaryRoot };
  for (const s of scopes) {
    if (!roots[s]) return { ok: false, error: `当前未配置 ${s} 目录，拒绝恢复` };
    if (path.parse(path.resolve(roots[s])).root === path.resolve(roots[s])) {
      return { ok: false, error: `拒绝恢复到磁盘根目录：${roots[s]}` };
    }
  }

  // 目标安全 + 覆盖检查（全部通过才动手，避免恢复一半才发现冲突）
  const plan = [];
  for (const s of scopes) {
    const root = roots[s];
    for (const f of m.files?.[s] || []) {
      const dest = path.join(root, ...String(f.rel).split('/'));
      try {
        if (!isUnder(norm(dest), norm(root))) return { ok: false, error: `恢复目标越界：${dest}` };
      } catch (e) {
        return { ok: false, error: `恢复目标无法解析：${String(e?.message ?? e)}` };
      }
      if (fs.existsSync(dest)) return { ok: false, error: `目标已存在新数据，拒绝覆盖：${s}/${f.rel}` };
      plan.push({
        scope: s,
        rel: String(f.rel),
        src: path.join(backupDir, s, ...String(f.rel).split('/')),
        dest,
        sha256: String(f.sha256),
        size: Number(f.size)
      });
    }
  }
  for (const s of scopes) {
    for (const d of m.dirs?.[s] || []) {
      const dest = path.join(roots[s], ...String(d).split('/'));
      try { fs.mkdirSync(dest, { recursive: true }); } catch (e) {
        return { ok: false, error: `创建目录失败：${s}/${d}：${String(e?.message ?? e)}` };
      }
    }
  }

  const restored = [];
  const failed = [];
  for (const item of plan) {
    const itemRel = `${item.scope}/${item.rel}`;
    if (hooks && hooks.failCopyRel === itemRel) {
      failed.push({ rel: itemRel, error: '模拟复制失败（测试注入）' });
      continue;
    }
    try {
      fs.mkdirSync(path.dirname(item.dest), { recursive: true });
      await fsp.copyFile(item.src, item.dest);
      const h = await hashFile(item.dest);
      const st = await fsp.stat(item.dest);
      if (h !== item.sha256 || st.size !== item.size) {
        failed.push({ rel: itemRel, error: '恢复后 hash/大小不一致' });
        continue;
      }
      restored.push(itemRel);
    } catch (e) {
      failed.push({ rel: itemRel, error: String(e?.message ?? e) });
    }
  }
  auditRestore({
    opId: id,
    backupDir,
    scopes,
    restored: restored.length,
    failed: failed.slice(0, 20),
    needsManual: failed.length > 0,
    result: failed.length ? 'failed' : 'ok'
  });
  if (failed.length) {
    return {
      ok: false,
      needsManual: true,
      partial: restored.length > 0,
      error: `恢复未完成（备份保留；已恢复 ${restored.length} 个文件，失败 ${failed.length} 个）：${failed.slice(0, 5).map((f) => `${f.rel}: ${f.error}`).join('；')}。请人工核对目标目录后清理或补齐，不要把部分恢复当作完成。`,
      restored: restored.length,
      failed,
      backupDir
    };
  }
  return { ok: true, opId: id, scopes, restored: restored.length, backupDir };
}

/**
 * 从 manifest 继续未完成的 reset。
 * 规则（fail-closed）：
 *   · 备份不完整 / 路径不一致 / manifest 不可读 → 拒绝，保留人工处理状态
 *   · data 阶段 planned → 补做备份后继续
 *   · backed_up / removing → 剩余文件必须与 manifest 记录一致；出现未备份新文件 → 拒绝
 *   · deleted / completed → 只补最终校验，**不再删除**（避免删掉重置后的新数据）
 */
export async function resumeReset(args = {}) {
  assertHooksAllowed(args.hooks || null);
  const paths = resolveResetPaths({ dataDir: args.dataDir, diaryRoot: args.diaryRoot, backupRoot: args.backupRoot });
  if (paths.refusals.length) return { ok: false, needsManual: true, error: paths.refusals.join('；') };

  fs.mkdirSync(paths.backupRoot, { recursive: true });
  try {
    return await withFileLockAsync(
      path.join(paths.backupRoot, '.reset'),
      () => resumeResetLocked(args, paths),
      { retries: 150, waitMs: 20 }
    );  } catch (e) {
    if (e?.code === 'ELOCKTIMEOUT') {
      return { ok: false, needsManual: true, error: '另一个 reset/恢复正在进行（等锁超时），请稍后再试' };
    }
    throw e;
  }
}

async function resumeResetLocked({ opId, dataDir, diaryRoot = '', backupRoot = '', hooks = null } = {}, paths) {
  const backupDir = path.join(paths.backupRoot, String(opId || '').trim());
  const r = readManifest(backupDir);
  if (!r.ok) return { ok: false, needsManual: true, error: r.error };
  if (r.checksumOk === false) {
    return { ok: false, needsManual: true, error: 'manifest 自校验失败（可能被改动），拒绝恢复', manifestPath: manifestPathOf(backupDir) };
  }
  const manifest = r.manifest;
  const id = manifest.backupId || manifest.opId;

  const pathProblems = manifestPathsMatch(manifest, paths);
  if (pathProblems.length) return { ok: false, needsManual: true, error: pathProblems.join('；'), manifestPath: manifestPathOf(backupDir) };

  const backup = await verifyBackupFiles(manifest, backupDir);
  if (!backup.ok) {
    return {
      ok: false,
      needsManual: true,
      error: `备份不完整，拒绝继续（保留现场）：${backup.problems.slice(0, 10).join('；')}`,
      manifestPath: manifestPathOf(backupDir),
      problems: backup.problems
    };
  }

  const write = () => writeManifest(backupDir, manifest);
  manifestWriteCount = 0;

  // 恢复/续删也可能删除，必须同样建立写入屏障。
  try {
    beginResetBarrier({ opId: id, backupRoot: paths.backupRoot });
  } catch (e) {
    return { ok: false, needsManual: true, error: `无法建立 reset 写入屏障：${String(e?.message ?? e)}` };
  }
  try {

  // 已经完成的 op：只做核验，不再改写历史（避免把用户后来的日记改动记成 reset 的问题）。
  if ((manifest.stages?.data?.stage || '') === 'completed' && manifest.result) {
    return {
      ok: true,
      alreadyCompleted: true,
      opId: id,
      status: manifest.status || STATUS.COMPLETED,
      backupDir,
      manifestPath: manifestPathOf(backupDir),
      result: manifest.result,
      stages: manifest.stages,
      deleted: manifest.deleted,
      diaryCheck: manifest.diaryCheck || null
    };
  }

  // ① 日记必须先有备份（或确认没有日记根），之后才允许删除 data。
  const diaryStage = manifest.stages?.diary?.stage || 'planned';
  if (diaryStage === 'planned' || diaryStage === 'failed') {
    if (paths.diaryRoot && fs.existsSync(paths.diaryRoot)) {
      try {
        const res = await copyTree({ src: paths.diaryRoot, dst: path.join(backupDir, 'diary'), scope: 'diary', hooks });
        manifest.files.diary = res.files;
        manifest.dirs.diary = res.dirs;
        manifest.links = (manifest.links || []).filter((l) => l.scope !== 'diary').concat(res.links);
        manifest.stages.diary = { stage: 'backed_up', at: nowIso(), error: '' };
        write();
      } catch (e) {
        manifest.stages.diary = { stage: 'failed', at: nowIso(), error: `恢复时补做日记备份失败：${String(e?.message ?? e)}` };
        manifest.status = STATUS.FAILED;
        manifest.result = 'failed';
        manifest.error = manifest.stages.diary.error;
        write();
        return { ok: false, status: STATUS.FAILED, error: manifest.error, opId: id, manifestPath: manifestPathOf(backupDir) };
      }
    } else {
      manifest.stages.diary = { stage: 'absent', at: nowIso(), error: '' };
      write();
    }
  }

  // ② data：删除前失败（一项都没删）→ 直接提示重新发起；否则按阶段继续。
  let currentStage = manifest.stages?.data?.stage || 'planned';
  const deletedEntries = Number(manifest.deleted?.entries || 0);
  if (currentStage === 'failed' && deletedEntries === 0) {
    return {
      ok: false,
      needsManual: false,
      error: `上一次 reset 在删除前失败（数据未见删除），可直接重新发起 reset：${manifest.error || ''}`,
      manifestPath: manifestPathOf(backupDir)
    };
  }

  if (currentStage === 'planned') {
    manifest.status = STATUS.BACKUP_IN_PROGRESS;
    try {
      const res = await copyTree({ src: paths.dataDir, dst: path.join(backupDir, 'data'), scope: 'data', skipRoot: [LOCK_NAME], hooks });
      manifest.files.data = res.files;
      manifest.dirs.data = res.dirs;
      manifest.links = (manifest.links || []).filter((l) => l.scope !== 'data').concat(res.links);
      manifest.stages.data = { stage: 'backed_up', at: nowIso(), error: '' };
      updateTotals(manifest);
      write();
    } catch (e) {
      manifest.stages.data = { stage: 'failed', at: nowIso(), error: `恢复时补做 data 备份失败：${String(e?.message ?? e)}` };
      manifest.status = STATUS.FAILED;
      manifest.result = 'failed';
      manifest.error = manifest.stages.data.error;
      write();
      return { ok: false, status: STATUS.FAILED, error: manifest.error, opId: id, manifestPath: manifestPathOf(backupDir) };
    }
    currentStage = manifest.stages.data.stage;
  }

  if (currentStage === 'backed_up' || currentStage === 'removing' || currentStage === 'failed') {
    // 删除前必须确认备份完整（续删同样适用）。
    const verifyNow = await verifyBackupFiles(manifest, backupDir);
    if (!verifyNow.ok) {
      return {
        ok: false,
        needsManual: true,
        error: `备份不完整，拒绝继续（保留现场）：${verifyNow.problems.slice(0, 10).join('；')}`,
        manifestPath: manifestPathOf(backupDir)
      };
    }
    updateTotals(manifest);
    manifest.status = STATUS.BACKUP_VERIFIED;
    write();
    let cmp;
    try {
      cmp = await compareWithManifest({
        root: paths.dataDir,
        entries: manifest.files.data,
        links: (manifest.links || []).filter((l) => l.scope === 'data'),
        skipRoot: [LOCK_NAME],
        mode: 'resume'
      });
    } catch (e) {
      return {
        ok: false,
        needsManual: true,
        error: `恢复时校验无法完成（未继续删除）：${String(e?.message ?? e)}`,
        manifestPath: manifestPathOf(backupDir)
      };
    }
    if (cmp.changed.length || cmp.extra.length || cmp.linkChanged.length) {
      return {
        ok: false,
        needsManual: true,
        error: `数据目录出现未备份/已变更的文件，拒绝继续删除：${JSON.stringify({
          changed: cmp.changed.slice(0, 20), extra: cmp.extra.slice(0, 20), linkChanged: cmp.linkChanged.slice(0, 20)
        })}`,
        manifestPath: manifestPathOf(backupDir)
      };
    }
    manifest.status = STATUS.DELETE_IN_PROGRESS;
    manifest.stages.data = { stage: 'removing', at: nowIso(), error: '' };
    write();
    const del = removeDataChildren(paths.dataDir);
    manifest.deleted = {
      entries: Number(manifest.deleted?.entries || 0) + del.removed.length,
      failed: del.failed
    };
    if (del.failed.length) {
      manifest.stages.data = { stage: 'failed', at: nowIso(), error: `恢复时删除失败：${del.failed.map((f) => `${f.rel}: ${f.error}`).join('；')}` };
      manifest.status = STATUS.NEEDS_MANUAL;
      manifest.result = 'failed';
      manifest.error = manifest.stages.data.error;
      write();
      return { ok: false, status: STATUS.NEEDS_MANUAL, error: manifest.error, opId: id, manifestPath: manifestPathOf(backupDir) };
    }
    const left = fs.readdirSync(paths.dataDir).filter((n) => n !== LOCK_NAME);
    if (left.length) {
      manifest.stages.data = { stage: 'failed', at: nowIso(), error: `删除后仍有残留：${left.slice(0, 20).join('，')}` };
      manifest.status = STATUS.NEEDS_MANUAL;
      manifest.result = 'failed';
      manifest.error = manifest.stages.data.error;
      write();
      return { ok: false, status: STATUS.NEEDS_MANUAL, error: manifest.error, opId: id, manifestPath: manifestPathOf(backupDir) };
    }
    manifest.stages.data = { stage: 'deleted', at: nowIso(), error: '' };
    write();
  }

  // 删除已完成：若 data 里又出现新文件（重启后的新数据），只记录、绝不再删。
  let postDeleteNewEntries = [];
  if ((manifest.stages?.data?.stage || '') === 'deleted' && fs.existsSync(paths.dataDir)) {
    postDeleteNewEntries = fs.readdirSync(paths.dataDir).filter((n) => n !== LOCK_NAME);
    if (postDeleteNewEntries.length) manifest.postDeleteNewEntries = postDeleteNewEntries.slice(0, 50);
  }

  let diaryCheck;
  let diaryError = '';
  try {
    diaryCheck = await checkDiaryUnchanged({
      diaryRoot: paths.diaryRoot,
      entries: manifest.files.diary || [],
      links: (manifest.links || []).filter((l) => l.scope === 'diary')
    });
  } catch (e) {
    diaryError = `恢复时日记校验无法完成：${String(e?.message ?? e)}`;
    diaryCheck = { stage: 'failed', changed: [], extra: [], missing: [] };
  }
  manifest.diaryCheck = {
    stage: diaryCheck.stage,
    changed: diaryCheck.changed.slice(0, 50),
    extra: diaryCheck.extra.slice(0, 50),
    missing: diaryCheck.missing.slice(0, 50)
  };
  manifest.stages.diary = { stage: diaryCheck.stage, at: nowIso(), error: diaryError };
  manifest.stages.data = { stage: 'completed', at: nowIso(), error: '' };
  manifest.status = STATUS.COMPLETED;
  manifest.result = ['verified', 'absent'].includes(diaryCheck.stage) ? 'ok' : 'ok_with_warnings';
  manifest.finishedAt = nowIso();
  write();

  return {
    ok: true,
    resumed: true,
    opId: id,
    backupId: id,
    status: manifest.status,
    backupDir,
    manifestPath: manifestPathOf(backupDir),
    result: manifest.result,
    totals: manifest.totals,
    sourceRoots: manifest.sourceRoots,
    stages: manifest.stages,
    deleted: manifest.deleted,
    diaryCheck: manifest.diaryCheck,
    postDeleteNewEntries
  };
  } finally {
    endResetBarrier();
  }
}

export const __internals = { realish, norm, isUnder, hashFile, copyTree, walkCurrent, isUnfinishedManifest };
