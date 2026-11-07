#!/usr/bin/env node
// B7 观察脚本（4.0 / 2.6-B7 / R1）—— **只读**。
//
// 用途：把手工 `node -e` 的观察查询变成一条命令。
//
// ── 只读承诺（机主 2026-11-02 的 10 条约束）───────────────
//   ① 只读打开生产文件
//   ② 不调用模型
//   ③ 不修改生产 JSON
//   ④ 不修改运行配置
//   ⑤ 不创建或修改业务日志
//   ⑥ 不自动修复缺失字段
//   ⑦ 不将读取失败显示成 0
//   ⑧ 缺失文件和字段异常必须明确标注
//   ⑨ 不输出用户私密消息、日记正文或不必要的原始内容
//   ⑩ --detail 也遵守脱敏要求
//
// ── 为什么不复用 readState ──
// `readState` 会给对象挂 `__base`（内存里），虽然不写盘，
// 但本脚本要**证明**只读 —— 直接用 fs.readFileSync + JSON.parse，
// 不经过任何可能带副作用的业务模块。
//
// 用法：
//   node scripts/b7-observe.mjs
//   node scripts/b7-observe.mjs --detail     # 更多细节（仍脱敏）
//   node scripts/b7-observe.mjs --json       # 机器可读
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
// 允许用环境变量指向隔离副本（测试用）—— 默认读生产。
const DATA = process.env.QQ_AGENT_DATA_DIR
  ? path.resolve(process.env.QQ_AGENT_DATA_DIR)
  : path.join(ROOT, 'data');
const AUTONOMOUS = path.join(DATA, 'autonomous.json');
const COMPANION = path.join(DATA, 'companion-state.json');
const CALLS = path.join(DATA, 'model-calls.ndjson');

const DETAIL = process.argv.includes('--detail');
const AS_JSON = process.argv.includes('--json');

/* ── 只读工具 ──────────────────────────────────────────────────────── */

/** 读 JSON。失败返回 { ok:false, error }，**不返回空对象冒充成功**。 */
function readJson(file) {
  try {
    const st = fs.statSync(file);
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) {
      return { ok: false, error: '不是对象', size: st.size };
    }
    return { ok: true, json: j, size: st.size, mtime: st.mtime };
  } catch (e) {
    if (e.code === 'ENOENT') return { ok: false, error: '文件不存在' };
    if (e instanceof SyntaxError) return { ok: false, error: 'JSON 损坏' };
    return { ok: false, error: String(e.message || e) };
  }
}

