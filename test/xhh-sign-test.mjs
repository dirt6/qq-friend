// 小黑盒 hkey 签名的移植验证。
//
// 判据：与 astrbot_plugin_xiaoheihe_adapter 的 Python 参考实现逐字节一致。
// 期望值由 Python 版（request_signing.generate_hkey）对固定输入算出，写死在这里当回归基准。
// 这些向量不含任何账号信息，只是算法输入/输出。
import { generateHkey, mapToAlphabet, buildSignedParams, WEB_PARAMS, md5Hex } from '../plugins/autonomous/lib/xhh/sign.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` -> ${extra}` : ''}`); }
};

console.log('=== 一、hkey 与 Python 参考实现对比 ===');
{
  const vectors = [
    ['/bbs/app/feeds', 1792600000, 'C8B6CB8884949DDE30311CC2281A9642', 'WTUX280'],
    ['/bbs/app/api/general/search/v1', 1792600001, 'A1B2C3D4E5F60718293A4B5C6D7E8F90', 'YP13Z81'],
    ['/bbs/app/link/tree', 1792600002, '0123456789ABCDEF0123456789ABCDEF', 'PXWPY09'],
    ['account/get_qrcode_url/', 1792600003, 'FFEEDDCCBBAA99887766554433221100', 'ZWPXY40']
  ];
  for (const [path, ts, nonce, expected] of vectors) {
    const got = generateHkey(path, ts, nonce);
    ok(`hkey(${path}) === ${expected}`, got === expected, got);
  }
}

console.log('\n=== 二、路径规范化 ===');
{
  // 带不带前导/结尾斜杠、多斜杠，都必须归一到同一结果
  const a = generateHkey('/bbs/app/feeds', 1792600000, 'C8B6CB8884949DDE30311CC2281A9642');
  const b = generateHkey('bbs/app/feeds/', 1792600000, 'C8B6CB8884949DDE30311CC2281A9642');
  const c = generateHkey('//bbs//app//feeds//', 1792600000, 'C8B6CB8884949DDE30311CC2281A9642');
  ok('前导斜杠不影响', a === b);
  ok('多余斜杠被折叠', a === c);
}

console.log('\n=== 三、字母表映射 ===');
{
  ok('空串映射为空', mapToAlphabet('') === '');
  ok('映射长度一致', mapToAlphabet('abc123') .length === 6);
  ok('映射结果是纯字母表字符', /^[AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89]+$/.test(mapToAlphabet('中文abc')));
}

console.log('\n=== 四、签名参数装配 ===');
{
  const r = buildSignedParams({
    path: '/bbs/app/feeds',
    params: { pull: 0, offset: 0 },
    deviceId: '2c2fef8385ccef915e3b3caf94e3aa06',
    now: 1792600000,
    nonce: 'C8B6CB8884949DDE30311CC2281A9642'
  });
  ok('带 _time', r.params._time === '1792600000');
  ok('带 nonce', r.params.nonce === 'C8B6CB8884949DDE30311CC2281A9642');
  ok('hkey 与直接计算一致', r.params.hkey === generateHkey('/bbs/app/feeds', 1792600000, 'C8B6CB8884949DDE30311CC2281A9642'));
  ok('设备 ID 带上了', r.params.device_id === '2c2fef8385ccef915e3b3caf94e3aa06');
  ok('业务参数保留', r.params.pull === '0' && r.params.offset === '0');
  ok('Web 环境参数齐全', r.params.app === 'heybox' && r.params.os_type === 'web' && r.params.x_app === 'heybox_website');
  ok('环境可覆盖（评论用 3.0）', buildSignedParams({ path: '/x', deviceId: 'd', env: { web_version: '3.0' }, now: 1, nonce: 'A' }).params.web_version === '3.0');
  ok('不把 undefined 写成字符串', buildSignedParams({ path: '/x', params: { q: undefined }, deviceId: 'd', now: 1, nonce: 'A' }).params.q === undefined);
}

console.log('\n=== 五、随机性 ===');
{
  const a = buildSignedParams({ path: '/bbs/app/feeds', deviceId: 'd1' });
  const b = buildSignedParams({ path: '/bbs/app/feeds', deviceId: 'd1' });
  ok('两次 nonce 不同', a.nonce !== b.nonce);
  ok('两次 hkey 不同', a.params.hkey !== b.params.hkey);
  ok('nonce 是 32 位十六进制', /^[0-9A-F]{32}$/.test(a.nonce), a.nonce);
  ok('md5 可用', md5Hex('abc') === '900150983cd24fb0d6963f7d28e17f72');
}

console.log(`\n${fail ? '✗ 失败' : '✓ 全部通过'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
