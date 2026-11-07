// 一次性迁移：把 日记/ 根目录下旧的日期文件转成新格式并移进 每日/。
// 旧格式（# 📅 日期 + 两个小节）→ 新格式（# 日期 + ## 记录 + 每条 `- 心情：｜正文`）。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:\\dsh\\日记';
const DAILY = path.join(ROOT, '每日');
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const weekdayOf = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return WEEK[new Date(y, m - 1, d).getDay()] || '';
};

fs.mkdirSync(DAILY, { recursive: true });
const files = fs.readdirSync(ROOT).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n));
if (!files.length) { console.log('没有需要迁移的旧日记'); process.exit(0); }

for (const name of files) {
  const day = name.replace('.md', '');
  const src = path.join(ROOT, name);
  const text = fs.readFileSync(src, 'utf8');
  const lines = text.split('\n');
  const bullets = [];
  let inSection = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (l.startsWith('## ')) { inSection = true; continue; }
    if (inSection && l.startsWith('- ')) {
      const body = l.replace(/^-\s*/, '');
      if (body) bullets.push(body);
    }
  }
  const out = `# ${day} ${weekdayOf(day)}\n\n## 记录\n\n`
    + bullets.map((b) => `- 心情：｜${b}`).join('\n')
    + (bullets.length ? '\n' : '');

  const dest = path.join(DAILY, name);
  fs.writeFileSync(dest, out, 'utf8');

  // 备份旧文件到 .trash，再从根目录删掉
  const trash = path.join(ROOT, '.trash');
  fs.mkdirSync(trash, { recursive: true });
  fs.copyFileSync(src, path.join(trash, `${name}.legacy-${Date.now()}.bak`));
  fs.rmSync(src, { force: true });
  console.log(`migrated ${name} -> 每日\\${name} (${bullets.length} 条)`);
}
console.log('done');
