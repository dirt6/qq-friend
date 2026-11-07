// 给候选补「正文 + 热评」。
//
// 为什么需要：自主活动原来只把标题、分区、播放量喂给模型，模型其实不知道
// 那条内容到底在说什么，写出来的分享只能停在「标题党复述」。
//
// 两条链路都走公开接口，不需要手机、也不需要额外登录：
//   · B 站：candidates 的 contentId 就是 bvid → /x/web-interface/view + /x/v2/reply
//   · 小黑盒：contentId 就是 linkid → /bbs/app/link/tree（正文在 link.text 的 JSON 里）
//
// 只补前几条：每多补一条就多一段正文，token 预算里是要还的。

import { formatDetail } from './bili/api.js';

/** 从小黑盒 link/tree 的返回里抠出标题、正文、热评。 */
export function xhhDetailFromTree(json, { maxChars = 600, maxComments = 3 } = {}) {
  const r = json?.result || {};
  const link = r.link || {};

  let body = String(link.description || '').trim();
  // link.text 是 JSON 字符串：[{"text":"<p>...</p>"}, ...]
  try {
    const arr = JSON.parse(String(link.text || '[]'));
    if (Array.isArray(arr)) {
      const joined = arr
        .map((x) => String(x?.text ?? ''))
        .join('\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (joined.length > body.length) body = joined;
    }
  } catch { /* 不是 JSON 就用 description */ }

  const comments = Array.isArray(r.comments) ? r.comments : [];
  const tops = comments.slice(0, maxComments).map((c) => ({
    user: String(c?.user?.username ?? c?.username ?? c?.user?.nickname ?? ''),
    text: String(c?.content ?? c?.text ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120),
    like: Number(c?.like_num ?? c?.like ?? 0) || 0
  })).filter((x) => x.text);

  return {
    title: String(link.title || ''),
    body: body.slice(0, maxChars),
    comments: tops,
    commentNum: Number(link.comment_num) || 0
  };
}

/** 把小黑盒详情压成给模型看的文本。 */
export function formatXhhDetail(d) {
  const lines = [];
  if (d.title) lines.push(`标题：${d.title}`);
  lines.push(`正文：${d.body || '（无）'}`);
  if (d.comments?.length) {
    lines.push('热评：');
    for (const c of d.comments) lines.push(`- ${c.user}：${c.text}`);
  }
  return lines.join('\n');
}

/**
 * 给前 limit 条候选补详情，挂到 item.detail 上。
 * 单条失败只记日志，不中断整轮——详情是加分项，不是必需品。
 */
export async function enrichItems(items, { bili, xhh, limit = 2, log = () => {} } = {}) {
  const out = items.map((x) => ({ ...x }));
  for (const item of out.slice(0, Math.max(0, limit))) {
    const id = String(item?.contentId || '');
    try {
      if (String(item.source || '').startsWith('bili') && /^BV[0-9A-Za-z]+$/.test(id)) {
        const d = await bili.detail(id, { replyLimit: 4 });
        if (d.ok) item.detail = formatDetail(d, { maxDesc: 400, maxReplies: 3 });
        else log(`B 站详情失败 ${id}：${d.error}`);
      } else if (item.source === 'xhh' && id) {
        const r = await xhh.linkTree(id);
        if (r.ok) item.detail = formatXhhDetail(xhhDetailFromTree(r.json));
        else log(`小黑盒详情失败 ${id}：${r.error}`);
      }
    } catch (e) {
      log(`详情异常 ${id}：${e?.message ?? e}`);
    }
  }
  return out;
}
