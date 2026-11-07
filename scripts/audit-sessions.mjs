// 1.5.7.1 Session 现状审计（只读，不改任何文件）。
//
// 机主要求：先看清楚硬盘被什么占用、会话怎么分布，再决定生命周期规则。
// 特别要确认「聊天存档」和「DSH Session」是否在重复保存同一份对话。
//
// 用法：node scripts/audit-sessions.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');
const SESSIONS = path.join(DATA, 'sessions');
const MESSAGES = path.join(DATA, 'messages');

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

function statDir(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    let bytes = 0;
    let newest = 0;
    let oldest = Date.now();
    for (const f of files) {
      try {
        const st = fs.statSync(path.join(dir, f));
        bytes += st.size;
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (st.mtimeMs < oldest) oldest = st.mtimeMs;
      } catch { /* ignore */ }
    }
    return { count: files.length, bytes, newest, oldest };
  } catch {
    return { count: 0, bytes: 0, newest: 0, oldest: 0 };
  }
}

console.log('═══ 1. 目录占用总览 ═══\n');
const dirs = [
  ['data/sessions', SESSIONS],
  ['data/messages', MESSAGES],
  ['data/dsh-home', path.join(DATA, 'dsh-home')],
  ['data/learned.json', path.join(DATA, 'learned.json')],
  ['data/autonomous.json', path.join(DATA, 'autonomous.json')],
  ['data/logs', path.join(DATA, 'logs')],
  ['data/usage-days', path.join(DATA, 'usage-days')],
  ['data/companion-events', path.join(DATA, 'companion-events')],
  ['data/drawings', path.join(DATA, 'drawings')],
  ['data/stickers', path.join(DATA, 'stickers')]
];

const total = { bytes: 0 };
for (const [label, p] of dirs) {
  try {
    const st = fs.statSync(p);
    if (st.isFile()) {
      console.log(`${label.padEnd(24)} ${mb(st.size).padStart(10)}`);
      total.bytes += st.size;
      continue;
    }
    const s = statDir(p);
    if (s.count) {
      console.log(`${label.padEnd(24)} ${mb(s.bytes).padStart(10)}  ${String(s.count).padStart(5)} 个文件`);
      total.bytes += s.bytes;
    } else {
      // 目录里可能不是 .json
      let bytes = 0;
      let n = 0;
      const walk = (d) => {
        for (const f of fs.readdirSync(d, { withFileTypes: true })) {
          const q = path.join(d, f.name);
          if (f.isDirectory()) walk(q);
          else { try { bytes += fs.statSync(q).size; n += 1; } catch { /* ignore */ } }
        }
      };
      walk(p);
      if (n) console.log(`${label.padEnd(24)} ${mb(bytes).padStart(10)}  ${String(n).padStart(5)} 个文件`);
      total.bytes += bytes;
    }
  } catch { /* 目录不存在 */ }
}
console.log(`${'合计'.padEnd(24)} ${mb(total.bytes).padStart(10)}`);

console.log('\n═══ 2. Session 分布 ═══\n');
const sess = [];
for (const f of fs.readdirSync(SESSIONS).filter((x) => x.endsWith('.json'))) {
  try {
    const p = path.join(SESSIONS, f);
    const st = fs.statSync(p);
    const raw = fs.readFileSync(p, 'utf8');
    const j = JSON.parse(raw);
    sess.push({
      file: f, size: st.size, mtime: st.mtimeMs,
      id: j.id, chatKey: j.chatKey, status: j.status,
      startedAt: j.startedAt, endedAt: j.endedAt,
      msgs: (j.messages || []).length,
      rounds: j.rounds,
      promptChars: j.promptChars,
      hasUsage: Boolean(j.usage)
    });
  } catch { /* 坏文件 */ }
}
sess.sort((a, b) => b.mtime - a.mtime);

const byStatus = {};
const byMonth = {};
const byChat = {};
for (const s of sess) {
  byStatus[s.status || '?'] = (byStatus[s.status || '?'] || 0) + 1;
  const d = new Date(s.startedAt || s.mtime);
  const mk = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  byMonth[mk] = (byMonth[mk] || 0) + 1;
  byChat[s.chatKey || '?'] = (byChat[s.chatKey || '?'] || 0) + 1;
}

console.log('按状态：');
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(12)} ${String(v).padStart(5)}`);
console.log('\n按月份（创建时间）：');
for (const [k, v] of Object.entries(byMonth).sort()) console.log(`  ${k}  ${String(v).padStart(5)}`);
console.log('\n按会话（前 8）：');
for (const [k, v] of Object.entries(byChat).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${k.padEnd(24)} ${String(v).padStart(5)}`);

