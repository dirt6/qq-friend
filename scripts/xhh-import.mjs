// 从小黑盒网页登录态导入 Cookie（扫码路的备用方案）。
//
// 用法：
//   1. 浏览器登录 https://www.xiaoheihe.cn/
//   2. F12 → Application → Storage → Cookies → https://www.xiaoheihe.cn
//   3. 找到 user_pkey、user_heybox_id，把「名称=值」逐行贴到 data/xhh-cookie.txt
//      （格式就是两行：user_pkey=xxxx / user_heybox_id=xxxx）
//   4. node scripts/xhh-import.mjs
//
// 安全：Cookie 只从本地文件读，不打印完整值，只报告名字和长度。
import fs from 'node:fs';
import path from 'node:path';
import { buildSignedParams, generateDeviceId } from '../plugins/autonomous/lib/xhh/sign.js';

const API = 'https://api.xiaoheihe.cn';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const COOKIE_TXT = path.join(DATA, 'xhh-cookie.txt');
const AUTH_FILE = path.join(DATA, 'xhh-auth.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function parseCookieFile() {
  const text = fs.readFileSync(COOKIE_TXT, 'utf8');
  const out = {};
  const put = (name, value) => {
    const n = String(name).trim().replace(/^["']|["']$/g, '');
    const v = String(value).trim().replace(/^["']|["']$/g, '');
    if (!/^[A-Za-z0-9_.\-]+$/.test(n) || !v) return;
    out[n] = v;
  };
  // 三种粘贴方式都认：
  //   ① 每行一个 name=value
  //   ② 直接粘 Network 里的整段 Cookie 头（name=value; name2=value2; …）
  //   ③ 粘 DevTools「Copy as cURL」的整条命令（从 -H 'cookie: …' 或 -b '…' 里抠）
  // 额外兼容「名字 空格 值」：F12 里手工抄经常是这样（2026-10-24 实际遇到）。
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
      const m = seg.match(/^(\S+)[\s:]+(\S.*)$/);
      if (m) put(m[1], m[2]);
    }
  }
  return out;
}

const cookies = parseCookieFile();
const names = Object.keys(cookies);
if (!names.length) {
  console.log(`✗ ${COOKIE_TXT} 里没有读到任何 name=value`);
  process.exit(1);
}
console.log(`读到 ${names.length} 个 Cookie：${names.join(', ')}`);
for (const n of names) console.log(`  ${n}: 长度 ${cookies[n].length}`);

const auth = (() => {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
})();
const deviceId = auth?.deviceId || generateDeviceId();

const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');

async function call(pathname, params = {}) {
  const { params: signed } = buildSignedParams({ path: pathname, params, deviceId });
  const url = `${API}${pathname}?${new URLSearchParams(signed)}`;
  const r = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.xiaoheihe.cn/',
      origin: 'https://www.xiaoheihe.cn',
      accept: 'application/json, text/plain, */*',
      cookie: cookieHeader
    },
    signal: AbortSignal.timeout(15000)
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  return { status: r.status, json, text };
}

const perm = await call('/bbs/app/api/user/permission', {
  // 参考实现里认证请求会自动带 heybox_id（= user_heybox_id），这里照做
  ...(cookies.user_heybox_id ? { heybox_id: cookies.user_heybox_id } : {})
});
console.log(`\n身份检查：HTTP ${perm.status} status=${perm.json?.status ?? '（无 status 字段，正常）'}`);
const body = perm.json?.result || perm.json?.data || perm.json || {};
const uid = String(body.heybox_id ?? body.uid ?? body.user?.heybox_id ?? body.account?.heybox_id ?? cookies.user_heybox_id ?? '');
const nickname = String(body.nickname ?? body.user?.nickname ?? body.account?.nickname ?? '');
console.log(`  uid=${uid || '?'} 昵称=${nickname || '（此接口不返回昵称）'}`);
console.log(`  权限字段 ${Object.keys(body).length} 个：${Object.keys(body).slice(0, 6).join(', ')}…`);

// 这个接口成功时返回权限字典而不是 {status:ok}，所以判据是：HTTP 200 + 有权限字段 + 不是 failed
const permKeys = Object.keys(body);
const ok = perm.status === 200
  && permKeys.length > 0
  && !/failed|error/i.test(String(perm.json?.status || ''))
  && permKeys.some((k) => /permission|permit/i.test(k));
if (!ok) {
  console.log('✗ 身份接口没认这份 Cookie。可能：Cookie 复制不完整（少了 user_pkey 的值），或已过期。');
  console.log(`  原始响应前 200 字：${String(perm.text).slice(0, 200)}`);
  process.exit(2);
}

fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(AUTH_FILE, JSON.stringify({
  uid,
  nickname,
  deviceId,
  cookies,
  cookieNames: Object.keys(cookies),
  loggedInAt: new Date().toISOString(),
  source: 'cookie-import'
}, null, 2), 'utf8');
console.log(`\n✓ 已保存到 ${AUTH_FILE}`);

// 顺手用登录态跑一次真实搜索，确认整条链路可用
const search = await call('/bbs/app/api/general/search/v1', { q: '游戏', search_type: 'link', offset: '0', limit: '3' });
const sb = search.json?.result || search.json?.data || search.json || {};
const list = sb.links || sb.list || sb.result || [];
console.log(`\n搜索验证：HTTP ${search.status} status=${search.json?.status ?? '?'} 条目 ${Array.isArray(list) ? list.length : '?'}`);
if (Array.isArray(list) && list.length) {
  console.log(`  首条字段：${Object.keys(list[0]).slice(0, 18).join(', ')}`);
}
