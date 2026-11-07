// DSH Session 只读审计与隔离恢复工具（D1-4 P3）。
//
// 默认只读：inspect / plan。quarantineSession / restoreQuarantined 仅供隔离测试与后续授权的恢复流程；
// 不暴露生产 CLI 清理命令、不 kill 任何进程、不删除任何 Session 目录（只做同卷移动隔离）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const DAY = 86400e3;
const nowIso = () => new Date().toISOString();
const sha256Text = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function safeReaddir(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function statSafe(p) { try { return fs.statSync(p); } catch { return null; } }
function treeHash(root) {
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of safeReaddir(dir)) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) {
        try { lines.push(`${r}|${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}|${fs.statSync(p).size}`); } catch { lines.push(`${r}|ERR`); }
      }
    }
  };
  walk(root, '');
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

/** 收集 DSH 会话目录（session-*），返回 [{sid, dir, project, mtime, bytes, files}]。 */
export function collectSessionDirs(dshHomeSessions) {
  const out = [];
  for (const proj of safeReaddir(dshHomeSessions).filter((e) => e.isDirectory())) {
    const projDir = path.join(dshHomeSessions, proj.name);
    for (const s of safeReaddir(projDir).filter((e) => e.isDirectory())) {
      const dir = path.join(projDir, s.name);
      const st = statSafe(dir);
      if (!st) continue;
      out.push({ sid: s.name, project: proj.name, dir, mtime: st.mtimeMs, bytes: null });
    }
  }
  return out;
}

/**
 * 只读审计。返回 findings + 汇总；processOwnership 恒为 unknown（没有持久子进程注册表）。
 */
