// B 站公开 API 客户端（搜索 / 视频详情 / 热评）。
//
// 为什么要单独一个客户端：`sources.js` 里原来的 B 站来源只抓排行榜和热门
// 列表，没有「按关键词找视频、再读简介和评论」的能力。而要让模型真正
// 「看懂」一条视频，光有标题不够——简介和评论才是内容本身。
//
// 2026-10-23 实测（未登录、无 Cookie、普通 UA）：
//   · /x/web-interface/nav                      200，给出 wbi_img 的两个 key
//   · /x/web-interface/wbi/search/type          200，code 0，20 条结果（**需要 wbi 签名**）
//   · /x/web-interface/view?bvid=               200，code 0，标题/aid/stat 都有
//   · /x/v2/reply?type=1&oid=<aid>&sort=2       200，code 0，热评可读
// 也就是说这条链路不需要登录态。Cookie 只在被 412 限流时才需要，先不做。
//
// wbi 算法说明：从 nav 拿到 img/sub 两个 key，按固定表重排后取前 32 位当
// mixin key；参数按 key 排序、删掉 !'()* 这几个字符、拼上 wts 和时间戳，
// md5 之后作为 w_rid。key 会轮换（通常几小时到一天），所以缓存 1 小时。

import crypto from 'node:crypto';

const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** 把 img_key+sub_key 重排成 32 位 mixin key。 */
export function mixinKey(imgKey, subKey) {
  const raw = `${imgKey}${subKey}`;
  return MIXIN_TAB.map((n) => raw[n] ?? '').join('').slice(0, 32);
}

