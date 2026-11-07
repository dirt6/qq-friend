// 备份保留策略工具（D1-4 P2）。默认只读 inspect；--apply 需 --confirm <planHash>。
//
// 用法：
//   node scripts/backup-retention.mjs [--json] [--no-deep] [--data-dir <dir>] [--diary-root <dir>] [--reset-root <dir>]
//   node scripts/backup-retention.mjs --plan [--json] ...
//   node scripts/backup-retention.mjs --apply --confirm <planHash> ...   # 需明确授权；本阶段不在生产执行
//
// 状态：verified / completed / corrupted / needs_manual_recovery / restore_in_progress / restore_failed / unknown
// 只有 verified|completed 可进入保留候选；恢复锁存在时全部保护；diary .trash 永不自动清理。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readManifest } from '../src/reset-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const nowIso = () => new Date().toISOString();
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const DAY = 86400e3;

export function defaultPolicy() {
  return {
    reset: { minBackups: 2, maxAgeDays: 30, maxCount: 10, maxBytes: 20 * 1024 ** 3, deleteAfterDays: 30 },
    memory: { minBackups: 1, perChat: true, maxAgeDays: 30, maxCount: 200, maxBytes: 2 * 1024 ** 3, deleteAfterDays: 30 },
    chat: { minBackups: 1, perChat: true, maxAgeDays: 30, maxCount: 200, maxBytes: 2 * 1024 ** 3, deleteAfterDays: 30 },
    learned: { minBackups: 1, maxAgeDays: 30, maxCount: 50, maxBytes: 500 * 1024 ** 2, deleteAfterDays: 30 },
    sessions: { minBackups: 2, maxAgeDays: 14, maxCount: 30, maxBytes: 5 * 1024 ** 3, deleteAfterDays: 30 }
  };
}

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
function listFiles(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name); } catch { return []; }
}
function dirStats(dir) {
  let files = 0; let bytes = 0;
  const walk = (abs) => {
    for (const e of (() => { try { return fs.readdirSync(abs, { withFileTypes: true }); } catch { return []; } })()) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) { files += 1; try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
    }
  };
  walk(dir);
  return { files, bytes, createdAt: (() => { try { return fs.statSync(dir).mtime.toISOString(); } catch { return ''; } })() };
}

/** 验证 manifest 列出的文件（兼容 files[] 与单 file）。 */
function verifyManifestFiles(dir, manifest) {
  const list = [];
  if (Array.isArray(manifest?.files)) list.push(...manifest.files);
  if (manifest?.file && typeof manifest.file === 'object') list.push(manifest.file);
  let bytes = 0;
  for (const f of list) {
    const file = path.join(dir, ...String(f.rel || '').split('/'));
    let h = '';
    try { h = sha256(file); } catch { return { ok: false, error: `缺文件：${f.rel}`, files: list.length }; }
    if (h !== f.sha256) return { ok: false, error: `hash 不一致：${f.rel}`, files: list.length };
    bytes += Number(f.size || 0);
  }
  return { ok: true, files: list.length, bytes };
}

