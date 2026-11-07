// 5.0 观察期只读检查：不写状态、不发消息、不调模型。
// 用法：node scripts/5.0-observe.mjs [--json] [--baseline=<hash.json>]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const baselineArg = args.find((x) => x.startsWith('--baseline='))?.slice(11) || '';
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const data = path.join(root, 'data');
const read = (p) => fs.readFileSync(path.join(data, p), 'utf8').trim();
const base = 'http://127.0.0.1:3210';
const checks = [];
const add = (name, ok, detail = '', level = 'FAIL') => checks.push({ name, ok: Boolean(ok), detail: String(detail), level });
const get = async (p, headers = {}) => {
  const r = await fetch(base + p, { headers, signal: AbortSignal.timeout(5000) });
  const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, body, text: text.slice(0, 200) };
};
try {
  const g1 = await get('/api/g1/status', { 'x-g1-token': read('5.0-g1/token') });
  add('G1 status 可达', g1.status === 200, `HTTP ${g1.status}`);
  add('G1 paused', g1.body?.paused === true, `paused=${g1.body?.paused}`);
  add('G1 not running', g1.body?.running !== true, `running=${g1.body?.running}`);
  const rt = await get('/api/5.0/status', { 'x-5.0-token': read('5.0-runtime/control-token') });
  add('Runtime status 可达', rt.status === 200, `HTTP ${rt.status}`);
  add('Runtime paused', rt.body?.paused === true, `paused=${rt.body?.paused}`);
  add('G2 disabled', rt.body?.g2Enabled === false, `g2=${rt.body?.g2Enabled}`);
  add('G3 disabled', rt.body?.g3Enabled === false, `g3=${rt.body?.g3Enabled}`);
  add('readonly disabled', rt.body?.readonlyEnabled === false, `readonly=${rt.body?.readonlyEnabled}`);
  add('control token configured', rt.body?.tokenConfigured === true, '');
  const live = await get('/api/status');
  add('OneBot connected', live.body?.onebot?.connected === true, `connected=${live.body?.onebot?.connected}`, 'WARN');
  const skills = await get('/api/skills');
  const auto = (skills.body?.skills || []).find((x) => String(x.id) === 'autonomous');
  const silence = (skills.body?.skills || []).find((x) => String(x.id) === 'silence-ping');
  add('old autonomous disabled', auto && auto.enabled === false && auto.active === false, `${auto?.enabled}/${auto?.active}`);
  add('silence-ping disabled', silence && silence.enabled === false && silence.active === false, `${silence?.enabled}/${silence?.active}`);

  const journal = JSON.parse(fs.readFileSync(path.join(data, '5.0-runtime/g3-send-journal.json'), 'utf8'));
  const intents = Object.values(journal.intents || {});
  const unknown = intents.filter((x) => x.state === 'unknown').length;
  const sent = intents.filter((x) => x.state === 'sent').length;
  const sending = intents.filter((x) => x.state === 'sending').length;
  add('no G3 sending intent', sending === 0, `sending=${sending}`);
  add('G3 unknown is visible', true, `unknown=${unknown}, sent=${sent}`, 'INFO');

  const exec = JSON.parse(fs.readFileSync(path.join(data, '5.0-runtime/execution.json'), 'utf8'));
  const started = Object.values(exec.records || {}).filter((r) => r.state === 'started').length;
  add('no stuck started execution', started === 0, `started=${started}`);

  const files = ['data/companion-events/active.ndjson', 'data/prompt-archive/turns.ndjson', 'data/learned.json', 'data/companion-state.json', 'data/token-usage.json', 'data/dsh-sessions.json'];
  const hashes = {};
  for (const f of files) { try { hashes[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, f))).digest('hex'); } catch { hashes[f] = 'missing'; } }
  if (baselineArg) {
    const b = JSON.parse(fs.readFileSync(path.resolve(root, baselineArg), 'utf8'));
    const changed = Object.keys(b).filter((k) => hashes[k] !== b[k]);
    add('business hashes unchanged', changed.length === 0, changed.join(', '), 'WARN');
  }
  const out = { at: new Date().toISOString(), checks, hashes, g3: { unknown, sent, sending }, budget: rt.body?.budget || null };
  if (jsonOut) console.log(JSON.stringify(out, null, 1));
  else {
    for (const c of checks) console.log(`${c.ok ? 'PASS' : c.level.padEnd(4)} ${c.name}${c.detail ? ` :: ${c.detail}` : ''}`);
    console.log(`G3 journal: unknown=${unknown} sent=${sent} sending=${sending}`);
  }
  const critical = checks.some((c) => !c.ok && c.level !== 'WARN' && c.level !== 'INFO');
  process.exit(critical ? 1 : 0);
} catch (e) {
  console.error(`OBSERVE_ERROR ${e?.message || e}`);
  process.exit(2);
}
