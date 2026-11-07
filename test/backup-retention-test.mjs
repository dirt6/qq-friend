// D1-4 P2 专项：备份巡检 / 保留计划 / 隔离 archive+delete / 恢复锁保护 / 失败保留。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-4 P2 备份保留');
const { inspectBackups, planRetention, applyRetention, defaultPolicy } = await import('../scripts/backup-retention.mjs');
const { resetData } = await import('../src/reset-data.js');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retention-'));
const dataDir = path.join(base, 'data');
const diaryRoot = path.join(base, '日记');
const resetRoot = path.join(base, 'reset-backups');
fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
fs.mkdirSync(path.join(diaryRoot, '.trash'), { recursive: true });
fs.writeFileSync(path.join(diaryRoot, '每日', '2026-11-03.md'), '# x\n', 'utf8');
fs.writeFileSync(path.join(diaryRoot, '.trash', 'old.bak'), 'old', 'utf8');

const writeFile = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
async function makeResetBackup(tag) {
  writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ tag }));
  writeFile(path.join(dataDir, 'learned.json'), `[{"tag":"${tag}"}]`);
  const r = await resetData({ dataDir, diaryRoot, backupRoot: resetRoot });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

try {
  c.section('1. 巡检（只读）');
  const resetOps = [];
  for (let i = 0; i < 4; i += 1) { resetOps.push(await makeResetBackup(`t${i}`)); await sleep(15); }
  // 篡改最早一个 → corrupted
  fs.appendFileSync(path.join(resetOps[0].backupDir, 'data', 'learned.json'), 'tamper');
  // memory：两个已校验备份（同 chat，min=1 → 一个归档候选）
  for (let i = 0; i < 2; i += 1) {
    const dir = path.join(dataDir, 'memory', 'backups', 'private_1', `op${i}`);
    writeFile(path.join(dir, 'p.json'), `{"i":${i}}`);
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
      schema: 1, createdAt: new Date(Date.now() - (i + 1) * 86400e3).toISOString(),
      files: [{ rel: 'p.json', sha256: sha(path.join(dir, 'p.json')), size: fs.statSync(path.join(dir, 'p.json')).size }]
    }));
  }
  // learned：两个
  for (let i = 0; i < 2; i += 1) {
    const dir = path.join(dataDir, 'backups', 'learned', `op${i}`);
    writeFile(path.join(dir, 'l.json'), `{"i":${i}}`);
    writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, createdAt: new Date(Date.now() - (i + 2) * 86400e3).toISOString(), file: { rel: 'l.json', sha256: sha(path.join(dir, 'l.json')), size: fs.statSync(path.join(dir, 'l.json')).size } }));
  }
  // sessions 备份
  writeFile(path.join(dataDir, 'backups', 'sessions-old', 's1.json'), '{"id":"s1"}');
  // 恢复锁
  fs.writeFileSync(path.join(resetRoot, '.restore.lock'), 'x', 'utf8');

  const locked = inspectBackups({ dataDir, diaryRoot, resetRoot });
  await c.check('restore 锁存在时全部保护、计划为空', () => {
    assert.equal(locked.restoreLock, true);
    assert.ok(locked.items.every((it) => it.status === 'restore_in_progress' && it.protected));
    const p = planRetention({ inspection: locked });
    assert.equal(p.candidates.length, 0);
  });
  fs.rmSync(path.join(resetRoot, '.restore.lock'), { force: true });

  const beforeSnapshot = JSON.stringify(fs.readdirSync(resetRoot).sort());
  const insp = inspectBackups({ dataDir, diaryRoot, resetRoot });
  await c.check('来源计数与状态（reset/memory/learned/sessions/diary）', () => {
    assert.deepEqual(insp.counts, { reset: 4, memory: 2, learned: 2, sessions: 1, diary: 1 });
    const st = insp.items.map((x) => `${x.type}:${x.status}`);
    assert.ok(st.includes('reset:corrupted'));
    assert.ok(st.includes('reset:verified'));
    assert.ok(st.includes('diary:unknown'));
    assert.ok(insp.items.filter((x) => x.type === 'memory').every((x) => x.status === 'verified'));
  });
  await c.check('巡检不修改目录', () => {
    assert.equal(JSON.stringify(fs.readdirSync(resetRoot).sort()), beforeSnapshot);
  });

  c.section('2. 保留计划（最低完整/时间/数量/容量；corrupted/unknown 不入选）');
  // 把 maxAgeDays 设为 0，验证“超出最低份数且超过时间上限”的归档候选
  const policy = defaultPolicy();
  for (const t of ['reset', 'memory', 'learned']) policy[t] = { ...policy[t], maxAgeDays: 0 };
  const plan = planRetention({ inspection: insp, policy });
  await c.check('reset 归档 1 个（3 verified，min 2）；memory/learned 各 1 个', () => {
    const byType = (t) => plan.candidates.filter((x) => x.type === t && x.action === 'archive');
    assert.equal(byType('reset').length, 1);
    assert.equal(byType('memory').length, 1);
    assert.equal(byType('learned').length, 1);
    assert.ok(plan.protectedItems.some((x) => x.status === 'corrupted'));
    assert.ok(plan.protectedItems.some((x) => x.status === 'unknown'));
  });
  await c.check('planHash 为 64 位 hex', () => assert.match(plan.planHash, /^[0-9a-f]{64}$/));

  c.section('3. 隔离执行 archive');
  const dry = applyRetention({ plan, inspection: insp, dataDir, dryRun: true });
  await c.check('dryRun 不移动任何目录', () => {
    assert.equal(dry.dryRun, true);
    assert.ok(dry.results.every((r) => r.result === 'planned'));
  });
  const applied = applyRetention({ plan, inspection: insp, dataDir, dryRun: false });
  await c.check('archive 移动成功、源消失、审计写入', () => {
    assert.equal(applied.ok, true);
    const archived = applied.results.filter((r) => r.result === 'archived');
    assert.ok(archived.length >= 3);
    for (const a of archived) {
      assert.equal(fs.existsSync(a.path), false, `源仍在：${a.path}`);
      assert.ok(fs.existsSync(a.dest), `归档不存在：${a.dest}`);
    }
    assert.ok(fs.existsSync(path.join(dataDir, 'backups', 'retention-audit.jsonl')));
  });

  c.section('4. 归档后删除（隔离）+ 失败保留');
  const insp2 = inspectBackups({ dataDir, diaryRoot, resetRoot });
  const plan2 = planRetention({ inspection: insp2, deleteArchivedAfterDays: -1 });
  await c.check('归档项进入 delete 候选', () => assert.ok(plan2.candidates.some((x) => x.action === 'delete')));
  const target = plan2.candidates.find((x) => x.action === 'delete');
  const fail = applyRetention({ plan: { ...plan2, candidates: [target] }, inspection: insp2, dataDir, dryRun: false, hooks: { failId: target.id } });
  await c.check('注入失败 → 源保留、结果 failed、审计记录', () => {
    assert.equal(fail.results[0].result, 'failed');
    assert.ok(fs.existsSync(target.path), '失败时源被删除了');
  });
  const del = applyRetention({ plan: { ...plan2, candidates: [target] }, inspection: insp2, dataDir, dryRun: false });
  await c.check('删除成功 → 归档副本消失、审计存在', () => {
    assert.equal(del.results[0].result, 'deleted');
    assert.equal(fs.existsSync(target.path), false);
    const audit = fs.readFileSync(path.join(dataDir, 'backups', 'retention-audit.jsonl'), 'utf8');
    assert.ok(audit.includes('"action":"delete"'));
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
