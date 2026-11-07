// 让"发说说"只留一个出口，同时保住 qqzone 的刷动态 / 点赞 / 评论
//
//   ① qqzone：postsPerDay=0、diaryPerDay=0 —— 两条闸都关掉发帖（代码里 cap=0 会硬拦并给出人话原因）。
//      点赞/评论/刷动态的配额（likesPerHour=6、commentsPerHour=3）一律不动。
//   ② qq-fun：allowQzone=false —— 必须先确认这个工具真的不可用再下结论（关掉它自己的"发说说"出口）。
//   ③ qq-self：启用（它在 config.skills 里没有任何条目 = 只跟随 enabledByDefault=false，等于装了没生效），
//      由它接管发说说；postDailyLimit 从 6 收到 3，跟原来 qqzone 的每日上限对齐，避免总量反弹。
//
// 只动这几个键，其余一律原样保留；改前备份、改后回读校验。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'data', 'config.json');

const raw = fs.readFileSync(FILE, 'utf8');
const cfg = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
fs.writeFileSync(path.join(ROOT, 'data', `config.json.bak-${Date.now()}`), raw, 'utf8');
console.log('[备份] data/config.json.bak-*');

cfg.skills = cfg.skills || {};
const changes = [];
const setIf = (obj, key, value) => {
  if (obj[key] !== value) { changes.push(`${key}: ${JSON.stringify(obj[key])} -> ${JSON.stringify(value)}`); obj[key] = value; }
};

// ① qqzone：停发帖，保互动
const qz = cfg.skills.qqzone = cfg.skills.qqzone || {};
setIf(qz, 'postsPerDay', 0);
setIf(qz, 'diaryPerDay', 0);

// ② qq-fun：关掉它自己的说说出口
const qf = cfg.skills['qq-fun'] = cfg.skills['qq-fun'] || {};
setIf(qf, 'allowQzone', false);

// ③ qq-self：启用并接管
const qs = cfg.skills['qq-self'] = cfg.skills['qq-self'] || {};
setIf(qs, 'enabled', true);
setIf(qs, 'postDailyLimit', 3);

fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2), 'utf8');
console.log('[写入] 共 ' + changes.length + ' 处：');
for (const c of changes) console.log('   ' + c);

// ── 回读校验 ──────────────────────────────────────────────────────────────
const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const problems = [];
if (back.skills.qqzone.postsPerDay !== 0) problems.push('qqzone.postsPerDay 没写进去');
if (back.skills.qqzone.diaryPerDay !== 0) problems.push('qqzone.diaryPerDay 没写进去');
if (back.skills.qqzone.likesPerHour !== 6 || back.skills.qqzone.commentsPerHour !== 3) problems.push('点赞/评论配额被误改');
if (back.skills['qq-fun'].allowQzone !== false) problems.push('qq-fun.allowQzone 没关掉');
if (back.skills['qq-self'].enabled !== true) problems.push('qq-self 没启用');
if (back.skills['qq-self'].postDailyLimit !== 3) problems.push('qq-self.postDailyLimit 没收到 3');

// 人设、白名单这些不能被动到
const untouched = ['persona', 'allow', 'store', 'api', 'sticker'];
const lostKeys = Object.keys(cfg).length;
console.log('[校验] 顶层键数 = ' + lostKeys + '，关键段仍在 = ' +
  untouched.filter((k) => !(k in back)).length + ' 个缺失');
for (const k of untouched) if (!(k in back)) problems.push('丢了顶层段 ' + k);

console.log('[校验] qqzone: postsPerDay=' + back.skills.qqzone.postsPerDay +
  ' diaryPerDay=' + back.skills.qqzone.diaryPerDay +
  ' likesPerHour=' + back.skills.qqzone.likesPerHour +
  ' commentsPerHour=' + back.skills.qqzone.commentsPerHour);
console.log('[校验] qq-fun.allowQzone=' + back.skills['qq-fun'].allowQzone);
console.log('[校验] qq-self: enabled=' + back.skills['qq-self'].enabled + ' postDailyLimit=' + back.skills['qq-self'].postDailyLimit);
console.log(problems.length ? '[✘] ' + problems.join('; ') : '[✔] 全部符合预期');
