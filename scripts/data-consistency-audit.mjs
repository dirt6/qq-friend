// 数据一致性只读审计（D1-4）。默认只读：不写、不修复、不删除。
//
// 用法：
//   node scripts/data-consistency-audit.mjs [--json] [--deep-backup]
//        [--data-dir <dir>] [--diary-root <dir>]
//        [--max-pending-hours 24] [--max-session-days 30]
//        [--fail-on critical|warn]
//
// 覆盖：正文/meta、pending、幂等键、sessions、DSH 映射、备份、审计文件。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { splitParagraphs } from '../src/diary/meta.js';
import { readManifest } from '../src/reset-data.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(dir, filter = () => true) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && filter(e.name)).map((e) => e.name); } catch { return []; }
}
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { return []; }
}
function readJson(file) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8')) }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function collectDirNames(root) {
  const names = new Set();
  const walk = (dir, depth) => {
    if (depth > 5) return;
    for (const e of safeReaddir(dir)) {
      if (!e.isDirectory()) continue;
      names.add(e.name);
      walk(path.join(dir, e.name), depth + 1);
    }
  };
  const safeReaddir = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };
  walk(root, 0);
  return names;
}

/**
 * 只读审计。返回 { schema, generatedAt, counts, findings }。
 */
export function auditConsistency({
  dataDir = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data'),
  diaryRoot = process.env.QQ_AGENT_DIARY_ROOT || 'E:\\dsh\\本子\\日记',
  now = Date.now(),
  maxPendingHours = 24,
  maxSessionDays = 30,
  deepBackup = false,
  testCorpus = null
} = {}) {
  const findings = [];
  const add = (level, code, at, message, extra = {}) => findings.push({ level, code, path: String(at || ''), message, ...extra });
  const data = path.resolve(dataDir);
  const diary = path.resolve(diaryRoot);

  /* 1. 正文 / meta */
  const dayDir = path.join(diary, '每日');
  const metaDir = path.join(data, 'diary-meta');
  const dayFiles = listFiles(dayDir, (n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
  const metaFiles = listFiles(metaDir, (n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
  const daySet = new Set(dayFiles.map((n) => n.slice(0, 10)));
  const metaSet = new Set(metaFiles.map((n) => n.slice(0, 10)));
  for (const day of daySet) {
    if (!metaSet.has(day)) add('info', 'meta_missing', path.join(metaDir, `${day}.json`), '正文存在但无 meta（meta 写入开关关闭时属预期）', { day });
  }
  for (const day of metaSet) {
    if (!daySet.has(day)) add('warn', 'meta_orphan', path.join(metaDir, `${day}.json`), 'meta 存在但正文不存在', { day });
    const body = readText(path.join(dayDir, `${day}.md`));
    const mj = readJson(path.join(metaDir, `${day}.json`));
    if (!mj.ok) { add('warn', 'meta_unreadable', path.join(metaDir, `${day}.json`), mj.error, { day }); continue; }
    if (!body) continue;
    const paras = splitParagraphs(body);
    for (const e of Array.isArray(mj.value?.entries) ? mj.value.entries : []) {
      if (e?.stale) { add('warn', 'meta_stale', path.join(metaDir, `${day}.json`), `条目标记 stale：${e.staleReason || ''}`, { day, paragraphIndex: e.paragraphIndex }); continue; }
      const p = paras[Number(e?.paragraphIndex)];
      if (!p) add('warn', 'meta_index_out_of_range', path.join(metaDir, `${day}.json`), '段落索引越界', { day, paragraphIndex: e?.paragraphIndex });
      else if (p.hash !== e?.quoteHash) add('warn', 'meta_quote_mismatch', path.join(metaDir, `${day}.json`), 'quoteHash 与正文不一致', { day, paragraphIndex: e?.paragraphIndex });
    }
  }

  /* 2. pending outbox */
  const pendingFile = path.join(metaDir, 'pending.json');
  if (fs.existsSync(pendingFile)) {
    const pj = readJson(pendingFile);
    if (!pj.ok) add('critical', 'pending_unreadable', pendingFile, `pending.json 损坏：${pj.error}`);
    else {
      const items = pj.value?.items && typeof pj.value.items === 'object' ? pj.value.items : {};
      for (const [id, it] of Object.entries(items)) {
        if (!it || it.stage === 'completed') continue;
        const ageH = it.createdAt ? (now - Date.parse(it.createdAt)) / 3600e3 : 0;
        const level = ageH > maxPendingHours ? 'warn' : 'info';
        add(level, ageH > maxPendingHours ? 'pending_long_unfinished' : 'pending_unfinished', path.join(pendingFile, `#${id}`), `未完成操作 stage=${it.stage} op=${it.op} age=${ageH.toFixed(1)}h`, { id, ageHours: Math.round(ageH) });
      }
    }
  }

  /* 3. 幂等键（hash 优先 + 合并链 + 测试/重复键分类） */
  const idemFile = path.join(data, 'diary-idempotency.json');
  const bodyCache = new Map();
  const bodyOf = (day) => {
    if (bodyCache.has(day)) return bodyCache.get(day);
    const t = readText(path.join(dayDir, `${day}.md`)) || '';
    bodyCache.set(day, t);
    return t;
  };
  const parseLine = (line) => {
    const m = /^- 心情：([^｜]+)｜(?:\[([^\]]+)\]\s*)?(.+)$/.exec(String(line || ''));
    return m ? { mood: m[1].trim(), imp: m[2] || '一般', text: m[3] } : null;
  };
  const lineHash = (line) => {
    const p = parseLine(line);
    return p ? crypto.createHash('sha1').update(`${p.mood}|${p.imp}|${p.text}`).digest('hex').slice(0, 16) : '';
  };
  const normText = (s) => String(s || '').replace(/[\s，。！？、,.!?]/g, '');
  const bodyLinesOf = (day) => bodyOf(day).split(/\r?\n/).filter((l) => l.startsWith('- 心情'))
    .map((l) => ({ line: l, parsed: parseLine(l) })).filter((x) => x.parsed);
  // 测试语料：用于识别“写进 test 的样例文本”，避免把测试残留误报为生产异常。
  let corpus = testCorpus;
  if (corpus == null) {
    const testDir = path.join(ROOT, 'test');
    corpus = listFiles(testDir, (n) => /\.(mjs|js)$/.test(n)).slice(0, 200).map((n) => readText(path.join(testDir, n)) || '').join('\n');
  }
  corpus = String(corpus || '');
  if (fs.existsSync(idemFile)) {
    const ij = readJson(idemFile);
    if (!ij.ok) add('critical', 'idem_unreadable', idemFile, `幂等表损坏：${ij.error}`);
    else {
      const entries = Object.entries(ij.value?.keys || {});
      const groups = new Map();
      for (const [key, v] of entries) {
        const gk = `${v?.day}|${v?.hash}`;
        if (!groups.has(gk)) groups.set(gk, []);
        groups.get(gk).push(key);
      }
      for (const [key, v] of entries) {
        const day = String(v?.day || '');
        if (!day) { add('warn', 'idem_no_day', idemFile, '记录缺少 day', { key }); continue; }
        if (!fs.existsSync(path.join(dayDir, `${day}.md`))) add('warn', 'idem_day_missing', idemFile, `记录对应的日记文件不存在：${day}`, { key, day });
        const body = bodyOf(day);
        const line = String(v?.line || '');
        const exact = Boolean(line && body.includes(line));
        const lines = bodyLinesOf(day);
        const hashHit = Boolean(v?.hash) && lines.some((x) => lineHash(x.line) === v.hash);
        const legacyPrefix = (line.split('｜').slice(1).join('｜') || '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 20);
        const legacyPresent = Boolean(legacyPrefix && body.includes(legacyPrefix));
        const parsed = parseLine(line);
        const ownHash = lineHash(line);
        // 记录自身 hash 与行文本不一致 → 明确异常（不是“相似”问题）
        if (parsed && ownHash && /^[0-9a-f]{16}$/.test(String(v?.hash || '')) && ownHash !== String(v.hash)) {
          add('warn', 'idem_hash_mismatch', idemFile, '幂等记录 hash 与其 line 反算不一致（记录损坏/被改写）', {
            key, day, verdict: 'confirmed_anomaly', expectedHash: v.hash, actualHash: ownHash
          });
          continue;
        }

        if (v?.state === 'done') {
          if (exact || hashHit) continue; // 一致（精确行或内容 hash 命中）
          const testSourceMatch = Boolean(parsed?.text && parsed.text.length >= 8 && corpus.includes(parsed.text));
          if (v?.source === 'test' || testSourceMatch) {
            add('info', 'idem_test_residue', idemFile, testSourceMatch ? '测试语料命中：该行文本出现在 test/ 样例中，判定测试残留' : '测试写入残留（source=test），非生产内容', {
              key, day, verdict: 'confirmed_consistent', evidence: testSourceMatch ? 'test_source_match' : 'source_test'
            });
            continue;
          }
          // 合并/改写链：正文中存在同 12 字族前缀的行，其 hash 等于某条更晚幂等记录的行 hash
          const vt = parsed?.text || '';
          const fam = normText(vt).slice(0, 12);
          let successor = null;
          for (const x of lines) {
            if (!fam || normText(x.parsed.text).slice(0, 12) !== fam) continue;
            const h = lineHash(x.line);
            for (const [k2, v2] of entries) {
              if (k2 === key || String(v2?.day || '') !== day) continue;
              if (!(Number(v2?.at) > Number(v?.at))) continue;
              if (lineHash(v2?.line) === h) { successor = { key: k2, hash: h, at: new Date(Number(v2.at)).toISOString() }; break; }
            }
            if (successor) break;
          }
          if (successor) {
            add('info', 'idem_done_superseded', idemFile, 'done 记录已被更晚的合并/改写取代（正文 hash 与后继记录一致）', {
              key, day, verdict: 'confirmed_consistent', successorKey: successor.key, successorAt: successor.at
            });
            continue;
          }
          const dup = (groups.get(`${day}|${v.hash}`) || []).length > 1;
          if (dup) {
            add('warn', 'idem_duplicate_done_missing', idemFile, '重复键（同 day+hash 多种形态）且正文无对应行，需人工确认是否测试残留', {
              key, day, verdict: 'historical_unverifiable', duplicateKeys: groups.get(`${day}|${v.hash}`)
            });
          } else {
            add('warn', 'idem_done_line_missing', idemFile, 'done 但正文找不到对应行（无合并链/无测试标记）', {
              key, day, verdict: 'historical_unverifiable'
            });
          }
          continue;
        }
        if (v?.state === 'pending') {
          const present = exact || hashHit || legacyPresent;
          if (present) add('info', 'idem_pending_written_unconfirmed', idemFile, 'pending 但正文已有对应行（待确认）', { key, day, verdict: 'confirmed_consistent' });
          else add('info', 'idem_pending_not_written', idemFile, 'pending 且正文无对应行（未写入/待重试）', { key, day, verdict: 'historical_unverifiable' });
        }
      }
    }
  }

  /* 4. sessions */
  const sessDir = path.join(data, 'sessions');
  const sessFiles = listFiles(sessDir, (n) => n.endsWith('.json'));
  const sessIds = new Set();
  for (const f of sessFiles) {
    const id = f.replace(/\.json$/, '');
    sessIds.add(id);
    const j = readJson(path.join(sessDir, f));
    if (!j.ok) { add('warn', 'session_unreadable', path.join(sessDir, f), j.error, { id }); continue; }
    const s = j.value || {};
    if (s.status === 'running' || s.status === 'waiting') {
      const ageD = s.startedAt ? (now - Number(s.startedAt)) / 86400e3 : 0;
      if (ageD > maxSessionDays) add('warn', 'session_zombie', path.join(sessDir, f), `状态 ${s.status} 已 ${ageD.toFixed(1)} 天（疑似僵尸）`, { id, ageDays: Math.round(ageD) });
    }
  }
  const cacheFile = path.join(data, 'session-index-cache.json');
  if (fs.existsSync(cacheFile)) {
    const cj = readJson(cacheFile);
    if (!cj.ok) add('warn', 'session_cache_unreadable', cacheFile, cj.error);
    else {
      const cached = new Set((Array.isArray(cj.value?.entries) ? cj.value.entries : []).map((e) => String(e.id)));
      for (const id of sessIds) if (!cached.has(id)) add('info', 'session_not_in_cache', cacheFile, '会话文件未出现在索引缓存', { id });
      for (const id of cached) if (!sessIds.has(id)) add('warn', 'session_cache_missing_file', cacheFile, '索引缓存引用的会话文件不存在', { id });
    }
  }

  /* 5. DSH 映射 */
  const dshFile = path.join(data, 'dsh-sessions.json');
  const dshHome = path.join(data, 'dsh-home', 'sessions');
  if (fs.existsSync(dshFile)) {
    const dj = readJson(dshFile);
    if (!dj.ok) add('warn', 'dsh_map_unreadable', dshFile, dj.error);
    else {
      const dirNames = fs.existsSync(dshHome) ? collectDirNames(dshHome) : new Set();
      for (const [chatKey, v] of Object.entries(dj.value || {})) {
        const sid = String(v?.sessionId || '');
        if (sid && dirNames.size > 0 && ![...dirNames].some((n) => n.includes(sid))) {
          add('warn', 'dsh_session_missing', dshFile, `映射的 DSH 会话目录不存在：${sid.slice(0, 24)}`, { chatKey, sessionId: sid });
        }
        const chatFile = path.join(data, 'messages', `${String(chatKey).replace(/[^a-z0-9_]/gi, '_')}.json`);
        if (!fs.existsSync(chatFile)) add('info', 'dsh_map_without_local_chat', dshFile, 'DSH 映射存在但本地聊天文件不存在', { chatKey });
      }
    }
  }

  /* 6. 备份 */
  const resetRoot = String(process.env.QQ_AGENT_RESET_BACKUP_DIR || `${data}.reset-backups`);
  for (const op of listDirs(resetRoot)) {
    const dir = path.join(resetRoot, op);
    const r = readManifest(dir);
    if (!r.ok) { add('critical', 'reset_backup_manifest_invalid', dir, r.error); continue; }
    if (r.checksumOk === false) add('critical', 'reset_backup_checksum_bad', dir, 'manifest 自校验失败');
    if (deepBackup) {
      for (const scope of ['data', 'diary']) {
        for (const f of r.manifest.files?.[scope] || []) {
          const file = path.join(dir, scope, ...String(f.rel).split('/'));
          let h = '';
          try { h = sha256(file); } catch { add('critical', 'reset_backup_file_missing', file, '备份文件缺失'); continue; }
          if (h !== f.sha256) add('critical', 'reset_backup_file_hash_mismatch', file, '备份文件 hash 不一致');
        }
      }
    }
  }
  for (const sub of ['chats', 'learned']) {
    const dir = path.join(data, 'backups', sub, 'audit.jsonl');
    if (!fs.existsSync(dir)) continue; // 未发生过该类删除属正常
  }
  const sessionBackupDirs = listDirs(path.join(data, 'backups')).filter((n) => n.startsWith('sessions-'));
  for (const n of sessionBackupDirs) {
    const dir = path.join(data, 'backups', n);
    if (listFiles(dir).length === 0) add('warn', 'session_backup_empty', dir, '会话备份目录为空');
  }

  const counts = findings.reduce((acc, f) => { acc[f.level] = (acc[f.level] || 0) + 1; return acc; }, { critical: 0, warn: 0, info: 0 });
  return { schema: 1, generatedAt: new Date(now).toISOString(), dataDir: data, diaryRoot: diary, counts, findings };
}

export function main(argv = process.argv.slice(2)) {
  const args = { json: false, deepBackup: false, dataDir: '', diaryRoot: '', failOn: '', maxPendingHours: 24, maxSessionDays: 30 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') { args.json = true; continue; }
    if (a === '--deep-backup') { args.deepBackup = true; continue; }
    const keys = ['--data-dir', '--diary-root', '--fail-on', '--max-pending-hours', '--max-session-days'];
    if (keys.includes(a)) {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--data-dir') args.dataDir = v;
      if (a === '--diary-root') args.diaryRoot = v;
      if (a === '--fail-on') args.failOn = v;
      if (a === '--max-pending-hours') args.maxPendingHours = Number(v);
      if (a === '--max-session-days') args.maxSessionDays = Number(v);
      i += 1;
      continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  const r = auditConsistency({
    dataDir: args.dataDir || undefined,
    diaryRoot: args.diaryRoot || undefined,
    deepBackup: args.deepBackup,
    maxPendingHours: args.maxPendingHours,
    maxSessionDays: args.maxSessionDays
  });
  if (args.json) {
    console.log(JSON.stringify(r, null, 1));
  } else {
    console.log(`数据一致性审计（只读）  critical=${r.counts.critical} warn=${r.counts.warn} info=${r.counts.info}`);
    console.log(`data=${r.dataDir}\ndiary=${r.diaryRoot}`);
    for (const f of r.findings.slice(0, 200)) console.log(`  [${f.level}] ${f.code} ${f.path} :: ${f.message}`);
    if (r.findings.length > 200) console.log(`  … 其余 ${r.findings.length - 200} 条省略`);
  }
  if (args.failOn === 'critical' && r.counts.critical > 0) return 1;
  if (args.failOn === 'warn' && (r.counts.critical + r.counts.warn) > 0) return 1;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
