// 5.0-E5/G1 单次人工运行验收。必须显式 --execute；token 从文件读取，不打印。
// 序列：paused 拦截 → resume → 一次 run → 重放拒绝 → pause。
import fs from 'node:fs';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const get = (k) => args.find((x) => x.startsWith(`--${k}=`))?.slice(k.length + 3) || '';
const base = get('base-url') || 'http://127.0.0.1:3210';
const tokenFile = get('token-file') || 'data/5.0-g1/token';
const execute = args.includes('--execute');
if (!execute) {
  console.log(JSON.stringify({ ok: true, dryRun: true, note: '未执行；确认后加 --execute', base, tokenFile }, null, 1));
  process.exit(0);
}
const token = fs.readFileSync(tokenFile, 'utf8').trim();
if (token.length < 32) throw new Error('token 文件缺失/过短');
const headers = { 'x-g1-token': token };
async function req(method, p, body) {
  const r = await fetch(`${base}${p}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, data, text: text.slice(0, 200) };
}
const out = [];
const step = async (name, fn) => { const r = await fn(); out.push({ name, status: r.status, code: r.data?.code || '', ok: r.data?.ok }); return r; };
let r = await step('status_before', () => req('GET', '/api/g1/status'));
if (r.status !== 200 || r.data?.paused !== true) throw new Error('status_before: paused 预期 true');
await step('pause', () => req('POST', '/api/g1/pause', { paused: true }));
r = await step('run_paused', () => req('POST', '/api/g1/run', null));
if (r.status !== 423) throw new Error('run_paused: 预期 423');
await step('resume', () => req('POST', '/api/g1/pause', { paused: false }));
const nonce = crypto.randomUUID();
r = await step('run_once', () => fetch(`${base}/api/g1/run`, { method: 'POST', headers: { ...headers, 'x-g1-nonce': nonce }, signal: AbortSignal.timeout(60000) }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => null), text: '' })));
if (r.status !== 200) throw new Error('run_once: 预期 200');
const receiptId = r.data?.result?.receipt?.receiptId || '';
r = await step('run_replay', () => fetch(`${base}/api/g1/run`, { method: 'POST', headers: { ...headers, 'x-g1-nonce': nonce }, signal: AbortSignal.timeout(15000) }).then(async (x) => ({ status: x.status, data: await x.json().catch(() => null), text: '' })));
if (![409, 423].includes(r.status)) throw new Error('run_replay: 预期 409/423');
await step('pause_after', () => req('POST', '/api/g1/pause', { paused: true }));
r = await step('status_after', () => req('GET', '/api/g1/status'));
console.log(JSON.stringify({ ok: true, receiptId, auditDir: 'data/5.0-g1', steps: out, finalPaused: r.data?.paused, token: 'redacted' }, null, 1));
