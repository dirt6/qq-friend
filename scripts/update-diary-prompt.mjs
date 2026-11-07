// 更新日记技能的提示词：说明 每日/ 子目录与「日期·心情·记录」格式。
import fs from 'node:fs';

const FILE = 'E:\\dsh\\QQ-agent\\skills\\diary\\skill.json';
const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const sec = j.prompt.sections[0];
let text = sec.content;

const before = text;
text = text.replace(
  '、按日期命名的日记（如 2026-10-17.md）。',
  '。\n\n按日期的日记单独放在 E:\\dsh\\日记\\每日\\ 里（如 每日\\2026-10-17.md），promises/wishlist/core_profile 还在 E:\\dsh\\日记\\ 这一层。'
);
text = text.replace(
  '没有值得记的事就别写，不用凑流水账。',
  '没有值得记的事就别写，不用凑流水账。\n\n**日记格式**：一天一个文件，只记三样——日期（文件名和标题）、心情、记录。每条写成一行「- 心情：开心｜今天他……」，不要写小节标题，也不要凑总结句。'
);

if (text === before) throw new Error('没有匹配到要替换的文本');
sec.content = text;
fs.writeFileSync(FILE, JSON.stringify(j, null, 2) + '\n', 'utf8');
JSON.parse(fs.readFileSync(FILE, 'utf8'));
console.log('ok, content len', sec.content.length);
