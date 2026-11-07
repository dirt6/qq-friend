// 小黑盒扫码登录（只做登录与凭据保存，不涉及任何写操作）。
//
// 依据：/account/get_qrcode_url/ + /account/qr_state/（匿名），身份用 /bbs/app/api/user/permission。
//
// 用法（沙箱里 Node 不能 spawn 子进程，所以拆成两段，由外面用 pwsh 串起来）：
//   node scripts/xhh-login.mjs --qr     请求二维码，把 qr_url 写到 data/xhh-qr.txt（不轮询）
//   python scripts/xhh-qr.py <qr_url> data/xhh-qrcode.svg    本地渲染二维码
//   node scripts/xhh-login.mjs --poll   轮询状态；成功后保存凭据并校验身份
//
// 安全约定：
//   · 只在本地生成二维码，绝不把登录 URL 交给在线二维码服务；
//   · 凭据写到 data/xhh-auth.json，不打印、不写日志、不进 git；
//   · 轮询只在内存里跑，失败不重试登录，超时就让人重新扫。

import fs from 'node:fs';
import path from 'node:path';
import { buildSignedParams, generateDeviceId } from '../plugins/autonomous/lib/xhh/sign.js';

const API = 'https://api.xiaoheihe.cn';
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const DATA = path.join(ROOT, 'data');
const AUTH_FILE = path.join(DATA, 'xhh-auth.json');
const QR_TXT = path.join(DATA, 'xhh-qr.txt');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadAuth() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function saveAuth(auth) {
  fs.mkdirSync(DATA, { recursive: true });
  const tmp = `${AUTH_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(auth, null, 2), 'utf8');
  fs.renameSync(tmp, AUTH_FILE);
}

async function signedGet(pathname, params = {}, deviceId) {
  const { params: signed } = buildSignedParams({ path: pathname, params, deviceId });
  const url = `${API}${pathname}?${new URLSearchParams(signed)}`;
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.xiaoheihe.cn/',
      origin: 'https://www.xiaoheihe.cn',
      accept: 'application/json, text/plain, */*'
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON 时保留原文 */ }
  const cookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  return { status: res.status, json, text, cookies };
}

/** 从 Set-Cookie 头里抽出 name=value（忽略属性）。 */
function cookiePairs(setCookieList) {
  const out = {};
  for (const raw of setCookieList || []) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) out[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return out;
}

/** 第一段：只请求二维码，把后续轮询需要的东西落盘。 */
async function requestQr() {
  fs.mkdirSync(DATA, { recursive: true });
  const prev = loadAuth();
  const deviceId = prev?.deviceId || generateDeviceId();
  console.log(`设备 ID：${deviceId.slice(0, 8)}…（${prev?.deviceId ? '复用已有' : '新生成'}）`);

  const qr = await signedGet('/account/get_qrcode_url/', {}, deviceId);
  const body = qr.json?.result || qr.json?.data || qr.json || {};
  const qrContent = String(body?.qr_url || body?.qrcode || body?.url || '');
  if (qr.status !== 200 || !qrContent) {
    console.log(`✗ 取二维码失败：HTTP ${qr.status} ${String(qr.text).slice(0, 160)}`);
    process.exit(1);
  }
  const expire = Number(body?.expire) > 0 ? Number(body.expire) : 120;
  const pollParams = Object.fromEntries(new URL(qrContent).searchParams.entries());
  fs.writeFileSync(QR_TXT, JSON.stringify({ deviceId, qrContent, pollParams, expire, at: Date.now() }, null, 1), 'utf8');
  // 再存一份纯 URL，方便 bat 直接读取（避免在 cmd 里嵌套 node -e）
  fs.writeFileSync(path.join(DATA, 'xhh-qr-url.txt'), qrContent, 'utf8');
  console.log(`✓ 二维码已获取（有效期 ${expire}s），轮询参数：${Object.keys(pollParams).join(',')}`);
  console.log(`✓ 已写入 ${QR_TXT}`);
  console.log(`  ${qrContent}`);
}

/** 第二段：轮询直到成功/过期，成功后保存凭据并校验身份。 */
async function pollLogin() {
  const info = JSON.parse(fs.readFileSync(QR_TXT, 'utf8'));
  const { deviceId, pollParams, expire } = info;
  const prev = loadAuth();
  const deadline = Date.now() + (Number(expire) || 120) * 1000 + 20000;
  let lastState = '';

  console.log(`开始轮询（二维码发布于 ${new Date(info.at).toLocaleTimeString('zh-CN', { hour12: false })}）…`);
  while (Date.now() < deadline) {
    await sleep(2000);
    let r;
    try {
      r = await signedGet('/account/qr_state/', pollParams, deviceId);
    } catch (e) {
      console.log(`  轮询出错（${e?.message ?? e}），继续等…`);
      continue;
    }
    const b = r.json?.result || r.json?.data || r.json || {};
    // 实测结构：{"status":"ok","result":{"error_msg":"","error":"wait"}}
    // 状态其实在 result.error 里。已知取值（2026-10-21 实测）：
    //   wait   等待扫码
    //   ready  已扫码，等手机上点「确认登录」
    //   cancel 二维码过期/取消
    // 成功值尚未亲眼见到，下面把常见的都收进来，并打印原始响应兜底。
    const raw = String(b.state ?? b.status ?? b.qr_state ?? b.error ?? b.err ?? b.error_msg ?? '').toLowerCase();
    const msg = String(b.message ?? b.msg ?? (b.error && b.error !== raw ? '' : b.error_msg) ?? '');
    let state;
    if (['0', 'wait', 'waiting', 'waiting_scan'].includes(raw)) state = 'waiting';
    else if (['1', 'ready', 'scan', 'scanned', 'confirm'].includes(raw)) state = 'scanned';
    else if (['2', 'success', 'ok', 'login', 'confirmed', 'logined'].includes(raw)) state = 'success';
    else if (['3', 'cancel', 'expired', 'timeout'].includes(raw)) state = 'expired';
    else if (['-1', 'failed', 'error', 'fail'].includes(raw)) state = 'failed';
    else state = raw ? `unknown(${raw})` : 'unknown';
    // 每次都打原始响应：扫码/确认那两步到底返回什么，只能靠这个看
    const cookieNames = (r.cookies || []).map((x) => String(x).split(';')[0].split('=')[0]).join(',');
    console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} raw=${JSON.stringify(b).slice(0, 150)}${cookieNames ? ` set-cookie=[${cookieNames}]` : ''}`);
    if (state !== lastState) {
      const label = {
        waiting: '等待扫码',
        scanned: '已扫码 —— 请在小黑盒 App 里点「确认登录」',
        success: '登录成功',
        expired: '二维码已过期/已取消',
        failed: '失败'
      }[state] || state;
      console.log(`  ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} 状态：${label}${msg ? `（${msg}）` : ''}`);
      if (state !== 'waiting' && state !== 'scanned') console.log(`    原始：${JSON.stringify(b).slice(0, 240)}`);
      lastState = state;
    }
    if (state === 'expired') { console.log('✗ 二维码过期，重新运行 --qr。'); process.exit(2); }
    if (state === 'failed') { console.log(`✗ 登录失败：${msg || '未说明原因'}`); process.exit(3); }
    if (state === 'success') {
      const cookies = { ...(prev?.cookies || {}), ...cookiePairs(r.cookies) };
      const uid = String(b.uid ?? b.heybox_id ?? b.user?.heybox_id ?? b.account?.heybox_id ?? b.profile?.heybox_id ?? '');
      const nickname = String(b.nickname ?? b.user?.nickname ?? b.account?.nickname ?? b.profile?.nickname ?? '');
      saveAuth({
        uid,
        nickname,
        deviceId,
        cookies,
        cookieNames: Object.keys(cookies),
        loggedInAt: new Date().toISOString(),
        source: 'qr-login'
      });
      console.log(`✓ 凭据已保存到 ${AUTH_FILE}`);
      console.log(`  uid=${uid || '（响应没给，用身份接口确认）'} 昵称=${nickname || '（同上）'} Cookie ${Object.keys(cookies).length} 个：${Object.keys(cookies).join(',') || '（空）'}`);
      await verify(deviceId, cookies);
      return;
    }
  }
  console.log('✗ 等待超时。重新生成二维码即可，不要在超时后重复轮询。');
  process.exit(4);
}

async function verify(deviceId, cookies) {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const { params } = buildSignedParams({ path: '/bbs/app/api/user/permission', deviceId });
  const url = `${API}/bbs/app/api/user/permission?${new URLSearchParams(params)}`;
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
  const b = json?.result || json?.data || json || {};
  const ok = String(json?.status || '').toLowerCase() === 'ok';
  console.log(`\n身份校验：HTTP ${r.status} status=${json?.status ?? '?'} ${ok ? '✓ 登录态可用' : '✗ 可能未生效'}`);
  console.log(`  ${JSON.stringify({ nickname: b.nickname ?? b.user?.nickname, heybox_id: b.heybox_id ?? b.user?.heybox_id ?? b.uid }).slice(0, 240)}`);
  if (!ok) console.log('  ⚠️ 身份接口没认这份 Cookie：检查 Cookie 名，或重新扫码。');
}

const isPoll = process.argv.includes('--poll');
(isPoll ? pollLogin() : requestQr()).catch((e) => {
  console.log(`✗ 未处理异常：${e?.message ?? e}`);
  process.exit(9);
});
