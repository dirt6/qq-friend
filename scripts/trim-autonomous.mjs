// 清理自主活动的历史数据（2026-10-31 机主：跑了 58 轮，想删一点省空间）。
//
// 三块占地方：
//   · seen  去重表：656 条约 125 KB —— **最大的一块**，只用来避免重复看同一条，
//     太久以前的没必要留；
//   · history 每轮记录：58 轮约 42 KB；
//   · autonomous-log.md：51 段约 59 KB。
//
// 用法：
//   node scripts/trim-autonomous.mjs                 按默认（去重 7 天 / 历史 20 轮 / 日志 20 段）
//   node scripts/trim-autonomous.mjs --dry           只看会删多少，不写
//   node scripts/trim-autonomous.mjs --seen-days 3 --keep-rounds 10 --keep-log 10
//
// 安全：先备份到 data/.trim-backup/，再原子替换；机器人 IDLE 时跑最稳。
import fs from 'node:fs';
import path from 'node:path';
// 4.0 / 1.5.3：不再自己读改写 —— 走单写者（锁内 读-改-写 + 原子替换）。
import { withState } from '../src/state-store.js';

const DATA = path.join(process.cwd(), 'data');
const STORE = path.join(DATA, 'autonomous.json');
const LOG = path.join(DATA, 'autonomous-log.md');
const BACKUP_DIR = path.join(DATA, '.trim-backup');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    args.set(k, v ?? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : 'true'));
  }
}
const dry = args.has('dry');
const seenDays = Math.max(0, Number(args.get('seen-days') ?? 7));
const keepRounds = Math.max(1, Number(args.get('keep-rounds') ?? 20));
const keepLog = Math.max(1, Number(args.get('keep-log') ?? 20));

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
const now = Date.now();

// ── 读 ──
const beforeSize = fs.existsSync(STORE) ? fs.statSync(STORE).size : 0;
// 试读一次：文件坏了就别硬改（withState 会把它备份重建，那不是 trim 该做的事）
try {
  JSON.parse(fs.readFileSync(STORE, 'utf8'));
} catch (e) {
  console.error(`读不了 ${STORE}：${e.message}`);
  process.exit(1);
}
const st = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const beforeLog = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
const beforeSeen = Object.keys(st.seen || {}).length;
const beforeRounds = Array.isArray(st.history) ? st.history.length : 0;
const logRaw = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
const logHead = '# 她一个人时都在干嘛（自动记录，可随时删）\n';
const logBody = logRaw.startsWith(logHead) ? logRaw.slice(logHead.length) : logRaw;
const logParts = logBody.split(/\n(?=## )/).filter(Boolean);

// ── 算 ──
// 1) 去重表：lastSeenAt 太老的丢掉（没有时间戳的按 firstSeenAt 算，都没有就保留）
const cutoff = now - seenDays * 86400e3;
const seen = st.seen || {};
const keptSeen = {};
let droppedSeen = 0;
for (const [k, v] of Object.entries(seen)) {
  const t = Number(v?.lastSeenAt || v?.firstSeenAt || 0);
  if (t && t < cutoff) { droppedSeen += 1; continue; }
  keptSeen[k] = v;
}

// 2) 历史：保留最近 N 轮
const hist = Array.isArray(st.history) ? st.history : [];
const keptHist = hist.slice(-keepRounds);
const droppedRounds = hist.length - keptHist.length;

// 3) 活动日志：保留最近 N 段
const keptLogParts = logParts.slice(0, keepLog);
const droppedLog = logParts.length - keptLogParts.length;

console.log('=== 清理前 ===');
console.log(`autonomous.json   ${kb(beforeSize)}（去重表 ${beforeSeen} 条 / 历史 ${beforeRounds} 轮）`);
console.log(`autonomous-log.md ${kb(beforeLog)}（${logParts.length} 段）`);
console.log('');
console.log('=== 将删除 ===');
console.log(`去重表：${droppedSeen} 条（${seenDays} 天前的）`);
console.log(`历史：${droppedRounds} 轮（保留最近 ${keptHist.length} 轮）`);
console.log(`日志：${droppedLog} 段（保留最近 ${keptLogParts.length} 段）`);

if (dry) {
  console.log('\n（--dry：什么都没写）');
  process.exit(0);
}

// ── 备份 ──
fs.mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const bakStore = path.join(BACKUP_DIR, `autonomous-${stamp}.json`);
fs.copyFileSync(STORE, bakStore);
if (fs.existsSync(LOG)) fs.copyFileSync(LOG, path.join(BACKUP_DIR, `autonomous-log-${stamp}.md`));
console.log(`\n已备份到 ${path.relative(process.cwd(), bakStore)}`);

// ── 写（单写者：锁内重新读 → 只替换这两个字段 → 原子替换）──
// 锁内重新读是为了不覆盖"读文件之后、写文件之前"别人做的修改。
const w = withState(STORE, (cur) => {
  cur.seen = keptSeen;
  cur.history = keptHist;
}, { fallback: st });
if (!w.ok) {
  console.error(`写入失败：${w.error}`);
  process.exit(1);
}

if (fs.existsSync(LOG)) {
  const tmpLog = `${LOG}.tmp`;
  fs.writeFileSync(tmpLog, logHead + keptLogParts.join('\n'), 'utf8');
  fs.renameSync(tmpLog, LOG);
}

const afterSize = fs.statSync(STORE).size;
const afterLog = fs.existsSync(LOG) ? fs.statSync(LOG).size : 0;
console.log('');
console.log('=== 清理后 ===');
console.log(`autonomous.json   ${kb(afterSize)}（省 ${kb(beforeSize - afterSize)}）`);
console.log(`autonomous-log.md ${kb(afterLog)}（省 ${kb(beforeLog - afterLog)}）`);
console.log(`合计省 ${kb((beforeSize + beforeLog) - (afterSize + afterLog))}；备份还在 data/.trim-backup/，确认没问题可以自己删`);
