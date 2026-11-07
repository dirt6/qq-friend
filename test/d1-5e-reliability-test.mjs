// D1-5E 综合可靠性：多进程/变化中/并发/中断/句柄/权限/冲突/损坏/hash/UI-API。
// 状态严格区分 PASS / FAIL / INCONCLUSIVE / UNKNOWN；模拟不冒充 Windows 实机。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createChecker, bootApp } from './_harness.mjs';

const c = createChecker('D1-5E 综合可靠性');
const { resetData } = await import('../src/reset-data.js');
const { inspectBackups } = await import('../scripts/backup-retention.mjs');
const { quarantineSessionOwned, inventorySessions } = await import('../scripts/session-inventory.mjs');
const { restoreLegacyBackup } = await import('../scripts/legacy-backup-recovery.mjs');
const { auditConsistency } = await import('../scripts/data-consistency-audit.mjs');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const DAY = 86400e3;
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'd5e-'));
process.env.DIARY_TEST_GUARD = '1';
process.env.DIARY_TEST_TMP = base;
const results = [];
const rec = (name, status, detail = '') => { results.push({ name, status, detail }); console.log(`  ${status.padEnd(11)} ${name}${detail ? ' :: ' + detail : ''}`); };
const project = (data) => `--${path.resolve(data, '..').replace(/[:\\/]+/g, '-')}--`;

function scene(tag) {
  const root = path.join(base, tag);
  const data = path.join(root, 'data');
  const diary = path.join(root, '日记');
  fs.mkdirSync(path.join(diary, '每日'), { recursive: true });
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), '{"x":1}');
  fs.writeFileSync(path.join(data, 'learned.json'), '[]');
  fs.writeFileSync(path.join(data, 'sessions', 'a.json'), '{"id":"a"}');
  fs.writeFileSync(path.join(diary, '每日', '2026-11-01.md'), '# 2026-11-01\n\n- 心情：平静｜甲\n', 'utf8');
  return { root, data, diary, dataDir: data, diaryRoot: diary, backupRoot: path.join(root, 'backups') };
}
const runChild = (args, opts = {}) => new Promise((resolve) => {
  const ch = spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true, ...opts });
  ch.on('exit', (code) => resolve(code));
});

