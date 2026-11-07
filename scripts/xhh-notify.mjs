// 拉小黑盒通知，对比 message_type=16 / 17，确认 @ 提及的真实结构。
// 用法：node scripts/xhh-notify.mjs

import fs from 'node:fs';
import path from 'node:path';
import { buildSignedParams } from '../plugins/autonomous/lib/xhh/sign.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const AUTH = path.join(ROOT, 'data', 'xhh-auth.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const auth = JSON.parse(fs.readFileSync(AUTH, 'utf8'));
const cookieHeader = Object.entries(auth.cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function get(pathname, params) {
  const { params: signed } = buildSignedParams({
    path: pathname,
    params: { ...params, heybox_id: auth.uid },
    deviceId: auth.deviceId
  });
  const r = await fetch(`https://api.xiaoheihe.cn${pathname}?${new URLSearchParams(signed)}`, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.xiaoheihe.cn/',
      origin: 'https://www.xiaoheihe.cn',
      accept: 'application/json',
      cookie: cookieHeader
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

function summarize(label, j) {
  const body = j?.result || j || {};
  const msgs = body.messages || body.items || body.list || [];
  console.log(`\n【${label}】数组 ${Array.isArray(msgs) ? msgs.length : '?'} 条`);
  if (!Array.isArray(msgs) || !msgs.length) {
    console.log(`  body 键: ${Object.keys(body).join(',') || '(空)'}`);
    return;
  }
  const first = msgs[0];
  console.log(`  首条字段: ${Object.keys(first).join(',')}`);
  const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, typeof o[k] === 'object' ? JSON.stringify(o[k]).slice(0, 80) : String(o[k]).slice(0, 120)]));
  console.log('  关键字段:', JSON.stringify(pick(first, [
    'message_id', 'type', 'message_type', 'comment_a_id', 'comment_b_id',
    'comment_a_text', 'comment_b_text', 'root_comment_id', 'linkid', 'link_id',
    'userid_a', 'user_a', 'user_a_name', 'create_at', 'is_read'
  ]), null, 1));
  const userObj = first.user_a || first.user || first.sender;
  if (userObj && typeof userObj === 'object') {
    console.log('  发送者对象键:', Object.keys(userObj).join(','));
    console.log('    username/nickname/uid:', userObj.username ?? userObj.nickname, userObj.heybox_id ?? userObj.userid ?? userObj.uid);
  }
  // 找正文里有没有 @ 标记
  const raw = JSON.stringify(first);
  const at = raw.match(/@[^"\\]{1,20}/g);
  console.log('  正文中的 @ 片段:', at ? at.slice(0, 3).join(' | ') : '(没有)');
}

for (const [label, params] of [
  ['message_type=16', { message_type: '16', offset: '0', limit: '20', no_more: 'false' }],
  ['message_type=17', { message_type: '17', offset: '0', limit: '20', no_more: 'false' }],
  ['list_type=0', { list_type: '0', offset: '0', limit: '20', no_more: 'false' }]
]) {
  const r = await get('/bbs/app/user/message', params);
  console.log(`\n${label} HTTP=${r.status} status=${r.json?.status ?? '?'}`);
  summarize(label, r.json);
}
