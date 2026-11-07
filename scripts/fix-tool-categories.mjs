// 修复 1 的续：分类的真正源头在**注册代码**里（skill.json 的声明只是元数据，加载器用注册时写的值）。
//   · skills/qqzone/index.js：6 处 category:'social' -> 按工具改成合法枚举
//   · skills/steam-deals/index.js：category:'utility' 是合法的，真正的问题是 required: [] （空数组应省略）
// 改法：逐行处理，遇到 category 行就往上找最近的 id:'xxx' 判断它属于哪个工具 —— 不靠猜、不整段替换。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WRITE = process.argv.includes('--write');

const TOOL_CATEGORY = {
  collect_diary: 'query',
  list_feeds: 'query',
  like_feed: 'messaging',
  comment_feed: 'messaging',
  post_mood: 'messaging',
  post_diary: 'messaging',
};

const jobs = [
  { file: 'skills/qqzone/index.js', kind: 'category' },
  { file: 'skills/steam-deals/index.js', kind: 'required' },
];

for (const job of jobs) {
  const full = path.join(ROOT, job.file);
  const raw = fs.readFileSync(full, 'utf8');
  const lines = raw.split('\n');
  const changes = [];

  if (job.kind === 'category') {
    let currentId = null;
    for (let i = 0; i < lines.length; i++) {
      const idm = /id:\s*'([a-zA-Z0-9_]+)'/.exec(lines[i]);
      if (idm) currentId = idm[1];
      const cm = /category:\s*'([^']+)'/.exec(lines[i]);
      if (cm) {
        const want = TOOL_CATEGORY[currentId];
        if (want && cm[1] !== want) {
          changes.push({ line: i + 1, from: cm[1], to: want, tool: currentId, text: lines[i].trim() });
          lines[i] = lines[i].replace(`category: '${cm[1]}'`, `category: '${want}'`);
        }
      }
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*required:\s*\[\s*\],?\s*$/.test(lines[i])) {
        changes.push({ line: i + 1, from: 'required: []', to: '(删掉该字段)', tool: '-', text: lines[i].trim() });
        lines[i] = null;   // 标记删除
      }
    }
  }

  console.log(`\n=== ${job.file} ===`);
  if (!changes.length) { console.log('  无需改动（已合法）'); continue }
  for (const c of changes) console.log(`   行${c.line} [${c.tool}] ${c.from} -> ${c.to}`);

  if (WRITE) {
    fs.writeFileSync(path.join(ROOT, 'data', path.basename(job.file) + '.bak-' + Date.now()), raw, 'utf8');
    const out = lines.filter((l) => l !== null).join('\n');
    fs.writeFileSync(full, out, 'utf8');
    console.log('   [写入] 已改（备份在 data/），改动 ' + changes.length + ' 处');
  } else {
    console.log('   [预览] 加 --write 才会真的写');
  }
}
