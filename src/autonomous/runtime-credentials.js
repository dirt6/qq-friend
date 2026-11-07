// 5.0-E6：独立 G2/G3 HMAC 授权密钥加载器。
// 只从受 ACL 保护的本地文件读取；缺失/损坏 → null（fail-closed），不写日志。
import fs from 'node:fs';
import { createAuthorizationService } from './authorization.js';

export function loadRuntimeAuthorization({ keysFile } = {}) {
  if (!keysFile) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
    if (!raw || typeof raw.keys !== 'object' || Array.isArray(raw.keys) || !raw.keyId) return null;
    if (!raw.keys[raw.keyId]) return null;
    return createAuthorizationService({ keys: raw.keys, keyId: raw.keyId, nonceFile: String(raw.nonceFile || '') });
  } catch { return null; }
}

export default loadRuntimeAuthorization;
