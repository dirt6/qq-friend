// 日记整理：临时日记目录 + fake chat；不联网、不定时。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { readDiaryForReview, diaryReviewPrompt, reviewDiary } from '../src/diary-review.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-review-'));
fs.writeFileSync(path.join(tmp, '2026-11-04.md'), '# 2026-11-04\n\n## 记录\n\n- 心情：平静｜[重要] 今天把日志找回来了\n', 'utf8');
fs.writeFileSync(path.join(tmp, '2026-11-05.md'), '# 2026-11-05\n\n## 记录\n\n- 心情：开心｜和小鲸鱼聊了画画\n', 'utf8');
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const r = readDiaryForReview({ days: 7, root: tmp });
ok('读取最近日记', r.ok === true && r.days.length === 2);
ok('提示词包含禁止编造', /不要编造/.test(diaryReviewPrompt(r.days)));
let seen = null;
const out = await reviewDiary({ days: 7, root: tmp, chat: async (args) => { seen = args; return { message: { content: '主题：日志与画画\n未解决：无' }, model: 'fake' }; } });
ok('整理成功', out.ok === true && /主题/.test(out.summary), JSON.stringify(out));
ok('材料含两天', /2026-11-04/.test(seen.messages[1].content) && /2026-11-05/.test(seen.messages[1].content));
const empty = await reviewDiary({ days: 7, root: path.join(tmp, 'none'), chat: async () => ({}) });
ok('空日记不调用模型', empty.ok === false || empty.summary.includes('没有'));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nDiary review: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
