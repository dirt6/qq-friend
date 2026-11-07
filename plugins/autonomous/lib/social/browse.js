// 统一浏览层：B 站 / 小黑盒的「搜索 → 看详情（标题+简介+评论）」。
//
// 为什么要有这一层：B 站和小黑盒的数据结构完全不同（bvid vs linkid、rpid vs
// comment_id、热评 vs 楼层树），但对她来说只有一件事——"这条内容在讲什么、大家
// 在说什么"。这里把两边归一成同一种文本，工具层只管调。
//
// 读的全部是公开/现有接口，不花 token；写操作不在这里（见 bili-write / xhh-write）。

import { BiliClient, stripTags, formatDetail } from '../bili/api.js';
import { XhhClient } from '../xhh/client.js';
import { buildSignedParams } from '../xhh/sign.js';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 建一套只读客户端（B 站不需要登录；小黑盒用 data/xhh-auth.json）。 */
export function makeClients({ dataDir, biliCookie = '' } = {}) {
  return {
    bili: new BiliClient({ cookie: biliCookie }),
    xhh: new XhhClient({ authFile: `${dataDir}/xhh-auth.json` })
  };
}

/* ── B 站 ─────────────────────────────────────────────────────── */

/** 搜索视频。返回 [{source,contentId,title,author,play,url}]。 */
export async function searchBili(bili, keyword, { limit = 8 } = {}) {
  const r = await bili.search(keyword, { limit });
  if (!r.ok) return { ok: false, items: [], error: r.error || 'B 站搜索失败' };
  return { ok: true, items: r.items };
}

/** 视频详情 + 热评，压成一段她可以直接读/总结的文本。 */
export async function detailBili(bili, bvid, { replyLimit = 8 } = {}) {
  const d = await bili.detail(bvid, { replyLimit });
  if (!d.ok) return { ok: false, error: d.error || '拿不到 B 站视频详情' };
  return {
    ok: true,
    source: 'bili',
    contentId: d.bvid,
    aid: d.aid,
    title: d.title,
    author: d.owner,
    url: d.url,
    imageUrls: d.pic ? [d.pic] : [],
    text: formatDetail(d, { maxDesc: 600, maxReplies: replyLimit }),
    desc: d.desc,
    replies: d.replies,
    stat: d.stat
  };
}

/* ── 小黑盒 ───────────────────────────────────────────────────── */

/** 搜索帖子。 */
export async function searchXhh(xhh, keyword, { limit = 8 } = {}) {
  const r = await xhh.search(keyword, { limit });
  if (!r.ok) return { ok: false, items: [], error: r.error || '小黑盒搜索失败' };
  return { ok: true, items: r.items };
}

/** 从 link/tree 的 link.text 里抽正文（它是 JSON 字符串，可能是段落数组）。 */
export function xhhBodyText(link) {
  const raw = link?.text;
  if (!raw) return String(link?.description || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const unwrap = (v) => {
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.startsWith('{') || s.startsWith('[')) {
        try { return unwrap(JSON.parse(s)); } catch { /* 不是 JSON */ }
      }
      return s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (Array.isArray(v)) return v.map(unwrap).filter(Boolean).join('\n');
    if (v && typeof v === 'object') {
      return unwrap(v.text ?? v.content ?? v.html ?? v.paragraphs ?? '');
    }
    return '';
  };
  return unwrap(raw);
}

/**
 * 帖子详情 + 评论。评论来自 result.comments[]，每条有 comment_id / text /
 * user / like_num / reply_num，楼中楼在子字段里（结构不稳，这里只取第一层）。
 */
export async function detailXhh(xhh, linkId, { replyLimit = 8, authFile } = {}) {
  // 有些字段（比如楼中楼的作者）要登录态才给全，走同一个客户端
  const r = await xhh.linkTree(linkId);
  if (!r.ok) return { ok: false, error: r.error || '拿不到小黑盒帖子' };
  const result = r.json?.result || r.json || {};
  const link = result.link || {};
  const title = String(link.title || '').trim();
  if (!title) return { ok: false, error: '帖子不存在或已被删除' };

  const comments = Array.isArray(result.comments) ? result.comments : [];
  // 结构：result.comments[] = { comment: [主评论, 楼中楼…] }。第一层是楼层，
  // 同一个 comment 数组里后面几条通常是楼中楼回复（实测 2026-10-24）。
  const flat = [];
  for (const floor of comments) {
    const list = Array.isArray(floor?.comment) ? floor.comment : [];
    for (const c of list) {
      const text = String(c?.text || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!text) continue;
      flat.push({
        id: String(c.commentid || c.comment_id || ''),
        user: String(c.user?.username || ''),
        text: text.slice(0, 300),
        like: Number(c.up ?? c.like_num ?? 0),
        replies: Number(c.child_num ?? 0),
        rootId: String(c.root_comment_id || c.commentid || ''),
        replyId: String(c.commentid || ''),
        floor: Number(c.floor_num) || 0
      });
    }
  }
  const picked = flat.slice(0, replyLimit);

  const body = xhhBodyText(link).slice(0, 1200);
  const id = String(link.linkid || linkId);
  const url = `https://www.xiaoheihe.cn/app/bbs/link/${id}`;
  const lines = [
    `标题：${title}`,
    `作者：${link.user?.username || link.user?.nickname || '?'}`,
    `链接：${url}`,
    `正文：${body || '（无）'}`
  ];
  if (picked.length) {
    lines.push(`评论（${picked.length} 条）：`);
    for (const c of picked) {
      lines.push(`- [${c.id}] ${c.user}（${c.like} 赞${c.replies ? `，${c.replies} 回复` : ''}）：${c.text.slice(0, 140)}`);
    }
  }
  return {
    ok: true,
    source: 'xhh',
    contentId: id,
    title,
    author: String(link.user?.username || ''),
    url,
    imageUrls: extractXhhImages(link),
    text: lines.join('\n'),
    desc: body,
    replies: picked
  };
}

