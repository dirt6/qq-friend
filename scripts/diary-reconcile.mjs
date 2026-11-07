// 日记正文 / meta / pending 对账 CLI（D1-2c-2f）。
//
// 用法：
//   node scripts/diary-reconcile.mjs [--date YYYY-MM-DD] [--json] [--diary-root <dir>]
//   node scripts/diary-reconcile.mjs ... --confirm <planHash>
//
// 原则：默认只读 dry-run；--confirm 只执行计划中列出、且输入未变化的确定性修复。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { splitParagraphs, readDiaryMeta, writeDiaryMeta } from '../src/diary/meta.js';
import { listUnfinishedDiaryOps, listDiaryOps, completeDiaryOp, outboxFile } from '../src/diary/outbox.js';
import { recoverDiaryOps } from '../src/diary/op.js';
import { dayFileOf } from '../src/diary/paths.js';
import { diaryRoot as defaultDiaryRoot } from '../src/diary/writer.js';

export const SCHEMA = 1;

/** 解析参数（独立可测）。错误统一返回 { error }。 */
export function parseReconcileArgs(argv) {
  const out = { date: '', json: false, confirm: '', diaryRoot: '' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      if (seen.has('json')) return { error: '参数重复：--json' };
      seen.add('json'); out.json = true; continue;
    }
    if (a === '--date' || a === '--confirm' || a === '--diary-root') {
      const key = a.slice(2);
      if (seen.has(key)) return { error: `参数重复：${a}` };
      const v = argv[i + 1];
      if (!v || String(v).startsWith('--')) return { error: `缺少参数值：${a}` };
      seen.add(key);
      if (key === 'date') out.date = v;
      if (key === 'confirm') out.confirm = v;
      if (key === 'diary-root') out.diaryRoot = v;
      i += 1;
      continue;
    }
    if (a.startsWith('--')) return { error: `未知参数：${a}` };
    return { error: `未知位置参数：${a}` };
  }
  if (out.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.date)) return { error: `日期格式不合法：${out.date}` };
    const d = new Date(`${out.date}T00:00:00`);
    if (Number.isNaN(d.getTime())) return { error: `日期不存在：${out.date}` };
  }
  if (out.confirm && !/^[0-9a-f]{64}$/.test(out.confirm)) return { error: 'planHash 格式不合法' };
  return out;
}

function sha256File(file) {
  try { return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return 'missing'; }
}
const sha256 = (text) => 'sha256:' + crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
const dateFromName = (n) => (/^\d{4}-\d{2}-\d{2}/.test(n) ? n.slice(0, 10) : '');

/** 待扫描日期：正文、meta、pending 三方的并集。 */
export function listDates(diaryRoot, dataDir, filter = '') {
  const set = new Set();
  try {
    for (const f of fs.readdirSync(path.join(diaryRoot, '每日'))) {
      if (/^\d{4}-\d{2}-\d{2}\.md$/.test(f)) set.add(f.slice(0, 10));
    }
  } catch { /* 没有日记目录 */ }
  try {
    for (const f of fs.readdirSync(path.join(dataDir, 'diary-meta'))) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) set.add(f.slice(0, 10));
    }
  } catch { /* 没有 meta 目录 */ }
  for (const it of listDiaryOps()) {
    const d = dateFromName(String(it.dateKey || ''));
    if (d) set.add(d);
  }
  let dates = [...set].sort();
  if (filter) dates = dates.filter((d) => d === filter);
  return dates;
}

