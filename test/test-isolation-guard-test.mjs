// 4.0 P2：测试隔离防护（10 项）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';
import {
  createIsolationRoot, isolationEnv, assertTestEnv, assertIsolatedPaths,
  isProductionPath, cleanupIsolation, PROD_DATA_DIR, PROD_DIARY_ROOT
} from './_isolation.mjs';

const c = createChecker('4.0 测试隔离防护');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const PROD_FILES = ['data/learned.json', 'data/diary-meta/pending.json', 'data/diary-idempotency.json', 'data/dsh-sessions.json'];
const prodBefore = Object.fromEntries(PROD_FILES.map((f) => [f, sha(f)]));
const roots = [];
const runProbe = (env, mode) => new Promise((resolve) => {
  const out = path.join(os.tmpdir(), `probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
  const ch = spawn(process.execPath, ['test/_isolation-probe.mjs'], {
    cwd: path.resolve('.'), stdio: 'ignore', windowsHide: true,
    env: { ...env, PROBE_MODE: mode, PROBE_OUT: out }
  });
  ch.on('exit', (code) => {
    let j = null; try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignore */ }
    try { fs.unlinkSync(out); } catch { /* ignore */ }
    resolve({ code, json: j });
  });
});

try {
  c.section('1. 环境缺失拒绝');
  {
    const env = { ...process.env }; delete env.QQ_AGENT_TEST_ISOLATION; delete env.QQ_AGENT_TEST_ROOT; delete env.QQ_AGENT_DATA_DIR; delete env.QQ_AGENT_DIARY_ROOT;
    const r = await runProbe(env, 'noenv');
    await c.check('缺少隔离环境变量时拒绝启动', () => assert.equal(r.json?.refused, true));
    const direct = await runProbe(env, 'check');
    await c.check('子进程无隔离 env → 退出非 0', () => assert.notEqual(direct.code, 0));
  }

  c.section('2. 生产路径拒绝');
  {
    const iso = createIsolationRoot('qqa-p2-'); roots.push(iso.root);
    const env = isolationEnv(iso);
    const a = await runProbe(env, 'prod-data');
    await c.check('DATA_DIR 指向生产 → 拒绝', () => assert.equal(a.json?.refused, true));
    const b = await runProbe(env, 'prod-diary');
    await c.check('DIARY_ROOT 指向生产 → 拒绝', () => assert.equal(b.json?.refused, true));
    await c.check('路径越界（prod/../data）仍拒绝', () => {
      assert.equal(isProductionPath(path.join(PROD_DATA_DIR, '..', 'data')), true);
      assert.throws(() => assertIsolatedPaths({ dataDir: path.join(PROD_DATA_DIR, '..', 'data'), diaryRoot: iso.diaryRoot }));
    });
  }

  c.section('3. 模块导入前后一致性');
  {
    const iso = createIsolationRoot('qqa-p2-mod-'); roots.push(iso.root);
    const env = isolationEnv(iso);
    const r = await runProbe(env, 'check');
    await c.check('隔离 env 下 config.DATA_DIR 与 env 一致', () => {
      assert.equal(r.code, 0, JSON.stringify(r.json));
      assert.equal(path.resolve(r.json.dataDirFromModule), path.resolve(iso.dataDir));
      assert.equal(fs.existsSync(r.json.marker), true);
    });
  }

  c.section('4. 并发测试互不污染');
  {
    const a = createIsolationRoot('qqa-p2-a-'); const b = createIsolationRoot('qqa-p2-b-'); roots.push(a.root, b.root);
    const [ra, rb] = await Promise.all([runProbe(isolationEnv(a), 'check'), runProbe(isolationEnv(b), 'check')]);
    await c.check('两个隔离根并发写入互不污染', () => {
      assert.equal(ra.code, 0); assert.equal(rb.code, 0);
      assert.notEqual(path.resolve(ra.json.dataDir), path.resolve(rb.json.dataDir));
      assert.ok(fs.existsSync(ra.json.marker)); assert.ok(fs.existsSync(rb.json.marker));
      assert.equal(fs.existsSync(path.join(a.dataDir, path.basename(ra.json.marker))), true);
    });
  }

  c.section('5. 清理与异常');
  {
    const iso = createIsolationRoot('qqa-p2-clean-'); roots.push(iso.root);
    await c.check('异常路径仍执行清理', () => {
      const x = createIsolationRoot('qqa-p2-ex-'); roots.push(x.root);
      try { throw new Error('boom'); } catch { /* expected */ } finally { assert.equal(cleanupIsolation(x.root).ok, true); }
      assert.equal(fs.existsSync(x.root), false);
    });
    await c.check('清理失败明确报告（缺少 root）', () => {
      const r = cleanupIsolation('');
      assert.equal(r.ok, false);
      assert.ok(r.error);
    });
    await c.check('未设置隔离 env 时 assertTestEnv 抛错', () => {
      const old = process.env.QQ_AGENT_TEST_ISOLATION;
      delete process.env.QQ_AGENT_TEST_ISOLATION;
      try { assert.throws(() => assertTestEnv()); } finally { if (old !== undefined) process.env.QQ_AGENT_TEST_ISOLATION = old; }
    });
  }

  c.section('6. 生产 hash');
  {
    await c.check('探测前后生产关键文件 hash 不变', () => {
      for (const f of PROD_FILES) assert.equal(sha(f), prodBefore[f], f);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  for (const r of roots) { try { cleanupIsolation(r); } catch { /* ignore */ } }
}

process.exit(c.finish() ? 0 : 1);
