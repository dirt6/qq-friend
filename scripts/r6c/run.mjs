#!/usr/bin/env node
// R6-C 真实实验 runner（4.0 / R6-C）。
//
// ── 前置条件 ────────────────────────────────────────────────────
//   · 实验凭据（QQ_R6C_DEEPSEEK_API_KEY / DEEPSEEK_API_KEY / {实验根}/credentials/api-key）
//   · 缺凭据时**直接退出**，不回退生产
//
// ── 用法 ────────────────────────────────────────────────────────
//   node scripts/r6c/run.mjs --check              只检查环境与凭据（不发请求）
//   node scripts/r6c/run.mjs --scene S1           跑单个场景
//   node scripts/r6c/run.mjs --all                跑全部
//   node scripts/r6c/run.mjs --all --samples 20   S7 的样本数
//
// ── 安全 ────────────────────────────────────────────────────────
//   · 每次运行都建**全新**实验环境
//   · 凭据只在内存里用，不落盘、不进日志
//   · 所有输出写进实验目录的 results/
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { createExperiment, validateExperiment, productionPaths, snapshot, describe } from '../r6c0/env.mjs';
import { checkCredential, resolveCredential, maskKey, scanForLeaks, describeCredential, assertNoProductionCredential, EXPERIMENT_KEY_ENV } from '../r6c0/credentials.mjs';
import { scenarioCatalog, decideVerdict, percentile95, emptyResult, VERDICT } from '../r6c0/scenarios.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DSH = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d = '') => { const i = args.indexOf(f); return i >= 0 ? String(args[i + 1] || d) : d; };

// ── 直接调 DSH（不走 dsh-gateway，避免污染生产映射）──────────────
/**
 * 跑一次 dsh，返回 { code, events, raw, stderr, ms }。
 * @param {object} o
 * @param {string} o.cwd
 * @param {string} o.dshHome
 * @param {string} [o.sessionId]
 * @param {string} o.text
 * @param {number} [o.timeoutMs]
 */
function runDsh({ cwd, dshHome, sessionId = '', text = '', timeoutMs = 180000 }) {
  // ⚠️ 沙箱不允许 pipe（spawn EPERM），所以**全部走文件重定向**：
  //    任务文本写进 task.txt，stdout/stderr 各自写进文件，进程结束再读。
  //    这样 spawn 的 stdio 全是 'ignore'，不碰任何管道。
  return new Promise((resolve) => {
    const runDir = path.join(path.dirname(dshHome), 'tmp', 'runs', 'r' + Date.now() + '-' + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(runDir, { recursive: true });
    const taskFile = path.join(runDir, 'task.txt');
    const outFile = path.join(runDir, 'out.txt');
    const errFile = path.join(runDir, 'err.txt');

    fs.writeFileSync(taskFile, String(text), 'utf8');

    const dshArgs = ['--profile', 'headless', '--json'];
    if (sessionId) dshArgs.push('--session-id', sessionId);
    dshArgs.push('-');

    // ⚠️ 不能直接 spawn('cmd', ['/c', 一长串]) —— Node 会吃掉内层引号，
    //    命令根本执行不了（out.txt / err.txt 都不会生成）。
    //    最稳的做法：把命令写进临时 .bat，然后 cmd /c 那个 .bat。
    const batFile = path.join(runDir, 'run.bat');
    const batBody = [
      '@echo off',
      'setlocal',
      '"' + DSH + '" ' + dshArgs.join(' ') + ' < "' + taskFile + '" > "' + outFile + '" 2> "' + errFile + '"',
      'exit /b %ERRORLEVEL%'
    ].join('\r\n');
    fs.writeFileSync(batFile, batBody, 'utf8');

    const started = Date.now();
    const child = spawn('cmd', ['/c', batFile], {
      cwd,
      windowsHide: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        TEMP: path.join(path.dirname(dshHome), 'tmp'),
        TMP: path.join(path.dirname(dshHome), 'tmp'),
        // ⚠️ 关键：DSH 认的是 DEEPSEEK_API_KEY，而我们的实验约定是
        //    QQ_R6C_DEEPSEEK_API_KEY。这里把前者**映射**成后者。
        //    · 只从实验变量取，**绝不读生产凭据文件**
        //    · 实验变量没设 → undefined → DSH 报 MISSING_CREDENTIAL（符合"不回退生产"）
        DEEPSEEK_API_KEY: process.env.QQ_R6C_DEEPSEEK_API_KEY || undefined
      }
    });

    let settled = false;
    const done = (extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let raw = [];
      try {
        raw = fs.readFileSync(outFile, 'utf8').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
      } catch { /* 没有输出文件 */ }
      let stderr = '';
      try { stderr = fs.readFileSync(errFile, 'utf8').slice(-8000); } catch { /* ignore */ }
      resolve({
        code: extra.code ?? null,
        events: parseEvents(raw),
        raw,
        stderr,
        ms: Date.now() - started,
        timedOut: Boolean(extra.timedOut)
      });
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done({ timedOut: true });
    }, timeoutMs);

    child.on('error', (e) => done({ code: -1, stderr: String(e?.message || e) }));
    child.on('close', (code) => done({ code }));
  });
}

