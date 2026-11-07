// B站主人身份映射（不含 Cookie）。用于把 mention=owner/me 解析成 B站昵称，
// 避免模型猜昵称、误 @ 路人；没有配置就明确失败，不硬编码。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const OWNER_FILE = path.join(DATA_DIR, 'bili-owner.json');

export function getBiliOwner({ file = OWNER_FILE } = {}) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const uid = String(j?.uid || '').trim();
    const nickname = String(j?.nickname || '').trim();
    if (!/^\d+$/.test(uid) || !nickname) return null;
    return { uid, nickname };
  } catch { return null; }
}

/** mention=owner/me/我 → B站昵称；其他值原样返回（可为空）。 */
export function resolveBiliMention(value, owner = getBiliOwner()) {
  const raw = String(value ?? '').trim();
  if (!raw) return { ok: true, mention: '' };
  if (/^(owner|me|我)$/i.test(raw)) {
    if (!owner?.nickname) return { ok: false, error: 'B站主人映射未配置（data/bili-owner.json）' };
    return { ok: true, mention: owner.nickname };
  }
  return { ok: true, mention: raw };
}

export default getBiliOwner;
