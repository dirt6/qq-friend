// 5.0：B站评论写适配器（手工、可预览、限频；不自动）。
// 读/写分离：预览不联网；真正发送必须 confirm=true 且账号已导入。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { BiliWriter } from '../plugins/autonomous/lib/social/bili-write.js';
import { BiliClient } from '../plugins/autonomous/lib/bili/api.js';

const MAX_TEXT = 200;
const MAX_PER_HOUR = 3;

function normalizeText(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim();
}

/** 和 BiliWriter 同一套 @ 规则：@ 提到开头，其余 @ 转全角，避免误 @ 路人。 */
function composeText(text, mention = '') {
  const body = normalizeText(text);
  const at = String(mention || '').trim();
  if (!at) return body.replace(/@/g, '＠');
  const rest = body.startsWith(`@${at}`) ? body.slice(at.length + 1).trim() : body;
  return `@${at} ${rest.replace(/@/g, '＠')}`;
}

function readJournal(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a.filter((x) => Number.isFinite(Number(x.at))) : [];
  } catch { return []; }
}

function writeJournal(file, arr) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(arr.slice(-50)), 'utf8');
  } catch { /* 限频账写不了不能导致重复发；失败时上层保守拒绝 */ }
}

export function createBiliWriteAdapter({
  writer = null,
  client = null,
  authFile = path.join(DATA_DIR, 'bili-auth.json'),
  journalFile = path.join(DATA_DIR, 'bili-comment-journal.json'),
  now = () => Date.now(),
  maxPerHour = MAX_PER_HOUR
} = {}) {
  const w = writer || new BiliWriter({ authFile });
  const c = client || new BiliClient();

  function preview({ bvid = '', text = '', mention = '' } = {}) {
    const id = String(bvid || '').trim();
    const body = normalizeText(text);
    if (!id) return { ok: false, error: 'bvid 为空' };
    if (!body) return { ok: false, error: '评论内容为空' };
    if (body.length > MAX_TEXT) return { ok: false, error: `评论最多 ${MAX_TEXT} 字` };
    const finalText = composeText(body, mention);
    return { ok: true, bvid: id, text: finalText, mention: String(mention || ''), chars: finalText.length, loggedIn: Boolean(w.loggedIn) };
  }

  async function comment({ bvid = '', text = '', mention = '', root = '', parent = '', confirm = false } = {}) {
    const p = preview({ bvid, text, mention });
    if (!p.ok) return { ok: false, sideEffect: 'none', ...p };
    if (confirm !== true) {
      return { ...p, ok: true, mode: 'preview', sent: false, sideEffect: 'none', note: '预览，未发送', replyTo: String(root || parent || '') };
    }
    if (!w.loggedIn) return { ok: false, sideEffect: 'none', error: 'B站未登录或 Cookie 失效，无法评论' };
    const t = now();
    const recent = readJournal(journalFile).filter((x) => t - Number(x.at) < 3600_000);
    if (recent.length >= Math.max(1, Number(maxPerHour) || MAX_PER_HOUR)) {
      return { ok: false, sideEffect: 'none', error: 'B站评论频率已达上限（每小时 3 条），稍后再试' };
    }
    let aid = 0;
    try {
      const v = await c.video(p.bvid);
      aid = Number(v?.aid) || 0;
    } catch { /* 下面统一报错 */ }
    if (!aid) return { ok: false, sideEffect: 'none', error: '拿不到视频 aid，未发送' };

    // 先记尝试再发：进程崩溃/超时也不会少算频率；失败也占用一次，宁可保守。
    writeJournal(journalFile, [...recent, { at: t, bvid: p.bvid, text: p.text.slice(0, 80) }]);
    let r;
    try {
      r = await w.comment(p.bvid, normalizeText(text), { mention, root: root || undefined, parent: parent || undefined, resolveAid: async () => aid });
    } catch (e) {
      return { ok: false, sideEffect: 'unknown', error: `评论异常，结果未知：${String(e?.message || e)}` };
    }
    if (!r?.ok) return { ok: false, sideEffect: 'none', error: r?.error || '评论失败', code: r?.code };
    return { ok: true, mode: 'sent', sent: true, sideEffect: 'sent', rpid: r.rpid || 0, text: r.text || p.text, bvid: p.bvid, aid };
  }

  return { preview, comment, maxPerHour };
}

export default createBiliWriteAdapter;
