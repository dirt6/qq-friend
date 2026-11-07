// D1-7F2 受控重启预检/执行器。默认只读；--execute 需要外部授权标记 + 身份联合验证。
// 设计原则：身份无法联合验证（PID+启动时间+可执行路径+命令行）时，永远不停止进程。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const LOCK = path.join(DATA, 'qq-agent.lock');
const CONFIG = path.join(DATA, 'config.json');
const BOOT = path.join(DATA, 'boot-diag.log');

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const nowIso = () => new Date().toISOString();

function git(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? String(r.stdout).trim() : '';
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function probeProcess(pid) {
  const script = `$ErrorActionPreference='Stop'; $p=Get-Process -Id ${Number(pid)}; [pscustomobject]@{Id=$p.Id;Name=$p.ProcessName;StartTime=$p.StartTime.ToUniversalTime().ToString('o');Path=$p.Path} | ConvertTo-Json -Compress`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.error || 'probe failed').slice(0, 300) };
  try { return { ok: true, ...JSON.parse(String(r.stdout).trim()) }; } catch { return { ok: false, error: 'probe json parse failed' }; }
}

function probeCommandLine(pid) {
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; [pscustomobject]@{CommandLine=$p.CommandLine;ParentProcessId=$p.ParentProcessId;ExecutablePath=$p.ExecutablePath} | ConvertTo-Json -Compress`;
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.error || 'cim denied').slice(0, 300) };
  try { return { ok: true, ...JSON.parse(String(r.stdout).trim()) }; } catch { return { ok: false, error: 'cim json parse failed' }; }
}

export function evaluateIdentity({ pid, startTime, path: exePath, commandLine }) {
  const missing = [];
  if (!pid) missing.push('pid');
  if (!startTime) missing.push('startTime');
  if (!exePath) missing.push('executablePath');
  if (!commandLine) missing.push('commandLine');
  return { verified: missing.length === 0, missing };
}

export function validateAuthorization(marker, { targetHead, pid, startTime, configSha256, now = Date.now(), scope = 'restart-production', action = 'restart' }) {
  if (!marker) return { ok: false, error: '缺少授权标记文件' };
  if (marker.scope !== scope) return { ok: false, error: `scope 不符：${marker.scope || 'missing'}` };
  if (marker.action !== action) return { ok: false, error: `action 不符：${marker.action || 'missing'}` };
  if (!marker.authorizedBy) return { ok: false, error: '缺少 authorizedBy' };
  if (!marker.nonce || String(marker.nonce).length < 16) return { ok: false, error: '缺少足够长的 nonce' };
  if (String(marker.targetHead || '') !== String(targetHead || '')) return { ok: false, error: 'targetHead 不符' };
  if (Number(marker.pid) !== Number(pid)) return { ok: false, error: 'pid 不符' };
  if (String(marker.startTime || '') !== String(startTime || '')) return { ok: false, error: 'startTime 不符' };
  if (String(marker.configSha256 || '') !== String(configSha256 || '')) return { ok: false, error: 'configSha256 不符' };
  const issued = Date.parse(marker.issuedAt || '');
  if (!Number.isFinite(issued) || issued > now) return { ok: false, error: 'issuedAt 缺失/在未来' };
  const exp = Date.parse(marker.expiresAt || '');
  if (!Number.isFinite(exp) || exp < now) return { ok: false, error: '授权已过期或缺少 expiresAt' };
  return { ok: true };
}

/** 一次性消费 nonce；状态文件由调用方指定（不得默认写生产）。 */
export function consumeMarker({ stateFile, nonce, now = Date.now() }) {
  if (!stateFile) return { ok: false, error: '缺少 marker state 文件' };
  let state = { used: [] };
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* new */ }
  if (!Array.isArray(state.used)) state.used = [];
  if (state.used.includes(nonce)) return { ok: false, error: 'marker 已使用（拒绝重放）' };
  state.used.push(nonce);
  state.updatedAt = new Date(now).toISOString();
  const tmp = `${stateFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, stateFile);
  return { ok: true };
}

function hashTree(root) {
  if (!fs.existsSync(root)) return { exists: false, files: 0, bytes: 0, sha256: '' };
  const lines = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.isFile()) lines.push(`${r}|${sha(p)}|${fs.statSync(p).size}`);
    }
  };
  walk(root, '');
  return { exists: true, files: lines.length, bytes: lines.reduce((s, l) => s + Number(l.split('|')[2]), 0), sha256: crypto.createHash('sha256').update(lines.sort().join('\n')).digest('hex') };
}

