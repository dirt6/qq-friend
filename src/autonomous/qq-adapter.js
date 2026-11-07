// 5.0-G3：QQ 单目标真实发送适配器（包装 SendQueue；无真实网络）。
// 发送前持久化 intent；sent/unknown 均落盘；unknown 不允许自动重发。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();

export function createQQAdapter({ sender, target = '', journalFile = '', paused = () => false, dryRun = false, now = () => Date.now() } = {}) {
  if (!sender || typeof sender.sendTextBatch !== 'function') throw new Error('QQ adapter 需要 sender.sendTextBatch');
  if (!/^\d+$/.test(String(target))) throw new Error('QQ adapter 需要单个数字私聊目标');
  const file = path.resolve(journalFile || `data/5.0-g3/send-journal.json`);
  function load() {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { version: 1, intents: {} }; }
  }
  function save(j) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(j, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  }
  async function send({ target: requested = '', text = '', fingerprint = '' } = {}) {
    if (paused()) return { ok: false, state: 'paused', reason: 'paused' };
    if (String(requested) !== String(target)) return { ok: false, state: 'blocked', reason: 'target_not_allowed' };
    const body = textOf(text);
    if (!body) return { ok: false, state: 'blocked', reason: 'text_required' };
    const fp = textOf(fingerprint) || `msg:${hash(`${target}|${body}`).slice(0, 32)}`;
    if (dryRun) return { ok: true, state: 'dry_run', dryRun: true, fingerprint: fp, target, text: body };
    const j = load();
    const prior = j.intents[fp];
    if (prior?.state === 'sent') return { ok: true, state: 'duplicate', duplicate: true, fingerprint: fp, messageId: prior.messageId || '' };
    if (prior?.state === 'sending' || prior?.state === 'unknown') return { ok: false, state: 'unknown', reason: 'prior_intent_unresolved', fingerprint: fp };
    if (prior?.state === 'failed') return { ok: false, state: 'failed', reason: 'prior_intent_failed', fingerprint: fp };

    j.intents[fp] = { state: 'sending', at: new Date(now()).toISOString(), target, textHash: hash(body).slice(0, 32) };
    save(j);
    try {
      const r = await sender.sendTextBatch(`private:${target}`, [body]);
      const sent = Array.isArray(r?.sent) ? r.sent : [];
      const failed = Array.isArray(r?.failed) ? r.failed : [];
      if (failed.length) {
        j.intents[fp] = { ...j.intents[fp], state: 'unknown', at: new Date(now()).toISOString(), reason: 'send_failed_side_effect_unknown' };
        save(j);
        return { ok: false, state: 'unknown', reason: 'send_failed_side_effect_unknown', fingerprint: fp };
      }
      const first = sent.find((x) => x && !x.deduped);
      if (first) {
        const messageId = first.messageId == null ? '' : String(first.messageId);
        j.intents[fp] = { ...j.intents[fp], state: 'sent', at: new Date(now()).toISOString(), messageId };
        save(j);
        return { ok: true, state: 'sent', fingerprint: fp, messageId };
      }
      if (sent.some((x) => x?.deduped)) {
        j.intents[fp] = { ...j.intents[fp], state: 'sent', at: new Date(now()).toISOString(), messageId: '' };
        save(j);
        return { ok: true, state: 'duplicate', duplicate: true, fingerprint: fp, messageId: '' };
      }
      j.intents[fp] = { ...j.intents[fp], state: 'unknown', at: new Date(now()).toISOString(), reason: 'empty_send_result' };
      save(j);
      return { ok: false, state: 'unknown', reason: 'empty_send_result', fingerprint: fp };
    } catch (e) {
      j.intents[fp] = { ...j.intents[fp], state: 'unknown', at: new Date(now()).toISOString(), reason: String(e?.message || e) };
      save(j);
      return { ok: false, state: 'unknown', reason: 'send_exception_unknown', fingerprint: fp };
    }
  }
  async function recover() {
    const j = load();
    const recovered = [];
    for (const [fp, it] of Object.entries(j.intents || {})) {
      if (it?.state === 'sending') {
        j.intents[fp] = { ...it, state: 'unknown', at: new Date(now()).toISOString(), reason: 'process_restart_after_intent' };
        recovered.push(fp);
      }
    }
    if (recovered.length) save(j);
    return { ok: true, recovered };
  }
  return { send, recover, target, journalFile: file };
}

export default createQQAdapter;
