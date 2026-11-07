// D1-3b-B4 专项：reset-data 跨目录 manifest、双目录备份校验、pending 拒绝、阶段化恢复。
//
// 全部在隔离临时目录内进行（统一启动器注入 QQ_AGENT_DATA_DIR / DIARY_TEST_TMP / DIARY_TEST_GUARD）；
// 断言真实文件与 hash，不只看返回值。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-3b B4 reset-data');
const TMP = process.env.DIARY_TEST_TMP;
const PROJECT_ROOT = process.env.DIARY_TEST_PROJECT_ROOT || path.resolve(import.meta.dirname, '..');
const MOD_URL = pathToFileURL(path.join(PROJECT_ROOT, 'src', 'reset-data.js')).href;

const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 目录聚合 hash：相对路径（/）+ 文件 hash + 大小，排序后 sha256。 */
function aggHash(root) {
  const lines = [];
  const walk = (dir, rel) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) lines.push(`${r}|${sha(p)}|${fs.statSync(p).size}`);
    }
  };
  walk(root, '');
  return crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex');
}

const D = await import('../src/reset-data.js');

/* ── 场景 ──────────────────────────────────────────────────────────── */

function scene(name) {
  const base = path.join(TMP, name);
  fs.rmSync(base, { recursive: true, force: true });
  const dataDir = path.join(base, 'data');
  const diaryRoot = path.join(base, '日记');
  const backupRoot = path.join(base, 'backups');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  fs.mkdirSync(path.join(diaryRoot, '.trash'), { recursive: true });
  const files = {
    'config.json': JSON.stringify({ api: { apiKey: 'secret' } }),
    'learned.json': JSON.stringify([{ id: 'l1' }]),
    'sessions/s1.json': JSON.stringify({ id: 's1', status: 'done' }),
    'sessions/s2.json': JSON.stringify({ id: 's2', status: 'done' }),
    'memory/private_1/1.json': JSON.stringify({ userId: '1', impressions: [] }),
    'logs/app.log': 'line1\nline2\n',
    'nested/deep/x.txt': 'deep',
    'diary-meta/pending.json': JSON.stringify({
      version: 1,
      items: { done1: { id: 'done1', stage: 'completed', createdAt: '2026-11-01T00:00:00.000Z' } }
    }),
    'diary-idempotency.json': JSON.stringify({ keys: { k1: { state: 'done', day: '2026-11-01' } } })
  };
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dataDir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  fs.mkdirSync(path.join(dataDir, 'empty-dir'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'qq-agent.lock'), '12345', 'utf8');
  fs.writeFileSync(path.join(diaryRoot, '每日', '2026-11-03.md'), '# 2026-11-03\n\n- 心情：平静｜测试一\n', 'utf8');
  fs.writeFileSync(path.join(diaryRoot, '.trash', 'old.bak'), 'old', 'utf8');

  const original = {};
  for (const rel of Object.keys(files)) original[rel] = sha(path.join(dataDir, ...rel.split('/')));
  return {
    base,
    dataDir,
    diaryRoot,
    backupRoot,
    files,
    original,
    dataHash: () => aggHash(dataDir),
    diaryHash: () => aggHash(diaryRoot),
    manifest: (opId) => JSON.parse(fs.readFileSync(path.join(backupRoot, opId, 'manifest.json'), 'utf8'))
  };
}

const args = (s) => ({ dataDir: s.dataDir, diaryRoot: s.diaryRoot, backupRoot: s.backupRoot });

/* ── 子进程工具 ────────────────────────────────────────────────────── */

const WORKER = path.join(TMP, 'reset-worker.mjs');
fs.writeFileSync(WORKER, `
const [,, modUrl, dataDir, diaryRoot, backupRoot] = process.argv;
const m = await import(modUrl);
const r = await m.resetData({ dataDir, diaryRoot, backupRoot });
process.exit(r.ok ? 0 : 1);
`, 'utf8');

function runWorker(s, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, MOD_URL, s.dataDir, s.diaryRoot, s.backupRoot], {
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, ...env }
    });
    child.on('exit', (code) => resolve(code));
  });
}

function runCrashWorker(s, stage) {
  return runWorker(s, { QQ_RESET_TEST_STOP_AFTER: stage });
}

