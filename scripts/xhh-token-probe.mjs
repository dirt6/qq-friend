// 小黑盒会话 token 只读探测（不评论、不点赞、不打印任何凭据值）。
//
// 目的：验证持久化 Edge profile 里有没有浏览器会话 token（x_xhh_tokenid），
// 以判断“自动回复走 API”是否可行。只输出键名/布尔，不输出值。
//
// 用法：node scripts/xhh-token-probe.mjs [--link-id 123] [--headful]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const linkId = String(argv[argv.indexOf('--link-id') + 1] || '').trim();
const isLink = argv.includes('--link-id') && /^\d+$/.test(linkId);
const headful = argv.includes('--headful');
const credFile = path.join(os.homedir(), '.heybox-ai', 'credentials.json');
const profile = path.resolve('data/xhh-edge-profile');
const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const out = { ok: false, profileExists: fs.existsSync(profile), credentialFile: fs.existsSync(credFile), linkId: isLink ? linkId : '' };
let browser = null;
try {
  const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
  const cookies = Object.entries(cred.cookies || {}).map(([name, value]) => ({ name, value: String(value), domain: '.xiaoheihe.cn', path: '/' }));
  out.injectedCookies = cookies.map((c) => c.name);
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: !headful,
    viewport: { width: 1280, height: 900 },
    args: ['--disable-blink-features=AutomationControlled']
  });
  await browser.addCookies(cookies);
  const page = browser.pages()[0] || await browser.newPage();
  const url = isLink ? `https://www.xiaoheihe.cn/app/bbs/link/${linkId}` : 'https://www.xiaoheihe.cn/app/bbs';
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(5500);
  const info = await page.evaluate(() => {
    const keys = Object.keys(localStorage).sort();
    const sKeys = Object.keys(sessionStorage).sort();
    const cookieNames = document.cookie.split(';').map((s) => s.split('=')[0].trim()).filter(Boolean);
    const tokenish = [...keys, ...sKeys].filter((k) => /token|auth|session|login|heybox|xhh/i.test(k));
    return {
      storageKeys: keys.length,
      sessionKeys: sKeys.length,
      tokenishKeys: tokenish,
      cookieCount: cookieNames.length,
      cookieNames,
      hasEditor: !!document.querySelector('.ProseMirror.hb-editor'),
      hasSendBtn: !!document.querySelector('button.link-reply__menu-btn'),
      title: String(document.title || '').slice(0, 60)
    };
  });
  Object.assign(out, info, { ok: true });
  // 用浏览器里拿到的会话 cookie 做一次**只读**登录态验证（不评论、不发帖）。
  try {
    const jar = await browser.cookies('https://www.xiaoheihe.cn');
    const tokenCookie = jar.find((c) => c.name === 'x_xhh_tokenid');
    out.hasXhhToken = Boolean(tokenCookie?.value);
    if (tokenCookie?.value) {
      const { HeyboxClient } = await import('../node_modules/dsh-heybox/tools/lib/http.mjs');
      const base = { ...(cred.cookies || {}) };
      const merged = { ...base, x_xhh_tokenid: tokenCookie.value };
      const params = { offset: 0, limit: 5, no_more: 'false', list_type: '0' };
      const probe = async (jar) => {
        try {
          const client = new HeyboxClient({ cookies: jar, interval: 700, timeout: 20000 });
          const d = await client.request({ path: '/bbs/app/user/message', params });
          return { status: String(d?.status || ''), ok: d?.status === 'ok', count: (d?.result?.messages || []).length };
        } catch (e) {
          return { error: String(e?.message || e).slice(0, 120) };
        }
      };
      out.apiPkeyOnly = await probe(base);
      out.apiWithXhhToken = await probe(merged);
    }
  } catch (e) {
    out.apiError = String(e?.message || e).slice(0, 160);
  }
} catch (e) {
  out.error = String(e?.message || e).slice(0, 200);
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
}
console.log(JSON.stringify(out, null, 1));
