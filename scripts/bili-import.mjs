// 从 B 站网页登录态导入 Cookie（评论/回复需要）。
//
// 用法：
//   1. 浏览器登录 https://www.bilibili.com/
//   2. F12 → Application → Storage → Cookies → https://www.bilibili.com
//   3. 找到 SESSDATA、bili_jct、DedeUserID，把「名称=值」逐行贴到 data/bili-cookie.txt
//      （也可以直接粘 Network 里整段 Cookie 请求头，或者「Copy as cURL」）
//   4. node scripts/bili-import.mjs
//      → 生成 data/bili-auth.json，然后删掉 data/bili-cookie.txt
//
// 为什么必须要这两个：
//   · SESSDATA 是登录票据，没有它 /x/v2/reply/add 会返回 -101；
//   · bili_jct 同时是 CSRF token，写接口的 csrf 参数就是它，缺了报 -111。
//
// 安全：Cookie 只从本地文件读，不打印完整值，只报名字和长度。

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const COOKIE_TXT = path.join(DATA, 'bili-cookie.txt');
const AUTH_FILE = path.join(DATA, 'bili-auth.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 三种粘贴方式都认：逐行 name=value / 整段 Cookie 头 / Copy as cURL。
 *  额外兼容「名字 空格 值」的写法（F12 里手工抄经常是这样，2026-10-24 实际遇到）。 */
function parseCookieFile() {
  const text = fs.readFileSync(COOKIE_TXT, 'utf8');
  const out = {};
  const put = (name, value) => {
    const n = String(name).trim().replace(/^["']|["']$/g, '');
    const v = String(value).trim().replace(/^["']|["']$/g, '');
    if (!/^[A-Za-z0-9_.\-]+$/.test(n) || !v) return;
    out[n] = v;
  };
  const curl = text.match(/-H\s+['"]cookie:\s*([^'"]+)['"]/i) || text.match(/-b\s+['"]([^'"]+)['"]/i);
  const source = curl ? curl[1] : text;
  for (const line of source.split(/\r?\n/)) {
    const t = line.trim().replace(/^cookie:\s*/i, '');
    if (!t || t.startsWith('#')) continue;
    for (const part of t.split(';')) {
      const seg = part.trim();
      if (!seg) continue;
      const eq = seg.indexOf('=');
      if (eq > 0) { put(seg.slice(0, eq), seg.slice(eq + 1)); continue; }
      // 没有 = 时按第一段空白/冒号分：`SESSDATA   xxxx`
      const m = seg.match(/^(\S+)[\s:]+(\S.*)$/);
      if (m) put(m[1], m[2]);
    }
  }
  return out;
}

if (!fs.existsSync(COOKIE_TXT)) {
  console.log(`✗ 没有找到 ${COOKIE_TXT}`);
  console.log('  先按文件头的说明把 Cookie 贴进去，再跑这个脚本。');
  process.exit(1);
}

const cookies = parseCookieFile();
const names = Object.keys(cookies);
if (!names.length) {
  console.log(`✗ ${COOKIE_TXT} 里没有读到任何 name=value`);
  process.exit(1);
}
console.log(`读到 ${names.length} 个 Cookie：${names.join(', ')}`);
for (const n of names) console.log(`  ${n}: 长度 ${cookies[n].length}`);

if (!cookies.SESSDATA) {
  console.log('\n✗ 缺 SESSDATA —— 没有它连登录态都没有，评论会被拒（-101）。');
  process.exit(2);
}
if (!cookies.bili_jct) {
  console.log('\n✗ 缺 bili_jct —— 它是写接口的 CSRF token，没有它评论会被拒（-111）。');
  process.exit(2);
}

const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function get(pathname, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const r = await fetch(`https://api.bilibili.com${pathname}${qs ? `?${qs}` : ''}`, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      cookie: cookieHeader
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

const nav = await get('/x/web-interface/nav');
const d = nav.json?.data || {};
console.log(`\n身份检查：HTTP ${nav.status} code=${nav.json?.code ?? '?'} isLogin=${d.isLogin}`);
console.log(`  uname=${d.uname || '?'} mid=${d.mid || '?'} 等级=${d.level ?? '?'}`);

if (!d.isLogin) {
  console.log('✗ 这份 Cookie 没通过登录校验（isLogin=false）。可能复制不全或已过期。');
  console.log(`  原始响应前 200 字：${String(nav.text).slice(0, 200)}`);
  process.exit(3);
}

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(AUTH_FILE, JSON.stringify({
  uid: String(d.mid || cookies.DedeUserID || ''),
  nickname: String(d.uname || ''),
  cookies,
  cookieNames: names,
  loggedInAt: new Date().toISOString(),
  source: 'cookie-import'
}, null, 2), 'utf8');
console.log(`\n✓ 已保存到 ${AUTH_FILE}（uid=${d.mid}，昵称=${d.uname}）`);

// 导入完把明文 Cookie 删掉（机主要求：等同账号凭证，不留在盘上）
try {
  fs.rmSync(COOKIE_TXT, { force: true });
  console.log('✓ 已删除 data/bili-cookie.txt');
} catch (e) {
  console.log(`! 删除 data/bili-cookie.txt 失败：${e.message}`);
}

// 顺手确认评论区可读（读接口不需要登录，但能验证 aid 链路）
const view = await get('/x/web-interface/view', { bvid: 'BV1xwnE6jEUZ' });
console.log(`\n读链路自检：view code=${view.json?.code ?? '?'} title=${String(view.json?.data?.title || '').slice(0, 30)}`);
