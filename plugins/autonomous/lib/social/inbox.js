// 收件箱：谁回复了她、谁 @ 了她。
//
// 为什么需要：能发不能收，等于只长了一张嘴。有了这个，她才能「看到有人回我
// → 直接在那条下面回楼中楼」，而不是等老大转述。
//
// 两个平台的结构完全不同，这里统一成同一种条目：
//   { source, kind:'reply'|'at'|'mention', user, text, context, url,
//     target, replyTo, root, ts }
// 其中 replyTo/root 是**直接可以喂给 qq_comment 的**（B 站 root+parent，
// 小黑盒 reply_id/root_id），省得她再自己推。
//
// 读接口：
//   B 站  GET /x/msgfeed/reply?pn=1&ps=N   （回复我的）
//         GET /x/msgfeed/at?pn=1&ps=N      （@我的）
//   小黑盒 GET /bbs/app/user/message        （message_type=16 是 @，list_type=0 是回复）

import fs from 'node:fs';
import { BiliClient } from '../bili/api.js';

/** 从 B 站 uri 里抠 BV 号（uri 形如 https://www.bilibili.com/video/BV1oWx1e5Euj）。 */
export function bvidFromUrl(url) {
  const m = String(url || '').match(/(BV[0-9A-Za-z]{10})/);
  return m ? m[1] : '';
}

/** B 站消息条目的时间戳（秒）→ ISO。 */
function tsText(sec) {
  const n = Number(sec) || 0;
  return n > 0 ? new Date(n * 1000).toISOString() : '';
}

/**
 * B 站收件箱：回复我的 + @我的。
 * @param {object} o
 * @param {string} o.cookie   bili-auth 里的 Cookie 串（没有就只报没登录）
 * @param {number} [o.limit]  每类取几条
 */
export async function inboxBili({ cookie, limit = 8, fetchImpl = globalThis.fetch } = {}) {
  if (!cookie) return { ok: false, error: 'B 站还没导入登录态', items: [] };
  const client = new BiliClient({ cookie, fetchImpl });
  const out = [];
  const errors = [];

  for (const [path, kind] of [['/x/msgfeed/reply', 'reply'], ['/x/msgfeed/at', 'at']]) {
    let r;
    try {
      r = await client.get(path, { pn: 1, ps: Math.max(1, Math.min(20, limit)) });
    } catch (e) {
      errors.push(`${kind}: ${e?.message ?? e}`);
      continue;
    }
    if (r.status === 412) { errors.push(`${kind}: 被风控（412）`); continue; }
    if (r.json?.code !== 0) {
      const code = r.json?.code;
      errors.push(code === -101
        ? `${kind}: 登录态失效（-101），要重新导入 B 站 Cookie`
        : `${kind}: code ${code ?? '?'} ${r.json?.message ?? ''}`);
      continue;
    }
    const items = r.json?.data?.items || [];
    for (const it of items) {
      const item = it.item || {};
      const user = it.user || {};
      const text = String(item.source_content || item.root_reply_content || item.title || '').trim();
      out.push({
        source: 'bili',
        kind: kind === 'reply' ? 'reply' : 'at',
        user: String(user.nickname || ''),
        uid: String(user.mid || ''),
        text,
        // 上下文：落在哪个视频/动态下
        context: String(item.title || item.desc || '').slice(0, 80),
        url: String(item.uri || ''),
        target: bvidFromUrl(item.uri),
        // 回楼中楼用：root=楼层根，replyTo=对方那条
        root: String(item.root_id || ''),
        replyTo: String(item.source_id || item.root_id || ''),
        ts: tsText(it.reply_time),
        // @ 消息里被 @ 的细节（B 站偶尔给）
        atDetails: Array.isArray(item.at_details) ? item.at_details.length : 0
      });
    }
  }

  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
  return { ok: true, items: out.slice(0, limit * 2), errors };
}

/** 小黑盒的消息里 user_a / user_b 是 JSON 字符串，必须二次 parse。 */
function parseUser(v) {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return {}; }
}

