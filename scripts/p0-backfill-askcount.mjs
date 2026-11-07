#!/usr/bin/env node
// 给旧的"等回话" pending 补 askCount（4.0 / P0 数据整理）。
//
// 机主 2026-11-03 授权（选 A）。
//
// ── 为什么需要这一步 ────────────────────────────────────────────
//   P0 的代码是 11-03 09:37 才随机器人重启生效的。
//   09:37 之前创建的 pending 没有 askCount 字段，读出来是 0，
//   而 isSilentWaiting 要求 >= 3 —— 于是它们**永远不会静默**，
//   会一直出现在 prompt 里，模型就会一直问。
//
//   这 10 条从 11-01 问到现在（至少 5 天），
//   显然早就超过 ASK_LIMIT=3 了。
//
// ── 只做什么 ────────────────────────────────────────────────────
//   · 补 askCount / lastAskedAt / waitingSince / silent 四个字段
//   · **不删、不结算、不改文本、不改状态**
//
// ── 安全 ────────────────────────────────────────────────────────
//   · 先备份到 data/backups/
//   · 只处理 looksLikeWaitingText() 为 true 的
//   · 已经 >= ASK_LIMIT 的跳过
//   · 输出逐条审计
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data');
const CS = path.join(DATA, 'companion-state.json');

const S = await import('file://' + path.join(ROOT, 'src', 'companion', 'state.js').replace(/\\/g, '/'));

const dryRun = !process.argv.includes('--yes');
const LIMIT = S.ASK_LIMIT;

function main() {
  if (!fs.existsSync(CS)) {
    console.error('找不到 companion-state.json');
    process.exit(1);
  }

  const raw = fs.readFileSync(CS, 'utf8');
  const j = JSON.parse(raw);

  const live = (j.pending || []).filter((p) => p && !['done', 'cancelled', 'expired'].includes(p.status));
  const targets = [];
  const skipped = [];

  for (const p of live) {
    const waitish = S.looksLikeWaitingText(p.text);
    const meta = S.askMetaOf(p);

    if (!waitish) {
      skipped.push({ p, why: '不是等待回复' });
      continue;
    }
    if (meta.askCount >= LIMIT) {
      skipped.push({ p, why: `askCount 已经是 ${meta.askCount}` });
      continue;
    }
    targets.push(p);
  }

  console.log(`ASK_LIMIT = ${LIMIT}`);
  console.log(`活的 pending：${live.length} 条`);
  console.log(`需要补的：${targets.length} 条`);
  console.log(`跳过的：${skipped.length} 条`);
  console.log('');

  if (!targets.length) {
    console.log('没有需要处理的。');
    return;
  }

  console.log('=== 将处理（补 askCount=3 + silent=true）===');
  for (const p of targets) {
    console.log(`  ${p.id}  ${String(p.text).slice(0, 45)}`);
  }

  console.log('');
  console.log('=== 跳过 ===');
  for (const { p, why } of skipped) {
    console.log(`  ${p.id}  ${String(p.text).slice(0, 40)}  ← ${why}`);
  }

  if (dryRun) {
    console.log('');
    console.log('⚠️ 这是演练。要真改请加 --yes');
    return;
  }

  // ── 备份 ──────────────────────────────────────────────────────
  const bakDir = path.join(DATA, 'backups');
  fs.mkdirSync(bakDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = path.join(bakDir, `companion-state-before-p0-askcount-${stamp}.json`);
  fs.writeFileSync(bak, raw, 'utf8');
  console.log('');
  console.log(`✓ 已备份：${path.relative(ROOT, bak)}`);

  // ── 改 ────────────────────────────────────────────────────────
  const now = new Date().toISOString();
  const changed = [];
  for (const p of targets) {
    p.askCount = LIMIT;
    p.lastAskedAt = p.at || now;
    p.waitingSince = p.at || now;
    p.silent = true;
    // 保留原来的 at / text / status / source 不变
    changed.push({ id: p.id, text: p.text, at: p.at, askCount: p.askCount });
  }

  fs.writeFileSync(CS, JSON.stringify(j, null, 1), 'utf8');

  // ── 审计 ──────────────────────────────────────────────────────
  const auditFile = path.join(DATA, 'logs', 'p0-askcount-backfill.jsonl');
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  const line = JSON.stringify({
    at: now,
    action: 'backfill-ask-count',
    limit: LIMIT,
    count: changed.length,
    backup: path.relative(ROOT, bak),
    items: changed
  }) + '\n';
  fs.appendFileSync(auditFile, line, 'utf8');

  console.log(`✓ 已修改 ${changed.length} 条`);
  console.log(`✓ 审计：${path.relative(ROOT, auditFile)}`);
  console.log('');
  console.log('=== 修改后的效果 ===');
  console.log(S.promptSection());
}

main();
