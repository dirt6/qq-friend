#!/usr/bin/env node
// 实验目录清理 CLI（4.0 / R6-C0-D）。
//
// 用法：
//   node scripts/r6c0/cleanup.mjs --list                 列出所有实验目录
//   node scripts/r6c0/cleanup.mjs --dir <路径>            演练（**默认不删**）
//   node scripts/r6c0/cleanup.mjs --dir <路径> --yes      真删
//   node scripts/r6c0/cleanup.mjs --recover <路径>        输出恢复指引
import { listExperiments, cleanupExperiment, checkDeletable, recoveryGuide } from './cleanup.mjs';

function usage() {
  console.log([
    '用法：',
    '  node scripts/r6c0/cleanup.mjs --list',
    '  node scripts/r6c0/cleanup.mjs --dir <路径>           演练（默认不删）',
    '  node scripts/r6c0/cleanup.mjs --dir <路径> --yes     真删',
    '  node scripts/r6c0/cleanup.mjs --recover <路径>       恢复指引',
    '',
    '安全规则：',
    '  · 只删除系统临时目录里、名字以 qq-r6c- 开头、且带 experiment.json 的目录',
    '  · 默认是演练模式，不加 --yes 绝不删除',
    '  · 任何指向生产路径的请求都会被拒绝'
  ].join('\n'));
}

const args = process.argv.slice(2);

if (!args.length || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(0);
}

if (args.includes('--list')) {
  const list = listExperiments();
  if (!list.length) {
    console.log('没有实验目录（系统临时目录里没有 qq-r6c-* 目录）');
    process.exit(0);
  }
  console.log(`实验目录清单（共 ${list.length} 个）：`);
  console.log('');
  console.log('标签'.padEnd(20) + '创建时间'.padEnd(22) + '文件数'.padEnd(8) + '大小'.padEnd(12) + '可删');
  console.log('-'.repeat(80));
  for (const e of list) {
    const size = e.bytes < 1024 ? e.bytes + 'B' : (e.bytes / 1024).toFixed(1) + 'KB';
    console.log(
      String(e.tag || '(无)').padEnd(20)
      + String(e.created || '(无)').padEnd(22)
      + String(e.files).padEnd(8)
      + String(size).padEnd(12)
      + (e.deletable ? '✓' : `✗ ${e.reason}`)
    );
    console.log('  ' + e.root);
  }
  process.exit(0);
}

const dirIdx = args.indexOf('--dir');
if (dirIdx >= 0) {
  const dir = args[dirIdx + 1];
  if (!dir) { console.error('--dir 后面要跟路径'); process.exit(1); }
  const yes = args.includes('--yes');

  const chk = checkDeletable(dir);
  if (!chk.ok) {
    console.error(`✗ 拒绝：${chk.error}`);
    console.error(`  （原因码：${chk.reason}）`);
    process.exit(1);
  }

  const r = cleanupExperiment(dir, { dryRun: !yes, confirm: yes });
  if (!r.ok) {
    console.error(`✗ ${r.error}`);
    process.exit(1);
  }

  if (r.dryRun) {
    console.log(`【演练】${r.message}`);
    console.log('');
    console.log('文件清单（前 20 个）：');
    for (const f of r.before.files.slice(0, 20)) console.log(`  ${f.path}  ${f.size}B  ${f.sha256}`);
    if (r.before.count > 20) console.log(`  ...（还有 ${r.before.count - 20} 个）`);
    console.log('');
    console.log(`整体 hash：${r.before.hash}`);
    console.log('');
    console.log('⚠️ 这是演练。要真删请加 --yes');
  } else {
    console.log(`✓ 已删除：${dir}`);
    console.log(`  删除前：${r.before.count} 个文件，${r.before.totalBytes} 字节，hash=${r.before.hash}`);
    console.log(`  删除后：存在=${!r.deleted ? '是' : '否'}`);
  }
  process.exit(0);
}

const recIdx = args.indexOf('--recover');
if (recIdx >= 0) {
  const dir = args[recIdx + 1];
  if (!dir) { console.error('--recover 后面要跟路径'); process.exit(1); }
  console.log(recoveryGuide(dir));
  process.exit(0);
}

usage();
process.exit(1);