/** 从原始行里解析事件。 */
function parseEvents(raw) {
  const out = [];
  for (const line of raw) {
    try { out.push(JSON.parse(line)); } catch { /* 非 JSON 跳过 */ }
  }
  return out;
}

/** 从事件里取关键信息。 */
function summarize(events, code, timedOut) {
  let sessionId = '';
  let finalText = '';
  let errorMsg = '';
  let turnEnd = null;
  let usage = null;
  const types = new Set();

  for (const e of events) {
    types.add(e.type);
    if (e.type === 'session' && e.sessionId) sessionId = e.sessionId;
    else if (e.type === 'final' && typeof e.text === 'string') finalText = e.text;
    else if (e.type === 'error') errorMsg = String(e.message || '');
    else if (e.type === 'status') {
      if (e.usage) usage = e.usage;
      if (e.phase === 'turn_end') {
        turnEnd = e;
        if (e.reason?.kind === 'error' && !errorMsg) errorMsg = String(e.reason?.error?.message || '');
      }
    }
  }

  const ok = !timedOut && code === 0 && !errorMsg && finalText.length > 0;
  return { ok, sessionId, finalText, errorMsg, turnEnd, usage, types: [...types], code, timedOut };
}

const rand = (n = 8) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < n; i += 1) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
};

