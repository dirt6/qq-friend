// 听写模式：她说「先别回话」时，机器人只记录、不回复；直到「我说完了」再回应。
//
// 背景（2026-11-06 机主）：让机器人先别回、等他说完，她总是一句一句回。
// 这必须由核心做确定性拦截（不能只靠提示词），所以放在 orchestrator 的入站路径上。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const LISTEN_FILE = process.env.LISTEN_MODE_FILE || path.join(DATA_DIR, 'listen-mode.json');

// 「先别回」：要足够明确，避免把普通句子（比如“别回我这条”）误判。
const START_RES = [
  /先别(回|回复|回话|回我|说话|理我)/,
  /暂时别(回|回复|回话|说话)/,
  /等(我)?(说|讲)完/,
  /先听(我)?说/,
  /我(还)?没说完/,
  /别急着回/,
  /先别理我/
];
// 「我说完了」：结束听写模式。
const END_RES = [
  /(我)?说完了/,
  /(我)?讲完了/,
  /可以(回|说)了/,
  /现在可以回/
];

export function isListenStart(text) {
  const t = String(text || '');
  return START_RES.some((re) => re.test(t));
}
export function isListenEnd(text) {
  const t = String(text || '');
  return END_RES.some((re) => re.test(t));
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(LISTEN_FILE, 'utf8'));
    if (j && typeof j.chats === 'object' && j.chats) return { version: 1, chats: j.chats };
  } catch { /* 不存在/损坏 → 空 */ }
  return { version: 1, chats: {} };
}

function save(state) {
  try {
    fs.mkdirSync(path.dirname(LISTEN_FILE), { recursive: true });
    const tmp = `${LISTEN_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, LISTEN_FILE);
  } catch { /* 写不了不影响本轮判断 */ }
}

export function isListening(chatKey) {
  const st = load();
  return Boolean(st.chats[String(chatKey || '')]?.enabled);
}

export function setListening(chatKey, enabled, { now = Date.now() } = {}) {
  const key = String(chatKey || '');
  if (!key) return { ok: false, error: 'chatKey 为空' };
  const st = load();
  if (enabled) st.chats[key] = { enabled: true, since: new Date(now).toISOString() };
  else delete st.chats[key];
  save(st);
  return { ok: true, listening: Boolean(enabled) };
}

export default { isListenStart, isListenEnd, isListening, setListening };
