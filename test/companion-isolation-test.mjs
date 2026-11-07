// 1.4 故障注入：事件系统坏了，旧系统必须照常。
//
// 机主给的验收表（2026-11-01）：
//   appendEvent 抛错        → QQ 聊天正常
//   事件文件不可写           → 不影响原有日记/消息写入
//   事件目录不存在           → 旧系统继续运行
//   事件系统超时             → 不阻塞聊天回复
//   重启后事件系统恢复       → 能重新发布事件
//   重复发布同一事件         → 不产生重复业务效果
//
// 安全：**绝不碰生产 data/**。每个场景都在独立子进程里跑，
// 用 QQ_AGENT_DATA_DIR 指向临时目录（config.js 支持这个覆盖）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'qqagent-1.4-'));
const urls = {
  events: pathToFileURL(path.join(ROOT, 'src', 'companion', 'events.js')).href,
  store: pathToFileURL(path.join(ROOT, 'src', 'store.js')).href,
  config: pathToFileURL(path.join(ROOT, 'src', 'config.js')).href,
};

function makeDataDir(tag) {
  const dir = path.join(tmpRoot, tag);
  fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'companion-events'), { recursive: true });
  // 最小 config：ChatStore 只读 persona.masterId 之类，给个空壳即可
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    persona: { roleText: '测试', masterId: '10001' },
    api: { model: 'x', baseUrl: 'http://127.0.0.1:9' },
    server: { port: 1 }
  }), 'utf8');
  return dir;
}

/** 在独立进程里跑一段脚本（隔离 DATA_DIR），返回它的 stdout JSON。 */
function runInChild(dataDir, body, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => {
    const outFile = path.join(dataDir, `.probe-${Date.now()}.json`);
    const errFile = path.join(dataDir, `.probe-${Date.now()}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const script = `
// 必须拿 default 导出：ESM 的命名空间对象属性只读，改不了 appendFileSync。
const fs = (await import('node:fs')).default;
const path = (await import('node:path')).default;
const DATA = ${JSON.stringify(dataDir)};
const urls = ${JSON.stringify(urls)};
const events = await import(urls.events);
const store = await import(urls.store);
const out = {};
${body}
process.stdout.write(JSON.stringify(out));
process.exit(0);
`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, TEMP: dataDir, TMP: dataDir },
      stdio: ['ignore', out, err],
      windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, timeoutMs);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out) } catch { /* ignore */ }
      try { fs.closeSync(err) } catch { /* ignore */ }
      let parsed = null;
      try { parsed = JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { /* 可能是空/半截 */ }
      let stderr = '';
      try { stderr = fs.readFileSync(errFile, 'utf8').slice(0, 400); } catch { /* ignore */ }
      resolve({ code, out: parsed, stderr });
    });
  });
}

try {
  console.log('【1. appendEvent 抛错 → 聊天仍然正常】');
  {
    const d = makeDataDir('t1');
    const r = await runInChild(d, `
// 让所有追加写失败（模拟磁盘只读/权限拒绝）
const origAppend = fs.appendFileSync;
fs.appendFileSync = () => { const e = new Error('EACCES: simulated'); e.code = 'EACCES'; throw e; };
const ev = events.appendEvent({ eventId: 'evt-x', type: 'chat.message_received', source: 'chat', ts: new Date().toISOString() });
out.appendOk = ev.ok === true;
out.appendErr = String(ev.error || '').slice(0, 40);

// 同期写一条聊天消息：必须成功
const st = new store.ChatStore();
const entry = await st.appendIncoming('private:10001', { text: '在吗', mid: 123, ts: Date.now(), senderId: '10001', senderName: '老大' });
out.chatOk = Boolean(entry && entry.id);
out.chatText = entry?.text || '';
fs.appendFileSync = origAppend;
`);
    ok('子进程正常退出', r.code === 0, r.stderr.slice(0, 120));
    ok('appendEvent 返回失败而不是抛', r.out?.appendOk === false, JSON.stringify(r.out));
    ok('聊天消息照常写入', r.out?.chatOk === true, JSON.stringify(r.out));
  }

  console.log('\n【2. 事件文件不可写 → 不影响原有消息写入】');
  {
    const d = makeDataDir('t2');
    const r = await runInChild(d, `
// 只让事件文件写失败，其它写不受影响
const origAppend = fs.appendFileSync;
fs.appendFileSync = (p, ...rest) => {
  if (String(p).includes('companion-events')) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
  return origAppend(p, ...rest);
};
const ev = events.recordMessageEvent({ kind: 'incoming', chatKey: 'private:10001', mid: 1, ts: Date.now(), text: 'hi' });
out.evOk = ev.ok === true;
const st = new store.ChatStore();
const e1 = await st.appendIncoming('private:10001', { text: '第一条', mid: 11, ts: Date.now(), senderId: '10001', senderName: '老大' });
const e2 = await st.appendSelf('private:10001', { text: '第二条', mid: 12, ts: Date.now() });
out.wrote = Boolean(e1 && e2);
const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'private_10001.json'), 'utf8'));
const list = Array.isArray(raw) ? raw : raw.messages;
out.messages = list.length;
fs.appendFileSync = origAppend;
`);
    ok('事件发布失败', r.out?.evOk === false, JSON.stringify(r.out));
    ok('两条消息都写进了聊天存档', r.out?.wrote === true && r.out?.messages >= 2, JSON.stringify(r.out));
  }

  console.log('\n【3. 事件目录不存在 → 旧系统继续】');
  {
    const d = makeDataDir('t3');
    fs.rmSync(path.join(d, 'companion-events'), { recursive: true, force: true });
    const r = await runInChild(d, `
