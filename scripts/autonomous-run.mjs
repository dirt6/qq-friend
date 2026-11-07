// 手动跑一次自主活动（调试/验收用，不依赖机器人进程）。
//
// 用法：
//   node scripts/autonomous-run.mjs --dry   只抓取 + 估算 token，不调模型、不写日记、不发消息
//   node scripts/autonomous-run.mjs         完整一轮（演练：调模型、看它挑什么，但不写日记、不真发）
//   node scripts/autonomous-run.mjs --live  完整一轮且按配置执行（写日记；分享仍看 shareMode）
//
// 说明：--dry 适合验证「来源通不通、候选长什么样、token 够不够」；
// 正式启用前建议先跑几次不带 --dry 的演练，看它挑的东西和想说的话合不合口味。

import { biliSource } from '../plugins/autonomous/lib/sources.js';
import { makeBuilder } from '../plugins/autonomous/lib/planner.js';
import { fitToBudget } from '../plugins/autonomous/lib/budget.js';
import { runSession } from '../plugins/autonomous/index.js';

const args = new Set(process.argv.slice(2));
const dry = args.has('--dry');
const live = args.has('--live');

const LIMIT = 8000;
const TARGET = 7000;

function fmtItem(item, i) {
  const bits = [`${i + 1}. ${item.title}`];
  if (item.tags?.length) bits.push(`[${item.tags.join('/')}]`);
  if (item.stats?.view) bits.push(`播放 ${Math.round(item.stats.view / 10000)}万`);
  if (item.publishedAt) bits.push(item.publishedAt);
  return `${bits.join(' ')}\n   ${item.url}`;
}

if (dry) {
  console.log('=== 干跑：只验证抓取与预算，不调模型 ===\n');
  const t0 = Date.now();
  const r = await biliSource.list({ fetchImpl: globalThis.fetch, limit: 10, log: (m) => console.log(`  · ${m}`) });
  console.log(`抓取耗时 ${Date.now() - t0}ms  ok=${r.ok}`);
  if (!r.ok) {
    console.log(`✗ 来源失败：${r.error}`);
    process.exit(1);
  }
  const items = r.items;
  console.log(`拿到 ${items.length} 条候选：\n`);
  for (const [i, item] of items.slice(0, 10).entries()) console.log(fmtItem(item, i) + '\n');

  const build = makeBuilder({ candidates: items, personaSnippet: '（演练，不带人设）', state: {} });
  const fitted = fitToBudget({ limit: TARGET, build, candidates: items });
  if (!fitted.ok) {
    console.log(`✗ 预算不够：${fitted.reason}`);
    process.exit(1);
  }
  console.log(`✓ 预算：估算 ${fitted.tokens} tokens（上限 ${LIMIT}，目标 ${TARGET}）`);
  console.log(`  裁剪方案：候选 ${fitted.plan.candidates} 条 / 摘要 ${fitted.plan.summaryChars} 字`);
  console.log('\n—— 实际会发给模型的 user 消息（前 800 字）——');
  console.log(fitted.messages[1].content.slice(0, 800));
  process.exit(0);
}

console.log(`=== 完整一轮（${live ? 'live：按配置执行' : '演练：不写日记、不真发'}）===`);
const rec = await runSession({ dryRun: !live });

// 4.0 / 2.6-B5c：并发触发时 runSession 会直接跳过（不排队、不抛错）。
// **这不是失败** —— 说明一句就退出，不写进失败统计。
if (rec && rec.skipped === "already-running") {
  console.log("[autonomous-run] 已经有一轮在跑了，这次跳过。");
  process.exit(0);
}
console.log('\n—— 本轮结果 ——');
for (const [k, v] of Object.entries(rec)) {
  if (k === 'intent') {
    console.log('intent'.padEnd(14), v ? JSON.stringify(v) : '(没生成)');
    continue;
  }
  if (k === 'actions') {
    console.log('actions'.padEnd(14));
    for (const a of v || []) {
      console.log(`  · ${a.action} → ${a.result}｜${a.resultSummary || '—'}`);
      if (a.reflection) console.log(`     她自己的话：${a.reflection}`);
      if (a.next) console.log(`     下次想：${a.next}`);
    }
    continue;
  }
  if (k === 'startedAt' || k === 'endedAt') console.log(`${k.padEnd(14)} ${new Date(v).toLocaleString('zh-CN', { hour12: false })}`);
  else console.log(`${k.padEnd(14)} ${v}`);
}
process.exit(rec.error ? 2 : 0);
