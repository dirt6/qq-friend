// reset-data 运维 CLI（D1-3b-B4）。
//
// 用法：
//   node scripts/reset-data-ops.mjs list [--backup-root <dir>] [--json]
//   node scripts/reset-data-ops.mjs verify <opId> [--backup-root <dir>] [--data-dir <dir>] [--diary-root <dir>] [--json]
//   node scripts/reset-data-ops.mjs resume <opId> --confirm <opId> [--backup-root <dir>] [--data-dir <dir>] [--diary-root <dir>]
//   node scripts/reset-data-ops.mjs restore <opId> --confirm <opId> [--scope data|diary|all] [...]
//
// 原则：
//   · 默认只读（list/verify）；resume/restore 必须 --confirm <opId> 精确确认；
//   · resume 只在备份完整、路径未变、剩余文件与 manifest 一致时继续；
//   · restore 只在目标不存在新数据、备份 hash 全部通过时恢复；
//   · 不自动运行、不在启动时恢复；数据目录/日记路径默认取应用的权威解析。
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  listResetOps, verifyResetOp, resumeReset, restoreResetBackup, defaultBackupRoot, resolveResetPaths
} from '../src/reset-data.js';
import { DATA_DIR } from '../src/config.js';
import { diaryRoot as defaultDiaryRoot } from '../src/diary/index.js';

export function parseArgs(argv) {
  const out = { cmd: '', opId: '', backupRoot: '', dataDir: '', diaryRoot: '', confirm: '', scope: 'all', json: false };
  if (!argv.length) return { error: '缺少子命令（list / verify / resume / restore）' };
  const known = new Set(['backup-root', 'data-dir', 'diary-root', 'confirm', 'scope']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') {
      if (seen.has('json')) return { error: '参数重复：--json' };
      seen.add('json'); out.json = true; continue;
    }
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (!known.has(key)) return { error: `未知参数：${a}` };
      if (seen.has(key)) return { error: `参数重复：${a}` };
      const v = argv[i + 1];
      if (!v || String(v).startsWith('--')) return { error: `缺少参数值：${a}` };
      seen.add(key);
      if (key === 'backup-root') out.backupRoot = v;
      if (key === 'data-dir') out.dataDir = v;
      if (key === 'diary-root') out.diaryRoot = v;
      if (key === 'confirm') out.confirm = v;
      if (key === 'scope') out.scope = v;
      i += 1;
      continue;
    }
    if (!out.cmd) { out.cmd = a; continue; }
    if (!out.opId) { out.opId = a; continue; }
    return { error: `未知位置参数：${a}` };
  }
  if (!['list', 'verify', 'resume', 'restore'].includes(out.cmd)) return { error: `未知子命令：${out.cmd}` };
  if (out.cmd !== 'list' && !out.opId) return { error: `${out.cmd} 需要 <opId>` };
  if (!['all', 'data', 'diary'].includes(out.scope)) return { error: `--scope 不合法：${out.scope}` };
  return out;
}

async function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`[reset-ops] ${args.error}`);
    return 2;
  }
  const dataDir = args.dataDir ? path.resolve(args.dataDir) : DATA_DIR;
  const diaryRoot = args.diaryRoot ? path.resolve(args.diaryRoot) : defaultDiaryRoot();
  const backupRoot = args.backupRoot ? path.resolve(args.backupRoot) : defaultBackupRoot(dataDir);

  if (args.cmd === 'list') {
    const ops = listResetOps({ backupRoot });
    if (args.json) { console.log(JSON.stringify({ backupRoot, ops }, null, 1)); return 0; }
    console.log(`备份根：${backupRoot}`);
    if (!ops.length) { console.log('（没有可识别的 reset manifest）'); return 0; }
    for (const op of ops) {
      const label = op.status || op.result || '(未完成)';
      console.log(`- ${op.opId}  ${label}${op.checksumOk === false ? '（manifest 校验失败）' : ''}  data=${op.dataStage} diary=${op.diaryStage} files(data=${op.files.data},diary=${op.files.diary})${op.unfinished ? '  ← 需要 resume/人工' : ''}`);
      if (op.error) console.log(`    error: ${op.error}`);
    }
    return 0;
  }

  if (args.cmd === 'verify') {
    const r = await verifyResetOp({ opId: args.opId, dataDir, diaryRoot, backupRoot });
    if (args.json) { console.log(JSON.stringify(r, null, 1)); return r.ok ? 0 : 1; }
    console.log(`opId：${r.opId || args.opId}`);
    if (!r.ok) {
      console.log(`核验未通过：${r.error || ''}`);
      for (const p of r.pathProblems || []) console.log(`  路径/清单：${p}`);
      for (const p of (r.backup && r.backup.problems) || []) console.log(`  备份：${p}`);
      return 1;
    }
    console.log(`备份完整：${r.backup.checked} 个文件 hash 通过；manifest 自校验=${r.checksumOk}`);
    console.log(`状态：${r.status || '(未记录)'}  result=${r.result || '(未完成)'}`);
    console.log(`阶段：data=${r.stages?.data?.stage} diary=${r.stages?.diary?.stage}`);
    console.log(`文件总数：${r.totals?.files ?? '?'}，字节：${r.totals?.bytes ?? '?'}`);
    console.log(`当前 data 剩余：${r.dataPresent.files} 个文件 / ${r.dataPresent.bytes} 字节`);
    return 0;
  }

  // resume / restore 都需要显式确认
  if ((args.cmd === 'resume' || args.cmd === 'restore') && String(args.confirm || '') !== String(args.opId)) {
    console.error(`[reset-ops] 拒绝：${args.cmd} 必须显式 --confirm ${args.opId}`);
    return 2;
  }
  const guard = resolveResetPaths({ dataDir, diaryRoot, backupRoot });
  if (guard.refusals.length) {
    console.error(`[reset-ops] 路径校验未通过：${guard.refusals.join('；')}`);
    return 1;
  }

  if (args.cmd === 'restore') {
    const r = await restoreResetBackup({ opId: args.opId, dataDir, diaryRoot, backupRoot, scope: args.scope });
    if (!r.ok) {
      console.error(`[reset-ops] 恢复未完成：${r.error}`);
      return 1;
    }
    console.log(`[reset-ops] 已恢复 ${r.restored} 个文件（scope=${r.scopes.join('+')}）`);
    console.log(`[reset-ops] 备份：${r.backupDir}`);
    return 0;
  }

  const r = await resumeReset({ opId: args.opId, dataDir, diaryRoot, backupRoot });
  if (!r.ok) {
    console.error(`[reset-ops] 未继续：${r.error}`);
    if (r.manifestPath) console.error(`[reset-ops] manifest：${r.manifestPath}`);
    return r.needsManual ? 3 : 1;
  }
  console.log(`[reset-ops] 已完成：opId=${r.opId} status=${r.status} result=${r.result}`);
  console.log(`[reset-ops] 备份：${r.backupDir}`);
  console.log(`[reset-ops] 阶段：data=${r.stages?.data?.stage} diary=${r.stages?.diary?.stage}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(`[reset-ops] 异常：${String(e?.message ?? e)}`);
    process.exit(1);
  });
}
