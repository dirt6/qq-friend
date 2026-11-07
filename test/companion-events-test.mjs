// 阶段 1.1 事件日志测试：幂等、跨进程单写者、追加格式。
// 用法：
//   node test/companion-events-test.mjs            # 主测试（会备份/恢复生产事件文件）
//   node test/companion-events-test.mjs --worker 1 # 并发 worker（测试内部使用）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIsolationRoot, isolationEnv, cleanupIsolation, assertIsolatedPaths } from './_isolation.mjs';

// 4.0 P1：先隔离 DATA_DIR，再动态 import 业务模块。
let OWN_ISO = '';
if (process.env.QQ_AGENT_TEST_ISOLATION !== '1' || !process.env.QQ_AGENT_DATA_DIR) {
  const iso = createIsolationRoot('events-test-');
  OWN_ISO = iso.root;
  Object.assign(process.env, isolationEnv(iso));
}
assertIsolatedPaths({ dataDir: process.env.QQ_AGENT_DATA_DIR, diaryRoot: process.env.QQ_AGENT_DIARY_ROOT });

const {
  appendEvent, makeEventId, recordMessageEvent, summaryOf, ACTIVE_FILE, EVENTS_DIR,
} = await import('../src/companion/events.js');

const SELF = fileURLToPath(import.meta.url);
const workerArg = process.argv.indexOf('--worker');
const pass = [];
const fail = [];
function ok(name, cond) {
  if (cond) pass.push(name); else fail.push(name);
  console.log(`${cond ? '✓' : '✗'} ${name}`);
}

if (workerArg >= 0) {
  const n = Number(process.argv[workerArg + 1]) || 1;
  for (let i = 0; i < 50; i += 1) {
    appendEvent({ eventId: makeEventId('test.worker', `${n}:${i}`), type: 'test.worker', source: 'test', n, i });
  }
  process.exit(0);
}

// 隔离根内：清空事件文件（不备份/不改生产）。
fs.mkdirSync(EVENTS_DIR, { recursive: true });
fs.rmSync(ACTIVE_FILE, { force: true });
fs.writeFileSync(ACTIVE_FILE, '', 'utf8');

function readEvents() {
  try {
    return fs.readFileSync(ACTIVE_FILE, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// 1) 幂等
const id = makeEventId('test', 'same');
appendEvent({ eventId: id, type: 'test.event', source: 'test', summary: '第一次' });
appendEvent({ eventId: id, type: 'test.event', source: 'test', summary: '第二次' });
appendEvent({ eventId: makeEventId('test', 'other'), type: 'test.event', source: 'test' });
let events = readEvents();
ok('同一 eventId 只写一条', events.length === 2);
ok('保留第一次的内容', events[0].summary === '第一次');

// 2) 消息事件幂等（同一 mid）
recordMessageEvent({ kind: 'incoming', chatKey: 'test:1', mid: 12345, ts: Date.now(), text: '你好' });
recordMessageEvent({ kind: 'incoming', chatKey: 'test:1', mid: 12345, ts: Date.now(), text: '你好（重复投递）' });
events = readEvents();
const received = events.filter((e) => e.type === 'chat.message_received');
ok('同一 mid 的消息事件只写一条', received.length === 1);
ok('摘要去掉换行并截断', summaryOf('a\n b', 10) === 'a b');

// 3) 跨进程并发（两个 worker 各 50 条）
await new Promise((resolve) => {
  const running = [1, 2].map((n) => spawn(process.execPath, [SELF, '--worker', String(n)], { stdio: 'ignore' }));
  let left = running.length;
  for (const child of running) child.on('close', () => { left -= 1; if (left === 0) resolve(); });
});
events = readEvents();
const workerEvents = events.filter((e) => e.type === 'test.worker');
ok('两个进程并发写入全部落盘（100 条）', workerEvents.length === 100);
const ids = new Set(events.map((e) => e.eventId));
ok('所有事件 ID 唯一', ids.size === events.length);
let parseable = true;
try {
  for (const line of fs.readFileSync(ACTIVE_FILE, 'utf8').split('\n').filter(Boolean)) JSON.parse(line);
} catch { parseable = false; }
ok('没有交错/半截行', parseable);

// 清理：只清理本测试的临时根；生产事件文件从未被备份/改名。
fs.rmSync(ACTIVE_FILE, { force: true });
if (OWN_ISO) {
  const cr = cleanupIsolation(OWN_ISO);
  if (!cr.ok) { fail.push('临时目录清理'); console.error(`[isolation] 清理失败：${cr.error}`); }
}

console.log(`\n${fail.length === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass.length} 通过 / ${fail.length} 失败`);
process.exit(fail.length === 0 ? 0 : 1);
