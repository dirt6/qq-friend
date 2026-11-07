// Companion State 迁移脚本（4.0 · 阶段 2.3）。
//
// 用法：
//   node scripts/migrate-companion-state.mjs --dry
//       只读预览。不创建 companion-state.json、不改 autonomous.json、不写备份和标记。
//
//   node scripts/migrate-companion-state.mjs --apply --expect-hash <sha256>
//       正式迁移。先比对源文件哈希（防止 dry 预览之后 autonomous.json 又变了），
//       不一致直接中止；然后备份、原子写、写标记。
//
// ── 映射（机主 2026-11-01 定）──────────────────────────────────────
//   currentGoal      → goal   { text, source:'autonomous', since }
//   pendingNextStep  → pending[0] { id, text, status, source:'autonomous', at, expiresAt }
//   topic            → **保持 null**（不从旧数据推测"当前话题"）
//
//   · 旧字段没有可靠时间戳时用**迁移时间**，并在条目上标 atSource:'migration'
//   · 待办状态不擅自推断成 done —— 无法确认的一律 pending
//   · 无法可靠映射的内容进 skipped，并写明原因
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 测试可以用 QQ_AGENT_DATA_DIR 指到临时目录，避免动生产数据
const DATA = process.env.QQ_AGENT_DATA_DIR
  ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
  : path.join(ROOT, 'data');
const AUTO = path.join(DATA, 'autonomous.json');
const TARGET = path.join(DATA, 'companion-state.json');
const BACKUP_DIR = path.join(DATA, 'backups');
const MARKER = path.join(DATA, 'companion-state-migration.json');