export function preflight({ baseline = null } = {}) {
  const head = git(['rev-parse', 'HEAD']);
  const dirty = git(['status', '--porcelain']);
  const lockPid = (() => { try { return Number(fs.readFileSync(LOCK, 'utf8').trim()); } catch { return null; } })();
  const proc = lockPid ? probeProcess(lockPid) : { ok: false, error: 'no lock pid' };
  const cmd = lockPid ? probeCommandLine(lockPid) : { ok: false, error: 'no lock pid' };
  const identity = evaluateIdentity({ pid: lockPid, startTime: proc.StartTime || proc.startTime, path: proc.Path || proc.path, commandLine: cmd.CommandLine || cmd.commandLine });
  const cfg = readJson(CONFIG) || {};
  const hashes = {
    companionEvents: hashTree(path.join(DATA, 'companion-events')),
    learned: fs.existsSync(path.join(DATA, 'learned.json')) ? sha(path.join(DATA, 'learned.json')) : 'missing',
    pending: fs.existsSync(path.join(DATA, 'diary-meta')) ? sha(path.join(DATA, 'diary-meta', 'pending.json')) : 'missing',
    idem: fs.existsSync(path.join(DATA, 'diary-idempotency.json')) ? sha(path.join(DATA, 'diary-idempotency.json')) : 'missing',
    dsh: fs.existsSync(path.join(DATA, 'dsh-sessions.json')) ? sha(path.join(DATA, 'dsh-sessions.json')) : 'missing',
    companion: fs.existsSync(path.join(DATA, 'companion-state.json')) ? sha(path.join(DATA, 'companion-state.json')) : 'missing',
    token: fs.existsSync(path.join(DATA, 'token-usage.json')) ? sha(path.join(DATA, 'token-usage.json')) : 'missing',
    messages: hashTree(path.join(DATA, 'messages')),
    diary: hashTree('E:\\dsh\\日记')
  };
  return {
    at: nowIso(),
    head,
    dirty: Boolean(dirty),
    lockPid,
    process: proc,
    commandLine: cmd,
    identity,
    hotReload: cfg.extensions?.hotReload,
    configSha256: fs.existsSync(CONFIG) ? sha(CONFIG) : 'missing',
    baselineProvided: Boolean(baseline),
    baselineMatch: baseline ? JSON.stringify(baseline) === JSON.stringify(hashes) : null,
    hashes
  };
}

function main() {
  const args = { execute: false, authorization: '', out: '', baseline: '', markerState: '', action: 'restart' };
  const av = process.argv.slice(2);
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] === '--execute') args.execute = true;
    else if (['--authorization', '--out', '--baseline', '--marker-state', '--action'].includes(av[i])) {
      const v = av[i + 1]; if (!v) throw new Error(`${av[i]} 缺少值`);
      if (av[i] === '--authorization') args.authorization = v;
      if (av[i] === '--out') args.out = v;
      if (av[i] === '--baseline') args.baseline = v;
      if (av[i] === '--marker-state') args.markerState = v;
      if (av[i] === '--action') args.action = v;
      i += 1;
    } else throw new Error(`未知参数 ${av[i]}`);
  }
  const baseline = args.baseline ? JSON.parse(fs.readFileSync(args.baseline, 'utf8')) : null;
  const pf = preflight({ baseline });
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(pf, null, 1), 'utf8');
  console.log(JSON.stringify(pf, null, 1));
  if (!args.execute) return 0;

  // 执行路径：默认必须失败关闭；仅当授权标记 + 身份联合验证 + 基线全通过才继续。
  const marker = args.authorization ? readJson(args.authorization) : null;
  const auth = validateAuthorization(marker, { targetHead: pf.head, pid: pf.lockPid, startTime: pf.process?.StartTime || pf.process?.startTime, configSha256: pf.configSha256, action: args.action });
  const blockers = [];
  if (!pf.commandLine?.ok) blockers.push('命令行/父进程不可读');
  if (!pf.identity.verified) blockers.push(`身份字段缺失：${pf.identity.missing.join(',')}`);
  if (!auth.ok) blockers.push(`授权：${auth.error}`);
  if (!args.markerState) blockers.push('缺少 --marker-state（一次性消费文件）');
  if (pf.dirty) blockers.push('工作区不干净');
  if (pf.baselineMatch === false) blockers.push('生产数据 hash 与基线不一致');
  if (blockers.length) {
    console.error(JSON.stringify({ ok: false, blocked: true, blockers, note: '拒绝停止/重启；未执行任何进程操作' }, null, 1));
    return 2;
  }
  // 本版本不提供程序化托盘退出；强制 Stop-Process 只能作为经批准的故障恢复路径，
  // 且需要授权 marker.method='force'。默认仍拒绝。
  if (marker.method !== 'force') {
    console.error(JSON.stringify({ ok: false, blocked: true, blockers: ['未提供程序化托盘退出；仅允许人工托盘退出或授权 force'] }, null, 1));
    return 2;
  }
  console.error(JSON.stringify({ ok: false, blocked: true, blockers: ['force 执行路径未启用（本批只准备，不执行生产重启）'] }, null, 1));
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { process.exit(main()); } catch (e) { console.error(String(e?.stack || e)); process.exit(1); }
}