/* ── 图片 ─────────────────────────────────────────────────────── */

/**
 * 从小黑盒正文里抽图片。
 *
 * `link.text` 是 JSON 数组，每项 `.text` 是 HTML；图片的地址在 **`data-original`**
 * 上，不是 `src`（`src` 是懒加载占位）。2026-10-24 实测。
 */
export function extractXhhImages(link, limit = 4) {
  const raw = link?.text;
  if (!raw) return [];
  let arr = [];
  try {
    arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const item of arr) {
    const html = String(item?.text || '');
    const re = /<img[^>]*?data-original=["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = m[1];
      if (u && !out.includes(u)) out.push(u);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** B 站视频封面。 */
export function extractBiliImages(video) {
  const pic = String(video?.pic || video?.cover || '').trim();
  return pic ? [pic] : [];
}

/**
 * 把图片下载到本地，返回路径。她拿到路径后用 `read_image` 就能看。
 * 失败返回空数组（看图是加分项，不能因此让浏览失败）。
 */
export async function downloadImages(urls, { dir, limit = 4, fetchImpl = globalThis.fetch } = {}) {
  const list = (urls || []).slice(0, limit);
  if (!list.length || !dir) return [];
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const crypto = await import('node:crypto');
  try { fsMod.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  const saved = [];
  for (const url of list) {
    try {
      // 图片站有防盗链：referer 要跟着域名走，不然小黑盒/ B 站都会 403
      const ref = /hdslb|bilibili/i.test(url) ? 'https://www.bilibili.com/' : 'https://www.xiaoheihe.cn/';
      const res = await fetchImpl(url, {
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36',
          referer: ref
        },
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) continue;              // 太小多半是占位图
      const ext = /\.png(\?|$)/i.test(url) ? 'png' : (/\.webp(\?|$)/i.test(url) ? 'webp' : 'jpg');
      const name = crypto.createHash('md5').update(url).digest('hex').slice(0, 12);
      const file = pathMod.join(dir, `${name}.${ext}`);
      fsMod.writeFileSync(file, buf);
      saved.push(file);
    } catch { /* 单张失败不影响其它 */ }
  }
  return saved;
}

/* ── 统一入口 ─────────────────────────────────────────────────── */

/** 根据用户给的东西猜来源：BV 号 → B 站；纯数字/长十六进制 → 小黑盒；否则两边都搜。 */
export function guessSource(input) {
  const s = String(input || '').trim();
  if (/^BV[0-9A-Za-z]{10}$/.test(s)) return 'bili';
  if (/^\d{6,}$/.test(s) || /^[0-9a-f]{32}$/i.test(s)) return 'xhh';
  return '';
}

/**
 * 从**分享链接**里抠出「来源 + id」。
 *
 * 为什么要它：机主在 QQ 里分享时发的是链接，不是 ID ——
 *   https://www.xiaoheihe.cn/app/bbs/post_share?link_id=11b572b24619&qq_aio_chat_type=2&...
 * guessSource 只认纯 ID，于是链接被当成关键词去搜，搜不到、也打不开，
 * 她只能回「网页是个空壳」然后让机主手打标题（2026-10-26 实际发生）。
 *
 * 返回 null 表示这不是一条认得的分享链接（普通关键词/别的网站），调用方按原样处理。
 */
export function parseShareLink(input) {
  const s = String(input || '').trim();
  const m = s.match(/https?:\/\/[^\s]+/i);
  if (!m) return null;
  let u;
  try { u = new URL(m[0]); } catch { return null; }
  const host = u.hostname.toLowerCase();
  const url = m[0];

  if (/(^|\.)bilibili\.com$/.test(host)) {
    const bv = url.match(/BV[0-9A-Za-z]{10}/);
    if (bv) return { source: 'bili', id: bv[0], url };
    const av = url.match(/\/video\/av(\d+)/i);
    if (av) return { source: 'bili', id: av[1], url };   // detailBili 也认纯 av 号
    return { source: 'bili', id: '', url };
  }
  if (host === 'b23.tv') return { source: 'bili', id: '', url };   // 短链，要展开才知道

  if (/(^|\.)xiaoheihe\.(cn|com)$/.test(host)) {
    const linkId = u.searchParams.get('link_id') || u.searchParams.get('linkid') || '';
    if (/^[0-9a-f]{8,32}$/i.test(linkId)) return { source: 'xhh', id: linkId.toLowerCase(), url };
    const inPath = u.pathname.match(/\/bbs\/link\/([0-9a-f]{8,32})/i);
    if (inPath) return { source: 'xhh', id: inPath[1].toLowerCase(), url };
    return { source: 'xhh', id: '', url };
  }

  return null;
}

/** 展开短链（b23.tv）拿到真实 URL；失败返回空串。 */
export async function expandShortLink(url, { timeoutMs = 8000 } = {}) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    return r.url || '';
  } catch {
    return '';
  }
}

export function formatItemList(source, items) {
  const tag = source === 'bili' ? 'B 站' : '小黑盒';
  return items.map((x, i) => {
    const meta = x.source === 'bili-search'
      ? `${x.play} 播放${x.duration ? ` · ${x.duration}` : ''}`
      : `${x.stats?.comments || 0} 评论`;
    return `${i + 1}. ${x.title}（${meta}）\n   ${x.url}`;
  }).join('\n') || `（${tag}没搜到）`;
}
