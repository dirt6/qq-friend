// D1-7F2 回滚预检（不执行）。默认只读；--execute 需要外部授权 + 目标版本核验。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const git = (args) => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); return r.status === 0 ? String(r.stdout).trim() : ''; };

export function preflightRollback({ target = 'c9c06ac' } = {}) {
  const exists = Boolean(git(['cat-file', '-t', target]));
  const subject = exists ? git(['log', '-1', '--format=%h %ci %s', target]) : '';
  const pkg = (() => { try { return JSON.parse(git(['show', `${target}:package.json`])); } catch { return null; } })();
  const curPkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return null; } })();
  const files = ['src/app.js', 'src/store.js', 'src/orchestrator.js', 'plugins/autonomous/index.js'];
  const refFiles = Object.fromEntries(files.map((f) => [f, git(['cat-file', '-e', `${target}:${f}`]) === '' ? 'exists' : 'missing']));
  return {
    at: new Date().toISOString(),
    currentHead: git(['rev-parse', 'HEAD']),
    dirty: Boolean(git(['status', '--porcelain'])),
    target,
    targetExists: exists,
    subject,
    packageVersion: { target: pkg?.version || null, current: curPkg?.version || null },
    refFiles,
    compatible: exists && pkg?.version === curPkg?.version,
    dataHashes: {
      pending: fs.existsSync(path.join(DATA, 'diary-meta', 'pending.json')) ? sha(path.join(DATA, 'diary-meta', 'pending.json')) : 'missing',
      idem: fs.existsSync(path.join(DATA, 'diary-idempotency.json')) ? sha(path.join(DATA, 'diary-idempotency.json')) : 'missing',
      companion: fs.existsSync(path.join(DATA, 'companion-state.json')) ? sha(path.join(DATA, 'companion-state.json')) : 'missing'
    },
    note: '回滚只切换代码并重启；不 reset/不删除数据'
  };
}

function main() {
  const av = process.argv.slice(2);
  const args = { execute: false, target: 'c9c06ac', authorization: '' };
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] === '--execute') args.execute = true;
    else if (['--target', '--authorization'].includes(av[i])) { const v = av[i + 1]; if (!v) throw new Error(`${av[i]} 缺少值`); if (av[i] === '--target') args.target = v; else args.authorization = v; i += 1; }
    else throw new Error(`未知参数 ${av[i]}`);
  }
  const r = preflightRollback({ target: args.target });
  console.log(JSON.stringify(r, null, 1));
  if (!args.execute) return 0;
  const blockers = [];
  if (!r.targetExists) blockers.push('目标版本不存在');
  if (!r.compatible) blockers.push('package version 不兼容');
  if (r.dirty) blockers.push('工作区不干净');
  if (!args.authorization) blockers.push('缺少授权标记');
  if (blockers.length) { console.error(JSON.stringify({ ok: false, blocked: true, blockers, note: '未执行 git checkout/重启' }, null, 1)); return 2; }
  console.error(JSON.stringify({ ok: false, blocked: true, blockers: ['回滚执行未启用（本批只预检）'] }, null, 1));
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exit(main()); } catch (e) { console.error(String(e?.stack || e)); process.exit(1); }
}
