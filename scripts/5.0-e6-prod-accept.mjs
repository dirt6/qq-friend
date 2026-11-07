// 5.0-E6 生产单次验收：G2 learned 一条、G3 QQ 单目标一条。
// 必须显式 --execute；token/密钥只读文件，不打印。
// 失败不重试；G3 UNKNOWN 不重发。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAuthorizationService } from '../src/autonomous/authorization.js';
import { planHashOf } from '../src/autonomous/coordinator.js';

const args = process.argv.slice(2);
const g2Only = args.includes('--g2-only');
if (!args.includes('--execute')) {
  console.log(JSON.stringify({ ok: true, dryRun: true, note: '未执行；确认后加 --execute' }, null, 1));
  process.exit(0);
}
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const dataDir = path.join(root, 'data');
const base = 'http://127.0.0.1:3210';
const read = (p) => fs.readFileSync(path.join(dataDir, p), 'utf8').trim();
const control = read('5.0-runtime/control-token');
const creds = JSON.parse(read('5.0-runtime/auth-keys.json'));
const auth = createAuthorizationService({ keys: creds.keys, keyId: creds.keyId, nonceFile: creds.nonceFile || '' });
const target = String(JSON.parse(read('config.json')).runtime?.g3Target || '').trim();
if (!/^\d+$/.test(target)) throw new Error('runtime.g3Target 未配置');
const H = { 'x-5.0-token': control, 'content-type': 'application/json' };
const call = async (p, body) => {
  const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: H, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, body: json, text: text.slice(0, 300) };
};
const live = await call('/api/status');
if (live.status !== 200) throw new Error('生产 API 不可达');
if (!g2Only && live.body?.onebot?.connected !== true) throw new Error('OneBot 未连接，停止验收');
const expiry = () => new Date(Date.now() + 3600e3).toISOString();
const nonce = () => crypto.randomBytes(16).toString('base64url');

// ══ G2：learned 一条 ══
let out = {};
await call('/api/5.0/pause', { paused: false });
await call('/api/5.0/features', { g2: true, g3: false, readonly: false });
const intentId = 'deploy-accept-g2-1';
const content = '部署验收：统一运行时已接入，G2 单条写入完成';
const purpose = { ok: true, candidates: [] };
const closure = { ok: true, decision: 'close' };
const g2Activity = { ok: true, decision: 'memory_maintenance', selectedActivity: { type: 'memory_maintenance', title: '整理记忆', risk: 'low' } };
const tools = { memory_maintenance: { schema: { type: 'object' }, maxRuns: 1 } };
const g2Plan = { kind: 'learned', tool: 'memory_maintenance', target: '整理记忆', params: {}, intents: [{ id: intentId, domain: 'learned', content, source: 'autonomous', owner: 'user', epistemicType: 'direct' }], accepted: [{ intentId, status: 'accepted' }] };
const firstG2 = await call('/api/5.0/run', { tickId: 'prod-g2-1', purpose, closure, activity: g2Activity, executionPlan: g2Plan, tools });
if (firstG2.status !== 200 || !firstG2.body?.result?.receipt?.receiptId) throw new Error(`G2 无法创建 receipt: ${firstG2.status} ${firstG2.text}`);
const g2rec = firstG2.body.result.receipt;
const g2auth = auth.sign({ receiptId: g2rec.receiptId, planHash: planHashOf(g2rec), actionType: 'memory_maintenance', target: '整理记忆', params: {}, authorizedBy: 'owner', expiresAt: expiry(), nonce: nonce(), scope: 'execute' });
const doneG2 = await call('/api/5.0/run', { tickId: 'prod-g2-1', purpose, closure, activity: g2Activity, executionPlan: g2Plan, tools, authorization: g2auth });
if (doneG2.status !== 200 || doneG2.body?.result?.state !== 'succeeded') throw new Error(`G2 失败: ${doneG2.status} ${doneG2.text}`);
const learned = JSON.parse(fs.readFileSync(path.join(dataDir, 'learned.json'), 'utf8'));
const item = (learned.items || []).find((x) => String(x.text || '').includes('G2 单条写入完成'));
out.g2 = { receiptId: g2rec.receiptId, learnedId: item?.id || '', merged: item?.origin?.ref || '', state: doneG2.body.result.state };
await call('/api/5.0/features', { g2: false });
await call('/api/5.0/pause', { paused: true });
if (g2Only) {
  out.final = await call('/api/5.0/status');
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

// ══ G3：QQ 单目标一条 ══
await call('/api/5.0/pause', { paused: false });
await call('/api/5.0/features', { g3: true, g2: false, readonly: false });
const text = '我在，E6 运行时验收完成。';
const g3Activity = { ok: true, decision: 'interest_exploration', selectedActivity: { type: 'interest_exploration', title: '分享', risk: 'low' } };
const g3Plan = { kind: 'qq', tool: 'interest_exploration', target: '分享', qqTarget: target, params: { text }, decision: { decision: 'share_now' }, text };
const g3Tools = { interest_exploration: { schema: { type: 'object' }, maxRuns: 1 } };
const firstG3 = await call('/api/5.0/run', { tickId: 'prod-g3-1', purpose, closure, activity: g3Activity, executionPlan: g3Plan, tools: g3Tools });
if (firstG3.status !== 200 || !firstG3.body?.result?.receipt?.receiptId) throw new Error(`G3 无法创建 receipt: ${firstG3.status} ${firstG3.text}`);
const g3rec = firstG3.body.result.receipt;
const coordAuth = auth.sign({ receiptId: g3rec.receiptId, planHash: planHashOf(g3rec), actionType: 'interest_exploration', target: '分享', params: { text }, authorizedBy: 'owner', expiresAt: expiry(), nonce: nonce(), scope: 'execute' });
const shareAuth = auth.sign({ receiptId: g3rec.receiptId, planHash: g3rec.receiptId, actionType: 'qq.send', target, params: { text }, authorizedBy: 'owner', expiresAt: expiry(), nonce: nonce(), scope: 'send' });
const doneG3 = await call('/api/5.0/run', { tickId: 'prod-g3-1', purpose, closure, activity: g3Activity, executionPlan: { ...g3Plan, shareAuthorization: shareAuth }, tools: g3Tools, authorization: coordAuth });
if (doneG3.status !== 200 || doneG3.body?.result?.state !== 'succeeded') throw new Error(`G3 失败/未知，不重发: ${doneG3.status} ${doneG3.text}`);
out.g3 = { receiptId: g3rec.receiptId, state: doneG3.body.result.state, result: doneG3.body.result.result?.result || null };
await call('/api/5.0/features', { g3: false });
await call('/api/5.0/pause', { paused: true });
out.final = await call('/api/5.0/status');
console.log(JSON.stringify(out, null, 1));
