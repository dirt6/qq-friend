// 她自己的醒来时间：30–1440 分钟后；取消每天的改期次数上限。
// 只保留最短 30 分钟（防止醒来风暴）与最长 24 小时；次数不再限制，counts 仅用于观察。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const WAKE_FILE = process.env.IDLE_WAKE_FILE || path.join(DATA_DIR, 'idle-wake.json');

function readRaw() {
  try { return JSON.parse(fs.readFileSync(WAKE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function dayKey(at) { return new Date(at).toLocaleDateString('en-CA'); }

export function readSelfWake(now = Date.now()) {
  const j = readRaw();
  if (j.enabled !== true || !Number(j.wakeAt)) return null;
  if (Number(j.wakeAt) <= now) return { ...j, due: true };
  return { ...j, due: false };
}

export function setSelfWake({ afterMinutes, reason = '', now = Date.now() } = {}) {
  const m = Math.trunc(Number(afterMinutes));
  if (!Number.isFinite(m) || m < 30 || m > 1440) return { ok: false, error: '醒来时间需在 30–1440 分钟之间' };
  const old = readRaw();
  const today = dayKey(now);
  const counts = old.counts && typeof old.counts === 'object' ? old.counts : {};
  counts[today] = Number(counts[today] || 0) + 1;
  const next = { enabled: true, wakeAt: now + m * 60e3, reason: String(reason || '').slice(0, 120), counts, updatedAt: new Date(now).toISOString() };
  fs.mkdirSync(path.dirname(WAKE_FILE), { recursive: true });
  fs.writeFileSync(WAKE_FILE, JSON.stringify(next, null, 1), 'utf8');
  return { ok: true, ...next };
}

export function consumeSelfWake(now = Date.now()) {
  const j = readRaw();
  if (j.enabled !== true || !Number(j.wakeAt) || Number(j.wakeAt) > now) return null;
  const next = { ...j, enabled: false, usedAt: now };
  try { fs.writeFileSync(WAKE_FILE, JSON.stringify(next, null, 1), 'utf8'); } catch { /* ignore */ }
  return j;
}
