// 小黑盒只读适配器：复用 dsh-heybox 的 hkey/_rnd 签名与凭据层。
// 只做 feed / 帖子 / 评论 / 搜索 / 通知读取；不点赞、不发评论、不发帖。
import { HeyboxClient } from '../node_modules/dsh-heybox/tools/lib/http.mjs';

const str = (v) => (v == null ? '' : String(v))
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function bodyOf(v) {
  if (typeof v === 'string') {
    try {
      const blocks = JSON.parse(v);
      if (Array.isArray(blocks)) return blocks.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('\n');
    } catch { /* 原文 */ }
    return v;
  }
  return '';
}

function normalizePost(x) {
  const p = x?.info || x || {};
  const id = String(p.linkid ?? p.link_id ?? '').trim();
  if (!id) return null;
  const title = str(p.title || p.description || '（无标题）').slice(0, 160);
  return {
    source: 'xhh', id, title,
    author: str(p.user?.username ?? p.user?.nickname),
    likes: Number(p.link_award_num ?? p.up ?? 0) || 0,
    comments: Number(p.comment_num ?? p.comment_count ?? 0) || 0,
    url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
    description: str(p.description).slice(0, 300)
  };
}

function findComments(value, depth = 0) {
  if (!value || depth > 5) return [];
  if (Array.isArray(value)) {
    if (value.length && value.every((v) => v && typeof v === 'object' && ('commentid' in v || 'comment_id' in v))) return value;
    for (const v of value) { const r = findComments(v, depth + 1); if (r.length) return r; }
    return [];
  }
  if (typeof value === 'object') {
    for (const k of ['comments', 'comment_list', 'list', 'data']) {
      const r = findComments(value[k], depth + 1);
      if (r.length) return r;
    }
    for (const v of Object.values(value)) { const r = findComments(v, depth + 1); if (r.length) return r; }
  }
  return [];
}

export function createXhhReader({ client = null } = {}) {
  const c = client || new HeyboxClient({ interval: 700, timeout: 25000 });

  async function feed({ limit = 12 } = {}) {
    try {
      const data = await c.get('/bbs/app/feeds', { offset: 0, limit: Math.max(1, Math.min(30, limit)), pull: '0', dw: '604' });
      const items = (data.result?.links || []).map(normalizePost).filter(Boolean).slice(0, Math.max(1, Math.min(30, limit)));
      return { ok: true, items, source: 'xhh' };
    } catch (e) { return { ok: false, items: [], error: String(e?.message || e) }; }
  }

  async function post(linkId) {
    const id = String(linkId || '').trim();
    if (!id) return { ok: false, error: 'link_id 为空' };
    try {
      const data = await c.get('/bbs/app/link/tree', {
        link_id: id, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 20, sort_filter: 'hot'
      });
      const result = data.result || {};
      const link = result.link || result;
      const comments = findComments(result).slice(0, 12).map((x) => ({
        id: String(x.commentid ?? x.comment_id ?? ''),
        user: str(x.user?.username ?? x.user?.nickname),
        text: str(x.text ?? x.content).slice(0, 300),
        likes: Number(x.up ?? x.like_num ?? 0) || 0
      })).filter((x) => x.text);
      return {
        ok: true, source: 'xhh', id,
        title: str(link.title || link.description || '（无标题）').slice(0, 200),
        author: str(link.user?.username ?? link.user?.nickname),
        text: bodyOf(link.text).slice(0, 2000),
        url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
        comments
      };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  async function search(keyword, { limit = 10 } = {}) {
    const q = str(keyword);
    if (!q) return { ok: false, items: [], error: '关键词为空' };
    try {
      const data = await c.get('/bbs/app/api/general/search/v1', { q, search_type: 'link', offset: 0, limit: Math.max(3, Math.min(30, limit)) });
      const items = (data.result?.items || []).map(normalizePost).filter(Boolean);
      return { ok: true, items, source: 'xhh' };
    } catch (e) { return { ok: false, items: [], error: String(e?.message || e) }; }
  }

  async function notify({ limit = 10, kind = 'all' } = {}) {
    try {
      const kinds = kind === 'mention' ? ['mention'] : kind === 'reply' ? ['reply'] : ['reply', 'mention'];
      const out = [];
      for (const k of kinds) {
        const params = { offset: 0, limit: Math.max(1, Math.min(30, limit)), no_more: 'false' };
        if (k === 'mention') params.message_type = '16';
        else params.list_type = '0';
        const data = await c.get('/bbs/app/user/message', params);
        const list = data.result?.messages || data.messages || [];
        for (const n of list) {
          const text = str(n.comment_a_text || n.comment_b_text || n.link_title || n.title).slice(0, 300);
          if (!text) continue;
          out.push({
            kind: k,
            user: str(n.user?.username ?? n.user?.nickname ?? n.link_user),
            text,
            linkId: String(n.linkid ?? n.link_id ?? ''),
            url: n.linkid ? `https://www.xiaoheihe.cn/app/bbs/link/${n.linkid}` : '',
            replyTo: String(n.comment_a_id ?? n.comment_id ?? ''),
            root: String(n.comment_b_id ?? n.root_comment_id ?? ''),
            at: n.create_at || n.timestamp || ''
          });
        }
      }
      return { ok: true, items: out.slice(0, Math.max(1, Math.min(30, limit))) };
    } catch (e) { return { ok: false, items: [], error: String(e?.message || e) }; }
  }
  async function whoami() {
    try {
      const data = await c.get('/account/restore_login');
      const r = data.result || {};
      return { ok: true, uid: String(r.profile?.heybox_id ?? r.heybox_id ?? r.account_detail?.userid ?? ''), nickname: str(r.profile?.username ?? r.profile?.nickname ?? '') };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  }

  return { feed, post, search, notify, whoami };
}

export default createXhhReader;
