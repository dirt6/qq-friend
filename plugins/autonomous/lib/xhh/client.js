// 小黑盒只读客户端（登录态来自 data/xhh-auth.json）。
//
// 边界（按机主要求）：
//   · 这个文件**只做读**：搜索、推荐流、帖子详情、通知列表。
//   · 不包含任何写操作（评论/发帖/点赞），写操作将来单独走一个文件，并且必须带幂等闸门。
//   · 所有接口都是非公开契约，随时可能变；失败一律返回结构化错误，不抛异常给上层。
//
// 鉴权：Cookie（user_pkey / user_heybox_id）+ 每请求 hkey 签名 + heybox_id 参数。
// 过期判定：401 / status=failed / 权限字段为空 → 视为登录失效，上层应停止调用并提示重登。

import fs from 'node:fs';
import path from 'node:path';
import { buildSignedParams, generateDeviceId } from './sign.js';

const API = 'https://api.xiaoheihe.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class XhhAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XhhAuthError';
  }
}

export class XhhClient {
  constructor({ authFile, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.authFile = authFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.auth = null;
    this.lastAuthError = '';
    this.reload();
  }

  /** 每次调用前重读一次凭据文件，这样重新导入 Cookie 后不用重启进程。 */
  reload() {
    try {
      const raw = fs.readFileSync(this.authFile, 'utf8');
      const j = JSON.parse(raw);
      if (!j?.cookies || typeof j.cookies !== 'object') throw new Error('没有 cookies 字段');
      this.auth = {
        uid: String(j.uid || ''),
        nickname: String(j.nickname || ''),
        deviceId: String(j.deviceId || generateDeviceId()),
        cookies: j.cookies,
        loggedInAt: j.loggedInAt || ''
      };
      this.lastAuthError = '';
      return true;
    } catch (e) {
      this.auth = null;
      this.lastAuthError = e?.code === 'ENOENT' ? '还没导入登录态' : String(e?.message ?? e);
      return false;
    }
  }

  get loggedIn() {
    return Boolean(this.auth && Object.keys(this.auth.cookies || {}).length);
  }

  get uid() {
    return this.auth?.uid || '';
  }

  cookieHeader() {
    return Object.entries(this.auth?.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * 发一个 GET。返回 { ok, status, json, text, error }，不抛异常。
   * 401 / status=failed 会抛 XhhAuthError，让上层区分"登录失效"和"普通失败"。
   */
  async get(pathname, params = {}) {
    if (!this.reload()) throw new XhhAuthError(this.lastAuthError);
    const withUid = { ...params };
    if (this.auth.uid) withUid.heybox_id = this.auth.uid;
    const { params: signed } = buildSignedParams({ path: pathname, params: withUid, deviceId: this.auth.deviceId });
    const url = `${API}${pathname}?${new URLSearchParams(signed)}`;
    let res;
    try {
      res = await this.fetchImpl(url, {
        headers: {
          'user-agent': UA,
          referer: 'https://www.xiaoheihe.cn/',
          origin: 'https://www.xiaoheihe.cn',
          accept: 'application/json, text/plain, */*',
          cookie: this.cookieHeader()
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      return { ok: false, status: 0, error: e?.name === 'AbortError' ? `超时（${this.timeoutMs}ms）` : String(e?.message ?? e) };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (res.status === 401 || res.status === 403) throw new XhhAuthError(`登录态失效（HTTP ${res.status}）`);
    if (!json) return { ok: false, status: res.status, error: `不是 JSON（${text.length} 字节）`, text };
    if (String(json.status || '').toLowerCase() === 'failed') return { ok: false, status: res.status, error: String(json.msg || '接口返回 failed'), json };
    if (res.status === 429) return { ok: false, status: 429, error: '请求过快（429）', json };
    return { ok: true, status: res.status, json };
  }

  /* ── 只读接口 ───────────────────────────────────────────────────── */

  /**
   * 关键词搜索帖子。
   * 实测（2026-10-21）：GET /bbs/app/api/general/search/v1?q=&search_type=link
   * 结构：result.items[] = { info: { linkid, title, description, share_url, user, … }, type }
   */
  async search(keyword, { limit = 10, offset = 0 } = {}) {
    const q = String(keyword ?? '').trim();
    if (!q) return { ok: false, items: [], error: '关键词为空' };
    const r = await this.get('/bbs/app/api/general/search/v1', {
      q,
      search_type: 'link',
      offset: String(Math.max(0, Math.floor(offset))),
      limit: String(Math.max(1, Math.min(30, Math.floor(limit))))
    });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const items = (r.json?.result?.items || []).map((x) => normalizePost(x?.info)).filter(Boolean);
    return { ok: true, items, keyword: q };
  }

  /** 推荐流。 */
  async feed({ limit = 10 } = {}) {
    const r = await this.get('/bbs/app/feeds', { pull: '0', offset: '0' });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const list = r.json?.result?.links || r.json?.result?.items || r.json?.result?.list || [];
    const items = list.slice(0, Math.max(1, limit)).map((x) => normalizePost(x?.info || x)).filter(Boolean);
    return { ok: true, items };
  }

  /**
   * 帖子详情 / 楼层树（只读）。
   *
   * ⚠️ **必须传 `limit`**：不传时服务端默认 limit=0，`result.comments` 直接是空数组
   * （但 `total_floor_num` 仍会显示真实楼层数，很容易误判成「这帖没评论」）。
   * 2026-10-24 在收件箱上下文里踩到：7 层楼的帖子拿到 0 条，传 limit=20 就正常了。
   */
  async linkTree(linkid, { limit = 20 } = {}) {
    const id = String(linkid ?? '').replace(/[^0-9a-zA-Z]/g, '');
    if (!id) return { ok: false, error: 'linkid 无效' };
    const r = await this.get('/bbs/app/link/tree', { link_id: id, limit: String(Math.max(1, limit)) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, json: r.json };
  }

  /**
   * 通知列表（@ / 回复）。
   * 实测结构与字段尚未确认，这里只做透传，由调用方检查。
   * @param {'mention'|'reply'} kind
   */
  async messages(kind = 'mention', { offset = 0, limit = 20 } = {}) {
    // 参考实现：mention 用 message_type=16；契约文档另提到 17。
    // 这里先按 16 请求，调用方可以传 overrideType 做对照实验。
    const params = { offset: String(offset), limit: String(limit), no_more: 'false' };
    if (kind === 'mention') params.message_type = '16';
    else params.list_type = '0';
    const r = await this.get('/bbs/app/user/message', params);
    if (!r.ok) return { ok: false, error: r.error };
    const body = r.json?.result || r.json || {};
    return { ok: true, json: r.json, body };
  }

  /** 我最近发过的评论（用于写操作后核对，防止重复发送）。 */
  async recentComments({ limit = 20 } = {}) {
    const r = await this.get('/bbs/app/comment/user', { offset: '0', limit: String(limit) });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, json: r.json };
  }

  /** 账号状态：能读就说明登录态有效。 */
  async identity() {
    const r = await this.get('/bbs/app/api/user/permission', {});
    if (!r.ok) return { ok: false, error: r.error };
    const body = r.json?.result || r.json?.data || r.json || {};
    const keys = Object.keys(body);
    return {
      ok: keys.some((k) => /permission|permit/i.test(k)),
      uid: this.auth?.uid || '',
      nickname: this.auth?.nickname || '',
      permissions: keys.length,
      raw: keys.slice(0, 8)
    };
  }
}

/** 把帖子对象归一成与 B 站同构的条目，便于共用去重/安全过滤/预算裁剪。 */
export function normalizePost(info) {
  if (!info || typeof info !== 'object') return null;
  const linkid = String(info.linkid ?? info.link_id ?? '').trim();
  const title = String(info.title ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  if (!linkid || !title) return null;
  const desc = String(info.description ?? info.hb_rich_texts?.[0]?.text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // 用站内帖子页，而不是接口返回的 api.xiaoheihe.cn/v3/...share?...（那个在 QQ 里打开体验差）
  const url = `https://www.xiaoheihe.cn/app/bbs/link/${linkid}`;
  // 标签在搜索/推荐流里是对象数组（{name} / {tag_name} / {topic_name}），不是字符串
  const tagText = (x) => {
    if (typeof x === 'string') return x.trim();
    if (x && typeof x === 'object') {
      return String(x.name ?? x.tag_name ?? x.topic_name ?? x.title ?? '').trim();
    }
    return '';
  };
  const tags = []
    .concat(info.content_tags || [], info.hashtags || [], info.topics || [])
    .map(tagText)
    .filter(Boolean)
    .slice(0, 3);
  const created = Number(info.create_at);
  return {
    source: 'xhh',
    contentId: linkid,
    url,
    title: title.slice(0, 120),
    tags,
    summary: desc.slice(0, 160),
    publishedAt: Number.isFinite(created) && created > 0 ? new Date(created * 1000).toISOString().slice(0, 10) : '',
    stats: Number(info.comment_num) > 0 ? { comments: Number(info.comment_num) } : undefined,
    author: String(info.user?.username ?? info.user?.nickname ?? info.userid ?? '').slice(0, 40) || undefined
  };
}
