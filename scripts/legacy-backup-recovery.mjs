// 旧日记 .trash 备份：清单/补录 manifest 设计 + 隔离恢复（默认 dry-run）。不接触生产。
//
// 用法：
//   node scripts/legacy-backup-recovery.mjs --inspect [--diary-root <dir>] [--json]
//   node scripts/legacy-backup-recovery.mjs --manifest <backupFile> [--date-key <YYYY-MM-DD>] [--json]
// 恢复仅作为模块能力供隔离测试/后续授权流程使用；不提供生产 CLI restore。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

export function parseTrashName(name) {
  const s = String(name || '');
  const legacy = /^(\d{4}-\d{2}-\d{2})\.md\.legacy-(\d+)\.bak$/.exec(s);
  if (legacy) return { dateKey: legacy[1], ts: Number(legacy[2]), op: 'legacy-migration' };
  const plain = /^(\d{4}-\d{2}-\d{2})\.md\.(\d+)\.bak$/.exec(s);
  if (plain) return { dateKey: plain[1], ts: Number(plain[2]), op: 'removeLine/relevel' };
  const promises = /^promises\.md\.migrated-(\d+)\.bak$/.exec(s);
  if (promises) return { dateKey: 'promises', ts: Number(promises[1]), op: 'migrated-promises' };
  return null;
}

/** 只读清单：文件/大小/SHA256/日期/时间/正文对照/唯一内容/分类。 */
export function inspectTrash({ diaryRoot = 'E:\\dsh\\日记', now = Date.now() } = {}) {
  const trash = path.join(diaryRoot, '.trash');
  const dayDir = path.join(diaryRoot, '每日');
  const out = [];
  for (const f of (() => { try { return fs.readdirSync(trash, { withFileTypes: true }); } catch { return []; } })()) {
    if (!f.isFile()) continue;
    const p = path.join(trash, f.name);
    try {
      const st = fs.statSync(p);
      const meta = parseTrashName(f.name) || { dateKey: '', ts: 0, op: 'unknown' };
      const bodyFile = meta.dateKey && meta.dateKey !== 'promises' ? path.join(dayDir, `${meta.dateKey}.md`) : null;
      const body = bodyFile && fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile, 'utf8') : null;
      const backupText = fs.readFileSync(p, 'utf8');
      const norm = (s) => s.replace(/[\s，。！？、,.!?]/g, '');
      const lines = (t) => String(t).replace(/\r\n/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
      const bodyLines = body ? lines(body) : [];
      const bodySet = new Set(bodyLines.map(norm));
      const unique = lines(backupText).filter((l) => !bodySet.has(norm(l)));
      const identical = body ? sha256(bodyFile) === sha256(p) : false;
      let classification = 'historical_unknown';
      if (body) classification = identical || unique.length === 0 ? 'verified_superseded' : 'verified_recoverable';
      out.push({
        file: f.name, path: p, size: st.size, sha256: sha256(p), dateKey: meta.dateKey,
        backupCreatedAt: meta.ts ? new Date(meta.ts).toISOString() : st.mtime.toISOString(),
        mtime: st.mtime.toISOString(), op: meta.op, bodyFile, bodyExists: Boolean(body),
        bodySha256: body ? sha256(bodyFile) : '', identicalToBody: identical,
        uniqueLines: unique.length, uniqueSample: unique.slice(0, 3).map((x) => x.slice(0, 80)),
        classification, manifestStatus: 'none'
      });
    } catch (e) {
      out.push({ file: f.name, path: p, size: 0, sha256: '', dateKey: '', backupCreatedAt: '', mtime: '', op: 'unknown', bodyExists: false, bodySha256: '', identicalToBody: false, uniqueLines: 0, uniqueSample: [], classification: 'corrupted', manifestStatus: 'none', error: String(e?.message ?? e) });
    }
  }
  return { schema: 1, generatedAt: new Date(now).toISOString(), diaryRoot, files: out, counts: out.reduce((a, x) => { a[x.classification] = (a[x.classification] || 0) + 1; return a; }, {}) };
}

/**
 * 旧备份 manifest 补录（**设计/纯函数**）：不写生产、不伪造历史 hash/时间。
 * - sha256/size 是当前读取的真实值；backupCreatedAt 来自文件名时间戳（历史事实），无法确认时用 mtime；
 * - recordedAt 是补录时间（不是历史创建时间）；historical=true / sourceUncertain=true。
 */
