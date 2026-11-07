// 小黑盒浏览器评论通道：备用号登录态 + 有头 Edge。
// 默认只填入评论、不点发送；只有显式 --send 才点发送。
// 用法：
//   node scripts/xhh-browser-comment.mjs --link-id 123 --text "..." [--send] [--headless]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const argv = process.argv.slice(2);
const flag = (name, def = '') => { const i = argv.indexOf(name); return i >= 0 ? (argv[i + 1] ?? '') : def; };
const has = (name) => argv.includes(name);
const linkId = String(flag('--link-id')).trim();
const text = String(flag('--text')).trim();
const doSend = has('--send');
const headless = has('--headless');
const holdSeconds = Math.max(0, Number(flag('--hold-seconds', '180')) || 0);
if (!linkId || !text) {
  console.error('用法: node scripts/xhh-browser-comment.mjs --link-id <id> --text "..." [--send] [--headless]');
  process.exit(2);
}
if (text.length > 500) { console.error('评论太长'); process.exit(2); }

const credFile = path.join(os.homedir(), '.heybox-ai', 'credentials.json');
const cred = JSON.parse(fs.readFileSync(credFile, 'utf8'));
const cookies = Object.entries(cred.cookies || {}).map(([name, value]) => ({ name, value: String(value), domain: '.xiaoheihe.cn', path: '/' }));
const profile = path.resolve('data/xhh-edge-profile');
const browser = await chromium.launchPersistentContext(profile, {
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless,
  viewport: { width: 1280, height: 900 },
  args: ['--start-maximized', '--disable-blink-features=AutomationControlled']
});
await browser.addCookies(cookies);
const page = browser.pages()[0] || await browser.newPage();
const url = `https://www.xiaoheihe.cn/app/bbs/link/${linkId}`;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(4500);
const editor = page.locator('.ProseMirror.hb-editor').first();
if (await editor.count() === 0) {
  await page.screenshot({ path: 'data/xhh-comment-need-login.png', fullPage: true });
  console.log('NEED_LOGIN_OR_EDITOR_NOT_FOUND screenshot=data/xhh-comment-need-login.png');
  if (!headless) await page.waitForTimeout(Math.min(holdSeconds, 300) * 1000);
  await browser.close();
  process.exit(3);
}
await editor.click();
// 先清空，再模拟输入；ProseMirror 对 execCommand 的兼容比 fill 好。
await page.evaluate(() => {
  const el = document.querySelector('.ProseMirror.hb-editor');
  if (el) { el.focus(); document.execCommand('selectAll', false, null); document.execCommand('delete', false, null); }
});
await page.evaluate((t) => document.execCommand('insertText', false, t), text);
await page.waitForTimeout(500);
const actual = String(await editor.innerText()).trim();
const preview = 'data/xhh-comment-preview.png';
await page.screenshot({ path: preview, fullPage: true });
const sendBtn = page.locator('button.link-reply__menu-btn.hb-color__btn--confirm').first();
console.log(JSON.stringify({ ok: true, filled: actual === text, chars: actual.length, preview, sendVisible: await sendBtn.count() > 0, sent: false }));
if (doSend) {
  if (await sendBtn.count() === 0) { console.log('SEND_BUTTON_NOT_FOUND'); await browser.close(); process.exit(4); }
  await sendBtn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'data/xhh-comment-sent.png', fullPage: true });
  console.log(JSON.stringify({ sent: true, screenshot: 'data/xhh-comment-sent.png', url: page.url() }));
  await browser.close();
  process.exit(0);
}
console.log('FILLED_ONLY：窗口保持打开，请检查后手动点发送；不自动发送。');
if (!headless && holdSeconds > 0) await page.waitForTimeout(holdSeconds * 1000);
await browser.close();
