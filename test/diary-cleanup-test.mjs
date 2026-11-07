// D1-3b B2 专项：autonomous.delete 领域入口、sessions.clearFinished 备份与终态确认。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-3b B2 清理入口');
const TMP = process.env.DIARY_TEST_TMP;
const DATA = process.env.QQ_AGENT_DATA_DIR;
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };

const reset = () => {
  for (const n of ['autonomous.json', 'sessions', 'backups']) {
    try { fs.rmSync(path.join(DATA, n), { recursive: true, force: true }); } catch { /* ignore */ }
  }
};

try {
  const state = await import('../plugins/autonomous/lib/state.js');
  const { SessionRegistry } = await import('../src/sessions.js');

  c.section('1. autonomous.delete 走领域入口：锁内读改写、原子写');
  {
    reset();
    const file = path.join(DATA, 'autonomous.json');
    fs.writeFileSync(file, JSON.stringify({ history: [{ roundId: 'r1', x: 1 }, { roundId: 'r2', x: 2 }], seen: {} }), 'utf8');
    const r = state.deleteHistoryRound(file, 'r1');
    await c.check('删除成功且其他记录保留', () => {
      if (!r.ok || r.removed !== 1) throw new Error(JSON.stringify(r));
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j.history.length !== 1 || j.history[0].roundId !== 'r2') throw new Error(JSON.stringify(j.history));
    });
    await c.check('删除不存在 → ok:false', () => {
      const r2 = state.deleteHistoryRound(file, 'nope');
      if (r2.ok) throw new Error(JSON.stringify(r2));
    });
    // 原子写失败：目标只读 → 抛错、旧文件 hash 不变
    const before = sha(file);
    try { fs.chmodSync(file, 0o444); } catch { /* ignore */ }
    let threw = false;
    try { state.deleteHistoryRound(file, 'r2'); } catch { threw = true; }
    try { fs.chmodSync(file, 0o666); } catch { /* ignore */ }
    await c.check('原子写失败 → 抛错、旧文件不变', () => {
      if (!threw) throw new Error('没有抛错');
      if (sha(file) !== before) throw new Error('文件被改');
    });
  }

  c.section('2. 并发新增与删除不丢更新（两个独立进程）');
  {
    reset();
    const file = path.join(DATA, 'autonomous.json');
    fs.writeFileSync(file, JSON.stringify({ history: [{ roundId: 'keep', x: 1 }], seen: {} }), 'utf8');
    const worker = path.join(TMP, 'cleanup-worker.mjs');
    fs.writeFileSync(worker, `
      import fs from 'node:fs';
      const [,, file, mode, roundId] = process.argv;
      const S = await import('file:///E:/dsh/QQ-agent/plugins/autonomous/lib/state.js');
      if (mode === 'add') {
        S.mutateState(file, (st) => { st.history = Array.isArray(st.history) ? st.history : []; st.history.push({ roundId }); });
      } else {
        S.deleteHistoryRound(file, roundId);
      }
    `, 'utf8');
    const run = (mode, id) => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, file, mode, id], { stdio: 'ignore', windowsHide: true, env: { ...process.env } });
      child.on('exit', resolve);
    });
    await Promise.all([run('add', 'add1'), run('delete', 'keep')]);
    await c.check('保留新增、删除生效、无丢更新', () => {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      const ids = j.history.map((h) => h.roundId).sort();
      if (!ids.includes('add1') || ids.includes('keep')) throw new Error(JSON.stringify(ids));
    });
  }

  c.section('3. sessions.clearFinished：备份 + 终态确认');
  {
    reset();
    const dir = path.join(DATA, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    const files = {
      'done.json': { id: 'done', status: 'done' },
      'error.json': { id: 'error', status: 'error' },
      'aborted.json': { id: 'aborted', status: 'aborted' },
      'running.json': { id: 'running', status: 'running' },
      'waiting.json': { id: 'waiting', status: 'waiting' },
      'weird.json': { id: 'weird', status: 'unknown-state' }
    };
    for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(data), 'utf8');
    const reg = new SessionRegistry();
    // 构造 Registry 时的僵尸扫描可能把 running/waiting 标成 aborted；测试前重写为预期状态
    for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify(data), 'utf8');
    const origin = {};
    for (const f of Object.keys(files)) origin[f] = sha(path.join(dir, f));
    const r = reg.clearFinished();
    await c.check('返回 ok、removed=3、kept=3', () => {
      if (!r.ok || r.removed !== 3 || r.kept !== 3) throw new Error(JSON.stringify(r));
    });
    await c.check('终态文件删除、运行/等待/未知保留', () => {
      const left = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
      if (JSON.stringify(left) !== JSON.stringify(['running.json', 'waiting.json', 'weird.json'])) throw new Error(JSON.stringify(left));
    });
    await c.check('备份目录存在且 hash 与源一致', () => {
      if (!r.backupDir || !fs.existsSync(r.backupDir)) throw new Error('无备份');
      for (const f of Object.keys(files)) {
        if (sha(path.join(r.backupDir, f)) !== origin[f]) throw new Error(`备份不一致：${f}`);
      }
    });
  }

  c.section('4. 备份失败 → 拒绝删除');
  {
    reset();
    const dir = path.join(DATA, 'sessions');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'done.json'), JSON.stringify({ id: 'done', status: 'done' }), 'utf8');
    fs.mkdirSync(path.join(dir, 'bad.json'));   // 目录冒充文件 → 备份 copyFileSync 失败
    const reg = new SessionRegistry();
    const r = reg.clearFinished();
    await c.check('返回 ok:false、终态文件仍在', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(path.join(dir, 'done.json'))) throw new Error('备份失败却删除了文件');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
