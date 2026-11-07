// 5.0-E6 G3 单目标生产验收（独立，不跑 G2）。
// 新 receipt/nonce/fingerprint；UNKNOWN 不重发。--execute 才执行。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAuthorizationService } from '../src/autonomous/authorization.js';
import { planHashOf } from '../src/autonomous/coordinator.js';

const args = process.argv.slice(2);
if (!args.includes('--execute')) { console.log(JSON.stringify({ ok: true, dryRun: true, note: '未执行；加 --execute' })); process.exit(0); }
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dataDir = path.join(root, 'data');
const base = 'http://127.0.0.1:3210';
const read = (p) => fs.readFileSync(path.join(dataDir, p), 'utf8').trim();
const control = read('5.0-runtime/control-token');
const creds = JSON.parse(read('5.0-runtime/auth-keys.json'));
const auth = createAuthorizationService({ keys: creds.keys, keyId: creds.keyId, nonceFile: creds.nonceFile || '' });
const target = String(JSON.parse(read('config.json')).runtime?.g3Target || '').trim();
if (!/^\d+$/.test(target)) throw new Error('g3Target 未配置');
const H = { 'x-5.0-token': control, 'content-type': 'application/json' };
const call = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, body: json, text: text.slice(0, 500) };
};
const live = await call('/api/status');
if (live.status !== 200) throw new Error('API 不可达');
if (live.body?.onebot?.connected !== true) throw new Error('OneBot 未连接，停止；不发送');
const expiry = () => new Date(Date.now() + 3600e3).toISOString();
const nonce = () => crypto.randomBytes(16).toString('base64url');
const purpose = { ok: true, candidates: [] };
const inputRef = `g3-login-${Date.now()}`;
const closure = { ok: true, decision: 'close' };
const activity = { ok: true, decision: 'interest_exploration', reason: `g3-login-${Date.now()}`, selectedActivity: { type: 'interest_exploration', title: '分享', risk: 'low' } };
const text = '我在，登录后 G3 单目标验收完成。';
const plan = { kind: 'qq', tool: 'interest_exploration', target: '分享', qqTarget: target, params: { text }, decision: { decision: 'share_now' }, text };
const tools = { interest_exploration: { schema: { type: 'object' }, maxRuns: 1 } };
let out = {};
try {
  await call('/api/5.0/pause', { paused: false });
  await call('/api/5.0/features', { g3: true, g2: false, readonly: false });
  const first = await call('/api/5.0/run', { tickId: `prod-g3-login-${Date.now()}`, inputRef, purpose, closure, activity, executionPlan: plan, tools });
  if (first.status !== 200 || !first.body?.result?.receipt?.receiptId) throw new Error(`无法创建 receipt: ${first.status} ${first.text}`);
  const rec = first.body.result.receipt;
  const coord = auth.sign({ receiptId: rec.receiptId, planHash: planHashOf(rec), actionType: 'interest_exploration', target: '分享', params: { text }, authorizedBy: 'owner', expiresAt: expiry(), nonce: nonce(), scope: 'execute' });
  const share = auth.sign({ receiptId: rec.receiptId, planHash: rec.receiptId, actionType: 'qq.send', target, params: { text }, authorizedBy: 'owner', expiresAt: expiry(), nonce: nonce(), scope: 'send' });
  const done = await call('/api/5.0/run', { tickId: `prod-g3-login-${Date.now()}`, inputRef, purpose, closure, activity, executionPlan: { ...plan, shareAuthorization: share }, tools, authorization: coord });
  out = { receiptId: rec.receiptId, status: done.status, state: done.body?.result?.state, result: done.body?.result?.result || null };
  if (done.status !== 200 || done.body?.result?.state !== 'succeeded') throw new Error(`G3 非成功，不重发: ${done.status} ${JSON.stringify(out)}`);
} finally {
  await call('/api/5.0/features', { g3: false }).catch(() => {});
  await call('/api/5.0/pause', { paused: true }).catch(() => {});
}
out.final = await call('/api/5.0/status');
console.log(JSON.stringify(out, null, 1));
