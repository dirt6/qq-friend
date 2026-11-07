// 事件可靠性与归档（4.0 · 1.3）的测试。
//
// 验收点（D5 + 待办清单 1.3）：
//   · 事件 ID 唯一、幂等消费（重复标记不产生新变化）
//   · 失败重试：没标记成功的事件下次还在未处理里
//   · 恢复：重启后 listUnprocessed 能拿到
//   · 归档：已处理 90 天按月 gzip；按 processedAt 判断；完整性校验
//   · 磁盘阈值分级
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(ROOT);

// 4.0 P1：只写临时 DATA_DIR。直接运行（无 preload）时在这里建立隔离根。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('events-archive-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
const DATA = process.env.QQ_AGENT_DATA_DIR;
assertIsolatedPaths({ dataDir: DATA, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });
const EV = path.join(DATA, 'companion-events');
const ACTIVE = path.join(EV, 'active.ndjson');
const ARCH = path.join(EV, 'archive');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

// 隔离根内的事件目录是空的；无需备份/还原生产。
fs.rmSync(EV, { recursive: true, force: true });
fs.mkdirSync(EV, { recursive: true });
fs.writeFileSync(ACTIVE, '', 'utf8');

const events = await import('../src/companion/events.js');
const archive = await import('../src/companion/archive.js');

const DAY = 86400e3;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();

try {
  console.log('【1. 发布 → 未处理列表】');
  const r1 = events.appendEvent({ eventId: 'evt-a', type: 'chat.message_received', source: 'chat', ts: iso(0), summary: 'hi' });
  const r2 = events.appendEvent({ eventId: 'evt-b', type: 'chat.reply_sent', source: 'chat', ts: iso(0), summary: 'yo' });
  ok('两条都写进去了', r1.ok && r2.ok, JSON.stringify([r1, r2]));
  const dup = events.appendEvent({ eventId: 'evt-a', type: 'chat.message_received', source: 'chat', ts: iso(0) });
  ok('同一 eventId 幂等跳过', dup.ok && dup.skipped === true, JSON.stringify(dup));

  let list = archive.listUnprocessed();
  ok('未处理列表有 2 条', list.events.length === 2, String(list.events.length));

  console.log('\n【2. 幂等消费】');
  const m1 = archive.markProcessed(['evt-a']);
  ok('标记一条', m1.ok && m1.marked === 1, JSON.stringify(m1));
  const m2 = archive.markProcessed(['evt-a']);
  ok('重复标记被跳过（幂等）', m2.ok && m2.marked === 0 && m2.skipped === 1, JSON.stringify(m2));
  list = archive.listUnprocessed();
  ok('未处理只剩 1 条', list.events.length === 1 && list.events[0].eventId === 'evt-b', String(list.events.length));

  console.log('\n【3. 失败重试：没标记成功的还在】');
  // 模拟"消费失败"：不调用 markProcessed，重新读一次列表
  const retry = archive.listUnprocessed();
  ok('失败的不丢，下次还能拿到', retry.events.some((e) => e.eventId === 'evt-b'));

  console.log('\n【4. 归档：按 processedAt，不按创建时间】');
  // 造一批"已处理且 100 天前处理"的事件，混一条"刚处理"的
  const lines = [];
  const oldAt = iso(100 * DAY);
  for (let i = 0; i < 5; i += 1) {
    lines.push(JSON.stringify({ eventId: `evt-old-${i}`, type: 'chat.message_received', source: 'chat', ts: oldAt, processed: true, processedAt: oldAt }));
  }
  lines.push(JSON.stringify({ eventId: 'evt-recent', type: 'chat.message_received', source: 'chat', ts: iso(0), processed: true, processedAt: iso(0) }));
  lines.push(JSON.stringify({ eventId: 'evt-b', type: 'chat.reply_sent', source: 'chat', ts: iso(0), processed: false }));
  fs.writeFileSync(ACTIVE, `${lines.join('\n')}\n`, 'utf8');

  const dry = archive.archiveProcessed({ keepDays: 90, dryRun: true });
  ok('dryRun 只报告不写', dry.ok && dry.archived === 5 && dry.dryRun === true, JSON.stringify(dry));

  const res = archive.archiveProcessed({ keepDays: 90 });
  ok('归档了 5 条', res.ok && res.archived === 5, JSON.stringify(res));
  ok('active 里留下 2 条（1 条未处理 + 1 条刚处理）', res.kept === 2, String(res.kept));

  const month = oldAt.slice(0, 7);
  const gz = path.join(ARCH, `${month}.ndjson.gz`);
  ok('按月生成了 gzip', fs.existsSync(gz), gz);
  const unzipped = (await import('node:zlib')).gunzipSync(fs.readFileSync(gz)).toString('utf8').trim().split('\n');
  ok('归档里是 5 条', unzipped.length === 5, String(unzipped.length));
  ok('归档里没有重复 eventId', new Set(unzipped.map((l) => JSON.parse(l).eventId)).size === 5);

  console.log('\n【5. 重复归档不产生重复】');
  const again = archive.archiveProcessed({ keepDays: 90 });
  ok('再归档一次：已处理的不重复写入', again.ok && again.archived === 0, JSON.stringify(again));
  const againLines = (await import('node:zlib')).gunzipSync(fs.readFileSync(gz)).toString('utf8').trim().split('\n');
  ok('归档条数还是 5', againLines.length === 5, String(againLines.length));

  console.log('\n【6. 磁盘阈值分级】');
  const s = archive.storage();
  ok('有 activeBytes / archiveBytes / level', typeof s.activeBytes === 'number' && typeof s.archiveBytes === 'number' && ['ok', 'warn', 'stop'].includes(s.level), s.level);
  ok('阈值是 500 MB / 1 GB', s.warnBytes === 500 * 1024 * 1024 && s.stopBytes === 1024 * 1024 * 1024);

  console.log('\n【7. 健康检查】');
  const h = archive.health();
  ok('返回计数', typeof h.total === 'number' && typeof h.unprocessed === 'number');
  ok('ok 只被 error 级问题拉黑', h.ok === h.issues.every((i) => i.level !== 'error'));
  ok('有存储信息', h.storage && typeof h.storage.totalBytes === 'number');

  console.log('\n【8. 坏行不炸】');
  fs.appendFileSync(ACTIVE, '{ 半截 json\n', 'utf8');
  const h2 = archive.health();
  ok('坏行被计数而不是抛错', h2.badLines >= 1, String(h2.badLines));
  const l2 = archive.listUnprocessed();
  ok('坏行不影响正常事件', l2.events.length >= 1);
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