try {
  /* ── 1. 预检 ───────────────────────────────────────────────────── */
  c.section('1. 预检：正常场景');
  {
    const s = scene('s1');
    const pre = await D.preflightReset(args(s));
    await c.check('canReset=true、无拒绝原因、路径正确', () => {
      if (!pre.ok || !pre.canReset) throw new Error(JSON.stringify(pre.refusals));
      if (pre.refusals.length) throw new Error(JSON.stringify(pre.refusals));
      if (pre.paths.dataDir !== path.resolve(s.dataDir)) throw new Error(pre.paths.dataDir);
      if (pre.paths.backupRoot !== path.resolve(s.backupRoot)) throw new Error(pre.paths.backupRoot);
    });
    await c.check('data 计数排除 lock（9 文件）、日记 2 文件', () => {
      if (pre.data.files !== 9) throw new Error(`data.files=${pre.data.files}`);
      if (!pre.diary.exists || pre.diary.files !== 2) throw new Error(JSON.stringify(pre.diary));
      if (pre.pending.count !== 0 || pre.idem.count !== 0) throw new Error(JSON.stringify({ p: pre.pending, i: pre.idem }));
    });
    await c.check('预检不写盘（backupRoot 不存在）', () => {
      if (fs.existsSync(s.backupRoot)) throw new Error('预检创建了目录');
    });
    await c.check('backupRoot 默认在 data 之外（同级）', () => {
      const def = D.defaultBackupRoot(s.dataDir);
      if (def === path.resolve(s.dataDir) || def.startsWith(path.resolve(s.dataDir) + path.sep)) throw new Error(def);
    });
  }

  /* ── 2. 拒绝矩阵 ───────────────────────────────────────────────── */
  c.section('2. 拒绝矩阵（fail-closed）');
  {
    const s = scene('s2-pending');
    const pendingFile = path.join(s.dataDir, 'diary-meta', 'pending.json');
    fs.writeFileSync(pendingFile, JSON.stringify({
      version: 1,
      items: { p1: { id: 'p1', op: 'remove', dateKey: '2026-11-03', stage: 'prepared', createdAt: '2026-11-03T00:00:00.000Z' } }
    }), 'utf8');
    const before = s.dataHash();
    const pre = await D.preflightReset(args(s));
    await c.check('未完成 pending → 拒绝并列出 id', () => {
      if (pre.canReset) throw new Error('应当拒绝');
      if (!pre.refusals.some((r) => r.includes('p1') && r.includes('未完成日记操作'))) throw new Error(JSON.stringify(pre.refusals));
    });
    const r = await D.resetData(args(s));
    await c.check('resetData 被拒绝、data 未变、无备份目录', () => {
      if (r.ok || !r.refused) throw new Error(JSON.stringify(r));
      if (s.dataHash() !== before) throw new Error('data 被改动');
      if (fs.existsSync(s.backupRoot)) throw new Error('拒绝时仍创建了备份目录');
    });

    const s2 = scene('s2-corrupt');
    fs.writeFileSync(path.join(s2.dataDir, 'diary-meta', 'pending.json'), '{ not json', 'utf8');
    const r2 = await D.resetData(args(s2));
    await c.check('pending.json 损坏 → 拒绝（不当成空）', () => {
      if (r2.ok || !r2.refused) throw new Error(JSON.stringify(r2));
      if (!r2.refusals.join('｜').includes('损坏')) throw new Error(JSON.stringify(r2.refusals));
    });

    const s3 = scene('s2-idem');
    fs.writeFileSync(path.join(s3.dataDir, 'diary-idempotency.json'), JSON.stringify({
      keys: { 'auto:2026-11-03:abc': { state: 'pending', day: '2026-11-03' } }
    }), 'utf8');
    const r3 = await D.resetData(args(s3));
    await c.check('幂等键 pending → 拒绝', () => {
      if (r3.ok || !r3.refused) throw new Error(JSON.stringify(r3));
      if (!r3.refusals.join('｜').includes('幂等键')) throw new Error(JSON.stringify(r3.refusals));
    });

    const s4 = scene('s2-diary-in-data');
    const inside = path.join(s4.dataDir, 'diary-inside');
    fs.mkdirSync(inside, { recursive: true });
    const r4 = await D.resetData({ dataDir: s4.dataDir, diaryRoot: inside, backupRoot: s4.backupRoot });
    await c.check('日记根在 data 内 → 拒绝', () => {
      if (r4.ok || !r4.refused) throw new Error(JSON.stringify(r4));
      if (!r4.refusals.join('｜').includes('日记根位于数据目录内')) throw new Error(JSON.stringify(r4.refusals));
    });

    const s5 = scene('s2-backup-in-data');
    const r5 = await D.resetData({ dataDir: s5.dataDir, diaryRoot: s5.diaryRoot, backupRoot: path.join(s5.dataDir, 'bak') });
    await c.check('备份目录在 data 内 → 拒绝', () => {
      if (r5.ok || !r5.refused) throw new Error(JSON.stringify(r5));
      if (!r5.refusals.join('｜').includes('备份目录位于数据目录内')) throw new Error(JSON.stringify(r5.refusals));
    });
  }

  /* ── 3. 正常重置 ───────────────────────────────────────────────── */
  c.section('3. 正常重置：双目录备份 + 删除 + 校验');
  {
    const s = scene('s3');
    const diaryBefore = s.diaryHash();
    const r = await D.resetData(args(s));
    await c.check('返回 ok、result=ok、atomic=false', () => {
      if (!r.ok || r.result !== 'ok') throw new Error(JSON.stringify(r));
      if (r.atomic !== false) throw new Error('atomic 必须显式 false');
      if (r.stages.data.stage !== 'completed' || r.stages.diary.stage !== 'verified') throw new Error(JSON.stringify(r.stages));
    });
    await c.check('data 删除后只剩 qq-agent.lock', () => {
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });
    await c.check('备份逐文件 hash 与原始一致（含空目录）', () => {
      for (const [rel, hash] of Object.entries(s.original)) {
        const b = path.join(r.backupDir, 'data', ...rel.split('/'));
        if (sha(b) !== hash) throw new Error(`备份不一致：${rel}`);
      }
      if (!fs.statSync(path.join(r.backupDir, 'data', 'empty-dir')).isDirectory()) throw new Error('空目录未备份');
    });
    await c.check('日记正文一个字节未改', () => {
      if (s.diaryHash() !== diaryBefore) throw new Error('日记被改动');
      if (r.diaryCheck.stage !== 'verified') throw new Error(JSON.stringify(r.diaryCheck));
    });
    await c.check('manifest 字段完整（schemaVersion/backupId/状态/源根/总计/自校验）', () => {
      const m = s.manifest(r.opId);
      if (m.schemaVersion !== 2 || m.kind !== 'reset' || m.backupId !== r.opId) throw new Error('schemaVersion/backupId');
      if (m.opId !== r.opId) throw new Error('opId 兼容字段');
      if (m.status !== 'completed') throw new Error(`status=${m.status}`);
      if (m.atomic !== false) throw new Error('atomic');
      if (JSON.stringify(m.scope) !== JSON.stringify(['data', 'diary'])) throw new Error('scope');
      if (m.paths.dataDir !== path.resolve(s.dataDir)) throw new Error('paths.dataDir');
      if (m.paths.backupDir !== r.backupDir) throw new Error('paths.backupDir');
      if (!Array.isArray(m.sourceRoots) || m.sourceRoots.length !== 2) throw new Error('sourceRoots');
      const rootData = m.sourceRoots.find((x) => x.id === 'data');
      const rootDiary = m.sourceRoots.find((x) => x.id === 'diary');
      if (!rootData || rootData.files !== 9 || !Array.isArray(rootData.skipped) || rootData.skipped[0] !== 'qq-agent.lock') throw new Error('sourceRoots.data');
      if (!rootDiary || rootDiary.files !== 2) throw new Error('sourceRoots.diary');
      if (m.totals.files !== 11 || !(m.totals.bytes > 0)) throw new Error(`totals=${JSON.stringify(m.totals)}`);
      if (m.files.data.length !== 9) throw new Error(`files.data=${m.files.data.length}`);
      if (!m.files.data.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size >= 0)) throw new Error('hash/size');
      if (!/^[0-9a-f]{64}$/.test(String(m.manifestChecksum))) throw new Error('manifestChecksum');
      if (m.pendingSnapshot.exists !== true || m.pendingSnapshot.unfinished !== 0) throw new Error('pendingSnapshot');
      if (m.deleted.entries !== 9) throw new Error(`deleted.entries=${m.deleted.entries}`);
      if (!m.notes.some((n) => n.includes('不是跨目录原子事务'))) throw new Error('notes 未声明非原子');
      if (!m.finishedAt) throw new Error('finishedAt');
    });
    await c.check('备份根保留 .reset.lock 之外的 op 目录、lock 已释放', () => {
      const names = fs.readdirSync(s.backupRoot);
      if (!names.includes(r.opId)) throw new Error(JSON.stringify(names));
      if (names.includes('.reset.lock')) throw new Error('锁文件未释放');
    });

    const r2 = await D.resetData(args(s));
    await c.check('第二次 reset：新 opId、旧备份保留、data 仍只剩 lock', () => {
      if (!r2.ok) throw new Error(JSON.stringify(r2));
      if (r2.opId === r.opId) throw new Error('opId 未变');
      if (sha(path.join(r.backupDir, 'data', 'learned.json')) !== s.original['learned.json']) throw new Error('旧备份被改动');
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });
  }

  /* ── 3b. data 目录内的 junction：不跟随、不删目标 ──────────────── */
  c.section('3b. junction：备份记录为链接、删除只删链接');
  {
    const s = scene('s3b');
    const outside = path.join(TMP, 's3b-outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside', 'utf8');
    const link = path.join(s.dataDir, 'linked-out');
    let linked = false;
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* 权限不足 */ }
    if (!linked) {
      console.log('  INCONCLUSIVE junction 创建失败（权限不足）');
    } else {
      const pre = await D.preflightReset(args(s));
      await c.check('预检不把 junction 目标计入 data 文件数', () => {
        if (pre.data.files !== 9) throw new Error(`data.files=${pre.data.files}`);
      });
      const r = await D.resetData(args(s));
      await c.check('reset 成功、manifest 记录链接而非复制目标内容', () => {
        if (!r.ok) throw new Error(JSON.stringify(r));
        const m = s.manifest(r.opId);
        if (m.files.data.length !== 9) throw new Error(`files.data=${m.files.data.length}`);
        if (!m.links.some((l) => l.scope === 'data' && l.rel === 'linked-out')) throw new Error(JSON.stringify(m.links));
        if (fs.existsSync(path.join(r.backupDir, 'data', 'linked-out'))) throw new Error('跟随复制了 junction');
      });
      await c.check('删除只删链接本身，目标文件仍在', () => {
        if (!fs.existsSync(path.join(outside, 'secret.txt'))) throw new Error('junction 目标被删');
        const left = fs.readdirSync(s.dataDir);
        if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
      });
    }
    try { fs.rmdirSync(link); } catch { /* 已删 */ }
    fs.rmSync(outside, { recursive: true, force: true });
  }

  /* ── 4. 备份失败 → 不删除 ──────────────────────────────────────── */
  c.section('4. 备份失败 → 拒绝删除');
  {
    const s = scene('s4');
    const before = s.dataHash();
    const r = await D.resetData({ ...args(s), hooks: { failFileRel: 'logs/app.log' } });
    await c.check('返回 failed、data 完整、manifest 记录失败原因', () => {
      if (r.ok || r.result !== 'failed') throw new Error(JSON.stringify(r));
      if (s.dataHash() !== before) throw new Error('data 被删除/改动');
      const m = s.manifest(r.opId);
      if (m.result !== 'failed' || !m.error) throw new Error(JSON.stringify({ result: m.result, error: m.error }));
      if (m.stages.data.stage !== 'failed') throw new Error(JSON.stringify(m.stages.data));
      if (!fs.existsSync(path.join(r.backupDir, 'data', 'config.json'))) throw new Error('已备份的文件也应保留');
    });
    await c.check('生产环境禁止使用测试 hooks', async () => {
      const old = process.env.DIARY_TEST_GUARD;
      process.env.DIARY_TEST_GUARD = '0';
      try {
        let threw = '';
        try { await D.resetData({ ...args(scene('s4-hook')), hooks: { failFileRel: 'x' } }); } catch (e) { threw = String(e.message); }
        if (!threw.includes('测试注入')) throw new Error(`未拒绝：${threw}`);
      } finally {
        process.env.DIARY_TEST_GUARD = old;
      }
    });
  }

  /* ── 5. 删除失败 → 记录、备份保留、可 resume ───────────────────── */
  c.section('5. 删除失败（真实占用）→ resume 续做');
  {
    const s = scene('s5');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], {
      cwd: path.join(s.dataDir, 'sessions'),
      stdio: 'ignore',
      windowsHide: true
    });
    await sleep(500);
    const r = await D.resetData(args(s));
    await c.check('返回 failed、deleted.failed 记录被占用目录', () => {
      if (r.ok || r.result !== 'failed') throw new Error(JSON.stringify(r));
      const m = s.manifest(r.opId);
      if (!m.deleted.failed.some((f) => f.rel === 'sessions')) throw new Error(JSON.stringify(m.deleted));
      if (!m.error.includes('删除阶段失败')) throw new Error(m.error);
    });
    await c.check('失败时备份完整、未删的文件仍在', () => {
      const m = s.manifest(r.opId);
      if (!m.files.data.every((f) => sha(path.join(r.backupDir, 'data', ...f.rel.split('/'))) === f.sha256)) throw new Error('备份不完整');
      if (!fs.existsSync(path.join(s.dataDir, 'sessions', 's1.json'))) throw new Error('未删的文件不见了');
    });
    await new Promise((resolve) => { holder.on('exit', resolve); holder.kill(); });
    await sleep(300);
    const rr = await D.resumeReset({ opId: r.opId, ...args(s) });
    await c.check('resume 续删并完成', () => {
      if (!rr.ok || rr.result !== 'ok') throw new Error(JSON.stringify(rr));
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });
  }

  /* ── 6. 崩溃注入 + 阶段化恢复 ──────────────────────────────────── */
  c.section('6. 崩溃注入 + 阶段化恢复');
  {
    const s = scene('s6a');
    const code = await runCrashWorker(s, 'data_backup');
    await c.check('崩溃@data_backup：子进程 exit 97、data 完整、status=backup_in_progress', () => {
      if (code !== 97) throw new Error(`exit=${code}`);
      const [op] = D.listResetOps({ backupRoot: s.backupRoot });
      if (!op || op.dataStage !== 'backed_up') throw new Error(JSON.stringify(op));
      if (op.status !== 'backup_in_progress') throw new Error(`status=${op.status}`);
      if (!fs.existsSync(path.join(s.dataDir, 'config.json'))) throw new Error('备份阶段不应删除数据');
    });
    const [op1] = D.listResetOps({ backupRoot: s.backupRoot });
    const rr = await D.resumeReset({ opId: op1.opId, ...args(s) });
    await c.check('resume 完成：data 只剩 lock、result=ok', () => {
      if (!rr.ok || rr.result !== 'ok') throw new Error(JSON.stringify(rr));
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });

    const s6b = scene('s6b');
    const code2 = await runCrashWorker(s6b, 'removing');
    const [op2] = D.listResetOps({ backupRoot: s6b.backupRoot });
    await c.check('崩溃@removing：exit 97、status=delete_in_progress、数据尚未删除', () => {
      if (code2 !== 97) throw new Error(`exit=${code2}`);
      if (!op2 || op2.dataStage !== 'removing') throw new Error(JSON.stringify(op2));
      if (op2.status !== 'delete_in_progress') throw new Error(`status=${op2.status}`);
      if (!fs.existsSync(path.join(s6b.dataDir, 'learned.json'))) throw new Error('removing 阶段就删了文件');
    });
    const blocked = await D.resetData(args(s6b));
    await c.check('删除可能已开始 → 新的 reset 被拒绝并指向未完成 opId', () => {
      if (blocked.ok || !blocked.refused) throw new Error(JSON.stringify(blocked));
      if (!blocked.refusals.join('｜').includes(op2.opId)) throw new Error(JSON.stringify(blocked.refusals));
    });
    const rr2 = await D.resumeReset({ opId: op2.opId, ...args(s6b) });
    await c.check('resume 续删完成', () => {
      if (!rr2.ok || rr2.result !== 'ok') throw new Error(JSON.stringify(rr2));
      const left = fs.readdirSync(s6b.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });

    const s6c = scene('s6c');
    const code3 = await runCrashWorker(s6c, 'deleted');
    const [op3] = D.listResetOps({ backupRoot: s6c.backupRoot });
    fs.writeFileSync(path.join(s6c.dataDir, 'new-after-reset.txt'), 'fresh', 'utf8');
    const rr3 = await D.resumeReset({ opId: op3.opId, ...args(s6c) });
    await c.check('崩溃@deleted：resume 只补校验，不删重置后新文件', () => {
      if (code3 !== 97) throw new Error(`exit=${code3}`);
      if (!rr3.ok) throw new Error(JSON.stringify(rr3));
      if (!fs.existsSync(path.join(s6c.dataDir, 'new-after-reset.txt'))) throw new Error('新文件被删除');
      if (rr3.stages.data.stage !== 'completed') throw new Error(JSON.stringify(rr3.stages));
      if (!(rr3.postDeleteNewEntries || []).includes('new-after-reset.txt')) throw new Error(JSON.stringify(rr3.postDeleteNewEntries));
    });
    const again = await D.resumeReset({ opId: op3.opId, ...args(s6c) });
    await c.check('对已完成的操作再次 resume：只核验、不改写结果', () => {
      if (!again.ok || !again.alreadyCompleted) throw new Error(JSON.stringify(again));
      if (again.result !== rr3.result) throw new Error(`${again.result} != ${rr3.result}`);
    });

    const s6d = scene('s6d');
    const code4 = await runCrashWorker(s6d, 'data_backup');
    const [op4] = D.listResetOps({ backupRoot: s6d.backupRoot });
    fs.appendFileSync(path.join(s6d.backupRoot, op4.opId, 'data', 'learned.json'), 'tamper');
    const rr4 = await D.resumeReset({ opId: op4.opId, ...args(s6d) });
    await c.check('备份损坏 → resume 拒绝（needsManual）、data 完整', () => {
      if (code4 !== 97) throw new Error(`exit=${code4}`);
      if (rr4.ok || !rr4.needsManual) throw new Error(JSON.stringify(rr4));
      if (!fs.existsSync(path.join(s6d.dataDir, 'learned.json'))) throw new Error('data 被删');
    });

    const s6e = scene('s6e');
    const code5 = await runCrashWorker(s6e, 'data_backup');
    const [op5] = D.listResetOps({ backupRoot: s6e.backupRoot });
    fs.writeFileSync(path.join(s6e.dataDir, 'unbacked-new.txt'), 'new', 'utf8');
    const rr5 = await D.resumeReset({ opId: op5.opId, ...args(s6e) });
    await c.check('删除阶段出现未备份新文件 → resume 拒绝、文件保留', () => {
      if (code5 !== 97) throw new Error(`exit=${code5}`);
      if (rr5.ok || !rr5.needsManual) throw new Error(JSON.stringify(rr5));
      if (!fs.existsSync(path.join(s6e.dataDir, 'unbacked-new.txt'))) throw new Error('新文件被删');
      if (!fs.existsSync(path.join(s6e.dataDir, 'learned.json'))) throw new Error('旧文件被删');
    });
  }

  /* ── 7. 测试隔离门禁 ───────────────────────────────────────────── */
  c.section('7. 测试隔离门禁');
  {
    const outside = path.join(path.dirname(TMP), 'reset-guard-outside');
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    const r = await D.resetData({ dataDir: outside, diaryRoot: '', backupRoot: path.join(outside, 'bak') });
    await c.check('测试守卫下 TMP 外路径 → 拒绝且不写盘', () => {
      if (r.ok || !r.refused) throw new Error(JSON.stringify(r));
      if (!r.refusals.join('｜').includes('EResetGuard')) throw new Error(JSON.stringify(r.refusals));
      if (fs.existsSync(path.join(outside, 'bak'))) throw new Error('越界写了备份目录');
    });
    fs.rmSync(outside, { recursive: true, force: true });
  }

  /* ── 8. 并发 reset：锁串行、互不覆盖 ───────────────────────────── */
  c.section('8. 并发 reset：锁串行、互不覆盖');
  {
    const s = scene('s8');
    const [a, b] = await Promise.all([runWorker(s), runWorker(s)]);
    await c.check('两个进程都正常结束（锁串行，无崩溃）', () => {
      if (a !== 0 || b !== 0) throw new Error(`exit=${a},${b}`);
    });
    await c.check('最终 data 只剩 lock、所有 manifest 可解析且结果 ok', () => {
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
      const ops = D.listResetOps({ backupRoot: s.backupRoot });
      if (ops.length !== 2) throw new Error(`ops=${ops.length}`);
      for (const op of ops) {
        if (!op.result.startsWith('ok')) throw new Error(JSON.stringify(op));
        const m = s.manifest(op.opId);
        if (m.result !== 'ok') throw new Error(`${op.opId} result=${m.result}`);
      }
      const ids = new Set(ops.map((o) => o.opId));
      if (ids.size !== 2) throw new Error('opId 重复');
    });
    await c.check('两套备份互不覆盖（各自 manifest 的 files 不同或为空）', () => {
      const ops = D.listResetOps({ backupRoot: s.backupRoot });
      const dirs = ops.map((o) => o.backupDir);
      if (new Set(dirs).size !== dirs.length) throw new Error('备份目录重复');
    });
  }

  /* ── 9. 写入屏障 ──────────────────────────────────────────────── */
  c.section('9. 写入屏障：生效时阻止领域写入、结束后恢复');
  {
    const s = scene('s9-barrier');
    const barrier = await import('../src/reset-barrier.js');
    const stateStore = await import('../src/state-store.js');
    const started = barrier.beginResetBarrier({ opId: 'test-op', backupRoot: s.backupRoot });
    await c.check('屏障生效：isResetBarrierActive=true、marker 存在', () => {
      if (!barrier.isResetBarrierActive()) throw new Error('未生效');
      if (!fs.existsSync(path.join(s.backupRoot, '.reset-barrier.json'))) throw new Error('无 marker');
      if (started.opId !== 'test-op') throw new Error('opId');
    });
    await c.check('assertWritesAllowed 抛 ERESETBARRIER', () => {
      try { barrier.assertWritesAllowed('测试写入'); } catch (e) { if (e.code === 'ERESETBARRIER') return; throw e; }
      throw new Error('没有抛错');
    });
    await c.check('state-store 写入被拒绝（ok:false + ERESETBARRIER）', () => {
      const r = stateStore.withState(path.join(s.dataDir, 'x.json'), (st) => { st.a = 1; });
      if (r.ok !== false || r.code !== 'ERESETBARRIER') throw new Error(JSON.stringify(r));
    });
    barrier.endResetBarrier();
    await c.check('结束后恢复可写、marker 删除', () => {
      if (barrier.isResetBarrierActive()) throw new Error('仍生效');
      if (fs.existsSync(path.join(s.backupRoot, '.reset-barrier.json'))) throw new Error('marker 未删');
      const r = stateStore.withState(path.join(s.dataDir, 'x.json'), (st) => { st.a = 1; });
      if (!r.ok) throw new Error(JSON.stringify(r));
    });
    await c.check('死 pid 的旧 marker 不阻塞', () => {
      fs.mkdirSync(s.backupRoot, { recursive: true });
      fs.writeFileSync(path.join(s.backupRoot, '.reset-barrier.json'), JSON.stringify({ opId: 'dead', pid: 999999, startedAt: 1 }), 'utf8');
      if (barrier.isResetBarrierActive(s.backupRoot)) throw new Error('死 pid 被判为生效');
    });
  }

  /* ── 10. manifest 自校验 ─────────────────────────────────────── */
  c.section('10. manifest 自校验：篡改后 verify/resume 拒绝');
  {
    const s = scene('s10');
    const r = await D.resetData(args(s));
    const mp = path.join(r.backupDir, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
    m.totals.files = 999;
    fs.writeFileSync(mp, JSON.stringify(m, null, 1), 'utf8');
    const v = await D.verifyResetOp({ opId: r.opId, ...args(s) });
    await c.check('verify 发现 manifestChecksum 不匹配', () => {
      if (v.ok) throw new Error('未发现');
      if (!v.pathProblems.some((p) => p.includes('自校验'))) throw new Error(JSON.stringify(v.pathProblems));
    });
    const rr = await D.resumeReset({ opId: r.opId, ...args(s) });
    await c.check('resume 拒绝自校验失败的 manifest', () => {
      if (rr.ok || !rr.needsManual) throw new Error(JSON.stringify(rr));
      if (!String(rr.error).includes('自校验')) throw new Error(rr.error);
    });
  }

  /* ── 11. manifest 写入失败 ───────────────────────────────────── */
  c.section('11. manifest 写入失败 → 不删除');
  {
    const s = scene('s11a');
    process.env.QQ_RESET_TEST_FAIL_MANIFEST_AT = '1';
    const r = await D.resetData(args(s));
    delete process.env.QQ_RESET_TEST_FAIL_MANIFEST_AT;
    await c.check('初始 manifest 写失败：返回错误、data 完整', () => {
      if (r.ok || !String(r.error).includes('manifest 初始写入失败')) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(path.join(s.dataDir, 'learned.json'))) throw new Error('data 被删');
    });
    const s2 = scene('s11b');
    process.env.QQ_RESET_TEST_FAIL_MANIFEST_AT = '4';
    const r2 = await D.resetData(args(s2));
    delete process.env.QQ_RESET_TEST_FAIL_MANIFEST_AT;
    await c.check('备份完成后 manifest 写失败：不删除、status=failed', () => {
      if (r2.ok) throw new Error('不应成功');
      if (!fs.existsSync(path.join(s2.dataDir, 'learned.json'))) throw new Error('data 被删');
      const ops = D.listResetOps({ backupRoot: s2.backupRoot });
      if (!ops.length || ops[0].status !== 'failed') throw new Error(JSON.stringify(ops));
    });
  }

  /* ── 12. reset 锁被占用 ──────────────────────────────────────── */
  c.section('12. reset 锁被占用 → 拒绝');
  {
    const s = scene('s12');
    fs.mkdirSync(s.backupRoot, { recursive: true });
    fs.writeFileSync(path.join(s.backupRoot, '.reset.lock'), JSON.stringify({ pid: process.pid, token: 'x', startedAt: Date.now() }), 'utf8');
    const t0 = Date.now();
    const r = await D.resetData(args(s));
    const ms = Date.now() - t0;
    fs.rmSync(path.join(s.backupRoot, '.reset.lock'), { force: true });
    await c.check('等锁超时后拒绝、data 完整（约 3 秒）', () => {
      if (r.ok) throw new Error('不应成功');
      if (!String(r.error).includes('另一个重置')) throw new Error(r.error);
      if (!fs.existsSync(path.join(s.dataDir, 'learned.json'))) throw new Error('data 被删');
      if (ms < 2000) throw new Error(`超时太快：${ms}ms`);
    });
  }

  /* ── 13. 删除中途崩溃（删了第一个条目）──────────────────────── */
  c.section('13. 删除中途崩溃 → resume 续删');
  {
    const s = scene('s13');
    const code = await runCrashWorker(s, 'delete_first');
    const [op] = D.listResetOps({ backupRoot: s.backupRoot });
    const leftAfterCrash = fs.existsSync(s.dataDir)
      ? fs.readdirSync(s.dataDir).filter((n) => n !== 'qq-agent.lock')
      : [];
    await c.check('崩溃后 status=delete_in_progress、只删了部分', () => {
      if (code !== 97) throw new Error(`exit=${code}`);
      if (!op || op.status !== 'delete_in_progress') throw new Error(JSON.stringify(op));
      if (leftAfterCrash.length === 0 || leftAfterCrash.length >= 9) throw new Error(JSON.stringify(leftAfterCrash));
    });
    const rr = await D.resumeReset({ opId: op.opId, ...args(s) });
    await c.check('resume 续删完成且备份完整', () => {
      if (!rr.ok || rr.result !== 'ok') throw new Error(JSON.stringify(rr));
      const left = fs.readdirSync(s.dataDir);
      if (JSON.stringify(left) !== JSON.stringify(['qq-agent.lock'])) throw new Error(JSON.stringify(left));
    });
  }

  /* ── 14. 备份后并发写入 → 拒绝删除 ───────────────────────────── */
  c.section('14. 备份后并发写入 → 拒绝删除');
  {
    const s = scene('s14a');
    const r = await D.resetData({
      ...args(s),
      hooks: { afterDataBackup: async () => { fs.writeFileSync(path.join(s.dataDir, 'late-write.txt'), 'late', 'utf8'); } }
    });
    await c.check('检测到未备份新文件、status=failed、data 未删', () => {
      if (r.ok) throw new Error('不应成功');
      if (!fs.existsSync(path.join(s.dataDir, 'late-write.txt'))) throw new Error('新文件丢失');
      if (!fs.existsSync(path.join(s.dataDir, 'learned.json'))) throw new Error('原有文件被删');
      const m = s.manifest(r.opId);
      if (m.status !== 'failed' || !String(m.error).includes('删除前校验失败')) throw new Error(JSON.stringify({ status: m.status, error: m.error }));
    });
    const s2 = scene('s14b');
    const r2 = await D.resetData({
      ...args(s2),
      hooks: { afterDataBackup: async () => { fs.appendFileSync(path.join(s2.dataDir, 'learned.json'), 'x'); } }
    });
    await c.check('检测到文件被改、拒绝删除', () => {
      if (r2.ok) throw new Error('不应成功');
      if (!fs.existsSync(path.join(s2.dataDir, 'learned.json'))) throw new Error('被删');
    });
  }

  /* ── 15. 恢复能力 ────────────────────────────────────────────── */
  c.section('15. 从备份恢复：目标冲突/损坏/成功');
  {
    const s = scene('s15');
    const r = await D.resetData(args(s));
    await c.check('恢复 data：逐文件 hash 复原 + 审计', async () => {
      const rr = await D.restoreResetBackup({ opId: r.opId, ...args(s), scope: 'data' });
      if (!rr.ok) throw new Error(JSON.stringify(rr));
      if (rr.restored !== 9) throw new Error(`restored=${rr.restored}`);
      for (const [rel, hash] of Object.entries(s.original)) {
        const p = path.join(s.dataDir, ...rel.split('/'));
        if (!fs.existsSync(p) || sha(p) !== hash) throw new Error(`恢复不一致：${rel}`);
      }
      if (!fs.existsSync(path.join(s.backupRoot, 'restore-audit.jsonl'))) throw new Error('无审计');
    });
    await c.check('目标已有新数据 → 拒绝覆盖', async () => {
      const rr = await D.restoreResetBackup({ opId: r.opId, ...args(s), scope: 'data' });
      if (rr.ok || !String(rr.error).includes('已存在新数据')) throw new Error(JSON.stringify(rr));
    });
    await c.check('scope=all 因日记已存在而整体拒绝（不半恢复）', async () => {
      const rr = await D.restoreResetBackup({ opId: r.opId, ...args(s), scope: 'all' });
      if (rr.ok) throw new Error('不应成功');
    });
    const s2 = scene('s15b');
    const r2 = await D.resetData(args(s2));
    fs.appendFileSync(path.join(r2.backupDir, 'data', 'learned.json'), 'tamper');
    await c.check('备份 hash 错误 → 拒绝恢复', async () => {
      const rr = await D.restoreResetBackup({ opId: r2.opId, ...args(s2), scope: 'data' });
      if (rr.ok || !String(rr.error).includes('备份不完整')) throw new Error(JSON.stringify(rr));
    });
  }

  /* ── 16. CLI 参数解析（不执行生产路径） ──────────────────────── */
  c.section('16. 运维 CLI 参数');
  {
    const { parseArgs } = await import('../scripts/reset-data-ops.mjs');
    await c.check('未知参数 / 缺 confirm / 缺 opId 都被拒绝', () => {
      if (!parseArgs([]).error) throw new Error('空参数未拒绝');
      if (!parseArgs(['list', '--nope', 'x']).error) throw new Error('未知参数未拒绝');
      if (!parseArgs(['resume']).error) throw new Error('缺 opId 未拒绝');
      if (parseArgs(['resume', 'abc', '--confirm', 'abc']).error) throw new Error('合法参数被拒绝');
    });
    await c.check('list 能识别已完成的 manifest', () => {
      const s = scene('s9');
      return D.resetData(args(s)).then((r) => {
        const ops = D.listResetOps({ backupRoot: s.backupRoot });
        if (!ops.some((o) => o.opId === r.opId && o.result === 'ok' && !o.unfinished)) throw new Error(JSON.stringify(ops));
      });
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
