// 阶段 2.6-B3 专项测试：自主 Goal 证据校验。
//
// 机主授权（2026-11-02）：
//   · 设计跨 Round 证据结构
//   · 校验引用的 Round 是否真实存在
//   · **禁止同一 Round 多个 Action 冒充跨 Round 证据**
//   · 禁止仅凭 Action 失败或一次活动创建 Goal
//   · 明确 evidence 缺失 / 无效 / 容量不足的返回结果
//   · **不接入 autonomous**（留到 B5）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const CS = path.join(tmp, 'companion-state.json');
const AUTO = path.join(tmp, 'autonomous.json');
const readCs = () => { try { return JSON.parse(fs.readFileSync(CS, 'utf8')); } catch { return { goals: [], pending: [] }; } };
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };
const writeAuto = (history) => fs.writeFileSync(AUTO, JSON.stringify({ version: 2, history, status: 'IDLE' }), 'utf8');

/**
 * 建一条 autonomous Goal（自动造证据）。
 *
 * **不覆盖已有的 Round 历史** —— 有些测试会先 writeAuto 自己的夹具，
 * 这里如果无脑覆盖，那些夹具就没了。
 */
function mkAutoGoal(text) {
  let history = [];
  try { history = JSON.parse(fs.readFileSync(AUTO, "utf8")).history || []; } catch { /* 没有就用空 */ }
  if (!history.some((r) => r.roundId === "r-fixture-1")) {
    history.push({ roundId: "r-fixture-1", startedAt: 1, actions: [] });
  }
  if (!history.some((r) => r.roundId === "r-fixture-2")) {
    history.push({ roundId: "r-fixture-2", startedAt: 2, actions: [] });
  }
  writeAuto(history);
  return cs.createAutonomousGoal({ text, evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' } });
}

try {
  console.log('【① 证据缺失 → 拒绝】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({ text: '想长期关注 AI 进展' });
    ok('返回失败', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('**code 是 EVIDENCE_REQUIRED**', r.code === 'EVIDENCE_REQUIRED', r.code);
    ok('没有创建 Goal', readCs().goals.length === 0);
  }

  console.log('\n【② 证据类型不合法 → 拒绝】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'bogus', roundIds: ['r1', 'r2'], reason: 'y' }
    });
    ok('code 是 EVIDENCE_INVALID_TYPE', r.code === 'EVIDENCE_INVALID_TYPE', r.code);
  }

  console.log('\n【③ 没有引用任何 Round → 拒绝】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: [], reason: 'y' }
    });
    ok('code 是 EVIDENCE_NO_ROUNDS', r.code === 'EVIDENCE_NO_ROUNDS', r.code);
  }

  console.log('\n【④ **同一个 Round 写两遍 → 拒绝**（防冒充跨轮）】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-a'], reason: 'y' },
      knownRounds: new Set(['round-a'])
    });
    ok('返回失败', r.ok === false);
    ok('**code 是 EVIDENCE_SINGLE_ROUND**', r.code === 'EVIDENCE_SINGLE_ROUND', r.code);
  }

  console.log('\n【⑤ 只有一个 Round → 拒绝】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a'], reason: 'y' },
      knownRounds: new Set(['round-a'])
    });
    ok('code 是 EVIDENCE_SINGLE_ROUND', r.code === 'EVIDENCE_SINGLE_ROUND', r.code);
  }

  console.log('\n【⑥ 引用了不存在的 Round → 拒绝】');
  {
    resetCs();
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-不存在'], reason: 'y' },
      knownRounds: new Set(['round-a'])
    });
    ok('返回失败', r.ok === false);
    ok('**code 是 EVIDENCE_ROUND_NOT_FOUND**', r.code === 'EVIDENCE_ROUND_NOT_FOUND', r.code);
    ok('错误信息里点名了不存在的那个', /round-不存在/.test(r.error || ''), r.error);
  }

  console.log('\n【⑦ 没有 reason → 拒绝】');
  {
    resetCs();
    writeAuto([
      { roundId: 'round-a', startedAt: 1, actions: [] },
      { roundId: 'round-b', startedAt: 2, actions: [] }
    ]);
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-b'], reason: '' }
    });
    ok('code 是 EVIDENCE_NO_REASON', r.code === 'EVIDENCE_NO_REASON', r.code);
  }

  console.log('\n【⑧ 证据齐全 → 创建成功】');
  {
    resetCs();
    writeAuto([
      { roundId: 'round-a', startedAt: 1, actions: [] },
      { roundId: 'round-b', startedAt: 2, actions: [] }
    ]);
    const r = cs.createAutonomousGoal({
      text: '持续关注老大的 AI 伙伴项目',
      evidence: {
        type: 'cross_round_continuity',
        roundIds: ['round-a', 'round-b'],
        reason: '多个独立活动持续围绕同一个长期项目'
      }
    });
    ok('创建成功', r.ok === true, JSON.stringify(r).slice(0, 150));
    ok('created: true', r.created === true);
    const g = readCs().goals[0];
    ok('source 是 autonomous', g.source === 'autonomous');
    ok('状态 active', g.status === 'active');
    ok('**evidence 去重后的 roundIds 保存了**', JSON.stringify(r.evidence.roundIds) === JSON.stringify(['round-a', 'round-b']), JSON.stringify(r.evidence?.roundIds));
  }

  console.log('\n【⑨ 从真实的 autonomous.json 读 Round（不注入 knownRounds）】');
  {
    resetCs();
    writeAuto([
      { roundId: 'round-real-1', startedAt: 1, actions: [] },
      { roundId: 'round-real-2', startedAt: 2, actions: [] },
      { roundId: 'round-real-3', startedAt: 3, actions: [] }
    ]);
    const r = cs.createAutonomousGoal({
      text: '长期跟进某件事',
      evidence: {
        type: 'cross_round_continuity',
        roundIds: ['round-real-1', 'round-real-3'],
        reason: '两轮都出现了'
      }
    });
    ok('成功（说明真的去读 autonomous.json 了）', r.ok === true, JSON.stringify(r).slice(0, 150));

    // 不存在的
    const r2 = cs.createAutonomousGoal({
      text: '另一个方向',
      evidence: {
        type: 'cross_round_continuity',
        roundIds: ['round-real-1', 'round-fake'],
        reason: 'x'
      }
    });
    ok('**引用不存在的 Round 被拒**', r2.code === 'EVIDENCE_ROUND_NOT_FOUND', r2.code);
  }

  console.log('\n【⑩ autonomous.json 读不到 → 拒绝（宁可拒绝）】');
  {
    resetCs();
    try { fs.rmSync(AUTO, { force: true }); } catch { /* ignore */ }
    const r = cs.createAutonomousGoal({
      text: 'x',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-b'], reason: 'y' }
    });
    ok('**读不到 Round 就拒绝**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('code 是 EVIDENCE_ROUND_NOT_FOUND', r.code === 'EVIDENCE_ROUND_NOT_FOUND', r.code);
  }

  console.log('\n【⑪ 容量满 → 返回 CAPACITY_FULL（不是证据错误）】');
  {
    resetCs();
    writeAuto([
      { roundId: 'round-a', startedAt: 1, actions: [] },
      { roundId: 'round-b', startedAt: 2, actions: [] }
    ]);
    // 填满容量：1 active + 3 paused
    for (let i = 0; i < 4; i += 1) mkAutoGoal('占位 ' + i);
    for (let i = 0; i < 3; i += 1) cs.pauseGoal(readCs().goals.find((g) => g.status === 'active').id);

    const r = cs.createAutonomousGoal({
      text: '想新建的长期方向',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-b'], reason: 'y' }
    });
    ok('返回失败', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('**code 是 CAPACITY_FULL**（证据是好的，只是没容量）', r.code === 'CAPACITY_FULL', r.code);
    ok('有 capacity 明细', Boolean(r.capacity), JSON.stringify(r.capacity));
  }

  console.log('\n【⑫ 和 createGoal 一样受权限/去重约束】');
  {
    resetCs();
    writeAuto([
      { roundId: 'round-a', startedAt: 1, actions: [] },
      { roundId: 'round-b', startedAt: 2, actions: [] }
    ]);
    mkAutoGoal('已有的方向');
    const r = cs.createAutonomousGoal({
      text: '已有的方向',
      evidence: { type: 'cross_round_continuity', roundIds: ['round-a', 'round-b'], reason: 'y' }
    });
    ok('created: false（复用已有）', r.created === false, String(r.created));
    ok('还是 1 条', readCs().goals.length === 1);
  }

  console.log('\n【⑬ B3 没接入 autonomous（生产调用点只有 setGoal）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    // 4.0 / 2.6-B5b 之后会引用（在 judgeGoalCandidate 里）。
    // 关键约束：**不传 knownRounds**（否则等于自己给自己发证据）。
    const i = src.indexOf('async function judgeGoalCandidate');
    ok('judgeGoalCandidate 存在', i >= 0);
    if (i >= 0) {
      const seg = src.slice(i, i + 3000);
      ok('**调 createAutonomousGoal 时不传 knownRounds**', !seg.split('\n').filter((l) => /createAutonomousGoal\(\{/.test(l)).some((l) => /knownRounds/.test(l)));
    }
    ok('没有直接引用 validateGoalEvidence（那个在 createAutonomousGoal 内部）', !src.includes('validateGoalEvidence'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
