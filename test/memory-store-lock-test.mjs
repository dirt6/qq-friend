// D1-1B-2c 专项：MemoryStore 完整事务锁集成验证。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'memory-store-lock-worker.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'memstore-lock-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const c = createChecker('D1-1B-2c MemoryStore 锁集成');
const { MemoryStore } = await import('../src/memory.js');
const { withMemoryPortLock, memoryPortFor } = await import('../src/memory-port-lock.js');

const chatDirName = (k) => String(k).replace(/[^a-z0-9_]/gi, '_');
const chatDirPath = (k) => path.join(tmp, 'memory', chatDirName(k));
const store = new MemoryStore();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const runWorker = ({ chatKey, userId, iters, suicide = false }) => new Promise((resolve) => {
  const out = path.join(tmp, `w-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const args = [WORKER, tmp, chatKey, userId, String(iters), out];
  if (suicide) args.push('suicide');
  const child = spawn(process.execPath, args, { stdio: ['ignore', fd, 'ignore'], windowsHide: true });
  child.on('exit', () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { resolve({ ok: 0, failed: 0, errors: ['no-output'] }); }
  });
});

const count = (chatKey, userId) => {
  const m = store.getMember(chatKey, userId);
  return (m.impressions || []).length;
};

const tryBind = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', (e) => resolve({ ok: false, code: e.code }));
  s.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve({ ok: true, server: s }));
});
const closeServer = (s) => new Promise((r) => { try { s.close(() => r()); } catch { r(); } });

try {
  c.section('1. 双进程各 50 次 append → 100 条（独立 Node 进程）');
  {
    const chatKey = 'group:9001';
    const [a, b] = await Promise.all([
      runWorker({ chatKey, userId: '1001', iters: 50 }),
      runWorker({ chatKey, userId: '1001', iters: 50 })
    ]);
    await c.check('最终 100 条、无失败', () => {
      if (a.failed || b.failed) throw new Error(JSON.stringify({ a, b }));
      if (count(chatKey, '1001') !== 100) throw new Error(String(count(chatKey, '1001')));
    });
  }

  c.section('2. 同进程并发 append');
  {
    const chatKey = 'group:9002';
    await Promise.all(Array.from({ length: 20 }, (_, i) =>
      store.append(chatKey, 'memberImpression', `进程内-${i}`, { userId: '2001', target: 'T' })));
    await c.check('20 条全部写入', () => {
      if (count(chatKey, '2001') !== 20) throw new Error(String(count(chatKey, '2001')));
    });
  }

  c.section('3. 聊天与自主模拟：不同会话并发');
  {
    const [a, b] = await Promise.all([
      runWorker({ chatKey: 'group:9003', userId: '3001', iters: 10 }),
      runWorker({ chatKey: 'private:9003', userId: '3002', iters: 10 })
    ]);
    await c.check('各 10 条、互不干扰', () => {
      if (a.ok !== 10 || b.ok !== 10) throw new Error(JSON.stringify({ a, b }));
      if (count('group:9003', '3001') !== 10) throw new Error('group 计数不对');
      if (count('private:9003', '3002') !== 10) throw new Error('private 计数不对');
    });
  }

  c.section('4. 不同会话并行（不互相阻塞）');
  {
    const t0 = Date.now();
    await Promise.all([
      withMemoryPortLock(chatDirPath('group:9010'), () => sleep(250)),
      withMemoryPortLock(chatDirPath('group:9011'), () => sleep(250))
    ]);
    const ms = Date.now() - t0;
    await c.check('耗时 < 450ms', () => {
      if (ms >= 450) throw new Error(`${ms}ms`);
    });
  }

  c.section('5. 端口碰撞：安全串行');
  {
    const seen = new Map();
    let pair = null;
    for (let i = 0; i < 20000 && !pair; i++) {
      const p = memoryPortFor(chatDirPath(`group:col${i}`));
      if (seen.has(p)) pair = [seen.get(p), `group:col${i}`];
      else seen.set(p, `group:col${i}`);
    }
    const t0 = Date.now();
    await Promise.all([
      withMemoryPortLock(chatDirPath(pair[0]), () => sleep(250)),
      withMemoryPortLock(chatDirPath(pair[1]), () => sleep(250))
    ]);
    const ms = Date.now() - t0;
    await c.check('同端口串行（≥450ms）', () => {
      if (ms < 450) throw new Error(`${ms}ms`);
    });
  }

  c.section('6. 端口被无关进程占用 → 拒绝写入');
  {
    const chatKey = 'group:9020';
    const port = memoryPortFor(chatDirPath(chatKey));
    const occ = await tryBind(port);
    await c.check('append 抛错且不写入', async () => {
      let code = '';
      try {
        await store.append(chatKey, 'memberImpression', '不该写入', { userId: '4001', target: 'T' });
      } catch (e) { code = e.code; }
      if (code !== 'EMEMORY_LOCK_TIMEOUT') throw new Error(`code=${code}`);
      if (count(chatKey, '4001') !== 0) throw new Error('被写入了');
    });
    if (occ.server) await closeServer(occ.server);
  }

  c.section('7. 正常释放后立即再获取');
  {
    const chatKey = 'group:9021';
    await store.append(chatKey, 'memberImpression', '第一条', { userId: '4002', target: 'T' });
    await store.append(chatKey, 'memberImpression', '第二条', { userId: '4002', target: 'T' });
    await c.check('连续两次都成功', () => {
      if (count(chatKey, '4002') !== 2) throw new Error(String(count(chatKey, '4002')));
    });
  }

  c.section('8. 进程写后 SIGKILL → 恢复');
  {
    const chatKey = 'group:9022';
    await runWorker({ chatKey, userId: '4003', iters: 1, suicide: true });
    await sleep(100);
    const r = await runWorker({ chatKey, userId: '4003', iters: 3 });
    await c.check('恢复后继续写入成功', () => {
      if (r.ok !== 3) throw new Error(JSON.stringify(r));
      if (count(chatKey, '4003') !== 4) throw new Error(String(count(chatKey, '4003')));
    });
  }

  c.section('9. 原子写入失败：旧文件不损坏');
  {
    const chatKey = 'group:9023';
    await store.append(chatKey, 'memberImpression', '旧内容', { userId: '4004', target: 'T' });
    const file = path.join(chatDirPath(chatKey), '4004.json');
    const before = fs.readFileSync(file, 'utf8');
    try { fs.chmodSync(file, 0o444); } catch { /* ignore */ }
    let threw = false;
    try {
      await store.append(chatKey, 'memberImpression', '新内容', { userId: '4004', target: 'T' });
    } catch { threw = true; }
    try { fs.chmodSync(file, 0o666); } catch { /* ignore */ }
    await c.check('写失败抛错、旧文件字节不变', () => {
      if (!threw) throw new Error('没有抛错');
      if (fs.readFileSync(file, 'utf8') !== before) throw new Error('旧文件被破坏');
    });
  }

  c.section('10. 历史 JSON 格式兼容');
  {
    const chatKey = 'group:9024';
    const dir = chatDirPath(chatKey);
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      userId: '5001', name: '老格式', updatedAt: 1700000000000,
      impressions: [{ content: '旧印象', createdAt: 1700000000000, contentType: 'preference' }]
    };
    fs.writeFileSync(path.join(dir, '5001.json'), JSON.stringify(legacy), 'utf8');
    await store.append(chatKey, 'memberImpression', '新印象', { userId: '5001', target: '老格式' });
    await c.check('旧条目保留 + 新条目加入', () => {
      const m = store.getMember(chatKey, '5001');
      const texts = m.impressions.map((x) => x.content);
      if (!texts.includes('旧印象') || !texts.includes('新印象')) throw new Error(JSON.stringify(texts));
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '5001.json'), 'utf8'));
      if (raw.userId !== '5001' || raw.name !== '老格式') throw new Error('旧字段丢了');
    });
  }

  c.section('11. 静态：源码写调用都带 await');
  {
    const fsx = await import('node:fs');
    for (const f of ['src/tools.js', 'src/routes.js', 'src/orchestrator.js']) {
      const src = fsx.readFileSync(path.join('E:/dsh/QQ-agent', f), 'utf8');
      const bad = [];
      for (const line of src.split('\n')) {
        if (/\.(append|remove|editMemberImpression|replaceMember|removeMember|removeChat|clear|markConsolidated|replaceConsolidated)\(/.test(line)
          && /memory|ctx\.memory/.test(line)
          && !line.includes('await')
          && !line.trim().startsWith('//')) {
          bad.push(line.trim());
        }
      }
      await c.check(`${f} 无未 await 的写调用`, () => {
        if (bad.length) throw new Error(bad.slice(0, 2).join(' | '));
      });
    }
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
