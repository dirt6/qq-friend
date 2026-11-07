// 小黑盒（heybox）请求签名 —— hkey / _time / nonce / 设备参数。
//
// 这是从 astrbot_plugin_xiaoheihe_adapter（MIT）的 Python 实现独立移植的，
// 算法本身源自 heybox-core（MIT）。**不是官方 API**：小黑盒没有公开稳定的
// 自动化接口，hkey 随时可能变。所以：
//   · 只放在一个文件里，变了就改这里；
//   · 用 Python 参考实现生成的固定测试向量锁住（见 test/xhh-sign-test.mjs）；
//   · 任何签名错误都表现为服务端拒绝，不要在客户端"猜"。
//
// 算法（与 Python 版逐行对应）：
//   1. 路径规范化成 /a/b/c/（去空段、补前导和结尾斜杠）
//   2. 三路字符分别用不同长度的字母表映射：时间戳用 alphabet[:-2]、路径和 nonce 用完整字母表
//   3. 三路按位交错取前 20 个字符
//   4. md5(交错串) → 取 hex 前 5 位用 alphabet[:-4] 映射（prefix）、后 6 位做 GF(2^8) 混合求和取模 100（两位 suffix）

import { createHash } from 'node:crypto';

const HKEY_ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';

/** 把一个字符串逐字符映射到字母表（按码点取模）。 */
export function mapToAlphabet(value, alphabet = HKEY_ALPHABET) {
  let out = '';
  for (const ch of String(value)) out += alphabet[ch.codePointAt(0) % alphabet.length];
  return out;
}

/** GF(2^8) 上的 x*2（多项式 0x1B，与 AES 同款思路）。溢出必须 & 255 截回字节。 */
function xtime(v) {
  return v & 128 ? (((v << 1) ^ 27) & 255) : v << 1;
}
const mul3 = (v) => xtime(v) ^ v;
const mul4 = (v) => mul3(xtime(v));
const mul8 = (v) => mul4(mul3(xtime(v)));
const mul14 = (v) => mul8(v) ^ mul4(v) ^ mul3(v);

/** 对 md5 末尾 6 个字符做一轮混合。 */
function mixTail(values) {
  const [a, b, c, d] = values;
  return [
    mul14(a) ^ mul8(b) ^ mul4(c) ^ mul3(d),
    mul3(a) ^ mul14(b) ^ mul8(c) ^ mul4(d),
    mul4(a) ^ mul3(b) ^ mul14(c) ^ mul8(d),
    mul8(a) ^ mul4(b) ^ mul3(c) ^ mul14(d),
    ...values.slice(4)
  ];
}

/**
 * 计算 hkey。
 * @param {string} path 请求路径，带不带前导斜杠都行（内部会规范化）
 * @param {number|string} timestamp 秒级时间戳
 * @param {string} nonce 32 位大写十六进制
 */
export function generateHkey(path, timestamp, nonce) {
  const normalized = `/${String(path).split('/').filter(Boolean).join('/')}/`;
  const parts = [
    mapToAlphabet(String(timestamp), HKEY_ALPHABET.slice(0, -2)),
    mapToAlphabet(normalized, HKEY_ALPHABET),
    mapToAlphabet(String(nonce), HKEY_ALPHABET)
  ];
  const maxLen = Math.max(...parts.map((p) => p.length));
  let interleaved = '';
  for (let i = 0; i < maxLen; i += 1) {
    for (const part of parts) if (i < part.length) interleaved += part[i];
  }
  interleaved = interleaved.slice(0, 20);
  const digest = md5Hex(interleaved);
  const mixed = mixTail([...digest.slice(-6)].map((ch) => ch.codePointAt(0)));
  const suffix = String(mixed.reduce((a, b) => a + b, 0) % 100).padStart(2, '0');
  return `${mapToAlphabet(digest.slice(0, 5), HKEY_ALPHABET.slice(0, -4))}${suffix}`;
}

/** 小写 md5（Node / Electron 主进程都有 crypto）。 */
export function md5Hex(text) {
  return createHash('md5').update(String(text)).digest('hex');
}

/** Web 客户端固定环境参数（对照 2026-10 的网页请求）。 */
export const WEB_PARAMS = Object.freeze({
  app: 'heybox',
  os_type: 'web',
  client_type: 'web',
  version: '999.0.4',
  web_version: '2.5',
  x_client_type: 'web',
  x_app: 'heybox_website',
  x_os_type: 'Windows',
  device_info: 'Chrome'
});

/** 生成稳定的 32 位设备 ID。 */
export function generateDeviceId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 生成 nonce（32 位大写十六进制）。 */
export function generateNonce() {
  return generateDeviceId().toUpperCase();
}

/**
 * 给一次请求补齐签名参数。
 *
 * @param {object} o
 * @param {string} o.path        请求路径（用于 hkey）
 * @param {object} o.params      业务参数
 * @param {string} o.deviceId    稳定设备 ID（首次生成后要存起来，换了会被当成新设备）
 * @param {number} [o.now]       秒级时间戳（测试用）
 * @param {string} [o.nonce]     测试用
 * @param {object} [o.env]       Web 参数覆盖（例如评论用 web_version=3.0）
 * @returns {{params: Record<string,string>, timestamp: number, nonce: string}}
 */
export function buildSignedParams({ path, params = {}, deviceId, now, nonce, env = {} }) {
  const timestamp = Number.isFinite(now) ? Math.floor(now) : Math.floor(Date.now() / 1000);
  const nonceValue = String(nonce || generateNonce());
  const out = {};
  for (const [k, v] of Object.entries({ ...WEB_PARAMS, ...env, ...params })) {
    if (v === undefined || v === null) continue;
    out[String(k)] = String(v);
  }
  out._time = String(timestamp);
  out.nonce = nonceValue;
  out.hkey = generateHkey(path, timestamp, nonceValue);
  if (deviceId) out.device_id = String(deviceId);
  return { params: out, timestamp, nonce: nonceValue };
}