export function inspectDshSessions({ dataDir = path.join(ROOT, 'data'), now = Date.now(), maxIdleDays = 30, maxSessionDays = 30 } = {}) {
  const data = path.resolve(dataDir);
  const mapFile = path.join(data, 'dsh-sessions.json');
  const dshSessions = path.join(data, 'dsh-home', 'sessions');
  const findings = [];
  const add = (level, code, at, message, extra = {}) => findings.push({ level, code, path: String(at || ''), message, ...extra });

  let map = {};
  let mapOk = false;
  if (fs.existsSync(mapFile)) {
    try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) || {}; mapOk = true; } catch (e) {
      add('critical', 'dsh_map_unreadable', mapFile, `DSH 映射不可读：${String(e?.message ?? e)}`);
    }
  }
  const dirs = collectSessionDirs(dshSessions);
  const bySid = new Map();
  for (const d of dirs) {
    if (!bySid.has(d.sid)) bySid.set(d.sid, []);
    bySid.get(d.sid).push(d);
  }
  const referenced = new Set();
  const sidToChats = new Map();
  if (mapOk) {
    for (const [chatKey, v] of Object.entries(map)) {
      const sid = String(v?.sessionId || '');
      if (!sid) { add('warn', 'dsh_map_invalid', mapFile, '映射缺少 sessionId', { chatKey }); continue; }
      referenced.add(sid);
      if (!sidToChats.has(sid)) sidToChats.set(sid, []);
      sidToChats.get(sid).push(chatKey);
      if (!bySid.has(sid)) {
        add('warn', 'dsh_map_missing_dir', mapFile, `映射的 DSH Session 目录不存在：${sid}`, { chatKey, sessionId: sid });
      }
      const chatFile = path.join(data, 'messages', `${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
      if (!fs.existsSync(chatFile)) add('info', 'dsh_map_without_local_chat', mapFile, '映射的聊天没有本地消息文件', { chatKey });
      const last = Date.parse(v?.lastUsedAt || v?.createdAt || '');
      if (Number.isFinite(last) && (now - last) / DAY > maxIdleDays) {
        add('info', 'dsh_map_idle', mapFile, `映射 ${Math.round((now - last) / DAY)} 天未使用`, { chatKey, lastUsedAt: v.lastUsedAt });
      }
    }
    for (const [sid, chats] of sidToChats) {
      if (chats.length > 1) add('warn', 'dsh_duplicate_mapping', mapFile, '多个聊天映射到同一个 DSH Session', { sessionId: sid, chatKeys: chats });
    }
  }
  for (const d of dirs) {
    if (!referenced.has(d.sid)) {
      const ageD = (now - d.mtime) / DAY;
      add('warn', 'dsh_orphan_session', d.dir, `未映射的 DSH Session 目录（项目 ${d.project}，${ageD.toFixed(1)} 天未修改）`, { sessionId: d.sid, project: d.project, ageDays: Math.round(ageD) });
    }
  }
  // 本地会话僵尸（只读；与 data-consistency 审计互补）
  const sessDir = path.join(data, 'sessions');
  for (const f of safeReaddir(sessDir).filter((e) => e.isFile() && e.name.endsWith('.json'))) {
    try {
      const s = JSON.parse(fs.readFileSync(path.join(sessDir, f.name), 'utf8'));
      if (s.status === 'running' || s.status === 'waiting') {
        const ageD = s.startedAt ? (now - Number(s.startedAt)) / DAY : 0;
        if (ageD > maxSessionDays) add('warn', 'local_session_zombie', path.join(sessDir, f.name), `本地会话 ${s.status} 已 ${ageD.toFixed(1)} 天`, { id: f.name.replace(/\.json$/, '') });
      }
    } catch { /* ignore */ }
  }
  const counts = findings.reduce((a, f) => { a[f.level] = (a[f.level] || 0) + 1; return a; }, { critical: 0, warn: 0, info: 0 });
  return {
    schema: 1,
    generatedAt: nowIso(),
    dataDir: data,
    mapOk,
    mappingCount: Object.keys(map).length,
    sessionDirCount: dirs.length,
    referencedCount: referenced.size,
    processOwnership: 'unknown',
    ownershipNote: '没有持久子进程注册表；不依赖 PID/PID 文件判断归属；无法验证时不终止任何进程',
    findings,
    counts
  };
}

/**
 * 只读恢复/清理计划：
 *  - orphan 且超过 quarantineAfterDays → quarantine 候选（仅隔离；生产需授权）
 *  - 映射缺失/重复/本地僵尸 → 人工动作，不自动执行
 */
export function planSessionActions({ inspection, quarantineAfterDays = 7, now = Date.now(), projectFilter = '' } = {}) {
  const candidates = [];
  const manual = [];
  const seen = new Set();
  // 默认只处理“本项目”的 DSH 项目目录（由 dataDir 的父目录推导，如 --E-dsh-QQ-agent--）；
  // 其他项目（如 --E-dsh--）一律人工确认，绝不自动隔离。
  const expectedProject = `--${path.resolve(inspection.dataDir, '..').replace(/[:\\/]+/g, '-')}--`;
  const filter = String(projectFilter || expectedProject);
  for (const f of inspection.findings) {
    if (f.code === 'dsh_orphan_session') {
      const age = Number(f.ageDays || 0);
      if (f.project !== filter) {
        manual.push({ action: 'manual_review_foreign_project', sessionId: f.sessionId, project: f.project, ageDays: age, reason: `非本项目 DSH 项目目录（期望 ${filter}）` });
        continue;
      }
      if (age >= quarantineAfterDays && !seen.has(f.path)) {
        seen.add(f.path);
        candidates.push({ action: 'quarantine', path: f.path, sessionId: f.sessionId, project: f.project, ageDays: age });
      }
    } else if (f.code === 'dsh_map_missing_dir' || f.code === 'dsh_duplicate_mapping') {
      manual.push({ action: f.code === 'dsh_duplicate_mapping' ? 'manual_review_mapping' : 'manual_rebuild_mapping', chatKey: f.chatKey, sessionId: f.sessionId, reason: f.message });
    } else if (f.code === 'local_session_zombie') {
      manual.push({ action: 'manual_review_local_session', id: f.id, reason: f.message });
    }
  }
  const planHash = sha256Text(JSON.stringify(candidates.map((c) => [c.action, c.path])));
  return { schema: 1, generatedAt: nowIso(), planHash, candidates, manual, counts: { quarantine: candidates.length, manual: manual.length } };
}

function assertUnderSessionRoot(p, dataDir) {
  const root = path.resolve(dataDir, 'dsh-home', 'sessions') + path.sep;
  const abs = path.resolve(p) + path.sep;
  if (!abs.toLowerCase().startsWith(root.toLowerCase())) throw new Error(`拒绝：目标不在 DSH sessions 根内：${p}`);
}

/**
 * 隔离一个 orphan Session 目录（同卷 rename 到 quarantine，不删除）。
 * 生产未授权；测试/人工流程使用。引用中的 session 一律拒绝。
 */
export function quarantineSession({ dir, dataDir = path.join(ROOT, 'data'), quarantineRoot = '', dryRun = true, now = Date.now() } = {}) {
  assertUnderSessionRoot(dir, dataDir);
  const data = path.resolve(dataDir);
  const mapFile = path.join(data, 'dsh-sessions.json');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(mapFile, 'utf8')) || {}; } catch { /* 无映射 */ }
  const sid = path.basename(dir);
  const referenced = Object.values(map).some((v) => String(v?.sessionId || '') === sid);
  if (referenced) return { ok: false, error: `拒绝隔离：Session 仍被映射引用：${sid}` };
  const destRoot = path.resolve(quarantineRoot || path.join(data, 'dsh-home', '.quarantine'));
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  const project = path.basename(path.dirname(dir));
  const dest = path.join(destRoot, stamp, project, sid);
  const record = { at: nowIso(), action: 'quarantine', sessionId: sid, project, from: dir, to: dest, result: dryRun ? 'planned' : 'ok' };
  const audit = () => { try { fs.mkdirSync(path.dirname(path.join(destRoot, 'audit.jsonl')), { recursive: true }); fs.appendFileSync(path.join(destRoot, 'audit.jsonl'), JSON.stringify(record) + '\n', 'utf8'); } catch { /* ignore */ } };
  if (dryRun) { audit(); return { ok: true, dryRun: true, dest } ; }
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(dir, dest);
    if (fs.existsSync(dir) || !fs.existsSync(dest)) throw new Error('移动后校验失败');
    audit();
    return { ok: true, dryRun: false, dest, record };
  } catch (e) {
    record.result = 'failed'; record.error = String(e?.message ?? e); audit();
    return { ok: false, error: String(e?.message ?? e), dest };
  }
}

/** 从 quarantine 恢复（目标已存在则拒绝，不覆盖）。 */
export function restoreQuarantined({ quarantinedDir, dataDir = path.join(ROOT, 'data'), dryRun = true } = {}) {
  const data = path.resolve(dataDir);
  const src = path.resolve(quarantinedDir);
  const parts = src.split(path.sep);
  const sid = parts[parts.length - 1];
  const project = parts[parts.length - 2];
  const dest = path.join(data, 'dsh-home', 'sessions', project, sid);
  assertUnderSessionRoot(dest, data);
  if (fs.existsSync(dest)) return { ok: false, error: `目标已存在，拒绝覆盖：${dest}` };
  if (!fs.existsSync(src)) return { ok: false, error: `隔离目录不存在：${src}` };
  if (dryRun) return { ok: true, dryRun: true, dest };
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(src, dest);
    return { ok: true, dryRun: false, dest };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

export function main(argv = process.argv.slice(2)) {
  const args = { json: false, dataDir: '', plan: false, maxIdleDays: 30, maxSessionDays: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (a === '--plan') { args.plan = true; continue; }
    if (['--data-dir', '--max-idle-days', '--max-session-days'].includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--data-dir') args.dataDir = v;
      if (a === '--max-idle-days') args.maxIdleDays = Number(v);
      if (a === '--max-session-days') args.maxSessionDays = Number(v);
      i += 1; continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  const inspection = inspectDshSessions({ dataDir: args.dataDir || undefined, maxIdleDays: args.maxIdleDays, maxSessionDays: args.maxSessionDays });
  const payload = args.plan ? { inspection, plan: planSessionActions({ inspection }) } : inspection;
  if (args.json) console.log(JSON.stringify(payload, null, 1));
  else {
    const r = inspection;
    console.log(`DSH Session 审计（只读）  映射=${r.mappingCount} 目录=${r.sessionDirCount} 引用=${r.referencedCount}`);
    console.log(`  critical=${r.counts.critical} warn=${r.counts.warn} info=${r.counts.info}  进程归属=${r.processOwnership}`);
    for (const f of r.findings.slice(0, 100)) console.log(`  [${f.level}] ${f.code} ${f.message}`);
    if (args.plan) {
      const p = planSessionActions({ inspection });
      console.log(`计划：隔离候选=${p.counts.quarantine} 人工动作=${p.counts.manual} planHash=${p.planHash}`);
      for (const c of p.candidates) console.log(`  quarantine ${c.sessionId} (${c.project}, ${c.ageDays}天)`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
