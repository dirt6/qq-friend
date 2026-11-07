// 修复 1/2：qqzone 的分类名规范化
//   工具 category: social -> 合法枚举（写操作 messaging / 读操作 query）
//   skill  category: social -> media（与 qq-self 的"个人空间"归类一致，避免回退成 utility）
// 只改 category 字段，别的字段一律原样保留；改前自动备份，改后回读校验。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'skills', 'qqzone', 'skill.json');

const TOOL_CATEGORY = {
  collect_diary: 'query',     // 收集素材，只读
  list_feeds: 'query',        // 刷好友动态，只读
  like_feed: 'messaging',     // 有写操作（点赞）
  comment_feed: 'messaging',  // 有写操作（评论）
  post_mood: 'messaging',     // 发说说
  post_diary: 'messaging',    // 发日记
};

const raw = fs.readFileSync(FILE, 'utf8');
const before = JSON.parse(raw);

// 备份（带时间戳，放 data/ 下不污染技能目录）
const bak = path.join(ROOT, 'data', `qqzone-skill.json.bak-${Date.now()}`);
fs.writeFileSync(bak, raw, 'utf8');
console.log('[备份]', path.relative(ROOT, bak));

const changes = [];

// ── 技能分类 ──────────────────────────────────────────────────────────────
if (before.category !== 'media') {
  changes.push(`skill.category: ${JSON.stringify(before.category)} -> "media"`);
  before.category = 'media';
}

// ── 工具分类 ──────────────────────────────────────────────────────────────
if (Array.isArray(before.tools)) {
  for (const t of before.tools) {
    const want = TOOL_CATEGORY[t.id];
    if (want && t.category !== want) {
      changes.push(`tools[${t.id}].category: ${JSON.stringify(t.category)} -> ${JSON.stringify(want)}`);
      t.category = want;
    }
  }
}

if (!changes.length) {
  console.log('[跳过] 已经都是合法分类，没有需要改的');
} else {
  // 保持 2 空格缩进 + 末尾换行，与原文件风格一致
  fs.writeFileSync(FILE, JSON.stringify(before, null, 2) + '\n', 'utf8');
  console.log('[写入] 改动 ' + changes.length + ' 处：');
  for (const c of changes) console.log('   ' + c);
}

// ── 回读校验 ──────────────────────────────────────────────────────────────
const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const VALID_SKILL = ['model', 'message', 'media', 'knowledge', 'utility', 'web'];
const VALID_TOOL = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
const bad = [];
if (!VALID_SKILL.includes(after.category)) bad.push('skill.category=' + after.category);
for (const t of after.tools || []) if (!VALID_TOOL.includes(t.category)) bad.push(`tools[${t.id}].category=` + t.category);
console.log('[校验] 技能分类=' + after.category + '，工具分类=' + (after.tools || []).map((t) => t.id + ':' + t.category).join(', '));
console.log(bad.length ? '[✘] 仍有非法值：' + bad.join(', ') : '[✔] 全部合法');

// 确认没弄丢其它字段
const lostKeys = Object.keys(JSON.parse(raw)).filter((k) => !(k in after));
console.log(lostKeys.length ? '[✘] 丢字段：' + lostKeys.join(',') : '[✔] 顶层字段无丢失（' + Object.keys(after).length + ' 个）');