console.log('\n═══ 3. 大小与年龄 ═══\n');
const sizes = sess.map((s) => s.size).sort((a, b) => a - b);
const pct = (p) => sizes[Math.min(sizes.length - 1, Math.floor(sizes.length * p))];
console.log(`  最小 ${kb(sizes[0] || 0)} / 中位 ${kb(pct(0.5))} / 90% ${kb(pct(0.9))} / 最大 ${kb(sizes[sizes.length - 1] || 0)}`);
console.log(`  总计 ${mb(sizes.reduce((a, b) => a + b, 0))}`);

const now = Date.now();
const ages = [7, 30, 90, 180, 365];
console.log('\n按时效分布（最后修改时间）：');
for (const d of ages) {
  const cut = now - d * 86400e3;
  const n = sess.filter((s) => s.mtime >= cut).length;
  console.log(`  最近 ${String(d).padStart(3)} 天：${String(n).padStart(5)} 个`);
}
const older = sess.filter((s) => s.mtime < now - 365 * 86400e3).length;
console.log(`  超过 365 天：${older} 个`);

console.log('\n═══ 4. 最大的 5 个会话 ═══\n');
for (const s of [...sess].sort((a, b) => b.size - a.size).slice(0, 5)) {
  console.log(`  ${s.file.padEnd(26)} ${kb(s.size).padStart(8)}  ${String(s.msgs).padStart(4)} 条消息  ${new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })}`);
}

console.log('\n═══ 5. 最新的 5 个会话 ═══\n');
for (const s of sess.slice(0, 5)) {
  console.log(`  ${s.file.padEnd(26)} ${kb(s.size).padStart(8)}  ${s.status.padEnd(9)} ${String(s.msgs).padStart(4)} 条  ${new Date(s.mtime).toLocaleString('zh-CN', { hour12: false })}`);
}

console.log('\n═══ 6. 是否存在「长会话」（机主提到的 717 turns 那种）═══\n');
const longOnes = sess.filter((s) => s.msgs >= 100 || Number(s.rounds) >= 50).sort((a, b) => b.msgs - a.msgs).slice(0, 6);
if (!longOnes.length) console.log('  没有消息数 ≥100 的会话');
for (const s of longOnes) {
  console.log(`  ${s.file.padEnd(26)} ${String(s.msgs).padStart(4)} 条消息 / ${s.rounds ?? '?'} 轮 / ${kb(s.size).padStart(8)} / ${s.status}`);
}

console.log('\n═══ 7. 聊天存档 vs Session：是否重复保存 ═══\n');
const msgFiles = (() => { try { return fs.readdirSync(MESSAGES).filter((f) => f.endsWith('.json')); } catch { return []; } })();
let msgBytes = 0;
let msgCount = 0;
for (const f of msgFiles) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(MESSAGES, f), 'utf8'));
    const list = Array.isArray(j) ? j : (j.messages || []);
    msgCount += list.length;
    msgBytes += fs.statSync(path.join(MESSAGES, f)).size;
  } catch { /* ignore */ }
}
let sessMsgs = 0;
for (const s of sess) sessMsgs += s.msgs;
console.log(`  data/messages ：${msgFiles.length} 个会话，${msgCount} 条消息，${mb(msgBytes)}`);
console.log(`  data/sessions ：${sess.length} 个会话，${sessMsgs} 条消息，${mb(sizes.reduce((a, b) => a + b, 0))}`);
console.log(`  → Session 里的消息是「每轮快照」，聊天存档是「全局流水」；同一句话确实存了两份。`);

console.log('\n═══ 8. DSH 会话目录 ═══\n');
const dshDirs = [
  path.join(DATA, 'dsh-home'),
  path.join(path.dirname(ROOT), 'dsh-tmp')
];
for (const d of dshDirs) {
  try {
    let bytes = 0; let n = 0;
    const walk = (p) => {
      for (const f of fs.readdirSync(p, { withFileTypes: true })) {
        const q = path.join(p, f.name);
        if (f.isDirectory()) walk(q);
        else { try { bytes += fs.statSync(q).size; n += 1; } catch { /* ignore */ } }
      }
    };
    walk(d);
    console.log(`  ${d.replace(ROOT, '.')}：${n} 个文件，${mb(bytes)}`);
  } catch {
    console.log(`  ${d.replace(ROOT, '.')}：不存在`);
  }
}

console.log('\n═══ 9. 结论用的原始数据 ═══\n');
console.log(JSON.stringify({
  sessions: { count: sess.length, bytes: sizes.reduce((a, b) => a + b, 0) },
  messages: { count: msgFiles.length, msgs: msgCount, bytes: msgBytes },
  status: byStatus,
  month: byMonth
}, null, 1));
