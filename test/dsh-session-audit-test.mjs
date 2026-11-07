// D1-4 P3 专项：DSH Session 只读审计 + 隔离 quarantine/restore（不删除、不 kill）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-4 P3 DSH Session');
const { inspectDshSessions, planSessionActions, quarantineSession, restoreQuarantined } = await import('../scripts/dsh-session-audit.mjs');
const DAY = 86400e3;
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const treeHash = (root) => {
  const lines = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, r); else lines.push(`${r}|${sha(p)}|${fs.statSync(p).size}`);
    }
  };
  walk(root, '');
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex');
};

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-audit-'));
const data = path.join(base, 'data');
const sessRoot = path.join(data, 'dsh-home', 'sessions', '--proj--');
const mkSession = (name, { ageDays = 0, files = { 'session.v4.jsonl.zstd': 'x' } } = {}) => {
  const dir = path.join(sessRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  const t = new Date(Date.now() - ageDays * DAY);
  fs.utimesSync(dir, t, t);
  return dir;
};

try {
  const ok = mkSession('session-ok');
  const dup = mkSession('session-dup');
  const z = mkSession('session-z');
  const old = mkSession('session-orphan-old', { ageDays: 10 });
  const recent = mkSession('session-orphan-new', { ageDays: 1 });
  fs.mkdirSync(path.join(data, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(data, 'messages', 'private_1.json'), '{"messages":[]}', 'utf8');
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'sessions', 'zombie.json'), JSON.stringify({ id: 'zombie', status: 'running', startedAt: Date.now() - 40 * DAY }), 'utf8');
  fs.writeFileSync(path.join(data, 'dsh-sessions.json'), JSON.stringify({
    'private:1': { sessionId: 'session-ok', createdAt: new Date(Date.now() - 60 * DAY).toISOString(), lastUsedAt: new Date(Date.now() - 40 * DAY).toISOString(), turns: 3 },
    'private:2': { sessionId: 'session-missing', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), turns: 1 },
    'private:3': { sessionId: 'session-dup', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), turns: 1 },
    'private:4': { sessionId: 'session-dup', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), turns: 1 },
    'private:5': { sessionId: 'session-z', createdAt: new Date().toISOString(), lastUsedAt: new Date().toISOString(), turns: 1 }
  }, null, 1), 'utf8');

  c.section('1. 只读审计');
  const insp = inspectDshSessions({ dataDir: data, now: Date.now() });
  const codes = new Set(insp.findings.map((f) => f.code));
  await c.check('映射缺失 / 孤儿 / 重复映射 / 无本地聊天 / 闲置 / 本地僵尸', () => {
    for (const code of ['dsh_map_missing_dir', 'dsh_orphan_session', 'dsh_duplicate_mapping', 'dsh_map_without_local_chat', 'dsh_map_idle', 'local_session_zombie']) {
      assert.ok(codes.has(code), `缺少 ${code}；实际 ${[...codes].join(',')}`);
    }
    assert.equal(insp.processOwnership, 'unknown');
  });
  await c.check('只读：审计前后目录树 hash 不变', () => {
    const before = treeHash(path.join(data, 'dsh-home'));
    inspectDshSessions({ dataDir: data, now: Date.now() });
    assert.equal(treeHash(path.join(data, 'dsh-home')), before);
  });

  c.section('2. 计划：只隔离“未映射且超期”的目录，映射/人工项不动');
  const plan = planSessionActions({ inspection: insp, quarantineAfterDays: 7, now: Date.now(), projectFilter: '--proj--' });
  await c.check('仅 session-orphan-old 进入 quarantine 候选', () => {
    assert.equal(plan.candidates.length, 1, JSON.stringify(plan.candidates));
    assert.equal(plan.candidates[0].sessionId, 'session-orphan-old');
    assert.ok(!plan.candidates.some((x) => ['session-ok', 'session-dup', 'session-z', 'session-orphan-new'].includes(x.sessionId)));
    assert.ok(plan.manual.some((x) => x.action === 'manual_rebuild_mapping'));
    assert.ok(plan.manual.some((x) => x.action === 'manual_review_mapping'));
    assert.ok(plan.manual.some((x) => x.action === 'manual_review_local_session'));
  });

  c.section('3. 隔离 quarantine / restore（同卷移动，不删除）');
  const okHash = treeHash(ok);
  await c.check('dryRun 不移动', () => {
    const r = quarantineSession({ dir: old, dataDir: data, dryRun: true });
    assert.equal(r.ok, true);
    assert.ok(fs.existsSync(old));
  });
  await c.check('映射中的目录拒绝隔离', () => {
    const r = quarantineSession({ dir: ok, dataDir: data, dryRun: false });
    assert.equal(r.ok, false);
    assert.ok(fs.existsSync(ok));
  });
  const q = quarantineSession({ dir: old, dataDir: data, dryRun: false });
  await c.check('orphan 移动成功、源消失、quarantine 审计写入', () => {
    assert.equal(q.ok, true, JSON.stringify(q));
    assert.equal(fs.existsSync(old), false);
    assert.ok(fs.existsSync(q.dest));
    assert.ok(fs.existsSync(path.join(data, 'dsh-home', '.quarantine', 'audit.jsonl')));
  });
  const back = restoreQuarantined({ quarantinedDir: q.dest, dataDir: data, dryRun: false });
  await c.check('恢复回原路径、内容 hash 不变', () => {
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.ok(fs.existsSync(old));
    assert.equal(treeHash(ok), okHash);
    assert.ok(fs.existsSync(path.join(old, 'session.v4.jsonl.zstd')));
  });
  await c.check('目标已存在时恢复拒绝覆盖', () => {
    const q2 = quarantineSession({ dir: recent, dataDir: data, dryRun: false });
    assert.equal(q2.ok, true);
    fs.mkdirSync(recent, { recursive: true });
    const bad = restoreQuarantined({ quarantinedDir: q2.dest, dataDir: data, dryRun: false });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /已存在/);
    fs.rmdirSync(recent);
    const good = restoreQuarantined({ quarantinedDir: q2.dest, dataDir: data, dryRun: false });
    assert.equal(good.ok, true);
  });
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
