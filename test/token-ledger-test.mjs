// 统一 Token 账本（4.0 · 1.2）的测试。
//
// 验收点（D9/D10）：并发调用后账本准确；聊天 + 自主能合并也能分列。
// 这个测试只碰 data/ 下的账本文件，不动会话、不发消息。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// 4.0 P1：只写临时 DATA_DIR。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('token-ledger-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
assertIsolatedPaths({ dataDir: DATA, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });
const AUTO = path.join(DATA, 'token-usage.json');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

fs.writeFileSync(AUTO, JSON.stringify({ version: 1, monthKey: '2026-10', budgetYuan: 5, days: {} }), 'utf8');

const ledger = await import('../src/token-ledger.js');

try {
  console.log('【1. 记账：串行 + 原子】');
  await ledger.recordAutonomousCall({ inputTokens: 1000, outputTokens: 100, pricing: { inputPerMillion: 2, outputPerMillion: 8 }, budgetYuan: 5 });
  let u = ledger.readAutonomous();
  const today = ledger.dayKeyOf();
  ok('记了一笔', u.days[today]?.calls === 1, JSON.stringify(u.days[today]));
  ok('token 累加正确', u.days[today]?.input_tokens === 1000 && u.days[today]?.output_tokens === 100);
  const cost1 = u.days[today]?.estimated_cost_yuan;
  ok('成本按单价算', Math.abs(cost1 - (1000 / 1e6 * 2 + 100 / 1e6 * 8)) < 1e-6, String(cost1));

  console.log('\n【2. 并发 50 笔不能丢】');
  const before = ledger.readAutonomous().days[today].calls;
  await Promise.all(Array.from({ length: 50 }, () => ledger.recordAutonomousCall({
    inputTokens: 10, outputTokens: 1, pricing: { inputPerMillion: 2, outputPerMillion: 8 }
  })));
  u = ledger.readAutonomous();
  ok('50 笔全部记上（串行队列生效）', u.days[today].calls === before + 50, `${u.days[today].calls} vs ${before + 50}`);

  console.log('\n【3. 合并视图：聊天 + 自主】');
  const day = ledger.readDay();
  ok('分列都在', day.chat && day.autonomous && day.total);
  ok('合计 = 两边相加', day.total.calls === day.chat.calls + day.autonomous.calls, JSON.stringify(day.total));
  ok('成本合计要么是数、要么明确 null（不假装精确）',
    day.total.cost === null || typeof day.total.cost === 'number', String(day.total.cost));
  ok('标了成本是否准确', typeof day.total.costAccurate === 'boolean');

  console.log('\n【4. 月度视图】');
  const month = ledger.readMonth();
  ok('有 month 字段', month.month === ledger.monthKeyOf());
  ok('自主侧有数（刚才记的）', month.autonomous.calls >= 51, String(month.autonomous.calls));
  ok('预算跟着自主账本走', month.total.budgetYuan === 5, String(month.total.budgetYuan));

  console.log('\n【5. 坏文件不炸】');
  fs.writeFileSync(AUTO, '{ 这不是 json', 'utf8');
  const broken = ledger.readAutonomous();
  ok('损坏 → 空账本（不抛）', broken.days && Object.keys(broken.days).length === 0);
  await ledger.recordAutonomousCall({ inputTokens: 5, outputTokens: 1, pricing: {} });
  ok('损坏后还能继续记', ledger.readAutonomous().days[ledger.dayKeyOf()]?.calls === 1);
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  // 只清理临时隔离根；生产账本从未被备份/改写。
  try {
    if (OWN_ISO) {
      const cr = cleanupIsolation(OWN_ISO);
      if (!cr.ok) { fail += 1; console.error(`[isolation] 清理失败：${cr.error}`); }
    }
  } catch (e) { fail += 1; console.error(`[isolation] 清理异常：${String(e?.message ?? e)}`); }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
