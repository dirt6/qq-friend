// 小黑盒扫码登录：生成二维码 PNG，轮询直到成功/过期。
// 凭据由 dsh-heybox 写入 ~/.heybox-ai/credentials.json，不打印 Cookie。
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { startQrLogin, pollQrLogin } from '../node_modules/dsh-heybox/tools/lib/qrlogin.mjs';

const out = path.resolve('data/xhh-login-qr.png');
const { qrUrl, token, expire } = await startQrLogin();
await QRCode.toFile(out, qrUrl, { width: 420, margin: 2 });
console.log(`QR=${out}`);
console.log(`EXPIRE=${expire}`);
const deadline = Date.now() + Math.min(expire, 120) * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const s = await pollQrLogin(token);
    if (s.state === 'ok') {
      console.log(`LOGIN_OK=${s.verified === true} HEYBOX_ID=${s.heyboxId || ''}`);
      try { fs.unlinkSync(out); } catch { /* ignore */ }
      process.exit(s.verified ? 0 : 1);
    }
    if (s.state === 'ready') console.log('SCANNED_WAIT_CONFIRM');
  } catch (e) {
    console.log(`POLL_ERR=${String(e?.message || e)}`);
  }
}
console.log('LOGIN_EXPIRED');
try { fs.unlinkSync(out); } catch { /* ignore */ }
process.exit(1);
