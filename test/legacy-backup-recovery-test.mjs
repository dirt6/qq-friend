// D1-5B 专项：Diary .trash 清单 + 旧备份隔离恢复（不接触生产）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-5B Diary trash');
const { inspectTrash, buildLegacyManifest, restoreLegacyBackup } = await import('../scripts/legacy-backup-recovery.mjs');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-b-'));
const diary = path.join(base, '日记');
const trash = path.join(diary, '.trash');
const dayDir = path.join(diary, '每日');
fs.mkdirSync(trash, { recursive: true });
fs.mkdirSync(dayDir, { recursive: true });
const body = '# 2026-11-01\n\n## 记录\n- 心情：平静｜保留行\n';
fs.writeFileSync(path.join(dayDir, '2026-11-01.md'), body, 'utf8');
const backupText = '# 2026-11-01\n\n## 记录\n- 心情：平静｜保留行\n- 心情：记住了｜被删掉的旧行\n';
fs.writeFileSync(path.join(trash, '2026-11-01.md.1793505408016.bak'), backupText, 'utf8');
fs.writeFileSync(path.join(trash, '2026-11-01.md.1793505408017.bak'), body, 'utf8');
fs.writeFileSync(path.join(trash, 'promises.md.migrated-1792598710107.bak'), '# 约定\n- [x] 旧\n', 'utf8');

try {
  c.section('1. 只读清单与分类');
  const inv = inspectTrash({ diaryRoot: diary });
  await c.check('13 类字段/分类：recoverable / superseded / historical_unknown', () => {
    assert.equal(inv.files.length, 3);
    const rec = inv.files.find((x) => x.file.includes('1793505408016'));
    const sup = inv.files.find((x) => x.file.includes('1793505408017'));
    const prom = inv.files.find((x) => x.file.startsWith('promises'));
    assert.equal(rec.classification, 'verified_recoverable');
    assert.equal(rec.uniqueLines, 1);
    assert.equal(sup.classification, 'verified_superseded');
    assert.equal(prom.classification, 'historical_unknown');
    assert.match(rec.sha256, /^[0-9a-f]{64}$/);
    assert.equal(rec.manifestStatus, 'none');
  });
  await c.check('补录 manifest：historical=true、时间来源标注、不改备份', () => {
    const f = path.join(trash, '2026-11-01.md.1793505408016.bak');
    const h = fs.readFileSync(f, 'utf8');
    const m = buildLegacyManifest({ backupFile: f, now: 1893456000000 });
    assert.equal(m.historical, true);
    assert.equal(m.sourceUncertain, true);
    assert.equal(m.sha256, sha(f));
    assert.equal(m.backupCreatedAtSource, 'filename-timestamp');
    assert.match(m.backupCreatedAt, /^2026-/);
    assert.equal(m.recordedAt, new Date(1893456000000).toISOString());
    assert.equal(fs.readFileSync(f, 'utf8'), h, 'manifest 不得改备份');
  });

  c.section('2. 隔离恢复：单备份/冲突/损坏/重复/中断/hash');
  const target = path.join(base, 'target');
  const src = path.join(trash, '2026-11-01.md.1793505408016.bak');
  await c.check('dryRun 不写目标', () => {
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: target, dryRun: true });
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(target, '每日', '2026-11-01.md')), false);
  });
  await c.check('单备份恢复 + 恢复后 hash 一致', () => {
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: target, expectedSha256: sha(src), dryRun: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(sha(r.target), sha(src));
    assert.equal(fs.readFileSync(r.target, 'utf8'), backupText);
  });
  await c.check('重复恢复/目标冲突 → 拒绝覆盖', () => {
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: target, dryRun: false });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /已存在/);
  });
  await c.check('备份损坏（expected hash 不符）→ 拒绝', () => {
    const target2 = path.join(base, 'target2');
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: target2, expectedSha256: '0'.repeat(64) });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /hash/);
  });
  await c.check('恢复中断 → 目标不存在、临时文件清理、审计 failed', () => {
    const target3 = path.join(base, 'target3');
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: target3, hooks: { interruptAfterTemp: true }, dryRun: false });
    assert.equal(r.ok, false);
    assert.equal(fs.existsSync(path.join(target3, '每日', '2026-11-01.md')), false);
    const leftovers = fs.existsSync(path.join(target3, '每日')) ? fs.readdirSync(path.join(target3, '每日')).filter((n) => n.includes('.tmp-')) : [];
    assert.equal(leftovers.length, 0, JSON.stringify(leftovers));
    assert.ok(fs.readFileSync(path.join(target3, '.legacy-restore-audit.jsonl'), 'utf8').includes('failed'));
  });
  await c.check('非法 dateKey 拒绝', () => {
    const r = restoreLegacyBackup({ backupFile: src, targetDiaryRoot: path.join(base, 't4'), dateKey: '../escape' });
    assert.equal(r.ok, false);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