// ── 场景 ────────────────────────────────────────────────────────
const SCENES = {
  async S1(ctx) {
    const r = emptyResult('S1');
    const t1 = `只回一个字：好。标记 ${rand()}`;
    const a = runDsh({ ...ctx, text: t1 });
    const ra = await a;
    const sa = summarize(ra.events, ra.code, ra.timedOut);
    r.raw.push({ step: 'create', ...sa, events: ra.events });
    if (!sa.sessionId) { r.verdict = VERDICT.INCONCLUSIVE; r.reason = '第一次没拿到 sessionId'; return r; }

    const b = await runDsh({ ...ctx, sessionId: sa.sessionId, text: '再回一个字：好' });
    const sb = summarize(b.events, b.code, b.timedOut);
    r.raw.push({ step: 'resume', ...sb, events: b.events });

    const turnA = sa.turnEnd?.turn || 0;
    const turnB = sb.turnEnd?.turn || 0;

    r.samples = (sa.ok ? 1 : 0) + (sb.ok ? 1 : 0);
    r.assertions = [
      { name: '第一次有 sessionId', pass: Boolean(sa.sessionId) },
      { name: '第二次 sessionId 相同', pass: sb.sessionId === sa.sessionId },
      { name: '第二次 turn > 第一次', pass: turnB > turnA, detail: `${turnA} → ${turnB}` },
      { name: 'session 文件在实验 DSH_HOME 内', pass: fs.existsSync(path.join(ctx.dshHome, 'sessions')) }
    ];
    const failures = r.assertions.filter((x) => !x.pass).length;
    const v = decideVerdict({ samples: r.samples, requiredSamples: 2, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  },

  async S2(ctx) {
    const r = emptyResult('S2');
    const M1 = 'X' + rand(6);
    const M2 = 'Y' + rand(6);

    const ra1 = await runDsh({ ...ctx, text: `请记住这个词，后面我会问你：${M1}。回一个字：好` });
    const sa1 = summarize(ra1.events, ra1.code, ra1.timedOut);
    if (!sa1.sessionId) { r.verdict = VERDICT.INCONCLUSIVE; r.reason = 'A 没拿到 sessionId'; return r; }

    const rb1 = await runDsh({ ...ctx, text: `请记住这个词：${M2}。回一个字：好` });
    const sb1 = summarize(rb1.events, rb1.code, rb1.timedOut);
    if (!sb1.sessionId) { r.verdict = VERDICT.INCONCLUSIVE; r.reason = 'B 没拿到 sessionId'; return r; }

    const ra2 = await runDsh({ ...ctx, sessionId: sa1.sessionId, text: '刚才让你记的那个词是什么？只回那个词。' });
    const sa2 = summarize(ra2.events, ra2.code, ra2.timedOut);

    const rb2 = await runDsh({ ...ctx, sessionId: sb1.sessionId, text: '刚才让你记的那个词是什么？只回那个词。' });
    const sb2 = summarize(rb2.events, rb2.code, rb2.timedOut);

    r.raw.push({ step: 'A-recall', text: sa2.finalText, events: ra2.events });
    r.raw.push({ step: 'B-recall', text: sb2.finalText, events: rb2.events });

    const textA = String(sa2.finalText || '');
    const textB = String(sb2.finalText || '');

    r.samples = (textA ? 1 : 0) + (textB ? 1 : 0);
    r.assertions = [
      { name: 'A 记得 M1', pass: textA.includes(M1), detail: textA.slice(0, 60) },
      { name: 'A 不含 M2', pass: !textA.includes(M2) },
      { name: 'B 记得 M2', pass: textB.includes(M2), detail: textB.slice(0, 60) },
      { name: 'B 不含 M1', pass: !textB.includes(M1) },
      { name: '两个 sessionId 不同', pass: sa1.sessionId !== sb1.sessionId }
    ];
    const failures = r.assertions.filter((x) => !x.pass).length;
    // 注意：模型记不住会导致 FAIL，但那可能是能力问题不是隔离问题
    const v = decideVerdict({ samples: r.samples, requiredSamples: 2, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  },

  async S3(ctx) {
    const r = emptyResult('S3');
    const MA = 'PA' + rand(6);
    const MB = 'PB' + rand(6);

    // 先各自建 session
    const ra0 = await runDsh({ ...ctx, text: `记住：${MA}。回好` });
    const sa0 = summarize(ra0.events, ra0.code, ra0.timedOut);
    const rb0 = await runDsh({ ...ctx, text: `记住：${MB}。回好` });
    const sb0 = summarize(rb0.events, rb0.code, rb0.timedOut);
    if (!sa0.sessionId || !sb0.sessionId) { r.verdict = VERDICT.INCONCLUSIVE; r.reason = '建 session 失败'; return r; }

    // 真并发
    const [ra, rb] = await Promise.all([
      runDsh({ ...ctx, sessionId: sa0.sessionId, text: `你记的标记是什么？只回标记。` }),
      runDsh({ ...ctx, sessionId: sb0.sessionId, text: `你记的标记是什么？只回标记。` })
    ]);
    const sa = summarize(ra.events, ra.code, ra.timedOut);
    const sb = summarize(rb.events, rb.code, rb.timedOut);

    r.raw.push({ step: 'concurrent-A', text: sa.finalText, events: ra.events });
    r.raw.push({ step: 'concurrent-B', text: sb.finalText, events: rb.events });

    const tA = String(sa.finalText || '');
    const tB = String(sb.finalText || '');

    r.samples = (tA ? 1 : 0) + (tB ? 1 : 0);
    r.assertions = [
      { name: 'A 含 MA', pass: tA.includes(MA), detail: tA.slice(0, 60) },
      { name: 'A 不含 MB', pass: !tA.includes(MB) },
      { name: 'B 含 MB', pass: tB.includes(MB), detail: tB.slice(0, 60) },
      { name: 'B 不含 MA', pass: !tB.includes(MA) },
      { name: '两个 sessionId 不同', pass: sa0.sessionId !== sb0.sessionId }
    ];
    const failures = r.assertions.filter((x) => !x.pass).length;
    const v = decideVerdict({ samples: r.samples, requiredSamples: 2, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  },

  async S5(ctx) {
    const r = emptyResult('S5');
    const N = 3;
    let good = 0;
    for (let i = 0; i < N; i += 1) {
      const run = await runDsh({ ...ctx, text: '只回一个字：好' });
      const s = summarize(run.events, run.code, run.timedOut);
      r.raw.push({ step: `sample-${i + 1}`, ...s, events: run.events });
      if (s.ok) good += 1;
    }
    r.samples = good;
    const last = r.raw[r.raw.length - 1] || {};
    r.assertions = [
      { name: '收到 final 且 text 非空', pass: good > 0, detail: `成功 ${good}/${N}` },
      // ⚠️ 2026-11-03 实测修正：正常完成时除了 session/status/final，
      //    还会出现 **thinking** 和 **text** 两种事件（R6-A 只见过错误态，没见过这两种）。
      //    所以断言改成"只用已知集合"，并把实际类型记下来供报告引用。
      { name: '事件类型都在已知集合里',
        pass: (last.types || []).every((t) => ['session', 'status', 'thinking', 'text', 'final', 'error'].includes(t)),
        detail: JSON.stringify(last.types) },
      { name: '**记录了实际出现的事件类型**', pass: true, detail: JSON.stringify(last.types) },
      { name: '没有 type:error', pass: !(last.types || []).includes('error') }
    ];
    const failures = r.assertions.filter((x) => !x.pass).length;
    const v = decideVerdict({ samples: good, requiredSamples: 1, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  },

  async S6(ctx) {
    const r = emptyResult('S6');
    const N = 3;
    let withUsage = 0;
    let total = 0;
    for (let i = 0; i < N; i += 1) {
      const run = await runDsh({ ...ctx, text: '只回一个字：好' });
      const s = summarize(run.events, run.code, run.timedOut);
      r.raw.push({ step: `sample-${i + 1}`, usage: s.usage, turnEnd: s.turnEnd, events: run.events });
      if (s.ok) {
        total += 1;
        if (s.usage) withUsage += 1;
      }
    }
    r.samples = total;
    r.assertions = [
      { name: `拿到 ${N} 次有效样本`, pass: total >= N, detail: `${total}/${N}` }
    ];
    // 结论：要么明确有 usage，要么明确没有
    r.notes = withUsage > 0
      ? `**有 usage**：${withUsage}/${total} 次`
      : `**没有 usage**：${total} 次正常完成都没看到`;
    r.assertions.push({ name: 'usage 结论明确', pass: total >= N });
    const failures = r.assertions.filter((x) => !x.pass).length;
    const v = decideVerdict({ samples: total, requiredSamples: N, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  },

  async S7(ctx, opts = {}) {
    const r = emptyResult('S7');
    const N = Number(opts.samples) || 10;
    const lat = [];
    let okCount = 0; let failCount = 0; let timeoutCount = 0;

    for (let i = 0; i < N; i += 1) {
      const run = await runDsh({ ...ctx, text: '只回一个字：好', timeoutMs: 60000 });
      const s = summarize(run.events, run.code, run.timedOut);
      if (s.timedOut) timeoutCount += 1;
      else if (!s.ok) failCount += 1;
      else { okCount += 1; lat.push(run.ms); }
      r.raw.push({ step: `sample-${i + 1}`, ms: run.ms, ok: s.ok, timedOut: s.timedOut });
    }

    const p = percentile95(lat);
    r.samples = okCount;
    r.failures = failCount;
    r.timeouts = timeoutCount;
    r.notes = p ? `P50=${p.p50}ms  P95=${p.p95}ms  样本=${p.n}  失败=${failCount}  超时=${timeoutCount}` : '没有有效样本';
    r.assertions = [
      { name: `样本数 >= ${N}`, pass: okCount >= N, detail: `${okCount}/${N}` },
      { name: '能算出 P95', pass: Boolean(p) }
    ];
    const failures = r.assertions.filter((x) => !x.pass).length;
    const v = decideVerdict({ samples: okCount, requiredSamples: N, allAssertionsPassed: failures === 0, failures });
    r.verdict = v.verdict; r.reason = v.reason;
    return r;
  }
};

// ── main ────────────────────────────────────────────────────────
async function main() {
  console.log('=== R6-C 实验 runner ===');
  console.log('');

  // ① 环境
  const exp = createExperiment({ tag: 'r6c' });
  const v = validateExperiment(exp.dirs);
  console.log('实验环境:', describe(exp.dirs));
  console.log('环境校验:', v.ok ? '✓' : `✗ ${v.error}`);
  if (!v.ok) process.exit(1);

  // ①b 把实验环境写进当前进程（**必须在凭据检查之前**）
  //     这样 assertNoProductionCredential 才有东西可校验
  process.env.DSH_HOME = exp.dirs.dshHome;
  process.env.TEMP = exp.dirs.tmp;
  process.env.TMP = exp.dirs.tmp;

  // ② 凭据
  const chk = checkCredential(exp.dirs);
  console.log('凭据:', describeCredential(chk));
  if (!chk.ok) {
    console.log('');
    console.log('❌ 没有实验凭据，无法跑真实请求。');
    console.log(chk.error);
    console.log('');
    console.log(`（实验目录已建：${exp.dirs.root}）`);
    process.exit(2);
  }

  const ng = assertNoProductionCredential(exp.dirs);
  if (!ng.ok) { console.log('✗', ng.error); process.exit(3); }

  if (has('--check')) {
    console.log('');
    console.log('✓ 环境与凭据检查通过（本次未发任何请求）');
    process.exit(0);
  }

  // ③ 生产快照（前后对比）
  const prod = productionPaths();
  const prodBefore = snapshot(prod.dataDir);

  // ④ 跑场景
  const ctx = { cwd: exp.dirs.cwd, dshHome: exp.dirs.dshHome };
  const want = has('--all') ? ['S1', 'S2', 'S3', 'S5', 'S6', 'S7'] : [val('--scene', 'S1')];
  const samples = val('--samples', '10');

  const results = [];
  for (const id of want) {
    const fn = SCENES[id];
    if (!fn) { console.log(`(跳过 ${id}：未实现)`); continue; }
    console.log('');
    console.log(`--- 跑 ${id} ---`);
    const r = await fn(ctx, { samples });
    results.push(r);
    console.log(`  ${r.verdict}  ${r.reason}`);

    // 每跑完一个就写盘（中断也不丢）
    const f = path.join(exp.dirs.results, `${id}.json`);
    fs.writeFileSync(f, JSON.stringify(r, null, 1), 'utf8');
  }

  // ⑤ 汇总
  const summary = {
    ranAt: new Date().toISOString(),
    experiment: exp.dirs.root,
    credential: { source: chk.source, masked: chk.masked },
    results: results.map((r) => ({ scenario: r.scenario, verdict: r.verdict, reason: r.reason, samples: r.samples }))
  };
  fs.writeFileSync(path.join(exp.dirs.results, 'summary.json'), JSON.stringify(summary, null, 1), 'utf8');

  // ⑥ 生产未变的证据
  const prodAfter = snapshot(prod.dataDir);
  console.log('');
  console.log('=== 生产 data 前后 ===');
  console.log(`  文件数: ${prodBefore.count} → ${prodAfter.count}`);
  console.log(`  hash:   ${prodBefore.hash} → ${prodAfter.hash}`);
  console.log(prodBefore.hash === prodAfter.hash ? '  ✓ 完全一致' : '  ⚠️ 有变化（可能是正常活动）');

  console.log('');
  console.log('=== 汇总 ===');
  for (const r of summary.results) console.log(`  ${r.scenario}: ${r.verdict}  ${r.reason}`);

  console.log('');
  console.log(`结果目录: ${exp.dirs.results}`);

  // 泄露自检
  const all = JSON.stringify(summary) + results.map((r) => JSON.stringify(r)).join('');
  const leak = scanForLeaks(all);
  console.log(leak.clean ? '✓ 结果里没有泄露疑似 Key' : `⚠️ 发现疑似 Key：${leak.hits.join(', ')}`);
}

main().catch((e) => {
  console.error('运行失败:', e?.message || e);
  process.exit(1);
});