/** 对单日分析，产出问题与可执行动作。 */
function analyzeDate(dateKey, diaryRoot) {
  const issues = [];
  const actions = [];
  const file = dayFileOf(diaryRoot, dateKey);
  let body = '';
  try { body = fs.readFileSync(file, 'utf8'); } catch { body = ''; }
  const bodyExists = body !== '';
  const paras = splitParagraphs(body);
  const m = readDiaryMeta(dateKey, diaryRoot);
  const entries = m.ok && m.meta && Array.isArray(m.meta.entries) ? m.meta.entries : [];

  if (!m.ok) {
    issues.push({ category: 'meta_unreadable', manual: true, reason: m.error, dateKey });
  } else if (m.meta && !Array.isArray(m.meta.entries)) {
    issues.push({ category: 'legacy_format', manual: true, reason: '旧格式 meta（无 entries）', dateKey });
  } else if (m.meta && m.meta.sourceHash && m.sourceHash && m.meta.sourceHash !== m.sourceHash) {
    issues.push({ category: 'source_hash_mismatch', manual: true, dateKey, reason: 'meta.sourceHash 与当前正文不一致' });
  }

  const seenKeys = new Set();
  for (const e of entries) {
    const idx = Number(e.paragraphIndex);
    const idxOk = Number.isInteger(idx) && idx >= 0 && idx < paras.length;
    if (!idxOk) {
      issues.push({ category: 'orphan_meta', manual: true, dateKey, paragraphIndex: e.paragraphIndex, quoteHash: e.quoteHash, summary: String(e.quote || '').slice(0, 50) });
      continue;
    }
    const p = paras[idx];
    if (p.hash !== e.quoteHash) {
      if (e.stale) {
        issues.push({ category: 'meta_stale_index_shift', manual: true, dateKey, paragraphIndex: idx, quoteHash: e.quoteHash, summary: String(e.quote || '').slice(0, 50) });
      } else {
        issues.push({ category: 'meta_mismatch', manual: true, dateKey, paragraphIndex: idx, quoteHash: e.quoteHash, summary: String(e.quote || '').slice(0, 50) });
      }
      continue;
    }
    if (e.stale) {
      issues.push({ category: 'stale_but_hash_match', manual: false, dateKey, paragraphIndex: idx, quoteHash: e.quoteHash, summary: String(p.text).slice(0, 50) });
      actions.push({ kind: 'clear_stale', dateKey, paragraphIndex: idx, quoteHash: e.quoteHash });
    }
    const key = `${idx}|${e.quoteHash}`;
    if (seenKeys.has(key)) {
      issues.push({ category: 'duplicate_meta', manual: true, dateKey, paragraphIndex: idx, quoteHash: e.quoteHash });
    }
    seenKeys.add(key);
  }

  if (bodyExists && paras.length && !entries.length && !(m.ok && m.meta)) {
    issues.push({ category: 'meta_missing', manual: true, dateKey, reason: '正文存在但无 meta' });
  }

  // pending：目标态判定复用 recover（只读），already_* 才可完成
  let recover = null;
  try { recover = recoverDiaryOps({ dryRun: true, root: diaryRoot }); } catch { recover = null; }
  const recById = new Map((recover?.report || []).map((r) => [r.id, r]));
  for (const it of listUnfinishedDiaryOps().filter((x) => x.dateKey === dateKey)) {
    const rec = recById.get(it.id);
    const action = rec?.action || 'unknown';
    if (action.startsWith('already_')) {
      issues.push({ category: 'pending_target_achieved', manual: false, dateKey, operationId: it.id, stage: it.stage, action, summary: String(it.match || '').slice(0, 50) });
      actions.push({ kind: 'complete_pending', dateKey, id: it.id });
    } else if (action === 'not_executed') {
      issues.push({ category: 'pending_not_executed', manual: true, dateKey, operationId: it.id, stage: it.stage, summary: String(it.match || '').slice(0, 50) });
    } else {
      issues.push({ category: 'pending_manual', manual: true, dateKey, operationId: it.id, stage: it.stage, action, summary: String(it.match || '').slice(0, 50) });
    }
  }

  return { dateKey, issues, actions, bodyExists, paras, entries };
}

/** 收集 planHash 绑定的输入文件 hash。 */
function collectInputs(dates, diaryRoot, dataDir) {
  const inputs = [];
  for (const d of dates) inputs.push({ path: dayFileOf(diaryRoot, d), hash: sha256File(dayFileOf(diaryRoot, d)) });
  for (const d of dates) {
    const f = path.join(dataDir, 'diary-meta', `${d}.json`);
    if (fs.existsSync(f)) inputs.push({ path: f, hash: sha256File(f) });
  }
  const ob = outboxFile();
  if (fs.existsSync(ob)) inputs.push({ path: ob, hash: sha256File(ob) });
  return inputs.sort((a, b) => a.path.localeCompare(b.path));
}

/** 扫描并生成计划（只读）。 */
export function buildPlan({ date = '', diaryRoot = '', dataDir }) {
  const root = diaryRoot || defaultDiaryRoot();
  const dates = listDates(root, dataDir, date);
  const analyses = dates.map((d) => analyzeDate(d, root));
  const issues = analyses.flatMap((a) => a.issues);
  const actions = analyses.flatMap((a) => a.actions);
  const inputs = collectInputs(dates, root, dataDir);
  const plan = {
    schema: SCHEMA,
    dateFilter: date,
    diaryRoot: root,
    dates,
    inputs,
    actions,
    issues
  };
  plan.planHash = sha256(JSON.stringify({ schema: plan.schema, dateFilter: plan.dateFilter, inputs: plan.inputs, actions: plan.actions }));
  return plan;
}

/** 计划统计。 */
export function planStats(plan) {
  const counts = {};
  for (const i of plan.issues) counts[i.category] = (counts[i.category] || 0) + 1;
  return {
    dates: plan.dates.length,
    bodyFiles: plan.inputs.filter((x) => x.path.endsWith('.md')).length,
    metaEntries: plan.issues.length && plan.issues.some((i) => i.category === 'meta_unreadable') ? -1 : undefined,
    pendingTotal: listUnfinishedDiaryOps().length,
    issues: plan.issues.length,
    autoFixable: plan.actions.length,
    manual: plan.issues.filter((i) => i.manual).length,
    counts
  };
}