function readRestoreAudit(resetRoot) {
  const map = new Map();
  try {
    for (const line of fs.readFileSync(path.join(resetRoot, 'restore-audit.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      try { const j = JSON.parse(line); if (j?.opId) map.set(j.opId, j.result || 'unknown'); } catch { /* ignore */ }
    }
  } catch { /* none */ }
  return map;
}

/**
 * 只读巡检所有备份来源。
 */
export function inspectBackups({ dataDir = path.join(ROOT, 'data'), diaryRoot = 'E:\\dsh\\日记', resetRoot = '', deep = true, now = Date.now() } = {}) {
  const data = path.resolve(dataDir);
  const reset = path.resolve(resetRoot || `${data}.reset-backups`);
  const archiveRoot = path.join(data, 'backups', 'archive');
  const restoreAudit = readRestoreAudit(reset);
  const restoreLock = fs.existsSync(path.join(reset, '.restore.lock'));
  const items = [];
  const push = (type, id, dir, { status, createdAt, bytes, files, chatKey = '', note = '', manifestStatus = '' }) => items.push({
    type, id, path: dir, chatKey, status, createdAt: createdAt || '', bytes: bytes || 0, files: files || 0,
    manifestStatus, note, archived: false, protected: status !== 'verified' && status !== 'completed'
  });

  // reset
  for (const op of listDirs(reset)) {
    const dir = path.join(reset, op);
    const r = readManifest(dir);
    if (!r.ok) { push('reset', op, dir, { status: 'corrupted', note: r.error }); continue; }
    let status = 'verified';
    if (r.checksumOk === false) status = 'corrupted';
    else if (r.manifest.status === 'needs_manual_recovery') status = 'needs_manual_recovery';
    else if (restoreAudit.get(op) === 'failed') status = 'restore_failed';
    if (status === 'verified' && deep) {
      let bad = '';
      for (const scope of ['data', 'diary']) {
        for (const f of r.manifest.files?.[scope] || []) {
          const file = path.join(dir, scope, ...String(f.rel).split('/'));
          let h = '';
          try { h = sha256(file); } catch { bad = `缺文件：${scope}/${f.rel}`; break; }
          if (h !== f.sha256) { bad = `hash 不一致：${scope}/${f.rel}`; break; }
        }
        if (bad) break;
      }
      if (bad) status = 'corrupted';
    }
    push('reset', op, dir, { status, createdAt: r.manifest.createdAt, bytes: dirStats(dir).bytes, files: dirStats(dir).files, note: r.manifest.status || '' });
  }

  // memory / chat（chat/op 两层）与 learned（直接 op 一层）
  const inspectManifestDir = (type, dir, chatKey = '') => {
    if (!fs.existsSync(path.join(dir, 'manifest.json'))) return;
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch {
      push(type, path.basename(dir), dir, { status: 'corrupted', chatKey, note: 'manifest 不可读' }); return;
    }
    let status = 'verified';
    if (deep) {
      const v = verifyManifestFiles(dir, manifest);
      if (!v.ok) status = 'corrupted';
    }
    const st = dirStats(dir);
    push(type, chatKey ? `${chatKey}/${path.basename(dir)}` : path.basename(dir), dir, {
      status, chatKey, createdAt: manifest.createdAt, bytes: st.bytes, files: st.files, note: manifest.kind || ''
    });
  };
  for (const chat of listDirs(path.join(data, 'memory', 'backups'))) {
    const chatDir = path.join(data, 'memory', 'backups', chat);
    for (const op of listDirs(chatDir)) inspectManifestDir('memory', path.join(chatDir, op), chat);
  }
  for (const chat of listDirs(path.join(data, 'backups', 'chats'))) {
    const chatDir = path.join(data, 'backups', 'chats', chat);
    for (const op of listDirs(chatDir)) inspectManifestDir('chat', path.join(chatDir, op), chat);
  }
  for (const op of listDirs(path.join(data, 'backups', 'learned'))) {
    inspectManifestDir('learned', path.join(data, 'backups', 'learned', op));
  }

  // sessions（无 manifest → unknown，fail-closed：不自动清理）
  for (const name of listDirs(path.join(data, 'backups'))) {
    if (!name.startsWith('sessions-')) continue;
    const dir = path.join(data, 'backups', name);
    const files = listFiles(dir);
    const st = dirStats(dir);
    push('sessions', name, dir, { status: 'unknown', createdAt: st.createdAt, bytes: st.bytes, files: st.files, note: '无 manifest，永不自动清理' });
  }

  // diary .trash（无 hash 元数据 → unknown，永久保护）
  for (const f of listFiles(path.join(diaryRoot, '.trash'))) {
    const p = path.join(diaryRoot, '.trash', f);
    let st = null;
    try { st = fs.statSync(p); } catch { continue; }
    push('diary', f, p, { status: 'unknown', createdAt: st.mtime.toISOString(), bytes: st.size, files: 1, note: '无 manifest，永不自动清理' });
  }

  if (restoreLock) for (const it of items) { it.status = 'restore_in_progress'; it.protected = true; it.note = 'restore 锁存在'; }

  const counts = items.reduce((acc, it) => { acc[it.type] = (acc[it.type] || 0) + 1; return acc; }, {});
  return { schema: 1, generatedAt: nowIso(), dataDir: data, resetRoot: reset, archiveRoot, restoreLock, items, counts };
}

/** 生成保留计划（只读）。 */
export function planRetention({ inspection, policy = defaultPolicy(), now = Date.now(), deleteArchivedAfterDays = null } = {}) {
  const items = inspection.items || [];
  const candidates = [];
  const protectedItems = [];
  const byType = {};
  for (const it of items) (byType[it.type] ||= []).push(it);
  // 所有受保护项（含无策略类型的 diary .trash unknown）都进入 protectedItems
  for (const it of items) if (it.protected) protectedItems.push({ ...it, reason: it.status });

  for (const [type, rule] of Object.entries(policy)) {
    const list = (byType[type] || []).filter((it) => !it.archived);
    // 归档项删除候选
    const archived = items.filter((it) => it.type === type && it.archived);
    const delDays = deleteArchivedAfterDays == null ? rule.deleteAfterDays : deleteArchivedAfterDays;
    for (const it of archived) {
      const age = (now - Date.parse(it.createdAt || 0)) / DAY;
      if (!it.protected && age > delDays) candidates.push({ action: 'delete', type, id: it.id, path: it.path, status: it.status, createdAt: it.createdAt });
    }
    const eligible = list.filter((it) => !it.protected && (it.status === 'verified' || it.status === 'completed'));
    eligible.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const keep = new Set();
    if (rule.perChat) {
      const seen = new Map();
      for (const it of eligible) {
        const n = (seen.get(it.chatKey) || 0);
        if (n < rule.minBackups) { keep.add(it.id); seen.set(it.chatKey, n + 1); }
      }
    } else {
      for (const it of eligible.slice(0, rule.minBackups)) keep.add(it.id);
    }
    let totalBytes = eligible.reduce((s, it) => s + Number(it.bytes || 0), 0);
    let keptCount = eligible.filter((it) => keep.has(it.id)).length;
    for (const it of eligible) {
      if (keep.has(it.id)) continue;
      const age = (now - Date.parse(it.createdAt || 0)) / DAY;
      const overCount = keptCount >= rule.maxCount;
      const overBytes = totalBytes > rule.maxBytes;
      const overAge = age > rule.maxAgeDays;
      if (overAge || overCount || overBytes) {
        candidates.push({ action: 'archive', type, id: it.id, path: it.path, status: it.status, createdAt: it.createdAt, bytes: it.bytes });
        totalBytes -= Number(it.bytes || 0); // 归档后不计入活动容量
      } else {
        keptCount += 1;
      }
    }
  }
  // 归档根下的历史项（来自上次归档）
  for (const type of listDirs(inspection.archiveRoot)) {
    const rule = policy[type];
    if (!rule) continue;
    const dir = path.join(inspection.archiveRoot, type);
    for (const id of listDirs(dir)) {
      const p = path.join(dir, id);
      const st = dirStats(p);
      const age = (now - Date.parse(st.createdAt || 0)) / DAY;
      if (age > (deleteArchivedAfterDays == null ? rule.deleteAfterDays : deleteArchivedAfterDays)) {
        candidates.push({ action: 'delete', type, id, path: p, status: 'verified', createdAt: st.createdAt, archived: true });
      }
    }
  }
  const planHash = crypto.createHash('sha256').update(JSON.stringify(candidates.map((c) => [c.action, c.type, c.id, c.path, c.status]))).digest('hex');
  return { schema: 1, generatedAt: nowIso(), planHash, candidates, protectedItems, counts: { candidates: candidates.length, archive: candidates.filter((c) => c.action === 'archive').length, delete: candidates.filter((c) => c.action === 'delete').length, protected: protectedItems.length } };
}

/** 执行计划（隔离/需授权）。默认 dryRun=true。 */
export function applyRetention({ plan, inspection, dataDir, dryRun = true, hooks = null } = {}) {
  const auditFile = path.join(path.resolve(dataDir), 'backups', 'retention-audit.jsonl');
  const results = [];
  const audit = (rec) => { try { fs.mkdirSync(path.dirname(auditFile), { recursive: true }); fs.appendFileSync(auditFile, JSON.stringify({ at: nowIso(), planHash: plan.planHash, ...rec }) + '\n', 'utf8'); } catch { /* ignore */ } };
  if (inspection.restoreLock) return { ok: false, error: 'restore 进行中，禁止清理', results };
  for (const c of plan.candidates) {
    if (hooks && hooks.failId === c.id) { results.push({ ...c, result: 'failed', error: '测试注入失败' }); audit({ action: c.action, type: c.type, id: c.id, result: 'failed', error: 'injected' }); continue; }
    if (dryRun) { results.push({ ...c, result: 'planned' }); continue; }
    try {
      if (c.action === 'archive') {
        const dest = path.join(inspection.archiveRoot, c.type, c.id);
        if (fs.existsSync(dest)) throw new Error('归档目标已存在');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(c.path, dest);
        results.push({ ...c, result: 'archived', dest });
        audit({ action: 'archive', type: c.type, id: c.id, result: 'ok', dest });
      } else if (c.action === 'delete') {
        if (!c.path.startsWith(inspection.archiveRoot) && !c.archived) throw new Error('拒绝删除非归档候选');
        fs.rmSync(c.path, { recursive: true, force: false });
        results.push({ ...c, result: 'deleted' });
        audit({ action: 'delete', type: c.type, id: c.id, result: 'ok' });
      }
    } catch (e) {
      results.push({ ...c, result: 'failed', error: String(e?.message ?? e) });
      audit({ action: c.action, type: c.type, id: c.id, result: 'failed', error: String(e?.message ?? e) });
    }
  }
  return { ok: true, dryRun, planHash: plan.planHash, results, auditFile };
}

export function main(argv = process.argv.slice(2)) {
  const args = { json: false, deep: true, dataDir: '', diaryRoot: '', resetRoot: '', plan: false, apply: false, confirm: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (a === '--no-deep') { args.deep = false; continue; }
    if (a === '--plan') { args.plan = true; continue; }
    if (a === '--apply') { args.apply = true; continue; }
    if (['--data-dir', '--diary-root', '--reset-root', '--confirm'].includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--data-dir') args.dataDir = v;
      if (a === '--diary-root') args.diaryRoot = v;
      if (a === '--reset-root') args.resetRoot = v;
      if (a === '--confirm') args.confirm = v;
      i += 1; continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  const inspection = inspectBackups({ dataDir: args.dataDir || undefined, diaryRoot: args.diaryRoot || undefined, resetRoot: args.resetRoot || undefined, deep: args.deep });
  if (!args.plan && !args.apply) {
    if (args.json) console.log(JSON.stringify(inspection, null, 1));
    else {
      console.log(`备份巡检（只读） 总数=${inspection.items.length}  restoreLock=${inspection.restoreLock}`);
      for (const [k, v] of Object.entries(inspection.counts)) console.log(`  ${k}: ${v}`);
      for (const it of inspection.items.slice(0, 100)) console.log(`  [${it.status}] ${it.type} ${it.id} ${it.bytes}B ${it.note || ''}`);
    }
    return 0;
  }
  const plan = planRetention({ inspection });
  if (args.apply) {
    if (String(args.confirm) !== String(plan.planHash)) { console.error(`拒绝：--apply 需要 --confirm ${plan.planHash}`); return 2; }
    const r = applyRetention({ plan, inspection, dataDir: inspection.dataDir, dryRun: false });
    console.log(JSON.stringify(r, null, 1));
    return r.ok ? 0 : 1;
  }
  console.log(JSON.stringify(plan, null, 1));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
