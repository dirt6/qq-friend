// D1-5C 专项：Session 清单/归属状态/隔离候选前置条件（只读）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-5C Session 清单');
const { inventorySessions, planSessionQuarantine, quarantineSessionOwned, restoreOwnedQuarantine } = await import('../scripts/session-inventory.mjs');
const DAY = 86400e3;
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'sess-inv-'));
const data = path.join(base, 'data');
const project = `--${path.resolve(data, '..').replace(/[:\\/]+/g, '-')}--`;
const root = path.join(data, 'dsh-home', 'sessions');
const mk = (proj, sid, { ageDays = 0, files = { 'session.v4.jsonl.zstd': 'x' } } = {}) => {
  const dir = path.join(root, proj, sid);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(dir, t, t);
  return dir;
};
try {
  const active = mk(project, 'session-active');
  const idle = mk(project, 'session-idle');
  const old = mk(project, 'session-old', { ageDays: 10 });
  const noBackup = mk(project, 'session-nobackup', { ageDays: 10 });
  const recent = mk(project, 'session-recent', { ageDays: 1 });
  const empty = mk(project, 'session-empty', { files: {} });
  mk('--other-project--', 'session-external', { ageDays: 10 });
  fs.mkdirSync(path.join(data, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(data, 'messages', 'private_1.json'), '{"messages":[]}', 'utf8');
  fs.writeFileSync(path.join(data, 'dsh-sessions.json'), JSON.stringify({
    'private:1': { sessionId: 'session-active', lastUsedAt: new Date().toISOString(), createdAt: new Date().toISOString() },
    'private:2': { sessionId: 'session-idle', lastUsedAt: new Date(Date.now() - 30 * DAY).toISOString(), createdAt: new Date(Date.now() - 60 * DAY).toISOString() }
  }), 'utf8');
  // 仅 session-old 有可恢复备份 + 无引用
  const bdir = path.join(data, 'dsh-home', '.session-backups', 'session-old');
  fs.mkdirSync(bdir, { recursive: true });
  const bfile = path.join(bdir, 'session.v4.jsonl.zstd');
  fs.writeFileSync(bfile, 'backup');
  fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ file: 'session.v4.jsonl.zstd', sha256: sha(bfile) }), 'utf8');
  fs.writeFileSync(path.join(data, 'companion-state.json'), JSON.stringify({ note: 'no refs' }), 'utf8');

  c.section('1. 状态分类');
  const inv = inventorySessions({ dataDir: data, now: Date.now() });
  const by = (sid) => inv.sessions.find((s) => s.sid === sid);
  await c.check('mapped_active / mapped_idle / external / empty=historical_unknown', () => {
    assert.equal(by('session-active').classification, 'mapped_active');
    assert.equal(by('session-idle').classification, 'mapped_idle');
    assert.equal(by('session-external').classification, 'external');
    assert.equal(by('session-empty').classification, 'historical_unknown');
  });
  await c.check('可隔离仅 session-old（项目归属+无映射+超期+有备份）', () => {
    assert.equal(by('session-old').classification, 'quarantine_candidate');
    assert.equal(by('session-old').quarantineEligible, true);
    assert.equal(by('session-nobackup').quarantineEligible, false);
    assert.ok(by('session-nobackup').blockers.includes('no_verified_backup'));
    assert.equal(by('session-recent').quarantineEligible, false);
    assert.ok(by('session-recent').blockers.some((x) => x.startsWith('age<')));
  });
  await c.check('映射中的 Session 永不进入隔离', () => {
    assert.equal(by('session-active').quarantineEligible, false);
    assert.equal(by('session-idle').quarantineEligible, false);
  });

  c.section('2. 计划与只读性');
  const before = JSON.stringify(fs.readdirSync(root).sort());
  const plan = planSessionQuarantine({ inventory: inv });
  await c.check('计划 quarantine=1；manual 含映射/阻塞项；外部项目不在计划', () => {
    assert.equal(plan.counts.quarantine, 1);
    assert.equal(plan.candidates[0].sid, 'session-old');
    assert.ok(plan.manual.some((x) => x.sid === 'session-nobackup'));
    assert.ok(!plan.candidates.some((x) => x.sid === 'session-external'));
  });
  await c.check('只读：不移动/删除目录', () => {
    assert.equal(JSON.stringify(fs.readdirSync(root).sort()), before);
    assert.ok(fs.existsSync(active) && fs.existsSync(old));
  });

  c.section('3. 带 manifest/hash 的隔离与恢复（隔离目录）');
  await c.check('dryRun 不移动；映射中的 Session 拒绝隔离', () => {
    const planQ = quarantineSessionOwned({ sid: 'session-old', dataDir: data, dryRun: true });
    assert.equal(planQ.ok, true);
    assert.ok(fs.existsSync(old));
    const bad = quarantineSessionOwned({ sid: 'session-active', dataDir: data, dryRun: false });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /映射/);
  });
  const q = quarantineSessionOwned({ sid: 'session-old', dataDir: data, dryRun: false, planHash: plan.planHash });
  await c.check('隔离：源消失、目标存在、manifest 记录 from/to/treeHash', () => {
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(q.dest));
    const m = JSON.parse(fs.readFileSync(path.join(q.dest, 'quarantine-manifest.json'), 'utf8'));
    assert.equal(m.sid, 'session-old');
    assert.equal(m.from, old);
    assert.equal(m.to, q.dest);
    assert.equal(m.treeHash, q.manifest.treeHash);
    assert.ok(m.files.length > 0);
  });
  await c.check('恢复：hash 校验通过、回到原路径、删除 manifest', () => {
    const r = restoreOwnedQuarantine({ quarantinedDir: q.dest, dataDir: data, dryRun: false });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(fs.existsSync(old));
    assert.equal(sha(path.join(old, 'session.v4.jsonl.zstd')), q.manifest.files[0].sha256);
    assert.equal(fs.existsSync(path.join(old, 'quarantine-manifest.json')), false);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
