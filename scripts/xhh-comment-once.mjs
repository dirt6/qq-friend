// 小黑盒评论 API 单次实测（需要显式 --confirm）。
//
// 目的是验证“带浏览器会话 token 的评论 API 是否可行”，只发一条，失败不重发。
// 不打印任何凭据值；token 只在内存里，不落盘。
//
// 用法：
//   node scripts/xhh-comment-once.mjs --link-id e4db725f0b4e --text "..." --confirm [--headed]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildSignedParams } from '../plugins/autonomous/lib/xhh/sign.js';

const argv = process.argv.slice(2);
const flag = (name, def = '') => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? '') : def; };
const linkId = String(flag('--link-id')).replace(/[^0-9a-zA-Z]/g, '');
const text = String(flag('--text')).trim();
const confirmed = argv.includes('--confirm');
const headed = argv.includes('--headed');
if (!linkId || !text) { console.error('用法: ... --link-id <id> --text "..." --confirm'); process.exit(2); }
if (!confirmed) { console.error('需要 --confirm 才发送（默认只做参数检查）'); process.exit(2); }
if (text.length > 500) { console.error('评论太长'); process.exit(2); }
if (!/^[0-9a-zA-Z]{4,64}$/.test(linkId)) { console.error('link_id 非法'); process.exit(2); }

const authFile = path.resolve('data/xhh-auth.json');
const credFile = path.join(os.homedir(), '.heybox-ai', 'credentials.json');
const out = { ok: false, linkId, textChars: text.length };
let browser = null;
try {
  const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const baseCookies = { ...(cred.cookies || {}), ...(auth.cookies || {}) };
  out.uid = String(auth.uid || '').slice(0, 20);
  out.hasDeviceId = Boolean(auth.deviceId);

  // 1) 浏览器会话 token（只在内存里用）
  browser = await chromium.launchPersistentContext(path.resolve('data/xhh-edge-profile'), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: !headed,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  await browser.addCookies(Object.entries(cred.cookies || {}).map(([name, value]) => ({ name, value: String(value), domain: '.xiaoheihe.cn', path: '/' })));
  const page = browser.pages()[0] || await browser.newPage();
  await page.goto(`https://www.xiaoheihe.cn/app/bbs/link/${linkId}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(4500);
  const jar = await browser.cookies('https://www.xiaoheihe.cn');
  const token = jar.find((c) => c.name === 'x_xhh_tokenid')?.value || '';
  out.hasToken = Boolean(token);
  await browser.close();
  browser = null;
  if (!token) { console.log(JSON.stringify({ ...out, error: '没有拿到 x_xhh_tokenid，未发送' }, null, 1)); process.exit(3); }

  const cookies = { ...baseCookies, x_xhh_tokenid: token };
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

  // 2) 签名（与旧实现一致：_rnd 进 query 和 body）
  const params = {
    is_cy: '0',
    link_id: linkId,
    reply_id: '-1',
    root_id: '-1',
    text,
    _rnd: `15:${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`
  };
  const withUid = { ...params, heybox_id: String(auth.uid || '') };
  const { params: signed } = buildSignedParams({ path: '/bbs/app/comment/create', params: withUid, deviceId: auth.deviceId });
  signed._rnd = params._rnd;

  // 3) 只发一次
  const res = await fetch(`https://workshopapi.xiaoheihe.cn/bbs/app/comment/create?${new URLSearchParams(signed).toString()}`, {
    method: 'POST',
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      referer: 'https://www.xiaoheihe.cn/',
      origin: 'https://www.xiaoheihe.cn',
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: cookieHeader
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20000)
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch { /* ignore */ }
  out.httpStatus = res.status;
  out.apiStatus = String(json?.status || '');
  out.apiMsg = String(json?.msg || '').slice(0, 160);
  out.commentId = String(json?.result?.comment_id || json?.result?.comment?.comment_id || json?.result?.id || '');
  out.ok = Boolean(json && String(json.status || '').toLowerCase() !== 'failed' && json.result);
  console.log(JSON.stringify(out, null, 1));
} catch (e) {
  out.error = String(e?.message || e).slice(0, 200);
  console.log(JSON.stringify(out, null, 1));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
}
