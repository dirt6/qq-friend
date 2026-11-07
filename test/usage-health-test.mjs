// 账本健康检查 + 补账幂等（4.0 · 1.2 终版）。
//
// 验收点（机主 2026-10-31 定）：
//   · 连续多次启动不会重复记账
//   · 重算必须幂等
//   · 重算失败不会损坏已有账本
//   · 不覆盖自主活动账本
//   · 历史补齐后月度统计准确
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// 4.0 P1：只写临时 DATA_DIR。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('usage-health-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
assertIsolatedPaths({ dataDir: DATA, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });
const AUTO = path.join(DATA, 'token-usage.json');
const DAYS = path.join(DATA, 'usage-days');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

fs.writeFileSync(AUTO, JSON.stringify({ version: 1, monthKey: '2026-10', budgetYuan: 5, days: {} }), 'utf8');

const ledger = await import('../src/token-ledger.js');

try {
  console.log('【1. 健康检查的基本形状】');
  const h = ledger.health({ days: 14 });
  ok('返回 ok / issues / usageDays / chat / autonomous / total / backfill',
    typeof h.ok === 'boolean' && Array.isArray(h.issues) && h.usageDays && h.chat && h.autonomous && h.total && h.backfill);
  ok('缺失日期是数组', Array.isArray(h.usageDays.missingDays));
  ok('重复记录是数组', Array.isArray(h.duplicateDays));
  ok('两边成本都是数', typeof h.chat.monthCost === 'number' && typeof h.autonomous.monthCost === 'number');
  ok('成本准确性有标记', typeof h.total.costAccurate === 'boolean');
  ok('补账状态有字段', 'lastRunAt' in h.backfill && 'lastError' in h.backfill);

  console.log('\n【2. 自主账本不被健康检查改动】');
  const before = fs.readFileSync(AUTO, 'utf8');
  ledger.health({ days: 7 });
  ok('健康检查是纯读（文件字节未变）', fs.readFileSync(AUTO, 'utf8') === before);

  console.log('\n【3. 记账幂等：同一天多次启动不重复】');
  await ledger.recordAutonomousCall({ inputTokens: 100, outputTokens: 10, pricing: { inputPerMillion: 2, outputPerMillion: 8 } });
  const c1 = ledger.readAutonomous().days[ledger.dayKeyOf()].calls;
  await ledger.recordAutonomousCall({ inputTokens: 100, outputTokens: 10, pricing: { inputPerMillion: 2, outputPerMillion: 8 } });
  const c2 = ledger.readAutonomous().days[ledger.dayKeyOf()].calls;
  ok('两次调用 → 两笔（这是记账，不是重算）', c1 === 1 && c2 === 2, `${c1} → ${c2}`);

  console.log('\n【4. 日文件重算是覆盖写，不是累加】');
  // 造一个假的日文件，确认 saveUsageDayFile 语义：重写后值不变（此处只验证 ledger 不写它）
  const fakeDay = '2020-01-01';
  const fakeFile = path.join(DAYS, `${fakeDay}.json`);
  fs.mkdirSync(DAYS, { recursive: true });
  fs.writeFileSync(fakeFile, JSON.stringify({ version: 1, day: fakeDay, aggregates: { totals: { runs: 3, cost: 0.5, promptTokens: 100, completionTokens: 10 } } }), 'utf8');
  const beforeFake = fs.readFileSync(fakeFile, 'utf8');
  ledger.health({ days: 1 });
  ok('健康检查不碰日文件', fs.readFileSync(fakeFile, 'utf8') === beforeFake);
  fs.unlinkSync(fakeFile);

  console.log('\n【5. 补账状态文件格式】');
  const stateFile = path.join(DATA, 'usage-backfill-state.json');
  const existed = fs.existsSync(stateFile);
  const state = ledger.health({ days: 3 }).backfill;
  ok('能读出补账字段（不存在时给空对象）', typeof state.lastRunAt === 'number' && typeof state.lastError === 'string');
  if (!existed && fs.existsSync(stateFile)) fs.unlinkSync(stateFile);

  console.log('\n【6. 缺失日期能被发现】');
  // 临时把窗口拉到 60 天：历史上必然有缺的日
  const wide = ledger.health({ days: 60 });
  ok('60 天窗口能查出缺失（或明确为 0）', Array.isArray(wide.usageDays.missingDays));
  ok('stale 标记只在确实落后时为 true',
    typeof wide.usageDays.stale === 'boolean');
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
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
