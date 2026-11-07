// 5.0：B站视频总结（只基于公开详情 + 热评，没字幕就明确说）。
// 这里只负责组织材料/调用注入的 chat；不联网、不写记忆、不发消息。
const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function videoMaterial(detail) {
  const d = detail || {};
  const lines = [
    `标题：${clip(d.title, 200) || '（无）'}`,
    `UP：${clip(d.owner, 80) || '（未知）'}`,
    `分区：${clip(d.tname, 40) || '（未知）'}`,
    `链接：${clip(d.url, 160) || '（无）'}`,
    `简介：${clip(d.desc, 800) || '（无）'}`
  ];
  if (d.stat) lines.push(`数据：${d.stat.view || 0} 播放 / ${d.stat.like || 0} 赞 / ${d.stat.reply || 0} 评论`);
  const replies = Array.isArray(d.replies) ? d.replies.slice(0, 8) : [];
  if (replies.length) {
    lines.push('热评：');
    for (const r of replies) lines.push(`- ${clip(r.user, 30) || '匿名'}（${r.like || 0} 赞）：${clip(r.text, 240)}`);
  } else {
    lines.push('热评：（没有拿到）');
  }
  return lines.join('\n');
}

export function summaryPrompt(detail) {
  return [
    '你是视频内容总结助手。只根据下面提供的标题、简介和热评总结，绝对不要编造视频画面、台词或未出现的情节。',
    '如果材料只有标题/简介/热评，没有字幕或正文，必须在“信息边界”里明确说明：总结主要基于简介和热评，不能代表完整视频。',
    '输出格式：',
    '一句话结论：……',
    '要点：',
    '1. ……',
    '2. ……',
    '3. ……',
    '热评在聊什么：……（没有热评就写“暂无热评”）',
    '信息边界：……',
    '',
    videoMaterial(detail)
  ].join('\n');
}

/**
 * @param {object} detail BiliClient.detail 的结果
 * @param {{chat: Function}} opts chat 接收 {messages, temperature, maxTokens, purpose}
 * @returns {Promise<{ok:boolean,summary?:string,error?:string,coverage?:string}>}
 */
export async function summarizeVideoDetail(detail, { chat } = {}) {
  if (!detail || detail.ok !== true) return { ok: false, error: detail?.error || '没有可总结的视频详情' };
  if (typeof chat !== 'function') return { ok: false, error: 'summary_chat_missing' };
  let r;
  try {
    r = await chat({
      messages: [
        { role: 'system', content: '你只做有依据的总结，不补写没看到的内容。' },
        { role: 'user', content: summaryPrompt(detail) }
      ],
      temperature: 0.2,
      maxTokens: 800,
      purpose: 'bili-summary'
    });
  } catch (e) {
    return { ok: false, error: `summary_failed:${String(e?.message || e)}` };
  }
  const text = clip(r?.message?.content ?? r?.content, 4000);
  if (!text) return { ok: false, error: 'summary_empty' };
  return {
    ok: true,
    summary: text,
    coverage: 'metadata+hot_comments',
    replyCount: Array.isArray(detail.replies) ? detail.replies.length : 0,
    model: String(r?.model || '')
  };
}

export default summarizeVideoDetail;
