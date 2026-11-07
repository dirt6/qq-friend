// D1-3c C3 专项：隔离启动新版本，验收 UI / API / reset preflight / 写入屏障 / 备份 / 日志。
// 使用 test/_harness 的隔离数据目录与 mock OneBot/LLM；不接触生产 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker, bootApp, ROOT, sleep } from './_harness.mjs';

const c = createChecker('D1-3c C3 隔离验收');
const diaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-accept-diary-'));
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let ctx = null;
try {
  ctx = await bootApp({
    config: {
      skills: { diary: { root: diaryRoot } },
      snowluma: { dir: path.join(ROOT, '__no_such_snowluma__'), accessToken: '' }
    }
  });
  const { app, request, dataDir } = ctx;

  // 预置一条日记，用于验证 reset 不删正文
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.writeFileSync(path.join(diaryRoot, '每日', '2026-11-03.md'), '# 2026-11-03\n\n- 心情：平静｜隔离验收\n', 'utf8');
  const diaryBefore = sha(path.join(diaryRoot, '每日', '2026-11-03.md'));

  c.section('1. 版本 / UI / 基础 API');
  {
    const v = await request('GET', '/api/version');
    await c.check('/api/version 与 package.json 一致', () => {
      assert.equal(v.status, 200);
      assert.equal(String(v.data.version), String(pkgVersion));
    });
    const index = await request('GET', '/');
    const appJs = await request('GET', '/app.js');
    await c.check('静态 UI 可加载（index.html + app.js）', () => {
      assert.equal(index.status, 200);
      assert.match(index.text, /<html/i);
      assert.equal(appJs.status, 200);
    });
    const uiFile = await request('GET', '/app/07-settings-events.js');
    await c.check('前端包含 reset preflight 调用（新 UI）', () => {
      assert.equal(uiFile.status, 200);
      assert.ok(uiFile.text.includes('/api/reset-data/preflight'), '前端缺少 preflight 调用');
    });
    const status = await request('GET', '/api/status');
    await c.check('/api/status 正常且 dataDir 指向隔离目录', () => {
      assert.equal(status.status, 200);
      assert.equal(path.resolve(status.data.dataDir), path.resolve(dataDir));
    });
  }

  c.section('2. reset preflight（隔离目录 + 门禁）');
  {
    const pre = await request('GET', '/api/reset-data/preflight');
    await c.check('preflight 200、canReset=true、路径在隔离目录、备份根在 data 外', () => {
      assert.equal(pre.status, 200);
      assert.equal(pre.data.canReset, true, JSON.stringify(pre.data.refusals));
      assert.equal(path.resolve(pre.data.paths.dataDir), path.resolve(dataDir));
      assert.equal(path.resolve(pre.data.paths.diaryRoot), path.resolve(diaryRoot));
      assert.ok(!String(pre.data.paths.backupRoot).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase() + path.sep));
    });
    // 写入一条未完成 pending → 拒绝
    fs.mkdirSync(path.join(dataDir, 'diary-meta'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'diary-meta', 'pending.json'), JSON.stringify({
      version: 1, items: { acceptp1: { id: 'acceptp1', op: 'append', dateKey: '2026-11-03', stage: 'prepared', createdAt: '2026-11-03T00:00:00.000Z' } }
    }), 'utf8');
    const pre2 = await request('GET', '/api/reset-data/preflight');
    await c.check('存在未完成 pending → canReset=false 且列出原因', () => {
      assert.equal(pre2.status, 200);
      assert.equal(pre2.data.canReset, false);
      assert.ok(pre2.data.refusals.some((x) => x.includes('未完成日记操作')));
    });
    const refused = await request('POST', '/api/reset-data', { body: {} });
    await c.check('POST reset 被拒绝（409）且未删除数据', () => {
      assert.equal(refused.status, 409);
      assert.equal(refused.data.refused, true);
      assert.ok(app.store.listChats() !== null);
      assert.ok(fs.existsSync(path.join(dataDir, 'diary-meta', 'pending.json')));
    });
    fs.rmSync(path.join(dataDir, 'diary-meta', 'pending.json'), { force: true });
  }

  c.section('3. 写入屏障（隔离实例内）');
  {
    const barrier = await import('../src/reset-barrier.js');
    barrier.beginResetBarrier({ opId: 'c3-barrier', backupRoot: path.join(dataDir, '..', 'c3-barrier-root') });
    let blocked = false;
    try { await app.store.appendIncoming('group:456', { mid: 9101, ts: Date.now(), senderId: '111', senderName: '甲', text: '屏障测试' }); }
    catch (e) { blocked = e?.code === 'ERESETBARRIER'; }
    await c.check('屏障生效时 chat 写入被拒绝（ERESETBARRIER）', () => assert.equal(blocked, true));
    barrier.endResetBarrier();
    await c.check('屏障解除后写入恢复、标记清理', async () => {
      assert.equal(barrier.isResetBarrierActive(), false);
      await app.store.appendIncoming('group:456', { mid: 9102, ts: Date.now(), senderId: '111', senderName: '甲', text: '恢复写入' });
    });
  }

  c.section('4. 隔离 reset：备份 manifest + 删除 + 日记保留');
  {
    const r = await request('POST', '/api/reset-data', { body: {} });
    await c.check('POST reset 200，返回 opId/status/backupDir/manifestPath/atomic=false', () => {
      assert.equal(r.status, 200, r.text);
      assert.equal(r.data.ok, true);
      assert.equal(r.data.atomic, false);
      assert.equal(r.data.status, 'completed');
      assert.ok(r.data.backupDir && fs.existsSync(r.data.manifestPath));
    });
    await c.check('备份 manifest 自校验 + 逐文件 hash 可核验', async () => {
      const { verifyResetOp } = await import('../src/reset-data.js');
      const v = await verifyResetOp({ opId: r.data.opId, dataDir, diaryRoot, backupRoot: r.data.backupDir.replace(/[\\/][^\\/]+$/, '') });
      assert.equal(v.ok, true, JSON.stringify(v.pathProblems.concat(v.backup.problems)));
      assert.ok(v.backup.checked > 0);
      assert.equal(v.checksumOk, true);
    });
    await c.check('data 已删除（仅 lock + 重置后重建的 config.json）', () => {
      const left = fs.readdirSync(dataDir).sort();
      const allowed = new Set(['qq-agent.lock', 'config.json']);
      assert.ok(left.every((n) => allowed.has(n)), JSON.stringify(left));
    });
    await c.check('日记正文未被删除/修改', () => {
      assert.equal(sha(path.join(diaryRoot, '每日', '2026-11-03.md')), diaryBefore);
    });
    await c.check('reset 后服务仍可响应', async () => {
      const s = await request('GET', '/api/status');
      assert.equal(s.status, 200);
    });
    await c.check('reset 后写入屏障已释放且可再写入', async () => {
      const barrier = await import('../src/reset-barrier.js');
      assert.equal(barrier.isResetBarrierActive(), false);
      await app.store.appendIncoming('group:777', { mid: 9201, ts: Date.now(), senderId: '222', senderName: '乙', text: 'reset 后写入' });
      assert.ok(fs.existsSync(path.join(dataDir, 'messages')));
    });
  }

  c.section('5. 日志');
  {
    const logs = await request('GET', '/api/logs');
    await c.check('GET /api/logs 返回数组（日志通路正常）', () => {
      assert.equal(logs.status, 200);
      assert.ok(Array.isArray(logs.data.logs));
    });
    await c.check('隔离目录出现 logs（reset 后写入日志并落盘）', async () => {
      const { logger } = await import('../src/logger.js');
      logger.info('deploy-acceptance', 'C3 验收：日志落盘检查');
      logger.flush();
      await sleep(300);
      const dir = path.join(dataDir, 'logs');
      assert.ok(fs.existsSync(dir), 'logs 目录不存在');
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log'));
      assert.ok(files.length > 0, '没有日志文件');
      assert.ok(fs.readFileSync(path.join(dir, files[0]), 'utf8').includes('C3 验收'), '日志内容缺失');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  if (ctx) {
    try { await ctx.teardown(); } catch { /* ignore */ }
    try { fs.rmSync(path.join(ctx.dataDir, '..', 'c3-barrier-root'), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(diaryRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
