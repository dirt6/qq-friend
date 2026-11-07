// 受控删除指定的 diary 幂等键（仅用于已授权的测试残留清理）。
// 默认 dry-run；--apply 需 --confirm <key1,key2>。
// 安全：只允许删除显式列出的键；备份原文件；写前重新校验 hash；失败回滚；写审计。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA = path.resolve(process.env.QQ_AGENT_DATA_DIR || 'data');
const IDEM = path.join(DATA, 'diary-idempotency.json');
const DIARY = path.resolve(process.env.QQ_AGENT_DIARY_ROOT || 'E:/dsh/本子/日记');
const BODY = path.join(DIARY, '每日', '2026-10-20.md');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const nowIso = () => new Date().toISOString();

function parseArgs(argv) {
  const a = { apply: false, confirm: '', dryRun: true };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--apply') { a.apply = true; a.dryRun = false; }
    else if (argv[i] === '--confirm') { a.confirm = argv[++i] || ''; }
    else throw new Error(`未知参数 ${argv[i]}`);
  }
  return a;
}

function validate(table, keys) {
  const errors = [];
  for (const k of keys) {
    const v = table.keys?.[k];
    if (!v) { errors.push(`缺少键：${k}`); continue; }
    if (v.state !== 'done') errors.push(`${k} state=${v.state}`);
    if (v.day !== '2026-10-20') errors.push(`${k} day=${v.day}`);
    if (!String(v.line || '').includes('鱼缸改的路由器') && !String(v.line || '').includes('会按按钮的猫')) errors.push(`${k} 非已知测试文本`);
  }
  if (fs.existsSync(BODY)) {
    const body = fs.readFileSync(BODY, 'utf8');
    for (const k of keys) {
      const line = table.keys?.[k]?.line;
      if (line && body.includes(line)) errors.push(`正文已含该行，拒绝删除幂等键：${k}`);
    }
  }
  return errors;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = String(args.confirm).split(',').map((s) => s.trim()).filter(Boolean);
  if (!args.apply) {
    const table = JSON.parse(fs.readFileSync(IDEM, 'utf8'));
    const errors = validate(table, keys);
    console.log(JSON.stringify({ dryRun: true, keys, errors, current: keys.map((k) => table.keys?.[k] || null), count: Object.keys(table.keys || {}).length }, null, 1));
    return errors.length ? 2 : 0;
  }
  if (keys.length !== 2) throw new Error('--apply 需要且只允许 2 个 key');
  const beforeHash = sha(IDEM);
  const before = JSON.parse(fs.readFileSync(IDEM, 'utf8'));
  const errors = validate(before, keys);
  if (errors.length) throw new Error(`校验失败：${errors.join('；')}`);
  const stamp = nowIso().replace(/[:.]/g, '-');
  const backupDir = path.join(DATA, 'backups', 'idem-cleanup', stamp);
  fs.mkdirSync(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, 'diary-idempotency.json');
  fs.copyFileSync(IDEM, backupFile);
  const backupHash = sha(backupFile);
  if (backupHash !== beforeHash) throw new Error('备份 hash 与源不一致');
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
    schema: 1, kind: 'idem-cleanup', source: IDEM, backupFile, sha256: backupHash, size: fs.statSync(IDEM).size,
    removedKeys: keys, beforeHash, createdAt: nowIso()
  }, null, 1), 'utf8');

  // 写前再校验：文件未被并发改写
  if (sha(IDEM) !== beforeHash) throw new Error('幂等表在准备期间被并发修改，已中止');
  for (const k of keys) delete before.keys[k];
  const text = JSON.stringify(before);
  const tmp = `${IDEM}.cleanup-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  if (sha(IDEM) !== beforeHash) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } throw new Error('幂等表在写入前被并发修改，已中止'); }
  fs.renameSync(tmp, IDEM);
  const afterHash = sha(IDEM);
  const after = JSON.parse(fs.readFileSync(IDEM, 'utf8'));
  const ok = afterHash !== beforeHash
    && keys.every((k) => !(k in (after.keys || {})))
    && Object.keys(after.keys || {}).length === Object.keys(before.keys || {}).length; // before already removed
  const audit = path.join(DATA, 'logs', 'ops-audit.jsonl');
  fs.appendFileSync(audit, JSON.stringify({
    at: nowIso(), op: 'diary.idem.cleanup_test_residue', result: ok ? 'ok' : 'failed',
    before: beforeHash, after: afterHash, removed: keys, remaining: Object.keys(after.keys || {}).length,
    backup: backupFile, note: 'B 方案：仅删除 2 条 10-20 测试幂等键；pending 保留'
  }) + '\n', 'utf8');
  if (!ok) {
    // 回滚（从备份原子替换）
    fs.copyFileSync(backupFile, IDEM);
    throw new Error(`清理后校验失败，已回滚；after=${afterHash}`);
  }
  console.log(JSON.stringify({ ok, beforeHash, afterHash, removed: keys, remaining: Object.keys(after.keys || {}).length, backup: backupFile }, null, 1));
  return 0;
}

try { process.exit(main()); } catch (e) { console.error(String(e?.stack || e)); process.exit(1); }
