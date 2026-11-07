// DSH Session 清单与归属状态（D1-5C，只读）。不移动/删除/终止任何进程。
//
// 用法：node scripts/session-inventory.mjs [--json] [--data-dir <dir>] [--now <ms>]
// 状态：mapped_active / mapped_idle / unmapped_project_owned / external /
//       process_unknown / recovery_candidate / quarantine_candidate / historical_unknown
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const DAY = 86400e3;
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sha256Text = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function listDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; } }
function filesOf(dir) {
  const out = [];
  const walk = (d, rel) => {
    for (const e of (() => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) { try { out.push({ rel: r, size: fs.statSync(p).size }); } catch { /* ignore */ } }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * 只读清单：每个 Session 的目录/时间/文件/mapping/聊天引用/companion 引用/本地会话引用/备份/状态。
 */
export function inventorySessions({
  dataDir = path.join(ROOT, 'data'),
  now = Date.now(),
  idleDays = 7,
  quarantineAfterDays = 7,
  deepLocalRefs = false
} = {}) {
  const data = path.resolve(dataDir);
  const sessionsRoot = path.join(data, 'dsh-home', 'sessions');
  const mapFile = path.join(data, 'dsh-sessions.json');
  const project = `--${path.resolve(data, '..').replace(/[:\\/]+/g, '-')}--`;
  let map = {};
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) || {}; } catch { /* none */ }
  const bySid = new Map();
  for (const [chatKey, v] of Object.entries(map)) {
    const sid = String(v?.sessionId || '');
    if (!sid) continue;
    if (!bySid.has(sid)) bySid.set(sid, []);
    bySid.get(sid).push({ chatKey, lastUsedAt: v.lastUsedAt, createdAt: v.createdAt });
  }
  const compText = (() => { try { return fs.readFileSync(path.join(data, 'companion-state.json'), 'utf8'); } catch { return ''; } })();
  const autoText = (() => { try { return fs.readFileSync(path.join(data, 'autonomous.json'), 'utf8'); } catch { return ''; } })();
  const localText = deepLocalRefs ? (() => {
    const dir = path.join(data, 'sessions');
    const parts = [];
    for (const f of (() => { try { return fs.readdirSync(dir); } catch { return []; } })()) {
      if (!f.endsWith('.json')) continue;
      try { parts.push(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* ignore */ }
    }
    return parts.join('\n');
  })() : '';

  const out = [];
  for (const proj of listDirs(sessionsRoot)) {
    for (const sid of listDirs(path.join(sessionsRoot, proj))) {
      const dir = path.join(sessionsRoot, proj, sid);
      const st = (() => { try { return fs.statSync(dir); } catch { return null; } })();
      if (!st) continue;
      const files = filesOf(dir);
      const refs = bySid.get(sid) || [];
      const chatRefs = refs.filter((r) => {
        const f = path.join(data, 'messages', `${String(r.chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
        return fs.existsSync(f);
      }).map((r) => r.chatKey);
      const companionRefs = compText.includes(sid);
      const autoRefs = autoText.includes(sid);
      const localRefs = Boolean(localText && localText.includes(sid));
      // 可恢复备份：D1-5C 前置条件（备份目录 + manifest + hash）
      const backupDir = path.join(data, 'dsh-home', '.session-backups', sid);
      let backup = { ok: false, path: backupDir };
      try {
        const m = JSON.parse(fs.readFileSync(path.join(backupDir, 'manifest.json'), 'utf8'));
        const file = path.join(backupDir, ...String(m.file || '').split('/'));
        backup = { ok: Boolean(m.sha256) && fs.existsSync(file) && sha256(file) === m.sha256, path: backupDir, manifest: m };
      } catch { /* none */ }
      const ageD = (now - st.mtimeMs) / DAY;
      const mapped = refs.length > 0;
      const lastUsed = refs.map((r) => Date.parse(r.lastUsedAt || '')).filter(Number.isFinite);
      const idle = mapped && lastUsed.length > 0 && (now - Math.max(...lastUsed)) / DAY > idleDays;
      let classification;
      let blockers = [];
      if (proj !== project) {
        classification = 'external';
        blockers = ['external_project'];
      } else if (mapped) {
        classification = idle ? 'mapped_idle' : 'mapped_active';
        blockers = ['mapped'];
      } else if (files.length === 0) {
        classification = 'historical_unknown';
        blockers = ['empty_dir', 'no_content'];
      } else {
        classification = 'unmapped_project_owned';
        blockers = ['process_unknown', 'content_unknown'];
        if (ageD < quarantineAfterDays) blockers.push(`age<${quarantineAfterDays}d`);
        if (!backup.ok) blockers.push('no_verified_backup');
        if (companionRefs || autoRefs || localRefs || chatRefs.length) blockers.push('has_reference');
      }
      const quarantineEligible = classification === 'unmapped_project_owned'
        && ageD >= quarantineAfterDays && backup.ok
        && !companionRefs && !autoRefs && !localRefs && chatRefs.length === 0
        && files.length > 0;
      if (quarantineEligible) classification = 'quarantine_candidate';
      else if (!mapped && proj === project && classification === 'unmapped_project_owned' && backup.ok) classification = 'recovery_candidate';
      out.push({
        sid, project: proj, dir, createdAt: st.birthtime.toISOString(), mtime: st.mtime.toISOString(), ageDays: Math.round(ageD * 10) / 10,
        files: files.length, bytes: files.reduce((s, f) => s + f.size, 0), fileSample: files.slice(0, 3).map((f) => f.rel),
        mappedChatKeys: refs.map((r) => r.chatKey), chatHistoryRefs: chatRefs, companionRefs, autoRefs, localRefs,
        process: 'unknown', processNote: '无持久子进程注册表；不依赖 PID 判断归属',
        content: 'unknown', contentNote: 'zstd 内容未解析',
        backup: { ok: backup.ok, path: backup.path },
        classification, blockers, quarantineEligible
      });
    }
  }
  const counts = out.reduce((a, x) => { a[x.classification] = (a[x.classification] || 0) + 1; return a; }, {});
  return { schema: 1, generatedAt: new Date(now).toISOString(), dataDir: data, project, idleDays, quarantineAfterDays, sessions: out, counts };
}

/** 只读计划：只有 quarantine_candidate 进入；其余仅说明阻塞项。 */export function planSessionQuarantine({ inventory }) {  const candidates = inventory.sessions.filter((s) => s.quarantineEligible).map((s) => ({
    action: 'quarantine', sid: s.sid, dir: s.dir, backup: s.backup.path, ageDays: s.ageDays, project: s.project
  }));
  const manual = inventory.sessions.filter((s) => s.project === inventory.project && !s.quarantineEligible && s.classification !== 'mapped_active').map((s) => ({
    sid: s.sid, classification: s.classification, blockers: s.blockers
  }));
  return { schema: 1, generatedAt: new Date().toISOString(), planHash: sha256Text(JSON.stringify(candidates.map((c) => [c.action, c.sid, c.dir]))), candidates, manual, counts: { quarantine: candidates.length, manual: manual.length } };
}

function treeManifest(dir, excludeManifest = false) {
  const files = filesOf(dir).filter((f) => !(excludeManifest && f.rel === 'quarantine-manifest.json')).map((f) => {
    const abs = path.join(dir, ...f.rel.split('/'));
    return { rel: f.rel, size: f.size, sha256: sha256(abs) };
  });
  return { files, treeHash: sha256Text(JSON.stringify(files)) };
}

/**
 * 带 manifest/hash 的隔离（仅本项目、无映射、需已验证备份；默认 dry-run）。
 * 同卷 rename，保留原路径/目标路径/文件 hash；失败不删除源。
 */
export function quarantineSessionOwned({ sid, dataDir = path.join(ROOT, 'data'), quarantineRoot = '', planHash = '', dryRun = true, requireBackup = true, now = Date.now(), hooks = null } = {}) {
  const data = path.resolve(dataDir);
  const project = `--${path.resolve(data, '..').replace(/[:\\/]+/g, '-')}--`;
  const dir = path.join(data, 'dsh-home', 'sessions', project, sid);
  const sessionsRoot = path.join(data, 'dsh-home', 'sessions');
  if (!fs.existsSync(dir)) return { ok: false, error: `Session 不存在：${sid}` };
  if (!path.resolve(dir).startsWith(sessionsRoot + path.sep)) return { ok: false, error: '路径越界，拒绝' };
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(data, 'dsh-sessions.json'), 'utf8')) || {}; } catch { /* none */ }
  if (Object.values(map).some((v) => String(v?.sessionId || '') === sid)) return { ok: false, error: `Session 仍被映射引用：${sid}` };
  if (requireBackup) {
    const bdir = path.join(data, 'dsh-home', '.session-backups', sid);
    try {
      const m = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'));
      const bf = path.join(bdir, ...String(m.file || '').split('/'));
      if (!m.sha256 || !fs.existsSync(bf) || sha256(bf) !== m.sha256) return { ok: false, error: '缺少可验证备份，拒绝隔离' };
    } catch { return { ok: false, error: '缺少可验证备份，拒绝隔离' }; }
  }
  const tm = treeManifest(dir);
  const destRoot = path.resolve(quarantineRoot || path.join(data, 'dsh-home', '.quarantine'));
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const dest = path.join(destRoot, stamp, project, sid);
  const manifest = { schemaVersion: 1, kind: 'session-quarantine', sid, project, from: dir, to: dest, files: tm.files, treeHash: tm.treeHash, planHash, createdAt: new Date(now).toISOString(), status: 'quarantined' };
  const auditFile = path.join(destRoot, 'audit.jsonl');
  const audit = (rec) => { try { fs.mkdirSync(path.dirname(auditFile), { recursive: true }); fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), action: 'quarantine', sid, planHash, ...rec }) + '\n', 'utf8'); } catch { /* ignore */ } };
  if (dryRun) { audit({ result: 'planned', from: dir, to: dest }); return { ok: true, dryRun: true, dest, manifest }; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (hooks && hooks.failBeforeMove) throw new Error('模拟移动中断（测试注入）');
    fs.renameSync(dir, dest);
    fs.writeFileSync(path.join(dest, 'quarantine-manifest.json'), JSON.stringify(manifest, null, 1), 'utf8');
    if (fs.existsSync(dir) || !fs.existsSync(dest)) throw new Error('移动后校验失败');
    audit({ result: 'ok', from: dir, to: dest, treeHash: tm.treeHash });
    return { ok: true, dryRun: false, dest, manifest };
  } catch (e) {
    if (!fs.existsSync(dir) && fs.existsSync(dest)) { try { fs.renameSync(dest, dir); } catch { /* ignore */ } }
    audit({ result: 'failed', from: dir, to: dest, error: String(e?.message ?? e) });
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 从隔离目录恢复（先校验 manifest/所有文件 hash；目标冲突拒绝）。 */
export function restoreOwnedQuarantine({ quarantinedDir, dataDir = path.join(ROOT, 'data'), dryRun = true } = {}) {
  const data = path.resolve(dataDir);
  const src = path.resolve(quarantinedDir);
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(src, 'quarantine-manifest.json'), 'utf8')); } catch { return { ok: false, error: '缺少 quarantine-manifest.json，拒绝恢复' }; }
  const dest = path.join(data, 'dsh-home', 'sessions', manifest.project, manifest.sid);
  if (fs.existsSync(dest)) return { ok: false, error: `目标已存在，拒绝覆盖：${dest}` };
  const tm = treeManifest(src, true);
  const want = JSON.stringify(manifest.files);
  if (tm.treeHash !== manifest.treeHash || JSON.stringify(tm.files) !== want) return { ok: false, error: '隔离目录文件 hash 与 manifest 不一致，拒绝恢复' };
  if (dryRun) return { ok: true, dryRun: true, dest };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    try { fs.unlinkSync(path.join(dest, 'quarantine-manifest.json')); } catch { /* ignore */ }
    return { ok: true, dryRun: false, dest };
  } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}

export function main(argv = process.argv.slice(2)) {
  const args = { json: false, dataDir: '', now: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (['--data-dir', '--now'].includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--data-dir') args.dataDir = v;
      if (a === '--now') args.now = Number(v);
      i += 1; continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  const inv = inventorySessions({ dataDir: args.dataDir || undefined, now: args.now || Date.now() });
  const plan = planSessionQuarantine({ inventory: inv });
  const payload = { inventory: inv, plan };
  if (args.json) console.log(JSON.stringify(payload, null, 1));
  else {
    console.log(`Session 清单（只读） 项目=${inv.project} 总数=${inv.sessions.length}`);
    for (const [k, v] of Object.entries(inv.counts)) console.log(`  ${k}: ${v}`);
    for (const s of inv.sessions) console.log(`  [${s.classification}] ${s.sid} ${s.bytes}B age=${s.ageDays}d blockers=${s.blockers.join(',')}`);
    console.log(`计划：quarantine=${plan.counts.quarantine} manual=${plan.counts.manual}`);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
