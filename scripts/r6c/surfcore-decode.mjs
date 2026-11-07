#!/usr/bin/env node
// SurfCore 源码审查辅助：解码 GitHub API 返回的 base64 内容，提取关键结构。
//
// ⚠️ 只做只读分析，不修改任何东西，也不把外部代码写进项目。
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
const label = process.argv[3] || 'unknown';
if (!src) { console.error('用法: node surfcore-decode.mjs <base64文件|json文件> [标签]'); process.exit(1); }

let b64 = '';
const raw = fs.readFileSync(src, 'utf8');

// 判断是纯 base64 还是 GitHub content API 的 JSON
try {
  const j = JSON.parse(raw);
  if (j.content) b64 = j.content;
  else if (j.encoding === 'base64' && j.content) b64 = j.content;
  else { console.error('JSON 里没有 content 字段'); process.exit(1); }
} catch {
  b64 = raw;
}

const code = Buffer.from(b64, 'base64').toString('utf8');
const outDir = path.join(process.env.TEMP, 'surfcore-audit');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, label + '.js');
fs.writeFileSync(outFile, code, 'utf8');

console.log(`=== ${label} ===`);
console.log(`源码长度: ${code.length} 字符，${code.split('\n').length} 行`);
console.log(`已存: ${outFile}`);
console.log('');

const lines = code.split('\n');

console.log('--- 顶部注释（设计意图）---');
for (const l of lines.slice(0, 30)) {
  if (l.startsWith('*') || l.startsWith('/**') || l.startsWith('//') || l.startsWith(' *')) {
    console.log('  ' + l.trim());
  }
}
console.log('');

console.log('--- import ---');
for (const l of lines) {
  if (/^import /.test(l)) console.log('  ' + l.trim());
}
console.log('');

console.log('--- 导出的函数/常量 ---');
for (const l of lines) {
  const m = l.match(/^export\s+(async\s+)?(function|const|let)\s+([A-Za-z0-9_]+)/);
  if (m) console.log('  ' + (m[2] === 'function' ? 'fn ' : 'const ') + m[3]);
}
console.log('');

console.log('--- 常量（全大写）---');
for (const l of lines) {
  const m = l.match(/^const\s+([A-Z][A-Z0-9_]+)\s*=/);
  if (m) console.log('  ' + m[1] + '  ' + l.trim().slice(0, 100));
}
console.log('');

console.log('--- 关键实现模式 ---');
const patterns = [
  ['串行化（promise 链）', /let chain = Promise\.resolve|serialize\(/],
  ['备份', /backupFile\(/],
  ['原子写', /writeJsonAtomic|writeTextAtomic/],
  ['衰减归档到全量', /archiveDecayedToFull/],
  ['容量压缩', /compactMemoryCard/],
  ['告警阈值', /alertLevel|80|90|100/],
  ['通知 owner', /notifyOwnerIfNeeded|shouldNotifyOwner/],
  ['定时器', /setInterval|setTimeout/],
  ['崩溃恢复（备份损坏文件）', /corrupt|backupFile\(.*corrupt/]
];
for (const [name, re] of patterns) {
  console.log(`  ${re.test(code) ? '✓' : '✗'} ${name}`);
}
