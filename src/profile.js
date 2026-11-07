// Profile identity is deliberately limited to a numeric instance id.
const rawProfile = String(process.env.QQ_AGENT_PROFILE ?? '').trim();

export const PROFILE_ID = /^\d+$/.test(rawProfile) ? rawProfile : '';

export function isSecondary() {
  return PROFILE_ID !== '';
}

export function profileSuffix() {
  return isSecondary() ? `-${PROFILE_ID}` : '';
}

export function dataDirName() {
  return `data${profileSuffix()}`;
}

export function portOffset() {
  // 每个实例偏移 (PROFILE_ID - 1) * 100：#2 → +100（3310）、#3 → +200（3410）。
  // 旧实现用 PROFILE_ID * 100 会让 #2 变成 3410，与注释和机主要求的 3310 不符。
  return isSecondary() ? (Number(PROFILE_ID) - 1) * 100 : 0;
}

export function describeInstance() {
  return isSecondary() ? `QQ Agent #${PROFILE_ID}` : 'QQ Agent';
}