/** 执行计划（--confirm）。输入 hash 必须与计划一致。 */
export function executePlan({ plan, dataDir }) {
  const root = plan.diaryRoot || defaultDiaryRoot();
  const fresh = buildPlan({ date: plan.dateFilter, diaryRoot: root, dataDir });
  if (fresh.planHash !== plan.planHash) {
    return { ok: false, code: 'PLAN_STALE', error: '输入已变化（正文/meta/pending），请重新 dry-run' };
  }
  // 计划动作以当前扫描为准（同一 hash 下应与 plan.actions 相同）
  const executed = [];
  const skipped = [];
  for (const act of fresh.actions) {
    try {
      if (act.kind === 'clear_stale') {
        const file = dayFileOf(root, act.dateKey);
        const body = fs.readFileSync(file, 'utf8');
        const paras = splitParagraphs(body);
        const p = paras[act.paragraphIndex];
        const m = readDiaryMeta(act.dateKey, root);
        if (!m.ok || !m.meta || !Array.isArray(m.meta.entries)) { skipped.push({ ...act, reason: 'meta 不可读' }); continue; }
        const entry = m.meta.entries.find((e) => Number(e.paragraphIndex) === act.paragraphIndex && e.quoteHash === act.quoteHash);
        if (!entry || !p || p.hash !== act.quoteHash) { skipped.push({ ...act, reason: '目标身份已变化' }); continue; }
        if (!entry.stale) { skipped.push({ ...act, reason: '已不是 stale' }); continue; }
        entry.stale = false;
        entry.staleReason = '';
        const w = writeDiaryMeta(act.dateKey, m.meta, root);
        if (!w.ok) { skipped.push({ ...act, reason: w.error }); continue; }
        executed.push(act);
      } else if (act.kind === 'complete_pending') {
        const still = listUnfinishedDiaryOps().some((x) => x.id === act.id);
        if (!still) { skipped.push({ ...act, reason: '操作已完成' }); continue; }
        const w = completeDiaryOp(act.id, { metaState: 'reconciled' });
        if (!w.ok) { skipped.push({ ...act, reason: w.error }); continue; }
        executed.push(act);
      }
    } catch (e) {
      skipped.push({ ...act, reason: String(e?.message ?? e) });
    }
  }
  return { ok: true, executed, skipped };
}

function printHuman(plan, stats) {
  const lines = [];
  lines.push(`日记对账（dry-run）  日期数=${stats.dates}  正文=${stats.bodyFiles}  问题=${stats.issues}  可修复=${stats.autoFixable}  人工=${stats.manual}`);
  lines.push(`pending 未完成=${stats.pendingTotal}`);
  for (const [k, v] of Object.entries(stats.counts).sort()) lines.push(`  ${k}: ${v}`);
  for (const i of plan.issues) {
    const id = i.operationId ? ` op=${i.operationId}` : '';
    const idx = i.paragraphIndex !== undefined ? ` idx=${i.paragraphIndex}` : '';
    const q = i.quoteHash ? ` hash=${String(i.quoteHash).slice(0, 16)}` : '';
    lines.push(`  [${i.manual ? '人工' : '可修复'}] ${i.dateKey} ${i.category}${id}${idx}${q} ${i.summary || ''}`);
  }
  lines.push(`planHash=${plan.planHash}`);
  return lines.join('\n');
}

export function main(argv) {
  const args = parseReconcileArgs(argv);
  if (args.error) { console.error(args.error); return 2; }
  const dataDir = process.env.QQ_AGENT_DATA_DIR || path.resolve(process.cwd(), 'data');
  const root = args.diaryRoot || defaultDiaryRoot();
  const plan = buildPlan({ date: args.date, diaryRoot: root, dataDir });
  plan.diaryRoot = root;
  const stats = planStats(plan);
  if (args.confirm) {
    if (args.date === '' && plan.dateFilter === '') {
      // 允许全量，但 hash 校验仍绑定所有输入
    }
    const r = executePlan({ plan, dataDir });
    if (!r.ok) { console.error(r.error); return 3; }
    if (args.json) {
      console.log(JSON.stringify({ ok: true, executed: r.executed, skipped: r.skipped, planHash: plan.planHash }, null, 2));
    } else {
      console.log(`执行完成：修复 ${r.executed.length} 项，跳过 ${r.skipped.length} 项`);
      for (const s of r.skipped) console.log(`  跳过 ${s.kind} ${s.dateKey} ${s.reason}`);
    }
    return 0;
  }
  if (args.json) {
    console.log(JSON.stringify({ schema: SCHEMA, planHash: plan.planHash, dateFilter: plan.dateFilter, stats, issues: plan.issues, actions: plan.actions }, null, 2));
  } else {
    console.log(printHuman(plan, stats));
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main(process.argv.slice(2)));
}
