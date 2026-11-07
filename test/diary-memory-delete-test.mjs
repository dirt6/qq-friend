// D1-3b-B3 专项：MemoryStore removeMember/removeChat 备份、校验、路径安全。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

const c = createChecker('D1-3b B3 记忆删除');
const TMP = process.env.DIARY_TEST_TMP;
const DATA = process.env.QQ_AGENT_DATA_DIR;
const MEM = path.join(DATA, 'memory');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const hex = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

const reset = () => {
  try { fs.rmSync(MEM, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.mkdirSync(MEM, { recursive: true });
};
const write = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj), 'utf8'); };

try {
  const memory = await import('../src/memory.js');
  const api = new memory.MemoryStore();

  const chat = 'group_123';
  const dir = path.join(MEM, chat);

  c.section('1. removeMember 正常：备份 + 校验 + 删除');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111', name: '甲', impressions: [{ content: 'a', createdAt: 1 }] });
    write(path.join(dir, '222.json'), { userId: '222', name: '乙', impressions: [] });
    const r = await api.removeMember(chat, '111');
    await c.check('返回 ok、备份、文件数', () => {
      if (!r.ok || !r.backupDir || r.files !== 1 || !r.verified) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(r.backupDir)) throw new Error('备份目录不存在');
    });
    await c.check('源文件已删、备份内容一致', () => {
      if (fs.existsSync(path.join(dir, '111.json'))) throw new Error('源文件还在');
      const bf = path.join(r.backupDir, '111.json');
      if (sha(bf) !== hex(bf)) throw new Error('备份 hash 异常');
      if (JSON.parse(fs.readFileSync(bf, 'utf8')).userId !== '111') throw new Error('备份内容不对');
    });
    await c.check('其他成员不受影响', () => {
      if (!fs.existsSync(path.join(dir, '222.json'))) throw new Error('222 被误删');
    });
  }

  c.section('2. removeChat 正常：备份全部文件 + 删除');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111', impressions: [] });
    write(path.join(dir, '_meta.json'), { lastConsolidatedAt: 1 });
    write(path.join(MEM, `${chat}.json`), { legacy: true });
    const r = await api.removeChat(chat);
    await c.check('返回 ok、备份 3 个文件（含旧版）', () => {
      if (!r.ok || r.files !== 3) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(r.backupDir)) throw new Error('备份目录不存在');
      if (!fs.existsSync(path.join(r.backupDir, '_legacy.json'))) throw new Error('旧版未备份');
    });
    await c.check('目录已空、旧版已删', () => {
      const left = fs.readdirSync(dir);
      if (left.length !== 0) throw new Error(JSON.stringify(left));
      if (fs.existsSync(path.join(MEM, `${chat}.json`))) throw new Error('旧版还在');
    });
  }

  c.section('3. 备份失败 → 拒绝删除');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111' });
    fs.rmSync(path.join(MEM, 'backups'), { recursive: true, force: true });
    fs.writeFileSync(path.join(MEM, 'backups'), 'not-a-dir', 'utf8');   // 备份根是文件 → mkdir 失败
    const r = await api.removeMember(chat, '111');
    await c.check('ok:false、源文件仍在', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(path.join(dir, '111.json'))) throw new Error('备份失败却删除了文件');
    });
    fs.rmSync(path.join(MEM, 'backups'), { force: true });
  }

  c.section('4. 删除失败 → 备份保留、返回可定位错误');
  {
    reset();
    const f = path.join(dir, '111.json');
    write(f, { userId: '111' });
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = () => { const e = new Error('mock unlink fail'); e.code = 'EPERM'; throw e; };
    let r;
    try { r = await api.removeMember(chat, '111'); } finally { fs.unlinkSync = originalUnlink; }
    await c.check('ok:false、backupDir 存在、源文件仍在', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      if (!r.backupDir || !fs.existsSync(r.backupDir)) throw new Error('备份丢失');
      if (!fs.existsSync(f)) throw new Error('源文件被删');
    });
  }

  c.section('5. 恢复：原目标已存在 → 拒绝；正常恢复');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111', name: '可恢复' });
    const r = await api.removeMember(chat, '111');
    const again = await api.removeMember(chat, '111');
    await c.check('第二次删除 not found', () => { if (again.ok) throw new Error(JSON.stringify(again)); });
    const before = memory.restoreMemoryBackup(r.backupDir);
    await c.check('原目标不存在时可恢复', () => {
      if (!before.ok) throw new Error(JSON.stringify(before));
      if (!fs.existsSync(path.join(dir, '111.json'))) throw new Error('未恢复');
    });
    const againRestore = memory.restoreMemoryBackup(r.backupDir);
    await c.check('原目标已存在 → 拒绝覆盖', () => { if (againRestore.ok) throw new Error(JSON.stringify(againRestore)); });
  }

  c.section('6. 备份损坏 → 恢复拒绝');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111' });
    const r = await api.removeMember(chat, '111');
    fs.writeFileSync(path.join(r.backupDir, '111.json'), '{"tampered":true}', 'utf8');
    const res = memory.restoreMemoryBackup(r.backupDir);
    await c.check('hash 不一致 → 拒绝恢复', () => { if (res.ok) throw new Error(JSON.stringify(res)); });
  }

  c.section('7. 未识别文件 → 拒绝删除');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111' });
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x', 'utf8');
    const r = await api.removeChat(chat);
    await c.check('ok:false、文件全保留', () => {
      if (r.ok) throw new Error(JSON.stringify(r));
      if (!fs.existsSync(path.join(dir, 'notes.txt')) || !fs.existsSync(path.join(dir, '111.json'))) throw new Error('文件被删');
    });
  }

  c.section('8. 空/非法参数与路径穿越');
  {
    reset();
    await c.check('空 chatKey/空 userId 拒绝', async () => {
      const a = await api.removeMember('', '');
      if (a.ok) throw new Error(JSON.stringify(a));
      fs.mkdirSync(dir, { recursive: true });
      write(path.join(dir, '111.json'), { userId: '111' });
      const b = await api.removeChat('..');
      if (b.ok) throw new Error(JSON.stringify(b));
    });
  }

  c.section('9. 符号链接越界 → 拒绝');
  {
    reset();
    const outside = path.join(TMP, 'outside-memory');
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'x.json'), '{}', 'utf8');
    const link = path.join(MEM, 'group_link');
    let linked = false;
    try { fs.symlinkSync(outside, link, 'junction'); linked = true; } catch { /* 权限不足 */ }
    if (linked) {
      await c.check('junction 指向根外 → 拒绝', async () => {
        const r = await api.removeChat('group_link');
        if (r.ok) throw new Error(JSON.stringify(r));
        if (!fs.existsSync(path.join(outside, 'x.json'))) throw new Error('外部文件被删');
      });
      // Windows junction 的 lstat 不是符号链接：unlink 会 EPERM，必须 rmdir（只删链接本身）。
      try { fs.rmdirSync(link); } catch { try { fs.unlinkSync(link); } catch { /* ignore */ } }
    } else {
      console.log('  INCONCLUSIVE junction 创建失败（权限不足）');
    }
    fs.rmSync(outside, { recursive: true, force: true });
  }

  c.section('10. 审计记录与备份唯一性');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111' });
    const r1 = await api.removeMember(chat, '111');
    write(path.join(dir, '111.json'), { userId: '111' });
    const r2 = await api.removeMember(chat, '111');
    await c.check('两次删除产生两个不同备份目录', () => {
      if (r1.backupDir === r2.backupDir) throw new Error('备份目录冲突');
      if (!fs.existsSync(r1.backupDir) || !fs.existsSync(r2.backupDir)) throw new Error('备份缺失');
    });
    await c.check('audit.jsonl 有记录', () => {
      const audit = path.join(MEM, 'backups', 'audit.jsonl');
      if (!fs.existsSync(audit)) throw new Error('无审计');
      const lines = fs.readFileSync(audit, 'utf8').trim().split('\n');
      if (!lines.some((l) => l.includes(r1.opId))) throw new Error('缺 opId');
    });
  }

  c.section('11. 并发删除：不覆盖、不重复成功');
  {
    reset();
    write(path.join(dir, '111.json'), { userId: '111' });
    const worker = path.join(TMP, 'mem-del-worker.mjs');
    fs.writeFileSync(worker, `
      import fs from 'node:fs';
      const [,, dataDir, chatKey, userId] = process.argv;
      process.env.QQ_AGENT_DATA_DIR = dataDir;
      const mod = await import('file:///E:/dsh/QQ-agent/src/memory.js');
      const M = mod.default && typeof mod.default.removeMember === 'function' ? new mod.default() : new mod.MemoryStore();
      const r = await M.removeMember(chatKey, userId);
      fs.writeFileSync(process.env.DIARY_TEST_TMP + '/mem-del-result-' + process.pid + '.json', JSON.stringify(r));
    `, 'utf8');
    const run = () => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, DATA, chat, '111'], { stdio: 'ignore', windowsHide: true, env: { ...process.env } });
      child.on('exit', resolve);
    });
    await Promise.all([run(), run()]);
    await c.check('只有一个成功、备份不覆盖、源文件删除', () => {
      const results = fs.readdirSync(TMP).filter((f) => f.startsWith('mem-del-result-')).map((f) => JSON.parse(fs.readFileSync(path.join(TMP, f), 'utf8')));
      if (results.filter((r) => r.ok).length !== 1) throw new Error(JSON.stringify(results));
      if (fs.existsSync(path.join(dir, '111.json'))) throw new Error('源文件还在');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
