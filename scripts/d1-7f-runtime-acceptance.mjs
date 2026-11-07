// D1-7F3 运行态只读验收（默认不触发自主活动、不写生产）。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { preflight } from './d1-7f-restart.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

function connect(port, host = '127.0.0.1', timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host });
    const done = (ok) => { try { s.destroy(); } catch { /* ignore */ } resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}
async function api(base, p) {
  try {
    const r = await fetch(`${base}${p}`, { signal: AbortSignal.timeout(5000) });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch { /* ignore */ }
    return { status: r.status, data, text: text.slice(0, 400) };
  } catch (e) { return { status: 0, error: String(e?.message ?? e) }; }
}

export function compareBaseline(current, baseline) {
  const base = baseline?.hashes || baseline;
  const problems = [];
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v === 'string') {
      if (String(current[k]) !== String(v)) problems.push({ key: k, expected: v, actual: current[k] });
    } else if (v && typeof v === 'object' && 'sha256' in v) {
      const cur = current[k];
      if (!cur || cur.sha256 !== v.sha256) problems.push({ key: k, expected: v.sha256, actual: cur?.sha256 || 'missing' });
    }
  }
  return { ok: problems.length === 0, problems };
}

export async function acceptance({ baseUrl = 'http://127.0.0.1:3210', baseline = null } = {}) {
  const pf = preflight();
  const version = await api(baseUrl, '/api/version');
  const status = await api(baseUrl, '/api/status');
  const chats = await api(baseUrl, '/api/chats');
  const pre = await api(baseUrl, '/api/reset-data/preflight');
  const ports = { 3210: await connect(3210), 3001: await connect(3001), 6099: await connect(6099) };
  const logFile = path.join(DATA, 'logs', `qq-agent-${new Date().toISOString().slice(0, 10)}.log`);
  const logText = (() => { try { return fs.readFileSync(logFile, 'utf8'); } catch { return ''; } })();
  const started = (logText.match(/自主活动已启动/g) || []).length;
  const loaded = (logText.match(/自主活动已加载/g) || []).length;
  const base = baseline ? compareBaseline(pf.hashes, baseline) : null;
  const checks = {
    service: Boolean(ports[3210] && version.status === 200 && status.status === 200 && status.data?.onebot?.connected),
    napcat: Boolean(ports[3001] && ports[6099]),
    chatStore: chats.status === 200 && Array.isArray(chats.data?.chats),
    resetPreflight: pre.status === 200,
    identity: pf.identity.verified,
    moduleVersion: 'UNKNOWN',       // 无运行期模块版本观测；不能用 /api/version 代替
    coreContext: 'UNKNOWN',          // 无运行期方法/单例观测 API
    autonomyLoop: loaded > 1 ? 'WARN_MULTIPLE_LOAD' : (loaded === 1 ? 'ONE_LOAD_LOG' : 'UNKNOWN'),
    autoStarted: started,
    dataBaseline: base ? (base.ok ? 'PASS' : 'FAIL') : 'NO_BASELINE'
  };
  const statuses = {
    service: checks.service ? 'PASS' : 'FAIL',
    coreChatStore: checks.chatStore ? 'PASS' : 'FAIL',
    identity: checks.identity ? 'PASS' : 'UNKNOWN',
    moduleVersion: 'UNKNOWN',
    coreContext: 'UNKNOWN',
    autonomyLifecycle: 'UNKNOWN',
    autonomyActivity: 'UNKNOWN',
    data: checks.dataBaseline === 'PASS' ? 'PASS' : (checks.dataBaseline === 'FAIL' ? 'FAIL' : 'UNKNOWN')
  };
  return { at: new Date().toISOString(), baseUrl, head: pf.head, pid: pf.lockPid, process: pf.process, identity: pf.identity, hotReload: pf.hotReload, ports, api: { version, status: { status: status.status, onebot: status.data?.onebot?.connected, running: status.data?.orchestrator?.running }, chats: chats.status, preflight: pre.status }, logs: { loaded, started }, checks, statuses, baseline: base };
}

function main() {
  const av = process.argv.slice(2);
  const args = { json: false, baseline: '', baseUrl: 'http://127.0.0.1:3210' };
  for (let i = 0; i < av.length; i += 1) {
    if (av[i] === '--json') args.json = true;
    else if (['--baseline', '--base-url'].includes(av[i])) {
      const v = av[i + 1]; if (!v) throw new Error(`${av[i]} 缺少值`);
      if (av[i] === '--baseline') args.baseline = v; else args.baseUrl = v;
      i += 1;
    } else throw new Error(`未知参数 ${av[i]}`);
  }
  const baseline = args.baseline ? JSON.parse(fs.readFileSync(args.baseline, 'utf8')) : null;
  acceptance({ baseUrl: args.baseUrl, baseline }).then((r) => {
    console.log(JSON.stringify(r, null, args.json ? 1 : 2));
    const hardFail = r.statuses.service === 'FAIL' || r.statuses.coreChatStore === 'FAIL' || r.statuses.data === 'FAIL';
    process.exit(hardFail ? 1 : 0);
  }).catch((e) => { console.error(String(e?.stack || e)); process.exit(1); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
