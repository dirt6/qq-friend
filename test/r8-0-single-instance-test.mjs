// R8-0-A2 专项：3210（+PROFILE 偏移）独占守门 + PROFILE 稳定映射。
//
// 不占用生产 3210：测试用随机空闲端口。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker, freePort } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const c = createChecker('R8-0-A2 单实例守门');

const { listenExclusive } = await import('../src/net-listen.js');

const mkServer = () => http.createServer((req, res) => res.end('ok'));
const closeServer = (s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } });

try {
  c.section('1. 独占监听：第一个成功，第二个 EADDRINUSE');
  {
    const port = await freePort();
    const s1 = mkServer();
    const got = await listenExclusive(s1, port);
    await c.check('第一个实例绑定成功', () => {
      if (got !== port) throw new Error(`${got} != ${port}`);
    });
    const s2 = mkServer();
    let code = '';
    try { await listenExclusive(s2, port); } catch (e) { code = e.code; }
    await c.check('第二个实例被 OS 拒绝（EADDRINUSE）', () => {
      if (code !== 'EADDRINUSE') throw new Error(`code=${code}`);
    });
    await closeServer(s1);
    await closeServer(s2);

    const s3 = mkServer();
    await c.check('第一个退出后新实例可以绑定', async () => {
      const p = await listenExclusive(s3, port);
      if (p !== port) throw new Error(String(p));
    });
    await closeServer(s3);
  }

  c.section('2. 并发启动两个实例：只有一个成功');
  {
    const port = await freePort();
    const a = mkServer();
    const b = mkServer();
    const results = await Promise.allSettled([
      listenExclusive(a, port),
      listenExclusive(b, port)
    ]);
    const okCount = results.filter((r) => r.status === 'fulfilled').length;
    await c.check('恰好一个成功、一个 EADDRINUSE', () => {
      if (okCount !== 1) throw new Error(JSON.stringify(results.map((r) => r.status)));
      const rejected = results.find((r) => r.status === 'rejected');
      if (rejected?.reason?.code !== 'EADDRINUSE') throw new Error(String(rejected?.reason?.code));
    });
    await closeServer(a);
    await closeServer(b);
  }

  c.section('3. 端口被无关服务占用 → 一样 fail-closed');
  {
    const port = await freePort();
    const unrelated = mkServer();
    await new Promise((r) => unrelated.listen(port, '127.0.0.1', r));
    const app = mkServer();
    let code = '';
    try { await listenExclusive(app, port); } catch (e) { code = e.code; }
    await c.check('不假定占用者是 QQ-agent，直接拒绝', () => {
      if (code !== 'EADDRINUSE') throw new Error(`code=${code}`);
    });
    await closeServer(app);
    await closeServer(unrelated);
  }

  c.section('4. 源码约束：单向绑、不順延、先 listen 后 acquire');
  {
    const appSrc = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/app.js'), 'utf8');
    const cfgSrc = (await import('node:fs')).readFileSync(path.join(ROOT, 'src/config.js'), 'utf8');
    await c.check('没有 basePort + 10 / 端口顺延', () => {
      if (/basePort\s*\+\s*10/.test(appSrc) || /for\s*\(let p = basePort/.test(appSrc)) throw new Error('仍有顺延');
    });
    await c.check('EADDRINUSE → INSTANCE_ALREADY_RUNNING', () => {
      if (!appSrc.includes('INSTANCE_ALREADY_RUNNING')) throw new Error('缺标记');
    });
    await c.check('listen 在 acquireInstanceLock 之前', () => {
      const listenIdx = appSrc.indexOf('await listenExclusive(');
      const acquireIdx = appSrc.indexOf('const lockResult = acquireInstanceLock()');
      if (listenIdx < 0 || acquireIdx < 0 || listenIdx > acquireIdx) throw new Error(`${listenIdx} vs ${acquireIdx}`);
    });
    await c.check('config 不再读 QQ_AGENT_PORT', () => {
      if (cfgSrc.includes('process.env.QQ_AGENT_PORT')) throw new Error('仍读 env 端口');
    });
    await c.check('端口 = 3210 + portOffset()', () => {
      if (!/port:\s*3210\s*\+\s*portOffset\(\)/.test(cfgSrc)) throw new Error('公式不符');
    });
  }

  c.section('5. PROFILE 稳定映射：data / data-2 与 3210 / 3310');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r80-profile-'));
    const run = (profile) => new Promise((resolve) => {
      const outFile = path.join(tmp, `out-${profile || 'base'}.json`);
      const fd = fs.openSync(outFile, 'w');
      const code = `
const c = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)});
process.stdout.write(JSON.stringify({ dataDir: c.DATA_DIR, port: c.DEFAULT_CONFIG.server.port }));`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: ROOT,
        env: { ...process.env, QQ_AGENT_PROFILE: profile, QQ_AGENT_DATA_DIR: '' },
        stdio: ['ignore', fd, 'ignore'], windowsHide: true
      });
      child.on('exit', () => {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        resolve(fs.readFileSync(outFile, 'utf8'));
      });
    });
    try {
      const base = JSON.parse(await run(''));
      const second = JSON.parse(await run('2'));
      await c.check('默认 PROFILE → data / 3210', () => {
        if (path.basename(base.dataDir) !== 'data') throw new Error(base.dataDir);
        if (base.port !== 3210) throw new Error(String(base.port));
      });
      await c.check('PROFILE=2 → data-2 / 3310', () => {
        if (path.basename(second.dataDir) !== 'data-2') throw new Error(second.dataDir);
        if (second.port !== 3310) throw new Error(String(second.port));
      });
      await c.check('两个 PROFILE 数据目录不同', () => {
        if (base.dataDir === second.dataDir) throw new Error('相同');
      });
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
