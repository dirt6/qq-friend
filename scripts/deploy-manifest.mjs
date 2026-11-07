// 部署清单生成/校验（D1-3c C2）。默认**只读**：只计算 hash，不写任何文件；--out 才写清单。
//
// 用法：
//   node scripts/deploy-manifest.mjs                 # 输出 JSON 清单到 stdout
//   node scripts/deploy-manifest.mjs --out <file>     # 写入清单（原子替换）
//   node scripts/deploy-manifest.mjs --verify <file>  # 校验当前仓库与清单是否一致
//   node scripts/deploy-manifest.mjs --no-production  # 不读取生产数据元信息
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const SCHEMA = 1;
const RUNTIME_DIRS = ['src', 'ui', 'electron', 'plugins', 'dsh-plugins', 'skills', 'scripts'];
const ROOT_FILES = ['package.json', 'package-lock.json'];
const PROD_KEY_FILES = [
  'data/config.json', 'data/learned.json', 'data/companion-state.json', 'data/autonomous.json',
  'data/reminders.json', 'data/diary-idempotency.json', 'data/diary-meta/pending.json', 'data/dsh-sessions.json'
];

function runGit(args) {
  // 沙箱/受限环境下 Node 的 pipe stdio 会被拒绝；改把 stdout 落到临时文件再读。
  const outFile = path.join(os.tmpdir(), `deploy-git-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.out`);
  let fd = null;
  try {
    fd = fs.openSync(outFile, 'w');
    const r = spawnSync('git', args, { cwd: ROOT, stdio: ['ignore', fd, 'ignore'], windowsHide: true });
    try { fs.closeSync(fd); } catch { /* ignore */ }
    fd = null;
    if (r.status !== 0) return '';
    return fs.readFileSync(outFile, 'utf8').trim();
  } catch {
    return '';
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { fs.unlinkSync(outFile); } catch { /* ignore */ }
  }
}
function git(args) { return runGit(args); }
function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function walkFiles(root, rel = '', out = []) {
  let ents = [];
  try { ents = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walkFiles(root, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}
function statTree(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (abs) => {
    let ents = [];
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(abs, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        files += 1;
        try { bytes += fs.statSync(p).size; } catch { /* ignore */ }
      }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** 生成清单（只读）。 */
export function generateManifest({ root = ROOT, dirs = RUNTIME_DIRS, files = ROOT_FILES, production = true } = {}) {
  const codeFiles = [];
  for (const d of dirs) {
    for (const rel of walkFiles(root, d)) {
      const abs = path.join(root, rel);
      codeFiles.push({ path: rel.replace(/\\/g, '/'), size: fs.statSync(abs).size, sha256: sha256(abs) });
    }
  }
  for (const rel of files) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    codeFiles.push({ path: rel, size: fs.statSync(abs).size, sha256: sha256(abs) });
  }
  codeFiles.sort((a, b) => a.path.localeCompare(b.path));
  const isRepo = path.resolve(root) === path.resolve(ROOT);
  const dirty = isRepo ? git(['status', '--porcelain']).split('\n').filter(Boolean) : [];
  const manifest = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    git: {
      head: isRepo ? git(['rev-parse', 'HEAD']) : '',
      branch: isRepo ? git(['rev-parse', '--abbrev-ref', 'HEAD']) : '',
      dirty: dirty.length > 0,
      dirtyFiles: dirty.slice(0, 50)
    },
    versions: {
      node: process.version,
      app: (() => { try { return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version; } catch { return ''; } })()
    },
    code: {
      dirs,
      roots: files,
      files: codeFiles,
      totals: { files: codeFiles.length, bytes: codeFiles.reduce((s, f) => s + f.size, 0) }
    },
    rollback: {
      previous: isRepo ? git(['rev-parse', 'HEAD~1']) : '',
      steps: isRepo ? [
        '确认生产数据已停止写入（或接受重启窗口）',
        'git checkout <previous>（或用发布包回退）',
        '用管理员快捷方式重启 Electron，确认 boot-diag/3210/OneBot',
        '按本清单校验代码 hash，执行只读 reset preflight（不执行 reset）'
      ] : []
    }
  };
  if (production) {
    const dataDir = path.resolve(process.env.QQ_AGENT_DATA_DIR || path.join(root, 'data'));
    const keyFiles = {};
    for (const rel of PROD_KEY_FILES) {
      const abs = path.join(root, rel);
      keyFiles[rel] = fs.existsSync(abs) ? { sha256: sha256(abs), size: fs.statSync(abs).size } : { sha256: 'missing', size: 0 };
    }
    manifest.production = {
      dataDir,
      keyFiles,
      counts: {
        memory: statTree(path.join(dataDir, 'memory')),
        sessions: statTree(path.join(dataDir, 'sessions')),
        diary: statTree(process.env.QQ_AGENT_DIARY_ROOT || 'E:\\dsh\\本子\\日记'),
        resetBackups: statTree(`${dataDir}.reset-backups`)
      }
    };
  }
  return manifest;
}

/** 校验：清单里每个文件的大小/hash 与当前一致；运行时代码目录不得有清单外的文件。 */
export function verifyManifest(manifest, { root = ROOT } = {}) {
  const problems = [];
  let checked = 0;
  for (const f of manifest?.code?.files || []) {
    const abs = path.join(root, f.path);
    if (!fs.existsSync(abs)) { problems.push({ type: 'missing', path: f.path }); continue; }
    const st = fs.statSync(abs);
    const h = sha256(abs);
    if (st.size !== f.size || h !== f.sha256) {
      problems.push({ type: 'mismatch', path: f.path, expected: { size: f.size, sha256: f.sha256 }, actual: { size: st.size, sha256: h } });
    }
    checked += 1;
  }
  const known = new Set((manifest?.code?.files || []).map((f) => f.path.replace(/\\/g, '/')));
  for (const d of manifest?.code?.dirs || []) {
    for (const rel of walkFiles(root, d)) {
      const p = rel.replace(/\\/g, '/');
      if (!known.has(p)) problems.push({ type: 'extra', path: p });
    }
  }
  return { ok: problems.length === 0, checked, problems, head: git(['rev-parse', 'HEAD']), manifestHead: manifest?.git?.head || '' };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export function main(argv = process.argv.slice(2)) {
  const args = { out: '', verify: '', production: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-production') { args.production = false; continue; }
    if (a === '--out' || a === '--verify') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) { console.error(`缺少参数值：${a}`); return 2; }
      if (a === '--out') args.out = v; else args.verify = v;
      i += 1;
      continue;
    }
    console.error(`未知参数：${a}`);
    return 2;
  }
  if (args.verify) {
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(args.verify, 'utf8')); } catch (e) { console.error(`清单不可读：${e.message}`); return 2; }
    const r = verifyManifest(manifest);
    if (r.ok) { console.log(`校验通过：${r.checked} 个文件 hash 一致（HEAD ${r.head}）`); return 0; }
    console.error(`校验失败：${r.problems.length} 个问题`);
    for (const p of r.problems.slice(0, 20)) console.error(`  ${p.type}: ${p.path}`);
    return 1;
  }
  const manifest = generateManifest({ production: args.production });
  const text = JSON.stringify(manifest, null, 1);
  if (args.out) {
    writeAtomic(args.out, text);
    console.log(`已写入 ${path.resolve(args.out)}（${manifest.code.totals.files} 文件）`);
  } else {
    console.log(text);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(main());
}