/** 给参数加 wts 并算出 w_rid，返回 query string。 */
export function signWbi(params, imgKey, subKey, now = Date.now()) {
  const mixin = mixinKey(imgKey, subKey);
  const wts = Math.round(now / 1000);
  const p = { ...params, wts };
  const query = Object.keys(p)
    .sort()
    .map((k) => {
      const v = String(p[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

function keyOf(url) {
  const s = String(url || '');
  const base = s.slice(s.lastIndexOf('/') + 1);
  return base.split('.')[0] || '';
}

export function stripTags(s) {
  return String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class BiliClient {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 12000, cookie = '' } = {}) {
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.cookie = cookie;
    this._keys = null;
    this._keysAt = 0;
  }

  headers() {
    const h = {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      origin: 'https://www.bilibili.com'
    };
    if (this.cookie) h.cookie = this.cookie;
    return h;
  }

  async get(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${API}${path}${qs ? `?${qs}` : ''}`;
    const res = await this.fetchImpl(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
    return { ok: res.ok, status: res.status, json, text };
  }

  /** 拿 wbi key（缓存 1 小时）。失败返回 null，调用方自己决定降级。 */
  async wbiKeys(now = Date.now()) {
    if (this._keys && now - this._keysAt < 3600_000) return this._keys;
    const r = await this.get('/x/web-interface/nav');
    const img = keyOf(r.json?.data?.wbi_img?.img_url);
    const sub = keyOf(r.json?.data?.wbi_img?.sub_url);
    if (!img || !sub) return null;
    this._keys = { imgKey: img, subKey: sub, loggedIn: Boolean(r.json?.data?.isLogin) };
    this._keysAt = now;
    return this._keys;
  }

  /**
   * 按关键词搜视频。
   * @returns {{ok:boolean, items:Array, error?:string}}
   */
  async search(keyword, { limit = 10, page = 1, now = Date.now() } = {}) {
    const q = String(keyword || '').trim();
    if (!q) return { ok: false, items: [], error: '关键词为空' };
    const keys = await this.wbiKeys(now);
    let path;
    let params;
    if (keys) {
      path = '/x/web-interface/wbi/search/type';
      params = null; // 用签名字符串，不走 URLSearchParams
    } else {
      // 没拿到 key 时退回旧接口（大概率 412，但总比直接失败好）
      path = '/x/web-interface/search/type';
      params = { search_type: 'video', keyword: q, page };
    }

    let url;
    if (keys) {
      const signed = signWbi({ search_type: 'video', keyword: q, page }, keys.imgKey, keys.subKey, now);
      url = `${API}${path}?${signed}`;
    } else {
      url = `${API}${path}?${new URLSearchParams(params).toString()}`;
    }

    const res = await this.fetchImpl(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.timeoutMs)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }

    if (!res.ok || json?.code !== 0) {
      return {
        ok: false,
        items: [],
        error: `搜索失败 HTTP ${res.status} code ${json?.code ?? '?'} ${json?.message ?? ''}`.trim()
      };
    }

    const list = json?.data?.result || [];
    const items = list.slice(0, limit).map((x) => ({
      bvid: String(x.bvid || ''),
      // 和其它来源对齐：contentId 用来去重，B 站就是 bvid
      contentId: String(x.bvid || ''),
      title: stripTags(x.title),
      author: String(x.author || ''),
      play: Number(x.play) || 0,
      danmaku: Number(x.video_review) || 0,
      duration: String(x.duration || ''),
      pubdate: Number(x.pubdate) || 0,
      url: x.bvid ? `https://www.bilibili.com/video/${x.bvid}` : '',
      source: 'bili-search'
    })).filter((x) => x.bvid && x.title);

    return { ok: true, items };
  }

  /** 视频详情：标题、简介、分区、统计数据。 */
  async video(bvid) {
    const id = String(bvid || '').trim();
    if (!id) return { ok: false, error: 'bvid 为空' };
    const r = await this.get('/x/web-interface/view', { bvid: id });
    if (!r.ok || r.json?.code !== 0) {
      return { ok: false, error: `详情失败 HTTP ${r.status} code ${r.json?.code ?? '?'}` };
    }
    const d = r.json.data || {};
    return {
      ok: true,
      bvid: id,
      aid: Number(d.aid) || 0,
      title: String(d.title || ''),
      desc: String(d.desc || '').trim(),
      tname: String(d.tname || ''),
      owner: String(d.owner?.name || ''),
      // 封面地址：给她「看图」用（她拿到本地路径后能 read_image）
      pic: String(d.pic || ''),
      url: `https://www.bilibili.com/video/${id}`,
      stat: {
        view: Number(d.stat?.view) || 0,
        like: Number(d.stat?.like) || 0,
        reply: Number(d.stat?.reply) || 0,
        coin: Number(d.stat?.coin) || 0,
        favorite: Number(d.stat?.favorite) || 0
      }
    };
  }

  /** 热评（按热度 sort=2）。aid 或 bvid 都行。 */
  async replies(oidOrBvid, { limit = 6 } = {}) {
    let aid = Number(oidOrBvid) || 0;
    if (!aid) {
      const v = await this.video(oidOrBvid);
      if (!v.ok) return { ok: false, items: [], error: v.error };
      aid = v.aid;
    }
    if (!aid) return { ok: false, items: [], error: '拿不到 aid' };
    const r = await this.get('/x/v2/reply', { type: 1, oid: aid, sort: 2, ps: limit, pn: 1 });
    if (!r.ok || r.json?.code !== 0) {
      return { ok: false, items: [], error: `评论失败 HTTP ${r.status} code ${r.json?.code ?? '?'}` };
    }
    const list = r.json?.data?.replies || [];
    const items = list.slice(0, limit).map((x) => ({
      user: String(x?.member?.uname || ''),
      text: stripTags(x?.content?.message || '').slice(0, 300),
      like: Number(x?.like) || 0,
      rpid: Number(x?.rpid) || 0,
      root: Number(x?.root) || 0,
      parent: Number(x?.parent) || 0
    })).filter((x) => x.text);
    return { ok: true, items };
  }

  /**
   * 一步拿齐「能喂给模型的东西」：详情 + 热评。
   * 简介为空时用评论补——很多搬运号根本没写简介。
   */
  async detail(bvid, { replyLimit = 5 } = {}) {
    const v = await this.video(bvid);
    if (!v.ok) return v;
    let replies = [];
    let replyErr = '';
    try {
      const r = await this.replies(v.aid || bvid, { limit: replyLimit });
      if (r.ok) replies = r.items;
      else replyErr = r.error;
    } catch (e) {
      replyErr = String(e?.message ?? e);
    }
    return { ...v, replies, replyError: replyErr };
  }
}

/** 把详情压成一段适合塞进提示词的文本。 */
export function formatDetail(d, { maxDesc = 400, maxReplies = 4 } = {}) {
  const lines = [];
  lines.push(`标题：${d.title}`);
  if (d.owner) lines.push(`UP：${d.owner}`);
  if (d.tname) lines.push(`分区：${d.tname}`);
  if (d.stat) {
    lines.push(`数据：${d.stat.view} 播放 / ${d.stat.like} 赞 / ${d.stat.reply} 评论`);
  }
  if (d.desc) lines.push(`简介：${d.desc.slice(0, maxDesc)}`);
  else lines.push('简介：（无）');
  if (d.replies?.length) {
    lines.push('热评：');
    for (const r of d.replies.slice(0, maxReplies)) {
      lines.push(`- ${r.user}（${r.like} 赞）：${r.text.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}
