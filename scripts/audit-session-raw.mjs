// messages[].raw / toolImages 只读评估（4.0 · 1.5.7.x）。
//
// **严格只读**：不修改任何 Session、不碰 DSH_HOME、不删文件、不建副本。
//
// 回答四个问题：
//   ① raw / toolImages 各占多少、比例多少
//   ② 全项目哪里读它们
//   ③ 剥离后会失去什么
//   ④ 保留必要字段还能省多少
//
// 外加机主特别要求的两项：
//   A. 区分模型轨迹 vs 用户内容（工具参数 / 模型响应 / 工具结果 / 图片引用 / 错误）
//   B. 检查 raw 里的内容是不是已经在别的字段里存过
//
// 用法：node scripts/audit-session-raw.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = path.join(ROOT, 'data', 'sessions');
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const bytesOf = (v) => Buffer.byteLength(JSON.stringify(v) ?? '', 'utf8');

console.log('══════ messages[].raw / toolImages 只读评估 ══════\n');
console.log('（不改任何文件，只统计和搜索）\n');

// ── ① 实际占用 ─────────────────────────────────────────
const files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));
const acc = {
  files: 0,
  totalBytes: 0,
  messagesBytes: 0,
  rawBytes: 0,
  toolImagesBytes: 0,
  contentBytes: 0,
  toolCallsBytes: 0,
  toolCallBytes: 0,      // 单数：工具执行结果
  msgCount: 0,
  rawCount: 0,
  toolImagesCount: 0,
  roles: {}
};

for (const f of files) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')); } catch { continue; }
  acc.files += 1;
  acc.totalBytes += Buffer.byteLength(fs.readFileSync(path.join(SESSIONS, f), 'utf8'), 'utf8');
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  acc.msgCount += msgs.length;
  acc.messagesBytes += bytesOf(msgs);
  for (const m of msgs) {
    if (m.role) acc.roles[m.role] = (acc.roles[m.role] || 0) + 1;
    if (m.raw !== undefined) { acc.rawCount += 1; acc.rawBytes += bytesOf(m.raw); }
    if (m.toolImages !== undefined) { acc.toolImagesCount += 1; acc.toolImagesBytes += bytesOf(m.toolImages); }
    if (m.content !== undefined) acc.contentBytes += bytesOf(m.content);
    if (m.tool_calls !== undefined) acc.toolCallsBytes += bytesOf(m.tool_calls);
    if (m.toolCall !== undefined) acc.toolCallBytes += bytesOf(m.toolCall);
  }
}

const pct = (n) => `${((n / Math.max(1, acc.totalBytes)) * 100).toFixed(1)}%`;

console.log('① 实际占用\n');
console.log(`  扫描会话        ${acc.files} 个 / ${mb(acc.totalBytes)}`);
console.log(`  消息总数        ${acc.msgCount} 条`);
console.log(`  messages 总大小 ${mb(acc.messagesBytes)}（占全库 ${pct(acc.messagesBytes)}）\n`);
console.log(`  ┌ raw           ${mb(acc.rawBytes).padStart(10)}  占全库 ${pct(acc.rawBytes).padStart(6)}  出现 ${acc.rawCount} 次`);
console.log(`  ├ toolImages    ${mb(acc.toolImagesBytes).padStart(10)}  占全库 ${pct(acc.toolImagesBytes).padStart(6)}  出现 ${acc.toolImagesCount} 次`);
console.log(`  ├ tool_calls    ${mb(acc.toolCallsBytes).padStart(10)}  占全库 ${pct(acc.toolCallsBytes).padStart(6)}`);
console.log(`  ├ toolCall(结果)${mb(acc.toolCallBytes).padStart(10)}  占全库 ${pct(acc.toolCallBytes).padStart(6)}`);
console.log(`  └ content       ${mb(acc.contentBytes).padStart(10)}  占全库 ${pct(acc.contentBytes).padStart(6)}`);

// ── A. 区分轨迹 vs 内容 ─────────────────────────────────
console.log('\n══════ A. 里面到底是什么（抽样看结构）══════\n');
let sampleRaw = null;
let sampleToolImages = null;
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
    for (const m of (j.messages || [])) {
      if (!sampleRaw && m.raw) sampleRaw = { file: f, raw: m.raw };
      if (!sampleToolImages && m.toolImages) sampleToolImages = { file: f, toolImages: m.toolImages };
    }
  } catch { /* ignore */ }
  if (sampleRaw && sampleToolImages) break;
}

