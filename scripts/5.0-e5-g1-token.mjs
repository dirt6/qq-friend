// 5.0-E5/G1：生成独立 G1 token 文件（不写入 config；不打印 token）。
// 默认 dry-run；--apply 才写文件；已存在则拒绝。部署窗口需配合 ACL。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const out = args.find((x) => x.startsWith('--out='))?.slice(6) || '';
const apply = args.includes('--apply');
if (!out) throw new Error('需要 --out=<data/5.0-g1/token>');
const file = path.resolve(out);
if (path.basename(file) !== 'token') throw new Error('token 文件名必须为 token');
const dir = path.dirname(file);
if (!fs.existsSync(dir)) {
  if (!apply) { console.log(JSON.stringify({ ok: true, dryRun: true, dir, file, note: '目录不存在；--apply 会创建' })); process.exit(0); }
  fs.mkdirSync(dir, { recursive: true });
}
if (fs.existsSync(file)) throw new Error('token 文件已存在，拒绝覆盖');
const token = crypto.randomBytes(32).toString('base64url');
if (!apply) {
  console.log(JSON.stringify({ ok: true, dryRun: true, file, bytes: token.length, note: '未写入；--apply 才写' }));
  process.exit(0);
}
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, token, { encoding: 'utf8', mode: 0o600 });
fs.renameSync(tmp, file);
try { fs.chmodSync(file, 0o600); } catch { /* Windows ACL is the real control */ }
console.log(JSON.stringify({ ok: true, dryRun: false, file, bytes: token.length, mode: '0600' }));
