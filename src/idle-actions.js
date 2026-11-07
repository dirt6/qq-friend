// 5.0 空闲动作：分享 / 主动聊天 / B站评论回复。
// 目标固定为主人私聊；每日配额、静默时段、内容去重；XHH 自动评论不走浏览器。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { createBiliWriteAdapter } from './bili-write-adapter.js';

const day = (at) => new Date(at).toLocaleDateString('en-CA');
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
const textOf = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const QUIET_START = 0;
const QUIET_END = 8;

export function createIdleActions({
  sender,
  target = '',
  now = () => Date.now(),
  journalFile = path.join(DATA_DIR, '5.0-idle-actions.json'),
  limits = { share: Infinity, chat: Infinity, comment: Infinity, reply: Infinity }
} = {}) {
  const digits = String(target || '').replace(/[^0-9]/g, '');
  const chatKey = digits ? `private:${digits}` : '';
  let state = { items: [] };
  try { state = JSON.parse(fs.readFileSync(journalFile, 'utf8')) || state; } catch { /* none */ }
  if (!Array.isArray(state.items)) state.items = [];

  function save() {
    try {
      fs.mkdirSync(path.dirname(journalFile), { recursive: true });
      state.items = state.items.slice(-300);
      fs.writeFileSync(journalFile, JSON.stringify(state, null, 1), 'utf8');
    } catch { /* 账本写不了时仍由内存限额兜底 */ }
  }
  function count(kind, at) { return state.items.filter((x) => x.kind === kind && String(x.day) === day(at)).length; }
  function seen(fp, withinMs = 6 * 3600e3) {
    const t = now();
    return state.items.some((x) => x.hash === fp && t - Number(x.at || 0) < withinMs);
  }
  function quiet(at) {
    const h = new Date(at).getHours();
    return QUIET_START < QUIET_END
      ? (h >= QUIET_START && h < QUIET_END)
      : (h >= QUIET_START || h < QUIET_END);
  }
  function record(kind, text, at, extra = {}) {
    const fp = hash(`${kind}|${chatKey}|${textOf(text)}`);
    state.items.push({ at, day: day(at), kind, hash: fp, text: textOf(text).slice(0, 120), ...extra });
    save();
    return fp;
  }
  async function send(kind, text, at) {
    if (!chatKey) return { ok: false, reason: 'no_target' };
    if (!sender?.sendTextBatch) return { ok: false, reason: 'no_sender' };
    if (quiet(at)) return { ok: false, reason: 'quiet_hours' };
    const body = String(text || '').trim();
    if (!body) return { ok: false, reason: 'empty' };
    const cap = Number(limits[kind]);
    if (Number.isFinite(cap) && cap > 0 && count(kind, at) >= cap) return { ok: false, reason: 'daily_limit' };
    const fp = hash(`${kind}|${chatKey}|${body}`);
    if (seen(fp)) return { ok: false, reason: 'duplicate' };
    record(kind, body, at);
    try {
      const r = await sender.sendTextBatch(chatKey, [body]);
      return { ok: true, sent: r?.sent?.length || 0, text: body, chatKey };
    } catch (e) { return { ok: false, reason: `send_failed:${String(e?.message || e)}` }; }
  }

  async function share({ title = '', url = '', text = '', includeLink = true } = {}) {
    const body = [textOf(text), textOf(title), includeLink ? textOf(url) : ''].filter(Boolean).join('\n');
    return send('share', body, now());
  }
  async function chat({ text = '' } = {}) { return send('chat', textOf(text), now()); }

  async function sendImage({ file = '', note = '' } = {}) {
    if (!chatKey) return { ok: false, reason: 'no_chat' };
    if (!sender?.sendImage) return { ok: false, reason: 'no_sender' };
    try {
      const r = await sender.sendImage(chatKey, { file }, note ? { note } : {});
      return { ok: true, sent: 1, file, messageId: r?.message_id ?? null };
    } catch (e) { return { ok: false, reason: `send_failed:${String(e?.message || e)}` }; }
  }

  async function commentBili({ bvid = '', text = '', replyTo = '', root = '', mention = '' } = {}) {
    const kind = root || replyTo ? 'reply' : 'comment';
    const at = now();
    if (quiet(at)) return { ok: false, reason: 'quiet_hours' };
    const cap = Number(limits[kind]);
    if (Number.isFinite(cap) && cap > 0 && count(kind, at) >= cap) return { ok: false, reason: 'daily_limit' };
    const a = createBiliWriteAdapter();
    const r = await a.comment({ bvid, text, mention, root: root || replyTo, parent: replyTo, confirm: true });
    if (r.ok && r.sent) record(kind, `${bvid}|${r.text || text}`, at, { bvid, rpid: r.rpid || 0 });
    return r;
  }

  function status() {
    const at = now();
    return { chatKey, quiet: quiet(at), counts: Object.fromEntries(Object.keys(limits).map((k) => [k, count(k, at)])), limits };
  }

  return { share, chat, commentBili, sendImage, status };
}

export default createIdleActions;