if (sampleRaw) {
  const r = sampleRaw.raw;
  console.log(`raw 的字段（来自 ${sampleRaw.file}）：${Object.keys(r).join(', ')}`);
  console.log(`  id / model / created / usage 等元数据：${JSON.stringify({ id: r.id, model: r.model, created: r.created })}`);
  if (r.choices) {
    console.log(`  choices: ${r.choices.length} 个`);
    const c0 = r.choices[0] || {};
    console.log(`  choices[0] 字段: ${Object.keys(c0).join(', ')}`);
    if (c0.message) {
      console.log(`  choices[0].message 字段: ${Object.keys(c0.message).join(', ')}`);
      console.log(`  choices[0].message.content 长度: ${String(c0.message.content || '').length} 字`);
      if (c0.message.tool_calls) console.log(`  choices[0].message.tool_calls: ${c0.message.tool_calls.length} 个`);
    }
  }
  if (r.usage) console.log(`  usage: ${JSON.stringify(r.usage)}`);
}
if (sampleToolImages) {
  console.log(`\ntoolImages（来自 ${sampleToolImages.file}）：`);
  const ti = sampleToolImages.toolImages;
  console.log(`  类型: ${Array.isArray(ti) ? '数组 ' + ti.length + ' 项' : typeof ti}`);
  const s = JSON.stringify(ti);
  console.log(`  内容摘要: ${s.slice(0, 200)}${s.length > 200 ? '…' : ''}`);
  console.log(`  大小: ${kb(bytesOf(ti))}`);
}

// ── ② 代码依赖 ─────────────────────────────────────────
console.log('\n══════ ② 代码依赖（谁读 raw / toolImages）══════\n');
const grepDirs = ['src', 'plugins', 'skills', 'scripts', 'dsh-plugins', 'test'];
const patterns = [
  { name: '读取 .raw', re: /\.raw\b/ },
  { name: 'toolImages', re: /toolImages/ },
  { name: 'messages 里的 toolCall', re: /\.toolCall\b/ }
];
for (const { name, re } of patterns) {
  const hits = [];
  for (const dir of grepDirs) {
    const walk = (d) => {
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.git') walk(p); continue; }
        if (!/\.(m?js)$/.test(e.name)) continue;
        let text;
        try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i += 1) {
          if (re.test(lines[i])) hits.push(`${p.replace(ROOT + path.sep, '')}:${i + 1}: ${lines[i].trim().slice(0, 70)}`);
        }
      }
    };
    walk(path.join(ROOT, dir));
  }
  console.log(`【${name}】${hits.length} 处`);
  for (const h of hits.slice(0, 8)) console.log('  ' + h);
  if (hits.length > 8) console.log(`  ……还有 ${hits.length - 8} 处`);
  console.log('');
}

// ── B. 重复存储检查 ─────────────────────────────────────
console.log('══════ B. raw 里有没有和别处重复的内容 ══════\n');
let dupContent = 0;   // raw 里的 content 和 message.content 相同
let dupCalls = 0;     // raw 里的 tool_calls 和 message.tool_calls 相同
let checked = 0;
for (const f of files) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8'));
    for (const m of (j.messages || [])) {
      if (!m.raw?.choices?.[0]?.message) continue;
      checked += 1;
      const inner = m.raw.choices[0].message;
      if (inner.content !== undefined && String(inner.content) === String(m.content ?? '')) dupContent += 1;
      if (inner.tool_calls && JSON.stringify(inner.tool_calls) === JSON.stringify(m.tool_calls)) dupCalls += 1;
    }
  } catch { /* ignore */ }
}
console.log(`  检查了 ${checked} 条带 raw 的消息`);
console.log(`  raw.choices[0].message.content 与顶层 content 相同：${dupContent} 条（${checked ? ((dupContent / checked) * 100).toFixed(0) : 0}%）`);
console.log(`  raw.choices[0].message.tool_calls 与顶层 tool_calls 相同：${dupCalls} 条（${checked ? ((dupCalls / checked) * 100).toFixed(0) : 0}%）`);
console.log('  → 内容确实重复，但 raw 还带了 id/model/created/usage/finish_reason 等顶层没有的元数据。');

// ── ④ 压缩收益估算 ──────────────────────────────────────
console.log('\n══════ ④ 如果剥离，能省多少 ══════\n');
console.log(`  全库 ${mb(acc.totalBytes)}`);
console.log(`  剥离 raw        → 省 ${mb(acc.rawBytes)}（${pct(acc.rawBytes)}），剩 ${mb(acc.totalBytes - acc.rawBytes)}`);
console.log(`  剥离 toolImages → 省 ${mb(acc.toolImagesBytes)}（${pct(acc.toolImagesBytes)}）`);
console.log(`  两个都剥        → 省 ${mb(acc.rawBytes + acc.toolImagesBytes)}（${pct(acc.rawBytes + acc.toolImagesBytes)}）`);
console.log(`  只剥 raw 里重复的 content/tool_calls（保留元数据）→ 约省 ${mb(acc.contentBytes + acc.toolCallsBytes)} 量级，但要逐条改结构`);

console.log('\n══════ 结论 ══════\n');
console.log('  这次只统计和搜索，没有改任何文件。');
console.log('  是否值得剥，看第二节的依赖和第三节的影响（见报告）。');
