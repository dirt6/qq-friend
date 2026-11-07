// 听歌（skills/now-playing）的单元测试
//
// 锁住三件事：
//   ① 选会话：优先网易云，其次"正在播放"，空列表返回 null
//   ② 歌词：LRC 按进度对行（xx.xxx / xx.xx 两种小数位都认），空行与短句跳过
//   ③ 时间格式化：秒 → m:ss
import { internals } from '../skills/now-playing/index.js';

const { pickSession, currentLyricLine, fmt } = internals;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('=== 一、选会话 ===');
{
  ok('空列表 → null', pickSession([]) === null);
  ok('优先网易云', pickSession([
    { app: 'Spotify.exe', status: 'Playing', title: 'A' },
    { app: 'CloudMusic.exe', status: 'Playing', title: 'B' }
  ])?.title === 'B');
  ok('没有网易云时取正在播放的', pickSession([
    { app: 'x.exe', status: 'Paused', title: 'P' },
    { app: 'y.exe', status: 'Playing', title: 'Q' }
  ])?.title === 'Q');
  ok('全都暂停时也有返回值', pickSession([{ app: 'x.exe', status: 'Paused', title: 'P' }])?.title === 'P');
}

console.log('=== 二、歌词对行 ===');
{
  const lrc = [
    '[00:00.000] 作词 : 某人',
    '[00:30.542]故事的小黄花',
    '[00:34.165]从出生那年就飘着',
    '[00:37.773]童年的荡秋千'
  ].join('\n');
  ok('进度 35s → 第二句', currentLyricLine(lrc, 35) === '从出生那年就飘着');
  ok('进度 34s → 第二句（含 0.3s 容差）', currentLyricLine(lrc, 34.1) === '从出生那年就飘着');
  ok('进度 10s → 空（还没到第一句）', currentLyricLine(lrc, 10) === '');
  ok('进度 40s → 第三句', currentLyricLine(lrc, 40) === '童年的荡秋千');
  ok('三位小数/两位小数都认', currentLyricLine('[00:01.5]甲\n[00:02.50]乙', 2.6) === '乙');
  ok('空歌词 → 空串', currentLyricLine('', 10) === '');
}

console.log('=== 三、时间格式 ===');
{
  ok('65 → 1:05', fmt(65) === '1:05');
  ok('0 → 0:00', fmt(0) === '0:00');
  ok('负数按 0', fmt(-3) === '0:00');
}

console.log('');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
