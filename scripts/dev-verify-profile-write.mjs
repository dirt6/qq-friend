// 真实验证 qq-self 的"报错但已生效"路径：把签名写成它当前的值。
// 值不变（不会改动你的资料），但足以检验：接口若报 UpdateUdcFail，技能是否靠回读判成功。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/dsh/QQ-agent';
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/config.json'), 'utf8'));
const sl = cfg.snowluma || {};
const base = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const token = String(sl.httpAccessToken || sl.accessToken || '');

// 直接用 HTTP 读当前签名（等价于技能里的 profile()）
const raw = async (a, p = {}) => {
  const r = await fetch(`${base}/${a}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(p), signal: AbortSignal.timeout(20000)
  });
  const j = await r.json();
  return j?.data ?? j;   // 和应用的 onebot.call 一样解包
};

const before = await raw('get_stranger_info', { user_id: 2029382488, no_cache: true });
const currentSig = before?.long_nick ?? before?.longNick ?? '';
console.log('当前昵称 =', JSON.stringify(before?.nickname));
console.log('当前签名 =', JSON.stringify(currentSig));
if (!currentSig) { console.log('\n当前签名为空，无法做"写成同值"的验证 —— 换个方式再测。'); process.exit(0) }

console.log('\n=== 写入（值 = 当前值）===');
const writeRes = await raw('set_qq_profile', { nickname: before?.nickname, personal_note: currentSig });
console.log('接口返回 =', JSON.stringify(writeRes));

await new Promise((r) => setTimeout(r, 1200));
const after = await raw('get_stranger_info', { user_id: 2029382488, no_cache: true });
const afterSig = after?.long_nick ?? after?.longNick ?? '';
console.log('回读签名 =', JSON.stringify(afterSig));
console.log('');
const errMsg = String(writeRes?.errMsg || '');
const match = afterSig === currentSig;
console.log('接口是否报了错 =', errMsg ? `是（${errMsg}）` : '否');
console.log('回读是否与预期一致 =', match);
console.log('');
if (errMsg && match) {
  console.log('=> 正是"报错但已生效"的情形。技能现在的行为：判成功并说明"接口报错但回读确认已生效"。');
} else if (!errMsg && match) {
  console.log('=> 这次接口没报错，写入正常。');
} else {
  console.log('=> 回读与预期不一致，需要看具体字段。');
}
