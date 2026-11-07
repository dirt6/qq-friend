// B6 事后审计补救（4.0 / 2.6-B6）。
//
// ⚠️ 背景：2026-11-02 21:29 的"演练"没有真正拦住写盘 ——
// `cancelGoal` 会走 updateCompanion 写文件，而演练模式只跳过了备份和 config 改动。
// 结果：四条 Goal 被真实取消了，但没有留下备份和日志。
//
// 这个脚本做三件事：
//   ① 备份**当前**状态（带 -posthoc 标记，明确它不是操作前的快照）
//   ② 从每条 Goal 的 history 反推原始状态，写进维护日志
//   ③ 验证四条状态 + 其它字段没被意外改动
//
// 它**不修改任何业务数据**，只写备份文件和日志文件。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/dsh/QQ-agent';
const CS = path.join(ROOT, 'data', 'companion-state.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const LOG = path.join(ROOT, 'data', 'b6-maintenance.log');

const REASON_MARK = 'misclassified_legacy_goal';
const TARGETS = ['g-legacy-1', 'g-ce9d75', 'g-ec778f', 'g-bda0fa'];

const d = new Date();
const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
  + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;

const raw = fs.readFileSync(CS, 'utf8');
const st = JSON.parse(raw);
const lines = [];
const say = (s) => { console.log(s); lines.push(s); };

say(`[${d.toISOString()}] === B6 事后审计（补做）===`);
say('⚠️ 说明：21:29 的"演练"实际执行了取消（cancelGoal 会写盘）。');
say('   操作前的原始文件**没有备份**。以下是从 history 反推的原始状态。');

// ── ① 备份当前状态（排他创建，不覆盖）──
fs.mkdirSync(BACKUP_DIR, { recursive: true });
let bp = path.join(BACKUP_DIR, `companion-state.b6-posthoc-${stamp}.json`);
let i = 1;
while (fs.existsSync(bp)) { bp = path.join(BACKUP_DIR, `companion-state.b6-posthoc-${stamp}-${i}.json`); i += 1; }
fs.writeFileSync(bp, raw, { encoding: 'utf8', flag: 'wx' });
const back = fs.readFileSync(bp, 'utf8');
if (back !== raw) throw new Error('备份内容不一致');
say(`① 当前状态已备份：${path.basename(bp)}（${raw.length} 字节，读回一致）`);
say('   ⚠️ 这是**操作后**的快照，不是操作前的。');

// ── ② 从 history 反推原始状态 ──
say('② 四条的反推（来自各自的 history）');
const inferred = [];
for (const id of TARGETS) {
  const g = st.goals.find((x) => x.id === id);
  if (!g) { say(`   ✗ ${id} 不见了`); process.exit(1); }
  const h = g.history || [];
  const from = h.length ? h[h.length - 1].from : '(无 history，原始状态未知)';
  say(`   ${id}`);
  say(`     文本: ${g.text}`);
  say(`     id / since / source: ${g.id} / ${g.since} / ${g.source}`);
  say(`     原始状态（反推）: ${from}`);
  say(`     当前状态: ${g.status}`);
  say(`     reason: ${String(g.reason).slice(0, 60)}…`);
  say(`     history: ${h.length} 条`);
  for (const e of h) say(`       ${e.at}  ${e.from}→${e.to}  by=${e.by}  ${String(e.reason).slice(0, 50)}`);
  inferred.push({ id, text: g.text, from, now: g.status, historyLen: h.length });
}

// ── ③ 验证 ──
say('③ 验证');
let bad = 0;
for (const id of TARGETS) {
  const g = st.goals.find((x) => x.id === id);
  if (!g) { say(`   ✗ ${id} 不见了`); bad += 1; continue; }
  if (g.status !== 'cancelled') { say(`   ✗ ${id} 状态是 ${g.status}`); bad += 1; continue; }
  if (!String(g.reason || '').includes(REASON_MARK)) { say(`   ✗ ${id} reason 缺失`); bad += 1; continue; }
  say(`   ✓ ${id}: cancelled，reason 已写，history ${(g.history || []).length} 条`);
}
const active = st.goals.filter((g) => g.status === 'active').length;
const paused = st.goals.filter((g) => g.status === 'paused').length;
const cancelled = st.goals.filter((g) => g.status === 'cancelled').length;
say(`   统计：active=${active}  paused=${paused}  cancelled=${cancelled}  总数=${st.goals.length}`);
say(`   其它字段：pending=${(st.pending || []).length}  topic=${st.topic ? '有' : '无'}  version=${st.version}`);

// 四条都还在（不只是数量对）
const allThere = TARGETS.every((id) => st.goals.some((g) => g.id === id));
say(`   四条都在：${allThere ? '✓' : '✗'}`);

fs.writeFileSync(LOG, lines.join('\n') + '\n', { encoding: 'utf8', flag: 'a' });
console.log(`\n日志已追加：${path.basename(LOG)}（${lines.length} 行）`);
if (bad || !allThere) process.exit(1);
process.exit(0);