const args = process.argv.slice(2);
const isDry = args.includes('--dry') || !args.includes('--apply');
const hashIdx = args.indexOf('--expect-hash');
const expectHash = hashIdx >= 0 ? String(args[hashIdx + 1] || '') : '';

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function readJsonSafe(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return { ok: true, text, json: JSON.parse(text), hash: sha256(text) };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/** 旧字段 → 标准化文本（返回 {text, how} 或 null）。 */
function normalizeText(v) {
  if (v === undefined) return null;
  if (v === null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? { text: t, how: 'string' } : null;
  }
  if (typeof v === 'object') {
    // pendingNextStep 是对象：{ topic, intent, sourceAction, status, at }
    const cand = [v.topic, v.intent, v.text].find((x) => typeof x === 'string' && x.trim());
    return cand ? { text: String(cand).trim(), how: 'object' } : null;
  }
  return { text: '', how: 'unexpected-type:' + typeof v };
}

function main() {
  console.log('[Companion State Migration] ' + (isDry ? 'DRY RUN' : 'APPLY'));
  console.log('');
  console.log('Source:');
  console.log('  autonomous.json');
  console.log('Target:');
  console.log('  companion-state.json');
  console.log('');

  // ── 读源 ──
  const src = readJsonSafe(AUTO);
  if (!src.ok) {
    console.log('ERROR: 读不了源文件：' + src.error);
    process.exit(2);
  }

  const skipped = [];
  const goalCandidates = [];
  const pendingCandidates = [];

  // ── goal ──
  const rawGoal = src.json?.currentGoal;
  const g = normalizeText(rawGoal);
  if (rawGoal === undefined) skipped.push('currentGoal：字段不存在');
  else if (rawGoal === null || rawGoal === '') skipped.push('currentGoal：空值（' + (rawGoal === null ? 'null' : '空字符串') + '）');
  else if (!g || !g.text) skipped.push('currentGoal：无法解析成文本（类型 ' + typeof rawGoal + '）');
  else if (g.text.length > 200) skipped.push(`currentGoal：太长（${g.text.length} 字），不截断，跳过`);
  else goalCandidates.push({ text: g.text, how: g.how });

  // ── pendingNextStep ──
  const rawPns = src.json?.pendingNextStep;
  if (rawPns === undefined) skipped.push('pendingNextStep：字段不存在');
  else if (rawPns === null || rawPns === '') skipped.push('pendingNextStep：空值');
  else {
    const p = normalizeText(rawPns);
    if (!p || !p.text) skipped.push('pendingNextStep：无法解析成文本（类型 ' + typeof rawPns + '）');
    else if (p.text.length > 200) skipped.push(`pendingNextStep：太长（${p.text.length} 字）`);
    else {
      // 状态：旧数据里的 status 可能是 pending / done 之类。
      // 机主要求「不擅自推断为 done」—— 只有明确写着 done 才认，其余一律 pending。
      let status = 'pending';
      let statusNote = '旧数据没有明确状态 → pending';
      const oldStatus = typeof rawPns === 'object' ? String(rawPns.status || '') : '';
      if (oldStatus === 'done') { status = 'done'; statusNote = '旧数据明确写了 done'; }
      else if (oldStatus === 'waiting') { status = 'waiting'; statusNote = '旧数据写了 waiting'; }

      // 时间：旧数据的 at 可能是数字时间戳 / ISO 字符串 / 没有
      let at = '';
      let atSource = 'migration';
      const rawAt = typeof rawPns === 'object' ? rawPns.at : null;
      if (rawAt !== null && rawAt !== undefined) {
        const t = typeof rawAt === 'number' ? rawAt : Date.parse(String(rawAt));
        if (Number.isFinite(t) && t > 0) { at = new Date(t).toISOString(); atSource = 'legacy'; }
      }
      pendingCandidates.push({ text: p.text, status, statusNote, at, atSource, how: p.how, oldStatus });
    }
  }

  // ── 输出统计 ──
  console.log('Goal:');
  console.log(`  currentGoal found: ${goalCandidates.length}`);
  console.log(`  -> goal: ${goalCandidates.length}`);
  if (goalCandidates.length) console.log(`     「${goalCandidates[0].text}」`);
  console.log('');

  console.log('Pending:');
  console.log(`  pendingNextStep found: ${pendingCandidates.length}`);
  console.log(`  -> pending: ${pendingCandidates.length}`);
  for (const p of pendingCandidates) {
    console.log(`     「${p.text}」 status=${p.status}（${p.statusNote}）`);
    console.log(`       at=${p.at || '(用迁移时间)'} atSource=${p.atSource}`);
  }
  console.log('');

  console.log('Topic:');
  console.log('  -> null（不从旧数据推测当前话题）');
  console.log('');

  console.log('Skipped:');
  console.log(`  ${skipped.length}`);
  for (const s of skipped) console.log('  - ' + s);
  console.log('');

  // ── 冲突检查 ──
  const conflicts = [];
  if (fs.existsSync(TARGET)) {
    const t = readJsonSafe(TARGET);
    if (t.ok && t.json) {
      const hasContent = (t.json.goal && t.json.goal.text)
        || (Array.isArray(t.json.pending) && t.json.pending.length > 0);
      if (hasContent) conflicts.push('目标文件已存在且**有内容** —— 默认拒绝覆盖');
      else conflicts.push('目标文件已存在但为空状态 —— 可以安全写入');
    } else {
      conflicts.push('目标文件存在但无法解析 —— 拒绝覆盖，请先人工处理');
    }
  }
  if (fs.existsSync(MARKER)) {
    try {
      const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
      if (m?.completedAt) conflicts.push(`迁移标记已存在（${m.completedAt}）—— 重复运行会识别并跳过`);
    } catch { /* 坏标记 */ }
  }
  console.log('Conflicts:');
  console.log(`  ${conflicts.length}`);
  for (const c of conflicts) console.log('  - ' + c);
  console.log('');

  // ── 源文件指纹（给 --apply 校验用）──
  console.log('Source fingerprint:');
  console.log('  sha256: ' + src.hash);
  console.log('  （--apply 时传 --expect-hash 比对；不一致说明预览之后源文件变了，应中止）');
  console.log('');

  if (isDry) {
    console.log('Files modified: 0');
    console.log('Migration marker written: no');
    console.log('');
    console.log('DRY RUN COMPLETE — no changes made.');
    return;
  }

  // ══════════ 正式迁移 ══════════
  if (!expectHash) {
    console.log('ERROR: 正式迁移必须带 --expect-hash <sha256>（用 --dry 的输出）。');
    process.exit(2);
  }
  if (expectHash !== src.hash) {
    console.log('ERROR: 源文件哈希与预期不一致 —— 预览之后 autonomous.json 被改过。');
    console.log(`  预期: ${expectHash}`);
    console.log(`  实际: ${src.hash}`);
    console.log('  按机主要求：不一致就中止，重新预览。');
    process.exit(3);
  }

  // 已迁移过 → 幂等退出
  if (fs.existsSync(MARKER)) {
    try {
      const m = JSON.parse(fs.readFileSync(MARKER, 'utf8'));
      if (m?.completedAt) {
        console.log(`已迁移过（${m.completedAt}），本次不做任何事。`);
        console.log('Files modified: 0');
        return;
      }
    } catch { /* 坏标记，继续 */ }
  }

  // 目标已有内容 → 拒绝
  if (fs.existsSync(TARGET)) {
    const t = readJsonSafe(TARGET);
    if (t.ok && t.json && ((t.json.goal && t.json.goal.text) || (t.json.pending || []).length)) {
      console.log('ERROR: companion-state.json 已有内容，拒绝覆盖。');
      console.log('  按机主要求：已有状态默认拒绝覆盖，不能直接合并或清空。');
      process.exit(4);
    }
  }

  // 备份
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bakAuto = path.join(BACKUP_DIR, `autonomous-before-companion-${stamp}.json`);
  fs.copyFileSync(AUTO, bakAuto);
  console.log('Backup:');
  console.log('  ' + path.relative(ROOT, bakAuto));

  // 构造新状态
  const now = new Date().toISOString();
  const state = { version: 1, goal: null, topic: null, pending: [], updatedAt: now };

  if (goalCandidates.length) {
    state.goal = { text: goalCandidates[0].text, source: 'autonomous', since: now, atSource: 'migration' };
  }
  for (const p of pendingCandidates) {
    state.pending.push({
      id: `p-${crypto.randomBytes(3).toString('hex')}`,
      text: p.text,
      status: p.status,
      source: 'autonomous',
      at: p.at || now,
      atSource: p.atSource,
      expiresAt: new Date(Date.now() + 30 * 86400e3).toISOString()
    });
  }
  state.migratedFrom = { file: 'autonomous.json', at: now, sourceHash: src.hash };

  // 原子写：tmp + 校验 + rename
  const json = JSON.stringify(state, null, 1);
  JSON.parse(json);   // 序列化结果自校验
  const tmp = `${TARGET}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  const back = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  if (JSON.stringify(back.goal) !== JSON.stringify(state.goal)) {
    fs.unlinkSync(tmp);
    console.log('ERROR: 临时文件校验失败，已中止，原文件未动。');
    process.exit(5);
  }
  fs.renameSync(tmp, TARGET);

  // 迁移标记（成功后才写）
  const marker = {
    version: 1,
    completedAt: now,
    sourceFile: 'autonomous.json',
    sourceHash: src.hash,
    goalMigrated: Boolean(state.goal),
    pendingMigrated: state.pending.length,
    skipped
  };
  fs.writeFileSync(MARKER, JSON.stringify(marker, null, 1), 'utf8');

  console.log('');
  console.log('APPLIED:');
  console.log(`  goal: ${state.goal ? '1' : '0'}`);
  console.log(`  pending: ${state.pending.length}`);
  console.log(`  marker: ${path.relative(ROOT, MARKER)}`);
  console.log('');
  console.log('旧字段仍保留在 autonomous.json 里（只读兼容，未删除）。');
  console.log('读点还没改 —— 下一步 2.4 才切换。');
}

main();