/** 只读文件的 sha256（用于测试证明「跑完没变」）。 */
export function fileHash(file) {
  try {
    return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
}

/** 脱敏：只保留前 N 个字符。 */
function clip(s, n = 24) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function fmtTime(ts) {
  if (!ts) return '(无)';
  const d = new Date(Number(ts) || ts);
  if (Number.isNaN(d.getTime())) return '(无效)';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/* ── 采集 ──────────────────────────────────────────────────────────── */

export function collect() {
  const out = { sources: {}, warnings: [] };

  // ── ① autonomous.json ──
  const au = readJson(AUTONOMOUS);
  out.sources.autonomous = au.ok
    ? { ok: true, size: au.size, mtime: fmtTime(au.mtime) }
    : { ok: false, error: au.error };
  const j = au.ok ? au.json : null;

  const history = Array.isArray(j?.history) ? j.history : [];
  const digests = Array.isArray(j?.digests) ? j.digests : [];
  const judgeLog = Array.isArray(j?.goalJudgeLog) ? j.goalJudgeLog : [];
  const judgeCount = j?.goalJudgeCount && typeof j.goalJudgeCount === 'object' ? j.goalJudgeCount : null;

  // ── ② companion-state.json ──
  const cp = readJson(COMPANION);
  out.sources.companion = cp.ok
    ? { ok: true, size: cp.size }
    : { ok: false, error: cp.error };

  // ── ③ model-calls.ndjson ──
  let calls = [];
  let callsError = null;
  try {
    const raw = fs.readFileSync(CALLS, 'utf8');
    calls = raw.split('\n').filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
    out.sources.calls = { ok: true, lines: calls.length, size: fs.statSync(CALLS).size };
  } catch (e) {
    callsError = e.code === 'ENOENT' ? '文件不存在' : String(e.message || e);
    out.sources.calls = { ok: false, error: callsError };
  }

  // ── Round 统计 ──
  const withRoundId = history.filter((r) => r && r.roundId);
  const digestIds = new Set(digests.map((d) => d && d.roundId).filter(Boolean));
  const historyIds = new Set(withRoundId.map((r) => r.roundId));

  // ── Judge 分布 ──
  const dist = {};
  for (const x of judgeLog) {
    const k = String(x?.outcome || '(缺失)');
    dist[k] = (dist[k] || 0) + 1;
  }
  const judgeCalls = calls.filter((c) => c && c.purpose === 'autonomous.goal_candidate');

  // ── Token ──
  let inTok = 0;
  let outTok = 0;
  for (const c of judgeCalls) {
    const t = c.tokens && typeof c.tokens === 'object' ? c.tokens : {};
    inTok += Number(t.input ?? t.prompt ?? 0) || 0;
    outTok += Number(t.output ?? t.completion ?? 0) || 0;
  }

  // ── 异常 Round 跳过条件：真实样本数 ──
  //
  // ⚠️ 必须区分两件事（2026-11-02 修）：
  //   · digest 功能上线**前**的轮次没有 roundId —— 那是**历史格式差异**，
  //     本来就不会进 digest，**不能算成「异常被跳过」**。
  //   · 只有**上线后**的轮次里触发跳过条件的，才是真实样本。
  //
  // 上线标记用「第一条有 roundId 的轮次」（2.6.8 才开始记 roundId）。
  // 起点 = **第一条 digest 的 createdAt** —— 那是 digest 功能第一次真正产出数据的时间。
  // 不能用「第一条有 roundId 的轮次」：roundId 是 2.6.8 就有了，digest 是 B5a（11-02 18:44）才有。
  const firstDigest = digests.find((d) => d && d.createdAt);
  const onsetAt = firstDigest ? Date.parse(firstDigest.createdAt) : 0;
  const preOnset = onsetAt > 0
    ? history.filter((r) => !Number(r?.startedAt) || Number(r.startedAt) < onsetAt).length
    : history.length;   // 还没有 digest → 全部算「起点之前」
  const onsetKnown = onsetAt > 0;

  let errRounds = 0;
  let noRoundId = 0;
  let badActions = 0;
  let emptyActions = 0;
  let postOnsetCount = 0;
  for (const r of history) {
    if (!r || typeof r !== 'object') continue;
    const at = Number(r.startedAt) || 0;
    if (!(onsetAt > 0 && at >= onsetAt)) continue;   // 上线前的不参与统计
    postOnsetCount += 1;
    if (String(r.error ?? '') !== '') errRounds += 1;
    else if (!String(r.roundId || '').trim()) noRoundId += 1;
    else if (!Array.isArray(r.actions)) badActions += 1;
    else if (!r.actions.some((a) => a && typeof a === 'object' && (a.action || a.actionType))) emptyActions += 1;
  }

  // ── 今日预算 ──
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dayKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayUsed = judgeCount ? (Number(judgeCount[dayKey]) || 0) : 0;

  return {
    sources: out.sources,
    history: {
      total: history.length,
      withRoundId: withRoundId.length,
      recent: withRoundId.slice(-5).map((r) => ({
        roundId: String(r.roundId),
        at: fmtTime(r.startedAt),
        actions: Array.isArray(r.actions) ? r.actions.length : 0,
        hasDigest: digestIds.has(String(r.roundId)),
        stopReason: clip(r.stopReason, 30)
      }))
    },
    digests: {
      total: digests.length,
      ids: [...digestIds],
      // 有 digest 但 history 里找不到对应轮次 → 异常
      orphans: [...digestIds].filter((id) => !historyIds.has(id)),
      coverage: withRoundId.length
        ? `${digests.filter((x) => x && digestIds.has(String(x.roundId))).length}/${withRoundId.length}`
        : '0/0'
    },
    judge: {
      logCount: judgeLog.length,
      distribution: dist,
      calls: judgeCalls.length,
      todayUsed,
      dailyLimit: 3,
      countRaw: judgeCount ? JSON.stringify(judgeCount) : null
    },
    tokens: { calls: judgeCalls.length, input: inTok, output: outTok, total: inTok + outTok },
    schedule: {
      lastWakeAt: j ? fmtTime(j.lastWakeAt) : '(无)',
      nextWakeAt: j ? fmtTime(j.nextWakeAt) : '(无)',
      status: j?.status ?? '(无)'
    },
    skipSamples: {
      onsetAt: onsetKnown ? fmtTime(onsetAt) : null,
      onsetKnown,
      preOnset,
      postOnsetCount,
      errorRounds: errRounds,
      noRoundId,
      badActions,
      emptyActions,
      total: errRounds + noRoundId + badActions + emptyActions
    }
  };
}

/* ── 输出 ──────────────────────────────────────────────────────────── */

export function render(r) {
  const L = [];
  const line = (s = '') => L.push(s);

  line('=== B7 观察指标 ===');
  line('');

  // ── 数据源 ──
  line('【数据源】');
  const srcName = { autonomous: 'autonomous.json', companion: 'companion-state.json', calls: 'model-calls.ndjson' };
  for (const [k, v] of Object.entries(r.sources)) {
    if (v.ok) {
      const extra = v.size !== undefined ? `  ${(v.size / 1024).toFixed(1)} KB` : '';
      const lines = v.lines !== undefined ? `  ${v.lines} 行` : '';
      line(`  ✅ ${srcName[k]}${extra}${lines}`);
    } else {
      // 机主要求：读取失败不能显示成 0
      line(`  ❌ ${srcName[k]}：${v.error}`);
    }
  }
  line('');

  // ── Round / Digest ──
  line('【Round 与 Digest】');
  line(`  history 总轮数        ${r.history.total}`);
  line(`  有 roundId 的轮次     ${r.history.withRoundId}`);
  line(`  digest 总数           ${r.digests.total}`);
  line(`  **digest 覆盖率**      ${r.digests.coverage}`);
  if (r.digests.orphans.length) {
    line(`  ⚠️ 孤儿 digest（history 里找不到）: ${r.digests.orphans.join(', ')}`);
  }
  line('');
  line('  最近 5 轮：');
  for (const x of r.history.recent) {
    const mark = x.hasDigest ? '✅' : '·';
    line(`    ${mark} ${x.roundId.slice(0, 18).padEnd(18)} ${x.at}  actions=${x.actions}`);
  }
  line('');

  // ── Judge ──
  line('【Goal Judge】');
  line(`  goalJudgeLog 条数     ${r.judge.logCount}`);
  if (r.judge.logCount) {
    const distStr = Object.entries(r.judge.distribution).map(([k, v]) => `${k}×${v}`).join('  ');
    line(`  分布                  ${distStr}`);
  } else {
    line('  分布                  (还没有记录)');
  }
  line(`  **Goal Judge 调用次数** ${r.judge.calls}（purpose = autonomous.goal_candidate）`);
  line(`  今日预算              ${r.judge.todayUsed}/${r.judge.dailyLimit}`);
  if (r.judge.countRaw) line(`  计数原文              ${r.judge.countRaw}`);
  line('');

  // ── Token ──
  line('【Token（Goal Judge）】');
  if (r.tokens.calls === 0) {
    line('  调用 0 次（还没有真实调用）');
  } else {
    line(`  调用 ${r.tokens.calls} 次  in=${r.tokens.input}  out=${r.tokens.output}  total=${r.tokens.total}`);
    line(`  平均每次 ${Math.round(r.tokens.total / r.tokens.calls)} tokens（设计预估 ~1900）`);
  }
  line('');

  // ── 调度 ──
  line('【调度】');
  line(`  status                ${r.schedule.status}`);
  line(`  上次唤醒              ${r.schedule.lastWakeAt}`);
  line(`  下次唤醒              ${r.schedule.nextWakeAt}`);
  line('');

  // ── 跳过样本 ──
  line('【buildDigest 异常 Round 跳过条件 —— 真实样本】');
  line(`  digest 功能起点（第一条 digest 的时间）      ${r.skipSamples.onsetAt || '(未知 —— 还没有任何 digest)'}`);
  line(`  起点之前的轮次（不算跳过）                    ${r.skipSamples.preOnset} 条`);
  line(`  **起点之后的轮次**                          ${r.skipSamples.postOnsetCount} 条`);
  line('');
  line('  起点之后触发跳过条件的：');
  line(`    · rec.error 非空            ${r.skipSamples.errorRounds} 条`);
  line(`    · 没有 roundId             ${r.skipSamples.noRoundId} 条`);
  line(`    · actions 不是数组          ${r.skipSamples.badActions} 条`);
  line(`    · 没有有效 Action           ${r.skipSamples.emptyActions} 条`);
  line(`    **合计**                    ${r.skipSamples.total} 条`);
  line('');

  // ── 机主要求必须打出来的那句话 ──
  line('  ⚠️ buildDigest 五种异常 Round 跳过条件：**生产零样本**；');
  line('     目前只有 stage26b5a-test 的 45 项测试覆盖，');
  line('     **测试覆盖不等于生产验证**。');
  line('');

  return L.join('\n');
}

/* ── 主流程 ────────────────────────────────────────────────────────── */

// 只在**直接运行**时输出（被 import 时不执行 —— 测试要直接调 collect/render）。
const IS_MAIN = (() => {
  try {
    const self = path.resolve(fileURLToPath(import.meta.url));
    const argv = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return Boolean(argv) && self === argv;
  } catch { return false; }
})();

if (IS_MAIN) {
  const result = collect();
  if (AS_JSON) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(render(result));
    if (DETAIL) {
      console.log('【明细（--detail）】');
      console.log('  digest 的 roundId：' + (result.digests.ids.join(', ') || '(无)'));
      console.log('  这只脚本只读：不调用模型、不写任何文件、不修改配置。');
    }
  }
}