/** 小黑盒正文里可能带 @ 的 HTML 链接，去掉标签但保留 @昵称。 */
function cleanXhhText(s) {
  return String(s || '')
    .replace(/<a[^>]*data-user-id="(\d+)"[^>]*>([^<]*)<\/a>/g, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把楼层树拍平成 commentid → 评论 的索引。
 * 小黑盒的楼层结构是 `result.comments[] = { comment: [主评论, 楼中楼…] }`，
 * 楼中楼用 `replyid` 指向它回复的那条评论（2026-10-24 实测）。
 */
export function indexComments(result) {
  const map = new Map();
  for (const floor of result?.comments || []) {
    for (const c of floor?.comment || []) {
      if (c?.commentid) map.set(String(c.commentid), c);
    }
  }
  return map;
}

/**
 * 找到「对方那条评论」以及「它回复的是哪一条」——后者就是她原来说的话。
 * @returns {{theirComment:string, myComment:string, myUser:string}|null}
 */
export function findReplyContext(map, commentId) {
  const me = map.get(String(commentId || ''));
  if (!me) return null;
  const clean = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const parentId = String(me.replyid || '');
  const parent = parentId ? map.get(parentId) : null;
  return {
    theirComment: clean(me.text).slice(0, 200),
    myComment: parent ? clean(parent.text).slice(0, 200) : '',
    myUser: parent ? String(parent.user?.username || '') : ''
  };
}

/**
 * 小黑盒收件箱：@ 我的 + 回复我的。
 *
 * `contextLimit` 条（默认前 2 条）会额外拉一次原帖，带上标题和正文摘要——
 * 否则她只知道「A 回复了你：😍😍」（2026-10-24 机主反馈：回复不检索上下文）。
 * 同一个 linkid 只拉一次。
 *
 * @param {import('../xhh/client.js').XhhClient} xhh
 */
export async function inboxXhh(xhh, { limit = 8, contextLimit = 2 } = {}) {
  const out = [];
  const errors = [];
  for (const [kind, method] of [['mention', 'mention'], ['reply', 'reply']]) {
    let r;
    try {
      r = await xhh.messages(method, { limit: Math.max(1, Math.min(20, limit)) });
    } catch (e) {
      errors.push(`${kind}: ${String(e?.message ?? e)}`);
      continue;
    }
    if (!r.ok) { errors.push(`${kind}: ${r.error}`); continue; }
    const list = r.body?.messages || r.body?.list || [];
    for (const m of list) {
      const from = parseUser(m.user_a);
      const to = parseUser(m.user_b);
      const text = cleanXhhText(m.comment_a_text || m.text || m.comment_a_content || '');
      out.push({
        source: 'xhh',
        kind,
        user: String(from.username || m.link_user || ''),
        uid: String(from.userid || m.userid_a || ''),
        text,
        context: String(m.link_title || '').slice(0, 80),
        url: m.linkid ? `https://www.xiaoheihe.cn/app/bbs/link/${m.linkid}` : '',
        target: String(m.linkid || ''),
        // 小黑盒的 comment_a_id 就是回复目标
        root: String(m.root_comment_id || m.comment_a_id || ''),
        replyTo: String(m.comment_a_id || ''),
        ts: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : '',
        toSelf: to?.userid && String(to.userid) === String(xhh.uid)
      });
    }
  }
  out.sort((a, b) => String(b.ts).localeCompare(String(a.ts)));

  // 给最新的几条补上下文：原帖标题 + 正文摘要 + 「她原来说了什么」
  const postCache = new Map();
  for (let i = 0; i < out.length && i < contextLimit; i += 1) {
    const it = out[i];
    if (!it.target) continue;
    if (!postCache.has(it.target)) {
      let ctx = null;
      try {
        const tr = await xhh.linkTree(it.target);
        const link = tr.json?.result?.link;
        if (tr.ok && link) {
          const raw = String(link.text || '');
          let body = raw;
          try {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) body = arr.map((x) => String(x?.text || '')).join(' ');
          } catch { /* 不是 JSON 就用原文 */ }
          body = body.replace(/<[^>]+>/g, ' ')
            // 正文 HTML 里偶尔会漏出图片的本地缓存路径（/storage/emulated/0/...），去掉
            .replace(/\/storage\/emulated\/[^\s]*/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          ctx = {
            title: String(link.title || ''),
            body: body.slice(0, 260),
            index: indexComments(tr.json?.result)
          };
        }
      } catch { /* 上下文拿不到不影响回复 */ }
      postCache.set(it.target, ctx);
    }
    const ctx = postCache.get(it.target);
    if (!ctx) continue;
    it.postTitle = ctx.title;
    it.postBody = ctx.body;
    // 对方回复的那条评论 → 它 replyid 指向的，就是她原来说的话
    if (ctx.index && it.replyTo) {
      const rc = findReplyContext(ctx.index, it.replyTo);
      if (rc) {
        if (rc.theirComment) it.theirComment = rc.theirComment;
        if (rc.myComment) it.myComment = rc.myComment;
        if (rc.myUser) it.myUser = rc.myUser;
      }
    }
  }

  return { ok: true, items: out.slice(0, limit * 2), errors };
}

function ago(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const min = Math.floor(ms / 60000);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.floor(h / 24)} 天前`;
}

/**
 * 把收件箱条目压成一段她可以直接读、并且知道怎么回的文字。
 * 每条都带上「要回复就传这些参数」的提示。
 */
export function formatInbox({ bili, xhh, limit = 8 } = {}) {
  const sections = [];
  const push = (label, res) => {
    if (!res) return;
    if (!res.ok) { sections.push(`【${label}】${res.error}`); return; }
    const items = res.items || [];
    if (!items.length) { sections.push(`【${label}】没有新消息`); return; }
    const lines = [`【${label}】${items.length} 条`];
    for (const it of items) {
      const who = it.user || '某人';
      const what = it.kind === 'at' || it.kind === 'mention' ? '@了你' : '回复了你';
      lines.push(`- ${who} ${what}（${ago(it.ts)}）${it.context ? ` · 在「${it.context}」` : ''}`);
      if (it.text) lines.push(`  说：「${it.text.slice(0, 120)}」`);
      if (it.myComment) lines.push(`  你原来说：「${it.myComment.slice(0, 140)}」`);
      if (it.postBody) lines.push(`  原帖正文：${it.postBody.slice(0, 200)}`);
      if (it.target) {
        const reply = it.replyTo
          ? `source=${it.source}, target=${it.target}, replyTo=${it.replyTo}${it.root && it.root !== it.replyTo ? `, root=${it.root}` : ''}`
          : '';
        lines.push(`  要回这条：${reply || `target=${it.target}`}`);
      }
    }
    sections.push(lines.join('\n'));
  };
  push('B 站', bili);
  push('小黑盒', xhh);
  const errs = [...(bili?.errors || []), ...(xhh?.errors || [])];
  if (errs.length) sections.push(`（有些没拉全：${errs.join('；')}）`);
  return sections.join('\n\n');
}

/** 从 data/bili-auth.json 读 Cookie 串（缺文件就空串）。 */
export function readBiliCookie(authFile) {
  try {
    const j = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    return Object.entries(j.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  } catch {
    return '';
  }
}
