// D1-3d 专项：reset 安全隔离演练（真实文件、真实删除/恢复、逐文件 hash）。
// 全部在临时目录；测试钩子仅在 DIARY_TEST_GUARD=1 下可用；不触碰生产 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-3d reset 安全演练');
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-drill-'));
process.env.DIARY_TEST_GUARD = '1';
process.env.DIARY_TEST_TMP = BASE;
process.env.QQ_AGENT_RESET_BACKUP_DIR = path.join(BASE, 'unused-default');
const MOD_URL = pathToFileURL(path.join(path.resolve(import.meta.dirname, '..'), 'src', 'reset-data.js')).href;
const D = await import('../src/reset-data.js');
const barrier = await import('../src/reset-barrier.js');
const stateStore = await import('../src/state-store.js');

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildScene(name) {
  const base = path.join(BASE, name);
  fs.rmSync(base, { recursive: true, force: true });
  const dataDir = path.join(base, 'data');
  const diaryRoot = path.join(base, 'diary');
  const backupRoot = path.join(base, 'backups');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-must-survive', 'utf8');
  const files = {
    'config.json': '{"api":{"model":"x"}}',
    'learned.json': '[{"id":"l1"}]',
    'sessions/a.json': '{"id":"a"}',
    'sessions/b.json': '{"id":"b"}',
    'memory/c1/1.json': '{"userId":"1"}',
    'logs/app.log': 'log line\n',
    'nested/deep/x.txt': 'deep-content',
    'large.bin': crypto.randomBytes(1024 * 256)
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dataDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  fs.mkdirSync(path.join(dataDir, 'empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'qq-agent.lock'), '25300', 'utf8');
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.mkdirSync(path.join(diaryRoot, '.trash'), { recursive: true });
  fs.writeFileSync(path.join(diaryRoot, '每日', '2026-11-03.md'), '# 2026-11-03\n\n- 心情：平静｜演练\n', 'utf8');
  fs.writeFileSync(path.join(diaryRoot, '.trash', 'old.bak'), 'old', 'utf8');
  // junction：data 内指向外部目录
  fs.symlinkSync(outside, path.join(dataDir, 'linked-out'), 'junction');
  // 文件 symlink：Windows 可能需要权限；失败则标 INCONCLUSIVE
  let symlinkOk = false;
  try {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dataDir, 'outside-link.txt'), 'file');
    symlinkOk = true;
  } catch { /* INCONCLUSIVE */ }
  const original = {};
  const originalSize = {};
  for (const rel of Object.keys(files)) {
    const p = path.join(dataDir, ...rel.split('/'));
    original[rel] = sha(p);
    originalSize[rel] = fs.statSync(p).size;
  }
  return {
    base, dataDir, diaryRoot, backupRoot, outside, original, originalSize, symlinkOk,
    args: { dataDir, diaryRoot, backupRoot },
    diaryHash: sha(path.join(diaryRoot, '每日', '2026-11-03.md')),
    outsideHash: sha(path.join(outside, 'secret.txt'))
  };
}

try {
  c.section('1. preflight 拒绝条件（隔离）');
  {
    const s = buildScene('s-refuse');
    const pendingFile = path.join(s.dataDir, 'diary-meta', 'pending.json');
    fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
    fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, items: { p1: { id: 'p1', op: 'append', dateKey: '2026-11-03', stage: 'prepared' } } }), 'utf8');
    let pre = await D.preflightReset(s.args);
    await c.check('未完成 pending → 拒绝', () => {
      assert.equal(pre.canReset, false);
      assert.ok(pre.refusals.join('；').includes('未完成日记操作'));
    });
    fs.writeFileSync(pendingFile, '{ bad json', 'utf8');
    pre = await D.preflightReset(s.args);
    await c.check('pending 损坏 → 拒绝', () => {
      assert.equal(pre.canReset, false);
      assert.ok(pre.refusals.join('；').includes('损坏'));
    });
    fs.writeFileSync(pendingFile, JSON.stringify({ version: 1, items: {} }), 'utf8');
    fs.writeFileSync(path.join(s.dataDir, 'diary-idempotency.json'), JSON.stringify({ keys: { 'auto:2026-11-03:abc': { state: 'pending', day: '2026-11-03' } } }), 'utf8');
    pre = await D.preflightReset(s.args);
    await c.check('幂等键 pending → 拒绝', () => {
      assert.equal(pre.canReset, false);
      assert.ok(pre.refusals.join('；').includes('幂等键'));
    });
    fs.rmSync(path.join(s.dataDir, 'diary-idempotency.json'), { force: true });
    pre = await D.preflightReset({ dataDir: s.dataDir, diaryRoot: path.join(s.dataDir, 'inside-diary'), backupRoot: s.backupRoot });
    await c.check('日记根在 data 内 → 拒绝', () => {
      assert.equal(pre.canReset, false);
      assert.ok(pre.refusals.join('；').includes('日记根位于数据目录内'));
    });
    pre = await D.preflightReset({ dataDir: s.dataDir, diaryRoot: s.diaryRoot, backupRoot: path.join(s.dataDir, 'inside-backup') });
    await c.check('备份根在 data 内 → 拒绝', () => {
      assert.equal(pre.canReset, false);
      assert.ok(pre.refusals.join('；').includes('备份目录位于数据目录内'));
    });
  }

  c.section('2. 正常 reset：manifest/hash/junction/symlink');
  let scene2 = null;
  let reset2 = null;
  {
    scene2 = buildScene('s-normal');
    reset2 = await D.resetData(scene2.args);
    await c.check('reset 成功；manifest 自校验/总计一致', () => {
      assert.equal(reset2.ok, true, JSON.stringify(reset2));
      const m = JSON.parse(fs.readFileSync(reset2.manifestPath, 'utf8'));
      assert.equal(m.schemaVersion, 2);
      assert.equal(m.status, 'completed');
      assert.ok(/^[0-9a-f]{64}$/.test(m.manifestChecksum));
      const checked = D.readManifest(reset2.backupDir);
      assert.equal(checked.ok, true);
      assert.equal(checked.checksumOk, true);
      assert.equal(m.files.data.length, Object.keys(scene2.original).length);
      assert.equal(m.totals.files, m.files.data.length + m.files.diary.length);
    });
    await c.check('备份逐文件 hash/大小与源一致', () => {
      for (const [rel, h] of Object.entries(scene2.original)) {
        const b = path.join(reset2.backupDir, 'data', ...rel.split('/'));
        assert.equal(sha(b), h, rel);
        assert.equal(fs.statSync(b).size, scene2.originalSize[rel], rel);
      }
    });
    await c.check('junction 只记录不跟随；删除后目标文件仍在', () => {
      const m = JSON.parse(fs.readFileSync(reset2.manifestPath, 'utf8'));
      assert.ok(m.links.some((l) => l.scope === 'data' && l.rel === 'linked-out'));
      assert.equal(sha(path.join(scene2.outside, 'secret.txt')), scene2.outsideHash);
      assert.ok(!fs.existsSync(path.join(reset2.backupDir, 'data', 'linked-out')));
    });
    await c.check('symlink 目标未被删除（无法创建则 INCONCLUSIVE）', () => {
      if (!scene2.symlinkOk) { console.log('  INCONCLUSIVE symlink 创建失败（权限不足）'); return; }
      assert.equal(sha(path.join(scene2.outside, 'secret.txt')), scene2.outsideHash);
      assert.equal(fs.existsSync(path.join(scene2.dataDir, 'outside-link.txt')), false);
    });
    await c.check('data 只剩 lock；日记正文未变', () => {
      assert.deepEqual(fs.readdirSync(scene2.dataDir), ['qq-agent.lock']);
      assert.equal(sha(path.join(scene2.diaryRoot, '每日', '2026-11-03.md')), scene2.diaryHash);
    });
  }

  c.section('3. 完整恢复：逐文件 hash + 目录重建');
  {
    const r = await D.restoreResetBackup({ opId: reset2.opId, ...scene2.args, scope: 'data' });
    await c.check('恢复成功且逐文件 hash 与原始一致', () => {
      assert.equal(r.ok, true, JSON.stringify(r));
      for (const [rel, h] of Object.entries(scene2.original)) {
        assert.equal(sha(path.join(scene2.dataDir, ...rel.split('/'))), h, rel);
      }
    });
    await c.check('空目录重建、日记未动、审计存在', () => {
      assert.ok(fs.statSync(path.join(scene2.dataDir, 'empty-dir')).isDirectory());
      assert.equal(sha(path.join(scene2.diaryRoot, '每日', '2026-11-03.md')), scene2.diaryHash);
      assert.ok(fs.existsSync(path.join(scene2.backupRoot, 'restore-audit.jsonl')));
    });
    await c.check('目标冲突 → 拒绝覆盖', async () => {
      const r2 = await D.restoreResetBackup({ opId: reset2.opId, ...scene2.args, scope: 'data' });
      assert.equal(r2.ok, false);
      assert.ok(String(r2.error).includes('已存在新数据'));
    });
    await c.check('junction 未随恢复重建（已知限制，目标未受影响）', () => {
      assert.equal(fs.existsSync(path.join(scene2.dataDir, 'linked-out')), false);
      assert.equal(sha(path.join(scene2.outside, 'secret.txt')), scene2.outsideHash);
    });
  }

  c.section('4. 损坏备份 → 拒绝恢复');
  {
    const s = buildScene('s-corrupt');
    const r = await D.resetData(s.args);
    fs.appendFileSync(path.join(r.backupDir, 'data', 'learned.json'), 'tamper');
    const rr = await D.restoreResetBackup({ opId: r.opId, ...s.args, scope: 'data' });
    await c.check('备份 hash 错误 → 拒绝、目标未写入', () => {
      assert.equal(rr.ok, false);
      assert.ok(String(rr.error).includes('备份不完整'));
      assert.equal(fs.existsSync(path.join(s.dataDir, 'learned.json')), false);
    });
  }

  c.section('5. 恢复中途失败 → 部分恢复、needsManual、不谎报');
  {
    const s = buildScene('s-partial');
    const r = await D.resetData(s.args);
    const rr = await D.restoreResetBackup({
      opId: r.opId, ...s.args, scope: 'data', hooks: { failCopyRel: 'data/sessions/a.json' }
    });
    await c.check('返回 ok:false + needsManual + partial，备份保留', () => {
      assert.equal(rr.ok, false);
      assert.equal(rr.needsManual, true);
      assert.equal(rr.partial, true);
      assert.ok(rr.restored > 0);
      assert.ok(rr.failed.some((f) => f.rel === 'data/sessions/a.json'));
      assert.ok(fs.existsSync(r.backupDir));
    });
    await c.check('已恢复文件保留、失败文件缺失；再次恢复因冲突拒绝（需人工）', async () => {
      assert.ok(fs.existsSync(path.join(s.dataDir, 'config.json')), '已恢复文件应保留');
      assert.ok(!fs.existsSync(path.join(s.dataDir, 'sessions', 'a.json')), '失败文件不应存在');
      const again = await D.restoreResetBackup({ opId: r.opId, ...s.args, scope: 'data' });
      assert.equal(again.ok, false);
      assert.ok(String(again.error).includes('已存在新数据'));
    });
  }

  c.section('6. 备份失败（模拟 I/O/权限）→ 不删除');
  {
    const s = buildScene('s-iofail');
    const r = await D.resetData({ ...s.args, hooks: { failFileRel: 'learned.json' } });
    await c.check('备份失败 → status=failed、data 完整、备份保留', () => {
      assert.equal(r.ok, false);
      assert.equal(r.status, 'failed');
      assert.equal(sha(path.join(s.dataDir, 'learned.json')), s.original['learned.json']);
      assert.ok(fs.existsSync(r.backupDir));
    });
  }

  c.section('7. 写入屏障与备份后并发写');
  {
    const s = buildScene('s-barrier');
    barrier.beginResetBarrier({ opId: 'drill', backupRoot: path.join(s.base, 'barrier-root') });
    const blocked = stateStore.withState(path.join(s.dataDir, 'x.json'), (st) => { st.a = 1; });
    barrier.endResetBarrier();
    await c.check('屏障期间状态写入被拒绝、结束后恢复', () => {
      assert.equal(blocked.ok, false);
      assert.equal(blocked.code, 'ERESETBARRIER');
      assert.equal(barrier.isResetBarrierActive(), false);
      const ok = stateStore.withState(path.join(s.dataDir, 'x.json'), (st) => { st.a = 1; });
      assert.equal(ok.ok, true);
      fs.rmSync(path.join(s.dataDir, 'x.json'), { force: true });
    });
    const s2 = buildScene('s-concurrent');
    const r = await D.resetData({
      ...s2.args,
      hooks: { afterDataBackup: async () => { fs.writeFileSync(path.join(s2.dataDir, 'late.txt'), 'late', 'utf8'); } }
    });
    await c.check('备份后并发写入 → 删除前复核拒绝、data 未删', () => {
      assert.equal(r.ok, false);
      assert.ok(fs.existsSync(path.join(s2.dataDir, 'late.txt')));
      assert.ok(fs.existsSync(path.join(s2.dataDir, 'learned.json')));
      const m = JSON.parse(fs.readFileSync(r.manifestPath, 'utf8'));
      assert.equal(m.status, 'failed');
    });
  }

  c.section('8. Windows 文件句柄占用 → resume');
  {
    const s = buildScene('s-handle');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      cwd: path.join(s.dataDir, 'sessions'), stdio: 'ignore', windowsHide: true
    });
    await sleep(500);
    const r = await D.resetData(s.args);
    await c.check('占用目录删除失败 → needs_manual_recovery、备份保留', () => {
      assert.equal(r.ok, false);
      assert.equal(r.status, 'needs_manual_recovery');
      assert.ok(fs.existsSync(path.join(s.dataDir, 'sessions')));
    });
    await new Promise((resolve) => { holder.on('exit', resolve); holder.kill(); });
    await sleep(300);
    const rr = await D.resumeReset({ opId: r.opId, ...s.args });
    await c.check('释放句柄后 resume 完成、数据只剩 lock', () => {
      assert.equal(rr.ok, true);
      assert.deepEqual(fs.readdirSync(s.dataDir), ['qq-agent.lock']);
    });
  }

  c.section('9. 删除中途崩溃（真实子进程）→ resume');
  {
    const s = buildScene('s-crash');
    const worker = path.join(s.base, 'crash-worker.mjs');
    fs.writeFileSync(worker, `
const [,, modUrl, dataDir, diaryRoot, backupRoot] = process.argv;
const m = await import(modUrl);
const r = await m.resetData({ dataDir, diaryRoot, backupRoot });
process.exit(r.ok ? 0 : 1);
`, 'utf8');
    const code = await new Promise((resolve) => {
      const ch = spawn(process.execPath, [worker, MOD_URL, s.dataDir, s.diaryRoot, s.backupRoot], {
        stdio: 'ignore', windowsHide: true, env: { ...process.env, QQ_RESET_TEST_STOP_AFTER: 'delete_first' }
      });
      ch.on('exit', resolve);
    });
    const [op] = D.listResetOps({ backupRoot: s.backupRoot });
    await c.check('崩溃：exit 97、status=delete_in_progress、部分删除', () => {
      assert.equal(code, 97);
      assert.equal(op.status, 'delete_in_progress');
      const left = fs.readdirSync(s.dataDir).filter((n) => n !== 'qq-agent.lock');
      assert.ok(left.length > 0, '应仍有残项');
      assert.equal(fs.existsSync(path.join(s.dataDir, 'config.json')), false, '首个条目应已删除');
      assert.equal(fs.existsSync(path.join(s.dataDir, 'learned.json')), true, '后续条目应尚未删除');
    });
    const rr = await D.resumeReset({ opId: op.opId, ...s.args });
    await c.check('resume 续删完成、备份完整', () => {
      assert.equal(rr.ok, true);
      assert.deepEqual(fs.readdirSync(s.dataDir), ['qq-agent.lock']);
      const v = D.readManifest(rr.backupDir);
      assert.equal(v.checksumOk, true);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  delete process.env.DIARY_TEST_GUARD;
  delete process.env.DIARY_TEST_TMP;
  delete process.env.QQ_AGENT_RESET_BACKUP_DIR;
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
