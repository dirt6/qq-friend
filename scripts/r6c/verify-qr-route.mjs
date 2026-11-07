// 临时验证脚本：测二维码路由的实际行为（不启服务）。
process.env.QQ_AGENT_DATA_DIR = 'E:/dsh/QQ-agent/data';

const { createRoutes } = await import('file:///E:/dsh/QQ-agent/src/routes.js');
const routes = createRoutes({});
const qr = routes.find((r) => String(r.pattern) === '/api/napcat/qrcode');

if (!qr) { console.log('✗ 路由没注册'); process.exit(1); }

let out = null;
const json = (o) => { out = o; return o; };
await qr.handler({ json, url: new URL('http://x/api/napcat/qrcode'), req: {}, res: {} });

console.log('=== 实际返回 ===');
if (out && out.ok) {
  console.log('  ok: true');
  console.log('  size:', out.size);
  console.log('  mtime:', out.mtime);
  console.log('  updateVerified:', out.updateVerified);
  console.log('  dataUrl 前 40 字符:', String(out.dataUrl).slice(0, 40) + '...');
  console.log('  dataUrl 总长度:', String(out.dataUrl).length);
  console.log('  note:', out.note);
} else {
  console.log('  ok: false');
  console.log('  code:', out?.code);
  console.log('  error:', out?.error);
}

console.log('');
console.log('=== 安全性检查（源码级）===');
const src = qr.handler.toString();
console.log('  不接受参数（没用 searchParams）:', !src.includes('searchParams'));
console.log('  路径写死 qrcode.png:', src.includes('qrcode.png'));
console.log('  不读 token:', !src.toLowerCase().includes('token'));
console.log('  有路径越界防御:', src.includes('QR_PATH_REJECTED'));
console.log('  校验 PNG 魔数:', src.includes('0x89'));
console.log('  带 updateVerified 标记:', src.includes('updateVerified'));
