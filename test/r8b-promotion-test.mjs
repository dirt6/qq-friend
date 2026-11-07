// R8-B 专项测试：晋升候选 + 衰减保护（2026-11-03）
//
// ── 隔离策略（重要）──────────────────────────────────────────
// learned.js 的 LEARNED_FILE 是**模块加载时**确定的，所以：
//   **必须在 import 之前设 QQ_AGENT_DATA_DIR**，指向临时目录。
// 不能用子进程（DSH 沙箱会 EPERM 拦 spawn 的管道）。
//
// 所有写操作都落在临时目录，**不碰生产 data/**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ══ 先建临时目录 + 设置环境变量（必须在 import 之前）═════════════
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'r8b-'));
const dataDir = path.join(tmpRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = dataDir;

// 现在才 import
const learned = await import('../src/learned.js');
const { suggestPromotion, archiveStale, PROMOTION_RULE_VERSION, STABLE_MIN_AGE_DAYS, USER_STATED_KINDS } = learned;

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, detail }); console.log(`✗ ${name}${detail ? ' -> ' + detail : ''}`); }
}

const NOW = Date.parse('2026-11-03T12:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

// ══════════════════════════════════════════════════════════════
// ① 常量
// ══════════════════════════════════════════════════════════════
ok('规则版本存在且是正整数', Number.isInteger(PROMOTION_RULE_VERSION) && PROMOTION_RULE_VERSION >= 1, String(PROMOTION_RULE_VERSION));
ok('14 天门槛常量 = 14', STABLE_MIN_AGE_DAYS === 14, String(STABLE_MIN_AGE_DAYS));
ok('USER_STATED_KINDS 含 user_stated', USER_STATED_KINDS.includes('user_stated'), JSON.stringify(USER_STATED_KINDS));

// ══════════════════════════════════════════════════════════════
// ② pending → verified
// ══════════════════════════════════════════════════════════════

// 2.1 hits 高但来源是推断 → 不产生候选（机主硬要求）
{
  const store = { items: [{
    id: 'a', status: 'pending', text: 'x', hits: 9999,
    lastUsedAt: daysAgo(0), createdAt: daysAgo(1),
    origin: { kind: 'inferred' }, epistemicType: 'inferred', corrections: 1,
    correction: { state: 'clear' }
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**hits=9999 + inferred → 不产生候选**', r.candidates.length === 0, JSON.stringify(r.candidates));
}

// 2.2 lastUsedAt 很新但来源推断 → 不产生候选
{
  const store = { items: [{
    id: 'b', status: 'pending', text: 'x', hits: 1,
    lastUsedAt: daysAgo(0), createdAt: daysAgo(30),
    origin: { kind: 'autonomous' }, epistemicType: 'inferred', corrections: 1,
    correction: { state: 'clear' }
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**lastUsedAt 很新但 autonomous/inferred → 不产生候选**', r.candidates.length === 0);
}

// 2.3 user_stated → 产生候选
{
  const store = { items: [{
    id: 'c', status: 'pending', text: '老大说喜欢下雨天',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { state: 'clear' },
    createdAt: daysAgo(1), lastUsedAt: null, hits: 0
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**user_stated → 产生 pending→verified 候选**', r.candidates.length === 1 && r.candidates[0].to === 'verified', JSON.stringify(r.candidates));
  ok('候选带 ruleVersion', r.candidates[0]?.ruleVersion === PROMOTION_RULE_VERSION);
  ok('候选带生成时间', typeof r.candidates[0]?.at === 'string' && r.candidates[0].at.includes('T'));
  ok('候选带理由', Array.isArray(r.candidates[0]?.reasons) && r.candidates[0].reasons.length > 0, JSON.stringify(r.candidates[0]?.reasons));
}

// 2.4 direct + corrections<=1 → 候选
{
  const store = { items: [{
    id: 'd', status: 'pending', text: '看到她发了表情',
    origin: { kind: 'chat' }, epistemicType: 'direct', corrections: 1,
    correction: { state: 'clear' },
    createdAt: daysAgo(2)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('direct + corrections=1 → 候选', r.candidates.length === 1, JSON.stringify(r.candidates));
}

// 2.5 direct + corrections=5（合并过）→ 不产生候选
{
  const store = { items: [{
    id: 'e', status: 'pending', text: 'x',
    origin: { kind: 'chat' }, epistemicType: 'direct', corrections: 5,
    correction: { state: 'clear' },
    createdAt: daysAgo(2)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('direct 但 corrections=5 → 不产生候选（有合并历史）', r.candidates.length === 0, JSON.stringify(r.candidates));
}

// 2.6 historicalUnresolved=true → 必须 blocked
{
  const store = { items: [{
    id: 'f', status: 'pending', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { count: 1, historicalUnresolved: true, events: [] },
    createdAt: daysAgo(1)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**historicalUnresolved=true → 不产生候选**', r.candidates.length === 0, JSON.stringify(r.candidates));
  ok('**且进入 blocked（带阻止理由）**', r.blocked.length === 1 && r.blocked[0].blockedReasons.length > 0, JSON.stringify(r.blocked));
}

// 2.7 correction events 最后一条不是用户认可 → blocked
{
  const store = { items: [{
    id: 'g', status: 'pending', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { state: 'clear', count: 1, events: [{ source: 'model', at: daysAgo(1) }] },
    createdAt: daysAgo(2)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**最后一条纠正是 model 来源 → 不产生候选**', r.candidates.length === 0, JSON.stringify(r.candidates));
  ok('blocked 理由提到"明确认可"', r.blocked[0]?.blockedReasons.some((x) => x.includes('明确认可')), JSON.stringify(r.blocked));
}

// 2.8 最后一条是 user_stated → 候选
{
  const store = { items: [{
    id: 'h', status: 'pending', text: 'x',
    origin: { kind: 'chat' }, epistemicType: 'inferred', corrections: 1,
    correction: { count: 1, historicalUnresolved: false, events: [{ source: 'user_stated', at: daysAgo(1) }] },
    createdAt: daysAgo(2)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('纠正过且最后一条是 user_stated → 候选', r.candidates.length === 1, JSON.stringify(r.candidates));
}

// 2.9 字段全缺 → 不猜
{
  const store = { items: [{ id: 'i', status: 'pending', text: 'x' }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('字段全缺 → 不产生候选（不猜）', r.candidates.length === 0, JSON.stringify(r.candidates));
}

// ══════════════════════════════════════════════════════════════
// ③ verified → stable
// ══════════════════════════════════════════════════════════════
{
  const store = { items: [{
    id: 'j', status: 'verified', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { state: 'clear' },
    createdAt: daysAgo(15)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('verified + direct + 15 天 → stable 候选', r.candidates.length === 1 && r.candidates[0].to === 'stable', JSON.stringify(r.candidates));
  ok('stable 候选理由提到时间门槛不是可靠性', r.candidates[0]?.reasons.some((x) => x.includes('时间门槛')), JSON.stringify(r.candidates[0]?.reasons));
}
{
  const store = { items: [{
    id: 'k', status: 'verified', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { state: 'clear' },
    createdAt: daysAgo(10)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('10 天 → 不产生 stable 候选', r.candidates.length === 0);
  ok('blocked 提到未满 14 天', r.blocked[0]?.blockedReasons.some((x) => x.includes('14 天')), JSON.stringify(r.blocked));
}
{
  const store = { items: [{
    id: 'l', status: 'verified', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'inferred', corrections: 1,
    correction: { state: 'clear' },
    createdAt: daysAgo(30)
  }] };
  const r = suggestPromotion(store, { now: NOW });
  ok('**inferred 不能进 stable**', r.candidates.length === 0, JSON.stringify(r.candidates));
  ok('blocked 提到推断', r.blocked[0]?.blockedReasons.some((x) => x.includes('推断')), JSON.stringify(r.blocked));
}
{
  const store = { items: [{
    id: 'm', status: 'verified', text: 'x',
    origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1,
    correction: { historicalUnresolved: true, events: [] },
    createdAt: daysAgo(30)
  }] };
  ok('verified + historicalUnresolved → 不产生 stable 候选', suggestPromotion(store, { now: NOW }).candidates.length === 0);
}

// ══════════════════════════════════════════════════════════════
// ④ 幂等 / 边界
// ══════════════════════════════════════════════════════════════
{
  const store = { items: [{ id: 'n', status: 'pending', text: 'x', origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1, createdAt: daysAgo(1) }] };
  const r1 = JSON.stringify(suggestPromotion(store, { now: NOW }));
  const r2 = JSON.stringify(suggestPromotion(store, { now: NOW }));
  ok('纯函数：同输入同输出', r1 === r2);
}
{
  const store = { items: [{ id: 'o', status: 'pending', text: 'x', origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1, createdAt: daysAgo(1) }] };
  const before = JSON.stringify(store);
  suggestPromotion(store, { now: NOW });
  ok('不修改传入的 store', JSON.stringify(store) === before);
}
{
  const store = { items: [
    { id: 'p', status: 'stable', text: 'x', origin: { kind: 'user_stated' }, epistemicType: 'direct', createdAt: daysAgo(100) },
    { id: 'q', status: 'archived', text: 'y', origin: { kind: 'user_stated' }, epistemicType: 'direct', createdAt: daysAgo(100) }
  ] };
  ok('stable / archived 不产生候选', suggestPromotion(store, { now: NOW }).candidates.length === 0);
}
ok('空 items 不崩', suggestPromotion({ items: [] }, { now: NOW }).candidates.length === 0);
ok('null store 不崩', suggestPromotion(null, { now: NOW }).candidates.length === 0);
ok('缺 items 不崩', suggestPromotion({}, { now: NOW }).candidates.length === 0);
{
  const store = { items: [{ status: 'pending', text: 'x', origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1, createdAt: daysAgo(1) }] };
  ok('缺 id 跳过', suggestPromotion(store, { now: NOW }).candidates.length === 0);
}

// ══════════════════════════════════════════════════════════════
// ⑤ archiveStale 的硬保护（同进程，隔离目录已设好）
// ══════════════════════════════════════════════════════════════
const old = daysAgo(100);
const fixture = {
  version: 1,
  items: [
    // R8-B v2：可归档的条目必须显式 clear（历史缺状态 = unknown，保守不归档）
    { id: 'arch-me', status: 'stable', text: '老事实', createdAt: old, lastUsedAt: old, updatedAt: old, origin: { kind: 'chat' }, epistemicType: 'direct', correction: { state: 'clear', count: 0, events: [] } },
    { id: 'unknown-arch', status: 'stable', text: '历史缺状态', createdAt: old, lastUsedAt: old, updatedAt: old },
    { id: 'protect-correction', status: 'stable', text: '有未解决纠正', createdAt: old, lastUsedAt: old, updatedAt: old, correction: { historicalUnresolved: true, events: [] } },
    { id: 'protect-conflict', status: 'stable', text: '有冲突', createdAt: old, lastUsedAt: old, updatedAt: old, conflicts: [{ with: 'x' }] },
    { id: 'protect-important', status: 'stable', text: '重要的', createdAt: old, lastUsedAt: old, updatedAt: old, importance: 'important' },
    { id: 'not-stable', status: 'pending', text: '待验证', createdAt: old, lastUsedAt: old, updatedAt: old },
    { id: 'young', status: 'stable', text: '新的', createdAt: daysAgo(2), lastUsedAt: daysAgo(2), updatedAt: daysAgo(2) }
  ]
};
const storeFile = path.join(dataDir, 'learned.json');
fs.writeFileSync(storeFile, JSON.stringify(fixture), 'utf8');

const r1 = archiveStale({ days: 30, dryRun: false });
ok('archiveStale 跑成功', r1 && typeof r1.archived === 'number', JSON.stringify(r1 && { archived: r1.archived, skipped: r1.skipped?.length }));
ok('**只归档了 1 条**', r1.archived === 1, String(r1.archived));
ok('**归档的正是 arch-me**', r1.ids?.includes('arch-me'), JSON.stringify(r1.ids));
ok('**历史缺状态的被跳过（unknown）**', r1.skipped?.some((s) => s.id === 'unknown-arch'), JSON.stringify(r1.skipped?.map((s) => s.id)));
ok('**未解决纠正的被跳过**', r1.skipped?.some((s) => s.id === 'protect-correction'), JSON.stringify(r1.skipped?.map((s) => s.id)));
ok('**有冲突的被跳过**', r1.skipped?.some((s) => s.id === 'protect-conflict'), JSON.stringify(r1.skipped?.map((s) => s.id)));
ok('**重要的被跳过**', r1.skipped?.some((s) => s.id === 'protect-important'), JSON.stringify(r1.skipped?.map((s) => s.id)));
ok('**没有归档 pending**', !r1.ids?.includes('not-stable'), JSON.stringify(r1.ids));
ok('**没有归档刚创建的 stable**', !r1.ids?.includes('young'), JSON.stringify(r1.ids));

// 落盘校验
{
  const after = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const byId = new Map(after.items.map((x) => [x.id, x]));
  ok('落盘：arch-me 变 archived', byId.get('arch-me')?.status === 'archived', byId.get('arch-me')?.status);
  ok('落盘：unknown-arch 仍是 stable', byId.get('unknown-arch')?.status === 'stable');
  ok('落盘：protect-correction 仍是 stable', byId.get('protect-correction')?.status === 'stable');
  ok('落盘：protect-conflict 仍是 stable', byId.get('protect-conflict')?.status === 'stable');
  ok('落盘：protect-important 仍是 stable', byId.get('protect-important')?.status === 'stable');
  ok('落盘：not-stable 仍是 pending', byId.get('not-stable')?.status === 'pending');
  ok('落盘：young 仍是 stable', byId.get('young')?.status === 'stable');
  ok('**没有删除任何条目（7 条还在）**', after.items.length === 7, String(after.items.length));
}

// ══════════════════════════════════════════════════════════════
// ⑥ dryRun 不写盘
// ══════════════════════════════════════════════════════════════
{
  // 重置 fixture
  fs.writeFileSync(storeFile, JSON.stringify(fixture), 'utf8');
  const before = fs.readFileSync(storeFile, 'utf8');
  const r2 = archiveStale({ days: 30, dryRun: true });
  ok('dryRun 返回 dryRun=true', r2.dryRun === true);
  ok('dryRun 报告会归档 1 条', r2.archived === 1, String(r2.archived));
  ok('**dryRun 没有写盘（文件字节完全一致）**', fs.readFileSync(storeFile, 'utf8') === before);
}

// ══════════════════════════════════════════════════════════════
// ⑦ 生产数据未被这次测试污染
// ══════════════════════════════════════════════════════════════
{
  const prodFile = path.resolve('data/learned.json');
  ok('**测试没有写生产 learned.json**', fs.existsSync(prodFile), '生产文件存在');
  const prod = JSON.parse(fs.readFileSync(prodFile, 'utf8'));
  ok('生产条目数没被测试改动（仍是 23）', prod.items.length === 23, String(prod.items.length));
  const by = {};
  for (const e of prod.items) by[e.status] = (by[e.status] || 0) + 1;
  ok('**生产没有出现 archived**（测试没漏到生产）', !by.archived, JSON.stringify(by));
}

// 清理临时目录
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ' -> ' + f.detail : ''}`);
  process.exit(1);
}