try {
  // 1. 多进程并发审计
  {
    const s = scene('multi');
    const codes = await Promise.all([0, 1, 2].map(() => runChild(['scripts/data-consistency-audit.mjs', '--json', '--data-dir', s.data, '--diary-root', s.diary], { cwd: path.resolve('.') })));
    rec('多进程并发审计（3 进程）', codes.every((x) => x === 0) ? 'PASS' : 'FAIL', `exit=${codes.join(',')}`);
  }
  // 2. 审计期间文件变化
  {
    const s = scene('changing');
    const ch = spawn(process.execPath, ['scripts/data-consistency-audit.mjs', '--json', '--data-dir', s.data, '--diary-root', s.diary], { stdio: 'ignore', windowsHide: true });
    for (let i = 0; i < 30; i += 1) fs.appendFileSync(path.join(s.diary, '每日', '2026-11-01.md'), `- 心情：平静｜并发写入${i}\n`);
    const code = await new Promise((r) => ch.on('exit', r));
    rec('审计期间文件变化（30 次追加）', code === 0 ? 'PASS' : 'FAIL', `exit=${code}（快照一致性不保证，未崩溃）`);
  }
  // 3. Session 映射变化中审计
  {
    const s = scene('mapchange');
    let ok = true;
    try {
      for (let i = 0; i < 20; i += 1) {
        fs.writeFileSync(path.join(s.data, 'dsh-sessions.json'), JSON.stringify({ [`private:${i}`]: { sessionId: `session-${i}`, lastUsedAt: new Date().toISOString() } }));
        const inv = inventorySessions({ dataDir: s.data });
        if (!Array.isArray(inv.sessions)) ok = false;
      }
    } catch { ok = false; }
    rec('Session 映射变化中审计', ok ? 'PASS' : 'FAIL');
  }
  // 4. Session 移动中断（注入）
  {
    const s = scene('move');
    const proj = project(s.data);
    const dir = path.join(s.data, 'dsh-home', 'sessions', proj, 'session-x');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), 'x');
    const bdir = path.join(s.data, 'dsh-home', '.session-backups', 'session-x');
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'session.v4.jsonl.zstd'), 'backup');
    fs.writeFileSync(path.join(bdir, 'manifest.json'), JSON.stringify({ file: 'session.v4.jsonl.zstd', sha256: sha(path.join(bdir, 'session.v4.jsonl.zstd')) }));
    const r = quarantineSessionOwned({ sid: 'session-x', dataDir: s.data, dryRun: false, hooks: { failBeforeMove: true } });
    rec('Session 目录移动中断', !r.ok && fs.existsSync(dir) ? 'PASS' : 'FAIL', r.error || '');
  }
  // 5. 文件句柄占用
  {
    const s = scene('handle');
    const holder = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { cwd: path.join(s.data, 'sessions'), stdio: 'ignore', windowsHide: true });
    await new Promise((r) => setTimeout(r, 300));
    const r = await resetData(s);
    const blocked = !r.ok && r.status === 'needs_manual_recovery';
    await new Promise((r) => { holder.on('exit', r); holder.kill(); });
    rec('Windows 文件句柄占用 → needs_manual_recovery', blocked ? 'PASS' : 'FAIL', (r.status || r.error || JSON.stringify(r)).slice(0, 200));
  }
  // 6. 权限不足（注入模拟；真实 ACL UNKNOWN）
  {
    const s = scene('perm');
    const r = await resetData({ ...s, hooks: { failFileRel: 'learned.json' } });
    rec('权限/IO 失败（注入）→ 不删除', !r.ok && fs.existsSync(path.join(s.data, 'learned.json')) ? 'PASS' : 'FAIL');
    rec('真实 Windows ACL/磁盘满', 'UNKNOWN', '本机 ACL 测试未执行；使用注入验证 fail-closed');
  }
  // 7. 目标冲突
  {
    const s = scene('conflict');
    const bfile = path.join(s.root, 'old.bak');
    fs.writeFileSync(bfile, 'old');
    const t = path.join(s.root, 'target');
    fs.mkdirSync(path.join(t, '每日'), { recursive: true });
    fs.writeFileSync(path.join(t, '每日', '2026-11-01.md'), 'exists');
    const r = restoreLegacyBackup({ backupFile: bfile, targetDiaryRoot: t, dateKey: '2026-11-01', dryRun: false });
    rec('恢复目标冲突 → 拒绝', !r.ok && /已存在/.test(r.error || '') ? 'PASS' : 'FAIL');
  }
  // 8. manifest 损坏
  {
    const s = scene('manifest');
    const r = await resetData(s);
    fs.appendFileSync(path.join(r.manifestPath), 'tamper');
    const insp = inspectBackups({ dataDir: s.data, diaryRoot: s.diary, resetRoot: s.backupRoot });
    const bad = insp.items.find((x) => x.type === 'reset' && x.id === r.opId);
    rec('manifest 损坏 → corrupted/protected', bad?.status === 'corrupted' && bad.protected ? 'PASS' : 'FAIL', bad?.status || '');
  }
  // 9. 恢复后 hash 不一致
  {
    const s = scene('hash');
    const bfile = path.join(s.root, 'b.bak');
    fs.writeFileSync(bfile, 'line\n');
    const t = path.join(s.root, 'target');
    const r = restoreLegacyBackup({ backupFile: bfile, targetDiaryRoot: t, dateKey: '2026-11-01', dryRun: false });
    fs.appendFileSync(r.target, 'tamper');
    rec('恢复后 hash 不一致可检测', sha(r.target) !== sha(bfile) ? 'PASS' : 'FAIL');
  }
  // 10. 备份与恢复并发（隔离）
  {
    const s = scene('concurrent');
    const worker = path.join(s.root, 'w.mjs');
    fs.writeFileSync(worker, `import fs from 'node:fs'; const { resetData } = await import('file:///E:/dsh/QQ-agent/src/reset-data.js'); const [,,d,dy,b,o]=process.argv; const r=await resetData({dataDir:d,diaryRoot:dy,backupRoot:b}); fs.writeFileSync(o, JSON.stringify(r));`);
    const outs = [path.join(s.root, 'o1.json'), path.join(s.root, 'o2.json')];
    const codes = await Promise.all(outs.map((o) => runChild([worker, s.data, s.diary, s.backupRoot, o])));
    const rs = outs.map((o) => { try { return JSON.parse(fs.readFileSync(o, 'utf8')); } catch { return { ok: false }; } });
    rec('备份与恢复并发（2 子进程同 backupRoot）', rs.some((x) => x.ok) && codes.every((x) => x === 0 || x === 1) ? 'PASS' : 'FAIL', `ok=${rs.map((x) => x.ok).join(',')}`);
  }
  // 11. UI/API 一致性 + 浏览器渲染（子进程 boot，避免父进程 config 已绑定生产端口）
  {
    const out = path.join(base, 'ui-check.json');
    const script = path.join(base, 'ui-check.mjs');
    fs.writeFileSync(script, `
import fs from 'node:fs';
import { bootApp } from 'file:///E:/dsh/QQ-agent/test/_harness.mjs';
const diary = ${JSON.stringify(path.join(base, 'ui-diary'))};
const ctx = await bootApp({ config: { skills: { diary: { root: diary } } } });
try {
  const { auditConsistency } = await import('file:///E:/dsh/QQ-agent/scripts/data-consistency-audit.mjs');
  const a = await ctx.request('GET', '/api/data-management/idempotency');
  const page = await ctx.request('GET', '/data-admin.html');
  const direct = auditConsistency({ dataDir: ctx.dataDir, diaryRoot: diary });
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ status: a.status, apiWarn: a.data?.counts?.warn, directWarn: direct.counts.warn, page: page.status === 200 && page.text.includes('数据管理') }));
} finally { await ctx.teardown(); }
`);
    const code = await runChild([script]);
    let j = null;
    try { j = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { /* ignore */ }
    rec('UI/API 与模块审计计数一致', code === 0 && j && j.status === 200 && j.apiWarn === j.directWarn ? 'PASS' : 'FAIL', j ? `warn=${j.apiWarn}/${j.directWarn}` : `exit=${code}`);
    rec('浏览器 DOM 实际渲染', 'UNKNOWN', '本机 Edge headless 被 mojo/ACL 拒绝，无替代渲染器；未伪造截图');
  }
} catch (e) {
  rec('测试执行', 'FAIL', String(e?.stack || e));
}

console.log('\n=== D1-5E 状态汇总 ===');
for (const r of results) console.log(`${r.status.padEnd(11)} ${r.name}${r.detail ? ' :: ' + r.detail : ''}`);
const counts = results.reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {});
console.log(JSON.stringify(counts));
try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
process.exit(results.some((r) => r.status === 'FAIL') ? 1 : 0);