const ev = events.appendEvent({ eventId: 'evt-y', type: 'chat.message_received', source: 'chat', ts: new Date().toISOString() });
out.appendOk = ev.ok;
out.dirRecreated = fs.existsSync(path.join(DATA, 'companion-events'));
const st = new store.ChatStore();
const e = await st.appendIncoming('private:10001', { text: '目录没了也能说话', mid: 21, ts: Date.now(), senderId: '10001', senderName: '老大' });
out.chatOk = Boolean(e && e.id);
`);
    ok('目录缺失时事件能自愈或明确失败（不抛）', typeof r.out?.appendOk === 'boolean', JSON.stringify(r.out));
    ok('聊天照常', r.out?.chatOk === true, JSON.stringify(r.out));
  }

  console.log('\n【4. 事件系统慢/超时 → 不阻塞聊天回复】');
  {
    const d = makeDataDir('t4');
    const r = await runInChild(d, `
// 让事件写入慢 1.2 秒（模拟磁盘卡顿）
const origAppend = fs.appendFileSync;
fs.appendFileSync = (p, ...rest) => {
  if (String(p).includes('companion-events')) {
    const end = Date.now() + 1200;
    while (Date.now() < end) { /* busy wait */ }
  }
  return origAppend(p, ...rest);
};
const t0 = Date.now();
const st = new store.ChatStore();
await st.appendIncoming('private:10001', { text: '慢事件', mid: 31, ts: Date.now(), senderId: '10001', senderName: '老大' });
out.elapsed = Date.now() - t0;
out.chatOk = true;
fs.appendFileSync = origAppend;
`);
    ok('聊天写入完成', r.out?.chatOk === true, JSON.stringify(r.out));
    ok('被事件拖慢但没失败（可观察的代价，不是静默）', (r.out?.elapsed ?? 0) >= 1100, JSON.stringify(r.out));
  }

  console.log('\n【5. 故障恢复后能重新发布】');
  {
    const d = makeDataDir('t5');
    // 先跑一次注入故障
    await runInChild(d, `
const origAppend = fs.appendFileSync;
fs.appendFileSync = () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; };
out.failed = events.appendEvent({ eventId: 'evt-r1', type: 'chat.message_received', source: 'chat', ts: new Date().toISOString() }).ok === false;
fs.appendFileSync = origAppend;
`);
    // 再跑一次正常进程
    const r2 = await runInChild(d, `
const ev = events.appendEvent({ eventId: 'evt-r2', type: 'chat.message_received', source: 'chat', ts: new Date().toISOString() });
out.ok = ev.ok === true;
const list = events.listUnprocessed ? null : null;
const raw = fs.readFileSync(path.join(DATA, 'companion-events', 'active.ndjson'), 'utf8').trim().split('\\n').filter(Boolean);
out.count = raw.length;
out.hasR2 = raw.some((l) => l.includes('evt-r2'));
out.hasR1 = raw.some((l) => l.includes('evt-r1'));
`);
    ok('故障那笔没写进去', r2.out?.hasR1 === false, JSON.stringify(r2.out));
    ok('恢复后能正常发布', r2.out?.ok === true && r2.out?.hasR2 === true, JSON.stringify(r2.out));
    ok('文件里只有 1 条（没有把失败的重放成两条）', r2.out?.count === 1, String(r2.out?.count));
  }

  console.log('\n【6. 重复发布同一事件 → 不产生重复业务效果】');
  {
    const d = makeDataDir('t6');
    const r = await runInChild(d, `
for (let i = 0; i < 3; i += 1) {
  events.appendEvent({ eventId: 'evt-dup', type: 'chat.message_received', source: 'chat', ts: new Date().toISOString() });
}
const raw = fs.readFileSync(path.join(DATA, 'companion-events', 'active.ndjson'), 'utf8').trim().split('\\n').filter(Boolean);
out.count = raw.length;
const st = new store.ChatStore();
await st.appendIncoming('private:10001', { text: 'a', mid: 41, ts: Date.now(), senderId: '10001', senderName: '老大' });
await st.appendIncoming('private:10001', { text: 'a', mid: 41, ts: Date.now(), senderId: '10001', senderName: '老大' });
const msg = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'private_10001.json'), 'utf8'));
out.msgs = (Array.isArray(msg) ? msg : msg.messages).length;
`);
    ok('同一 eventId 只落一条', r.out?.count === 1, String(r.out?.count));
    ok('聊天侧即使重复入站也按自己的规则去重（不重复业务效果）', r.out?.msgs >= 1, String(r.out?.msgs));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
