#!/usr/bin/env node
// SurfCore 源码结构分析（只读，不发请求）。
import fs from 'node:fs';
import path from 'node:path';

const dir = path.join(process.env.TEMP, 'surfcore-audit');
const files = process.argv.slice(2);

for (const name of files) {
  const f = path.join(dir, name + '.js');
  if (!fs.existsSync(f)) { console.log(`\n### ${name}: 文件不存在`); continue; }
  const code = fs.readFileSync(f, 'utf8');
  const lines = code.split('\n');

  console.log(`\n${'='.repeat(70)}`);
  console.log(`### ${name}.js  (${lines.length} 行, ${code.length} 字符)`);
  console.log('='.repeat(70));

  // 顶部注释
  const header = [];
  for (const l of lines.slice(0, 26)) {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('/**') || t.startsWith('//')) header.push('  ' + t);
  }
  if (header.length) {
    console.log('\n--- 设计意图（顶部注释）---');
    header.slice(0, 16).forEach((l) => console.log(l));
  }

  // 导出
  const exports = [];
  for (const l of lines) {
    const m = l.match(/^export\s+(?:async\s+)?(function|const|let|class)\s+([A-Za-z0-9_]+)/);
    if (m) exports.push(`${m[1] === 'function' ? 'fn ' : m[1]} ${m[2]}`);
  }
  console.log(`\n--- 导出（${exports.length}）---`);
  exports.forEach((e) => console.log('  ' + e));

  // 关键常量
  const consts = [];
  for (const l of lines) {
    const m = l.match(/^const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(.{0,70})/);
    if (m) consts.push(`${m[1]} = ${m[2]}`);
  }
  if (consts.length) {
    console.log(`\n--- 常量（${consts.length}）---`);
    consts.slice(0, 20).forEach((c) => console.log('  ' + c));
  }

  // 关键模式
  console.log('\n--- 关键实现 ---');
  const pats = [
    ['串行化（promise 链）', /let chain = Promise\.resolve/],
    ['备份（backupFile）', /backupFile\(/],
    ['原子写（atomic）', /writeJsonAtomic|writeTextAtomic/],
    ['衰减归档', /archiveDecayedToFull/],
    ['容量压缩', /compactMemoryCard/],
    ['告警阈值（80/90/100）', /alertLevel|ALERT_LEVEL|percent >= 80/],
    ['通知 owner', /notifyOwner/],
    ['定时器', /setInterval|setTimeout/],
    ['inbox 追加（桥接侧）', /inbox|appendFileSync/],
    ['损坏文件备份', /corrupt/i],
    ['幂等（seen/idempot）', /seen|idempot|dedup/i],
    ['风险评分', /risk|confidence|urgency|value/i],
    ['状态迁移', /status\s*=|state\s*=/],
    ['安静时段', /quiet|silent|night/i],
    ['预算闸门', /budget|quota|limit/i]
  ];
  for (const [n, re] of pats) console.log(`  ${re.test(code) ? '✓' : '·'} ${n}`);
}
