#!/usr/bin/env node
// 经验库的命令行管理（三层记忆的中间层）
//
// 为什么需要它：状态从「待验证」升到「已验证/稳定」**只能由机主确认**，
// 她自己不能改（src/learned.js 里 setStatus 会拒绝 source !== 'owner'）。
// 但机主手上得有个入口 —— 这个脚本就是最轻的那个，不用开面板。
//
// 用法：
//   node scripts/learned.mjs                 看全部
//   node scripts/learned.mjs pending         只看待验证的
//   node scripts/learned.mjs verify <id>     确认这条已经做到了
//   node scripts/learned.mjs stable <id>     标记为长期稳定（不再每轮提醒）
//   node scripts/learned.mjs drop <id>       降回待验证（又犯了）
//   node scripts/learned.mjs archive         把 30 天没用的稳定经验归档
//   node scripts/learned.mjs stats           只看统计
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Windows 上 import() 不收裸盘符路径（报 ERR_UNSUPPORTED_ESM_URL_SCHEME），
// 所以用相对这个文件的 import，别拼绝对路径。
const L = await import('../src/learned.js');

const argv = process.argv.slice(2);
const cmd = String(argv[0] || 'list').toLowerCase();
const id = String(argv[1] || '').trim();

const STATUS_CN = { pending: '待验证', verified: '已验证', stable: '稳定', archived: '已归档' };

function line(x) {
  const s = STATUS_CN[x.status] || x.status;
  const extra = x.corrections > 1 ? `　×${x.corrections}次` : '';
  return `${x.id}  [${s}]${extra}  ${x.text}`;
}

function printAll(list) {
  if (!list.length) {
    console.log('（经验库是空的）');
    return;
  }
  for (const x of list) console.log(line(x));
}

switch (cmd) {
  case 'stats': {
    const s = L.stats();
    console.log(`共 ${s.total} 条：` + Object.entries(s.by).map(([k, v]) => `${STATUS_CN[k] || k} ${v}`).join(' / '));
    console.log(`文件：${s.file}`);
    break;
  }
  case 'pending':
    printAll(L.listAll({ status: 'pending' }));
    break;
  case 'archive': {
    const r = L.archiveStale({ days: 30 });
    console.log(`归档了 ${r.archived} 条（30 天没用到的稳定经验）`);
    break;
  }
  case 'verify':
  case 'stable':
  case 'drop': {
    if (!id) {
      console.log('要给个 id（先跑一次看列表）');
      process.exit(2);
    }
    const target = cmd === 'verify' ? 'verified' : cmd === 'stable' ? 'stable' : 'pending';
    const r = L.setStatus(id, target, { source: 'owner' });
    console.log(r.ok ? `已改成「${STATUS_CN[target]}」` : `失败：${r.reason}`);
    process.exit(r.ok ? 0 : 1);
    break;
  }
  default:
    printAll(L.listAll());
}
