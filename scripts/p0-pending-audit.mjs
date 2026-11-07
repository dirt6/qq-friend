#!/usr/bin/env node
// 生产 Pending 只读统计 + 人工整理清单（4.0 / P0）。
//
// **只读**：不修改、不合并、不删除任何生产数据。
//
// 用法：
//   node scripts/p0-pending-audit.mjs
//   node scripts/p0-pending-audit.mjs --json
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const DATA = path.join(ROOT, 'data');
const CS = path.join(DATA, 'companion-state.json');

function readJson(f) {
  try {
    return { ok: true, json: JSON.parse(fs.readFileSync(f, 'utf8')) };
  } catch (e) {
    return { ok: false, error: e.code === 'ENOENT' ? '文件不存在' : String(e.message || e) };
  }
}

function fmtTime(ts) {
  if (!ts) return '(无)';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '(无效)';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function main() {
  const S = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);

  const r = readJson(CS);
  if (!r.ok) {
    console.error(`读不到 companion-state.json：${r.error}`);
    process.exit(1);
  }
  const pending = Array.isArray(r.json.pending) ? r.json.pending : [];

  // 只看"活着"的
  const live = pending.filter((p) => p && !['done', 'cancelled', 'expired'].includes(p.status));

  const rows = [];
  for (const p of live) {
    const meta = S.askMetaOf(p);
    // 4.0 / P0：和 promptSection 用同一套判断（含文本兜底）
    const byStatus = p.status === 'waiting' || S.isSilentWaiting(p);
    const byText = S.looksLikeWaitingText(p.text);
    const isWait = byStatus || byText;
    // 用 P0 的去重规则判断它和别的条目是不是同一件事
    const group = [];
    for (const q of live) {
      if (q.id === p.id) continue;
      if (S.isSamePendingItem(p.text, q.text)) group.push(q.id);
    }
    const conflictWith = [];
    for (const q of live) {
      if (q.id === p.id) continue;
      if (S.hasActionConflict(p.text, q.text)) conflictWith.push(q.id);
    }
    rows.push({
      id: p.id,
      text: p.text,
      status: p.status,
      at: p.at,
      atText: fmtTime(Date.parse(p.at || '')),
      source: p.source || '',
      isWaiting: isWait,
      waitByStatus: byStatus,
      waitByText: byText,
      askCount: meta.askCount,
      askKnown: Number.isFinite(Number(p.askCount)),
      silent: meta.silent,
      similarTo: group,
      conflictsWith: conflictWith
    });
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ total: pending.length, live: live.length, rows }, null, 2));
    return;
  }

  console.log('=== 生产 Pending 只读统计（P0） ===');
  console.log(`companion-state.json：共 ${pending.length} 条，活着 ${live.length} 条`);
  console.log('');
  console.log('ID'.padEnd(10) + '状态'.padEnd(10) + '创建时间'.padEnd(18) + '判定'.padEnd(10) + 'askCount 文本');
  console.log('-'.repeat(100));
  for (const x of rows) {
    const judge = x.isWaiting ? '等待回复' : '普通';
    const ask = x.askKnown ? String(x.askCount) : '未知';
    console.log(
      String(x.id).padEnd(10)
      + String(x.status).padEnd(10)
      + String(x.atText).padEnd(18)
      + judge.padEnd(10)
      + ask.padEnd(9)
      + String(x.text).slice(0, 40)
    );
  }

  console.log('');
  console.log('=== 相似分组（只读判断，不改数据） ===');
  const done = new Set();
  for (const x of rows) {
    if (done.has(x.id)) continue;
    const comp = [x.id, ...x.similarTo];
    comp.forEach((id) => done.add(id));
    if (comp.length > 1) {
      console.log(`\n【可能同一组】${comp.length} 条`);
      for (const id of comp) {
        const y = rows.find((z) => z.id === id);
        if (y) console.log(`  ${y.id}  ${String(y.text).slice(0, 50)}`);
      }
    }
  }
  const singles = rows.filter((x) => x.similarTo.length === 0);
  if (singles.length) {
    console.log(`\n【独立条目】${singles.length} 条（没有相似项）`);
    for (const y of singles) console.log(`  ${y.id}  ${String(y.text).slice(0, 50)}`);
  }

  console.log('');
  console.log('=== ⚠️ 需要人工决定的 ===');
  // ① 等待回复但 askCount 未知 → 会继续被问，需要人工决定
  const needHuman = rows.filter((x) => x.isWaiting && !x.askKnown);
  if (needHuman.length) {
    console.log(`\n【A】「等待回复」但 askCount 未知（旧数据，没有这个字段）：${needHuman.length} 条`);
    for (const y of needHuman) console.log(`  ${y.id}  ${String(y.text).slice(0, 50)}`);
    console.log('');
    console.log('  → 会被当作"还没问过"处理（askCount=0），**可能继续被问**。');
    console.log('  → 需要的决定：保留 / 标 silent / 结算掉。');
  }

  // ② 文本判定不出来的 → 人工判断是不是等待事项
  const notRecognized = rows.filter((x) => !x.isWaiting);
  if (notRecognized.length) {
    console.log(`\n【B】文本判定不出「等待回复」（会被当普通待办注入）：${notRecognized.length} 条`);
    for (const y of notRecognized) console.log(`  ${y.id}  ${String(y.text).slice(0, 50)}`);
    console.log('');
    console.log('  → 如果其中有的其实是在等回复，需要你指定，我再手工标（本批次不动数据）。');
  }

  // ③ 相似但没合并的 → 人工确认是不是同一件事
  const simPairs = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const sim = S.similarityOf(rows[i].text, rows[j].text);
      if (sim >= 0.4) simPairs.push({ a: rows[i], b: rows[j], sim });
    }
  }
  if (simPairs.length) {
    simPairs.sort((x, y) => y.sim - x.sim);
    console.log(`\n【C】相似度 >= 0.4 但没自动合并的（${simPairs.length} 对）：`);
    for (const p2 of simPairs.slice(0, 10)) {
      console.log(`  sim=${p2.sim.toFixed(2)}`);
      console.log(`    ${p2.a.id} ${String(p2.a.text).slice(0, 40)}`);
      console.log(`    ${p2.b.id} ${String(p2.b.text).slice(0, 40)}`);
    }
    console.log('');
    console.log('  → 如果确认是同一件事，需要你指定合并哪几条（本批次不动数据）。');
  }

  console.log('');
  console.log('=== 说明 ===');
  console.log('· 本脚本**只读**，不修改任何文件');
  console.log('· 相似分组用的是 P0 的保守阈值（宁可分组不准，也不错误合并）');
  console.log('· **没有**自动合并、没有改状态、没有删除');
}

main().catch((e) => {
  console.error('[失败] ' + (e?.message || e));
  process.exit(1);
});
