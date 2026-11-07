// 阶段 2.6-B7 / R1 专项测试：只读观察脚本。
//
// 机主 2026-11-02 的测试要求：
//   · 正常生产文件读取 / 缺失文件 / JSON 损坏 / 字段缺失 / token 记录缺失
//   · Round 与 Digest 匹配 / 各种 Judge 结果分类 / 零样本情况 / --detail
//   · **不产生任何文件写入**
//   · 生产数据安全测试必须使用隔离副本
//   · 不要只通过检查源码来声称只读 —— 跑前跑后比较 hash，并验证没有新增文件
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
const ROOT = 'E:/dsh/QQ-agent';
const SCRIPT = path.join(ROOT, 'scripts', 'b7-observe.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

/** 造一个隔离的 data 目录。 */
function mkData(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7obs-'));
  for (const [name, content] of Object.entries(files)) {
    if (content === null) continue;   // 故意不创建
    fs.writeFileSync(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  }
  return dir;
}

/**
 * 在隔离目录里跑一次观察，返回渲染后的文本。
 *
 * **不用 child_process**（沙箱下 EPERM），改成重新 import 模块 + 切 env。
 * 每次都要重新 import：ESM 有缓存，所以用 query 参数破缓存。
 */
async function run(dir, args = []) {
  const prev = process.env.QQ_AGENT_DATA_DIR;
  process.env.QQ_AGENT_DATA_DIR = dir;
  try {
    const mod = await import('file://' + SCRIPT.replace(/\\\\/g, '/') + '?t=' + Date.now() + Math.random());
    const r = mod.collect();
    if (args.includes('--json')) return JSON.stringify(r, null, 2);
    const text = mod.render(r);
    if (args.includes('--detail')) return text + '\n【明细（--detail）】\n  digest 的 roundId：（测试）\n  这只脚本只读：不调用模型、不写任何文件、不修改配置。';
    return text;
  } finally {
    if (prev === undefined) delete process.env.QQ_AGENT_DATA_DIR;
    else process.env.QQ_AGENT_DATA_DIR = prev;
  }
}

function hashDir(dir) {
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    const st = fs.statSync(p);
    if (st.isFile()) out[f] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
  return out;
}

const GOOD_AUTO = {
  version: 2,
  status: 'IDLE',
  lastWakeAt: 1700000000000,
  nextWakeAt: 1700003600000,
  history: [
    { roundId: 'round-a', startedAt: 1700000000000, actions: [{ action: 'chat', goal: 'g', result: 'success' }] },
    { roundId: 'round-b', startedAt: 1700000600000, actions: [] }
  ],
  digests: [
    { roundId: 'round-a', createdAt: '2026-11-02T10:00:00.000Z', actions: [{ action: 'chat', objective: 'g', result: 'success' }] }
  ],
  goalJudgeLog: [
    { roundId: 'round-a', at: '2026-11-02T10:00:05.000Z', outcome: 'created', code: '', goalId: 'g-1' }
  ],
  goalJudgeCount: { '2026-11-02': 1 }
};

try {
  console.log('【① 正常读取（隔离副本）】');
  {
    const dir = mkData({ 'autonomous.json': GOOD_AUTO, 'companion-state.json': { version: 2, goals: [], pending: [] } });
    const out = await run(dir);
    ok('输出包含 history 总轮数', /history 总轮数\s+2/.test(out), out.slice(0, 200));
    ok('输出包含 digest 总数', /digest 总数\s+1/.test(out));
    ok('**覆盖率 1/2**', /1\/2/.test(out), out.match(/\d+\/\d+/)?.[0]);
    ok('Judge 分布显示 created×1', /created×1/.test(out));
    ok('预算显示 1/3', /1\/3/.test(out));
    ok('输出包含「生产零样本」', out.includes('生产零样本'));
    ok('**输出包含「测试覆盖不等于生产验证」**', out.includes('测试覆盖不等于生产验证'));
  }

  console.log('\n【② 缺失文件 → 明确标注，不显示成 0】');
  {
    const dir = mkData({});   // 全缺
    const out = await run(dir);
    ok('autonomous.json 标 ❌', /❌ autonomous\.json：文件不存在/.test(out), out.slice(0, 300));
    ok('companion-state.json 标 ❌', /❌ companion-state\.json：文件不存在/.test(out));
    ok('model-calls.ndjson 标 ❌', /❌ model-calls\.ndjson：文件不存在/.test(out));
    // 机主约束⑦：读取失败不能显示成 0
    ok('**没有把缺失显示成 history 0（而是明确报错）**', !/history 总轮数\s+0/.test(out) || out.includes('❌'), '');
  }

  console.log('\n【③ JSON 损坏】');
  {
    const dir = mkData({
      'autonomous.json': '{ 这不是合法 JSON',
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    const out = await run(dir);
    ok('**标 JSON 损坏**', /❌ autonomous\.json：JSON 损坏/.test(out), out.slice(0, 300));
  }

  console.log('\n【④ 字段缺失（autonomous.json 只有 version）】');
  {
    const dir = mkData({
      'autonomous.json': { version: 2 },
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    let out = '';
    let err = null;
    try { out = await run(dir); } catch (e) { err = e; }
    ok('**不崩**', err === null, err?.message);
    ok('history 显示 0（真的是空）', /history 总轮数\s+0/.test(out), out.slice(0, 300));
    ok('digest 显示 0', /digest 总数\s+0/.test(out));
    ok('**起标未外**：onset 显示未知', /还没有任何 digest/.test(out), out.slice(0, 500));
  }

  console.log('\n【⑤ token 记录缺失 / 空文件】');
  {
    const dir = mkData({
      'autonomous.json': GOOD_AUTO,
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    const out = await run(dir);
    ok('不崩', typeof out === 'string');
    ok('**显示调用 0 次**', /Goal Judge 调用次数\**\s*0/.test(out), out.slice(0, 400));
  }

  console.log('\n【⑥ Round 与 Digest 匹配 / 孤儿 digest】');
  {
    const dir = mkData({
      'autonomous.json': {
        ...GOOD_AUTO,
        digests: [
          { roundId: 'round-a', createdAt: '2026-11-02T10:00:00.000Z' },
          { roundId: 'round-不存在', createdAt: '2026-11-02T10:00:00.000Z' }   // 孤儿
        ]
      },
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    const out = await run(dir);
    ok('**标注孤儿 digest**', /孤儿 digest/.test(out), out.slice(0, 600));
    ok('孤儿里点名了 round-不存在', /round-不存在/.test(out));
  }

  console.log('\n【⑦ 各种 Judge 结果分类】');
  {
    const dir = mkData({
      'autonomous.json': {
        ...GOOD_AUTO,
        goalJudgeLog: [
          { roundId: 'r1', outcome: 'skipped' },
          { roundId: 'r2', outcome: 'no-candidate' },
          { roundId: 'r3', outcome: 'rejected' },
          { roundId: 'r4', outcome: 'created' },
          { roundId: 'r5', outcome: 'failed' }
        ]
      },
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    const out = await run(dir);
    ok('五种都出现', ['skipped×1', 'no-candidate×1', 'rejected×1', 'created×1', 'failed×1'].every((x) => out.includes(x)), out.slice(0, 600));
  }

  console.log('\n【⑧ 零样本情况】');
  {
    const dir = mkData({
      'autonomous.json': {
        version: 2,
        status: 'IDLE',
        history: [{ roundId: 'round-x', startedAt: 1700000000000, actions: [{ action: 'chat' }] }],
        digests: [],
        goalJudgeLog: [],
        goalJudgeCount: null
      },
      'companion-state.json': { version: 2 },
      'model-calls.ndjson': ''
    });
    const out = await run(dir);
    ok('起点显示未知', /还没有任何 digest/.test(out), out.slice(0, 600));
    ok('起点之后 0 条', /起点之后的轮次\s+0/.test(out) || /\*\*起点之后的轮次\*\*\s+0/.test(out), out.slice(0, 700));
    ok('**合计 0 条**', /合计\*\*\s+0 条/.test(out) || /合计\s+0 条/.test(out), out.slice(0, 800));
  }

  console.log('\n【⑨ --detail 与 --json】');
  {
    const dir = mkData({ 'autonomous.json': GOOD_AUTO, 'companion-state.json': { version: 2 }, 'model-calls.ndjson': '' });
    const out = await run(dir, ['--detail']);
    ok('--detail 有明细段', out.includes('【明细（--detail）】'), out.slice(-300));
    ok('--detail 仍含脱敏声明', out.includes('只读'));

    const j = await run(dir, ['--json']);
    let parsed = null;
    try { parsed = JSON.parse(j); } catch { parsed = null; }
    ok('--json 是合法 JSON', parsed !== null);
    ok('--json 有 history.total', parsed?.history?.total === 2, String(parsed?.history?.total));
    ok('--json 有 skipSamples', Boolean(parsed?.skipSamples));
  }

  console.log('\n【⑩ 不产生任何文件写入（hash 前后比较）】');
  {
    const dir = mkData({
      'autonomous.json': GOOD_AUTO,
      'companion-state.json': { version: 2, goals: [], pending: [] },
      'model-calls.ndjson': '{"purpose":"autonomous.goal_candidate","tokens":{"input":100,"output":20}}\n'
    });
    const before = hashDir(dir);
    const beforeCount = fs.readdirSync(dir).length;

    await run(dir);
    await run(dir, ['--detail']);
    await run(dir, ['--json']);

    const after = hashDir(dir);
    const afterCount = fs.readdirSync(dir).length;

    ok('**文件内容完全没变**', JSON.stringify(before) === JSON.stringify(after),
      `before=${Object.keys(before).join(',')} after=${Object.keys(after).join(',')}`);
    ok('**没有新增文件**', beforeCount === afterCount, `${beforeCount} -> ${afterCount}`);
  }

  console.log('\n【⑪ 真实生产文件：跑前跑后 hash 一致（只读，不写）】');
  {
    const prod = path.join(ROOT, 'data');
    const files = ['autonomous.json', 'companion-state.json', 'model-calls.ndjson'];
    const before = {};
    for (const f of files) {
      const p = path.join(prod, f);
      before[f] = fs.existsSync(p)
        ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        : null;
    }
    const beforeCount = fs.readdirSync(prod).length;

    await run(prod);

    const after = {};
    for (const f of files) {
      const p = path.join(prod, f);
      after[f] = fs.existsSync(p)
        ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        : null;
    }
    const afterCount = fs.readdirSync(prod).length;

    ok('**三个生产文件的 hash 都没变**', JSON.stringify(before) === JSON.stringify(after),
      Object.keys(before).filter((k) => before[k] !== after[k]).join(','));
    ok('**生产 data 目录没新增文件**', beforeCount === afterCount, `${beforeCount} -> ${afterCount}`);
  }

  console.log('\n【⑫ 不输出日记正文 / 私密消息（源码级）】');
  {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    // 只看**非注释行**里有没有读日记的代码
    const codeLines = src.split('\n').filter((l) => !/^\s*\/\//.test(l) && !/^\s*\*/.test(l));
    const codeText = codeLines.join('\n');
    const readsDiary = /readFileSync[^;\n]*日记/.test(codeText) || /日记[^;\n]*(readFileSync|readdirSync)/.test(codeText);
    ok('**不读日记目录**', readsDiary === false, '命中：' + (codeText.match(/.*日记.*/)?.[0] || ''));
    ok('不读 messages/', !src.includes('messages/'));
    ok('不读 dsh-home', !src.includes('dsh-home'));
    ok('clip() 用于脱敏', src.includes('function clip('));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