export function buildLegacyManifest({ backupFile, dateKey = '', now = Date.now() } = {}) {
  const p = path.resolve(backupFile);
  const st = fs.statSync(p);
  const meta = parseTrashName(path.basename(p)) || { dateKey, ts: 0, op: 'unknown' };
  const key = dateKey || meta.dateKey;
  if (!key) throw new Error('缺少 dateKey，拒绝生成 manifest');
  return {
    schemaVersion: 1,
    kind: 'legacy-trash',
    file: path.basename(p),
    dateKey: key,
    sha256: sha256(p),
    size: st.size,
    sourcePath: p,
    op: meta.op,
    backupCreatedAt: meta.ts ? new Date(meta.ts).toISOString() : st.mtime.toISOString(),
    backupCreatedAtSource: meta.ts ? 'filename-timestamp' : 'mtime',
    recordedAt: new Date(now).toISOString(),
    historical: true,
    sourceUncertain: true,
    note: '补录 manifest：hash/size 为当前实测；未改写备份，未伪造历史时间或历史 hash'
  };
}

/**
 * 隔离恢复：把备份复制到目标日记根（默认 dry-run）。目标存在则拒绝（不覆盖）。
 * expectedSha256 可选：提供时校验备份完整性，不一致拒绝。
 */
export function restoreLegacyBackup({ backupFile, targetDiaryRoot, dateKey = '', dryRun = true, expectedSha256 = '', hooks = null } = {}) {
  const src = path.resolve(backupFile);
  const targetRoot = path.resolve(targetDiaryRoot || '');
  if (!targetRoot) return { ok: false, error: '缺少 targetDiaryRoot' };
  if (!fs.existsSync(src)) return { ok: false, error: `备份不存在：${src}` };
  const meta = parseTrashName(path.basename(src)) || { dateKey };
  const key = String(dateKey || meta.dateKey || '');
  if (!/^(\d{4}-\d{2}-\d{2}|promises)$/.test(key)) return { ok: false, error: `dateKey 不合法：${key}` };
  let actual = '';
  try { actual = sha256(src); } catch (e) { return { ok: false, error: `备份不可读：${String(e?.message ?? e)}` }; }
  if (expectedSha256 && actual !== expectedSha256) return { ok: false, error: '备份 hash 与期望不一致（可能损坏），拒绝恢复' };
  const dest = key === 'promises' ? path.join(targetRoot, 'promises.md') : path.join(targetRoot, '每日', `${key}.md`);
  if (fs.existsSync(dest)) return { ok: false, error: `目标已存在，拒绝覆盖：${dest}` };
  const record = { at: new Date().toISOString(), action: 'restore-legacy', backupFile: src, sha256: actual, target: dest, result: dryRun ? 'planned' : 'ok' };
  const auditFile = path.join(targetRoot, '.legacy-restore-audit.jsonl');
  const audit = () => { try { fs.mkdirSync(path.dirname(auditFile), { recursive: true }); fs.appendFileSync(auditFile, JSON.stringify(record) + '\n', 'utf8'); } catch { /* ignore */ } };
  if (dryRun) { audit(); return { ok: true, dryRun: true, target: dest, sha256: actual }; }
  const tmp = `${dest}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, tmp);
    if (hooks && hooks.interruptAfterTemp) throw new Error('模拟恢复中断（测试注入）');
    const h = sha256(tmp);
    if (h !== actual) throw new Error('恢复后 hash 不一致');
    fs.renameSync(tmp, dest);
    record.result = 'ok';
    audit();
    return { ok: true, dryRun: false, target: dest, sha256: h };
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    record.result = 'failed'; record.error = String(e?.message ?? e); audit();
    return { ok: false, error: String(e?.message ?? e), target: dest };
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = { json: false, inspect: false, manifest: '', diaryRoot: '', dateKey: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (a === '--inspect') { args.inspect = true; continue; }
    if (['--manifest', '--diary-root', '--date-key'].includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--manifest') args.manifest = v;
      if (a === '--diary-root') args.diaryRoot = v;
      if (a === '--date-key') args.dateKey = v;
      i += 1; continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  if (args.manifest) {
    try { console.log(JSON.stringify(buildLegacyManifest({ backupFile: args.manifest, dateKey: args.dateKey }), null, 1)); return 0; }
    catch (e) { console.error(String(e?.message ?? e)); return 1; }
  }
  const r = inspectTrash({ diaryRoot: args.diaryRoot || undefined });
  if (args.json) console.log(JSON.stringify(r, null, 1));
  else {
    console.log(`旧日记备份清单（只读） 共 ${r.files.length}`);
    for (const x of r.files) console.log(`  [${x.classification}] ${x.file} ${x.size}B uniq=${x.uniqueLines} ${x.backupCreatedAt}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
