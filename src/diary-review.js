// 5.0：日记整理（只读回顾，不改原文）。
// 输入最近 N 天日记；输出主题、重复/矛盾、未解决、建议。
import fs from 'node:fs';
import path from 'node:path';
import { diaryDir } from './diary/index.js';

const clip = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

export function readDiaryForReview({ days = 7, root = '' } = {}) {
  const dir = root || diaryDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().reverse().slice(0, Math.max(1, Math.min(30, days)));
  } catch { return { ok: false, days: [], error: `读不到日记目录：${dir}` }; }
  const out = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      out.push({ day: f.replace(/\.md$/, ''), text: text.slice(0, 12000) });
    } catch { /* skip */ }
  }
  return { ok: true, days: out, dir };
}

export function diaryReviewPrompt(days) {
  const material = days.map((d) => `## ${d.day}\n${d.text}`).join('\n\n');
  return [
    '你是日记整理助手。只根据下面最近几天的日记做回顾，不要改写原文、不要编造。',
    '输出：',
    '1. 最近的主题（3-6 个）',
    '2. 重复出现或互相矛盾的地方',
    '3. 还没解决/值得继续跟进的事',
    '4. 给主人的 3 条温和建议',
    '如果某天没有内容，不要硬编。',
    '',
    material
  ].join('\n');
}

export async function reviewDiary({ days = 7, chat, root = '' } = {}) {
  if (typeof chat !== 'function') return { ok: false, error: 'review_chat_missing' };
  const r = readDiaryForReview({ days, root });
  if (!r.ok) return r;
  if (!r.days.length) return { ok: true, summary: '最近没有日记可整理。', days: [] };
  let out;
  try {
    out = await chat({
      messages: [
        { role: 'system', content: '你只整理已有日记，不补写没发生的事。' },
        { role: 'user', content: diaryReviewPrompt(r.days) }
      ],
      temperature: 0.2,
      maxTokens: 1200,
      thinkingMode: 'off',
      purpose: 'diary-review'
    });
  } catch (e) { return { ok: false, error: `review_failed:${String(e?.message || e)}` }; }
  const summary = clip(out?.message?.content ?? out?.content, 5000);
  if (!summary) return { ok: false, error: 'review_empty' };
  return { ok: true, summary, days: r.days.map((d) => d.day), model: String(out?.model || '') };
}

export default reviewDiary;
