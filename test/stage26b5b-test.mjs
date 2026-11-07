// 阶段 2.6-B5b 专项测试：自主 Goal 候选判断。
//
// 机主授权（2026-11-02）：
//   · 窗口 5 条 digest，少于 2 条跳过
//   · 每轮最多判断一次，roundId 幂等
//   · 只通过 createAutonomousGoal 创建，**不传 knownRounds**
//   · 每日最多 3 次（独立于 maxModelCalls）
//   · 模型失败不重试
//   · 判断结果不进 history
//
// 注意：本测试**不联真实模型**（judgeGoalCandidate 的 call 可注入），
// 也不调 createAutonomousGoal（只测纯逻辑层）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b5b-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const gj = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'goal-judge.js')).href);

/** 造 digest。 */
function mkDigest(roundId, over = {}) {
  return {
    roundId,
    createdAt: new Date(Date.now() - 3600e3).toISOString(),
    status: 'IDLE',
    intent: { intent: 'explore', goal: '翻榜单', why: '闲' },
    actions: [{ action: 'chat', objective: '问老大回来没', result: 'success' }],
    stopReason: '完成',
    ...over
  };
}

/** 造一份真实的 autonomous.json（history 里的 roundId 才可信）。 */
function seedHistory(ids) {
  fs.writeFileSync(path.join(tmp, 'autonomous.json'), JSON.stringify({
    version: 2, status: 'IDLE',
    history: ids.map((id, i) => ({ roundId: id, startedAt: i + 1, actions: [] }))
  }), 'utf8');
}

try {
  console.log('【① shouldJudge：各种跳过】');
  {
    seedHistory(['r1', 'r2']);
    const rec = { roundId: 'r3', error: '' };

    ok('**digest < 2 跳过**', gj.shouldJudge({ rec, digests: [mkDigest('r1')] }).code === 'NOT_ENOUGH_ROUNDS');
    ok('digest 0 条跳过', gj.shouldJudge({ rec, digests: [] }).code === 'NOT_ENOUGH_ROUNDS');
    ok('2 条 digest 放行', gj.shouldJudge({ rec, digests: [mkDigest('r1'), mkDigest('r2')] }).ok === true);

    ok('**rec.error 非空跳过**', gj.shouldJudge({ rec: { roundId: 'r3', error: 'boom' }, digests: [mkDigest('r1'), mkDigest('r2')] }).code === 'ROUND_ERROR');
    ok('没有 roundId 跳过', gj.shouldJudge({ rec: { roundId: '' }, digests: [mkDigest('r1'), mkDigest('r2')] }).code === 'NO_ROUND_ID');

    ok('**已判断过跳过（幂等）**', gj.shouldJudge({
      rec, digests: [mkDigest('r1'), mkDigest('r2')], log: [{ roundId: 'r3' }]
    }).code === 'ALREADY_JUDGED');

    ok('**每日预算用完跳过**', gj.shouldJudge({
      rec, digests: [mkDigest('r1'), mkDigest('r2')], count: { [gj.dayKeyOf()]: 3 }
    }).code === 'BUDGET_EXCEEDED');

    ok('今天用了 2 次仍放行', gj.shouldJudge({
      rec, digests: [mkDigest('r1'), mkDigest('r2')], count: { [gj.dayKeyOf()]: 2 }
    }).ok === true);

    ok('昨天的计数不算今天', gj.shouldJudge({
      rec, digests: [mkDigest('r1'), mkDigest('r2')], count: { '2000-01-01': 99 }
    }).ok === true);
  }

  console.log('\n【② shouldJudge：history 读不到 → 跳过】');
  {
    try { fs.rmSync(path.join(tmp, 'autonomous.json'), { force: true }); } catch { /* ignore */ }
    const r = gj.shouldJudge({ rec: { roundId: 'r3' }, digests: [mkDigest('r1'), mkDigest('r2')] });
    ok('**跳过（证据来源不可信）**', r.ok === false && r.code === 'HISTORY_UNREADABLE', r.code);
  }

  console.log('\n【③ buildJudgeInput：窗口与裁剪】');
  {
    const ds = Array.from({ length: 8 }, (_, i) => mkDigest('r' + i));
    const built = gj.buildJudgeInput(ds, 5);
    ok('**只取最近 5 条**', built.list.length === 5, String(built.list.length));
    ok('留下的是最近的', built.list[built.list.length - 1].roundId === 'r7');
    ok('有一条 system 消息', built.messages[0].role === 'system');
    ok('有一条 user 消息', built.messages[1].role === 'user');
    ok('user 里是 JSON', built.messages[1].content.includes('"rounds"'));
    ok('actions 里是 objective 不是 goal', built.list[0].actions[0].objective === '问老大回来没');
  }

  console.log('\n【④ parseJudgement：容错】');
  {
    ok('纯 JSON', gj.parseJudgement('{"candidate":false}').ok === true);
    ok('```json 包裹', gj.parseJudgement('```json\n{"candidate":false}\n```').ok === true);
    ok('前后有废话', gj.parseJudgement('我觉得：{"candidate":false} 就这样').ok === true);
    ok('空串失败', gj.parseJudgement('').code === 'BAD_FORMAT');
    ok('非法 JSON 失败', gj.parseJudgement('not json at all').code === 'BAD_FORMAT');
    ok('数组失败', gj.parseJudgement('[1,2,3]').code === 'BAD_FORMAT');
  }

  console.log('\n【⑤ looksLikeObjective：复述检测（弱过滤器）】');
  {
    const objs = ['问老大回来没', '把白嫖资源告诉老大'];
    ok('**完全相同** → 拦', gj.looksLikeObjective('问老大回来没', objs) === true);
    ok('**加了标点** → 拦', gj.looksLikeObjective('问老大，回来没？', objs) === true);
    ok('**明显包含** → 拦', gj.looksLikeObjective('我想问老大回来没这件事', objs) === true);
    ok('**两个拼接** → 拦', gj.looksLikeObjective('问老大回来没把白嫖资源告诉老大', objs) === true);
    ok('完全不同的方向 → 放行', gj.looksLikeObjective('持续关注老大的 AI 伙伴项目进展', objs) === false);
    ok('空 text → 拦', gj.looksLikeObjective('', objs) === true);
  }

  console.log('\n【⑥ validateJudgement：无候选】');
  {
    const r = gj.validateJudgement({ candidate: false }, {});
    ok('**candidate: false 通过**', r.ok === true && r.noCandidate === true);
  }

  console.log('\n【⑦ validateJudgement：八项校验】');
  {
    const ctx = {
      digestRoundIds: new Set(['r1', 'r2', 'r3']),
      historyRounds: new Set(['r1', 'r2', 'r3']),
      objectives: ['问老大回来没']
    };
    const good = {
      candidate: true,
      text: '持续关注老大的 AI 伙伴项目',
      roundIds: ['r1', 'r2'],
      reason: '两轮都在推进同一个项目',
      evidenceSummary: [
        { roundId: 'r1', support: '分享了架构帖' },
        { roundId: 'r2', support: '继续翻同一个帖' }
      ]
    };
    ok('合法候选通过', gj.validateJudgement(good, ctx).ok === true);

    // ① 引用了本次没给过的
    const r1 = gj.validateJudgement({ ...good, roundIds: ['r1', 'r99'] }, ctx);
    ok('**ROUND_ID_FOREIGN**', r1.code === 'ROUND_ID_FOREIGN', r1.code);

    // ② 只有一个
    const r2 = gj.validateJudgement({ ...good, roundIds: ['r1'] }, ctx);
    ok('**TOO_FEW_ROUNDS**', r2.code === 'TOO_FEW_ROUNDS', r2.code);

    // ② 同一个写两遍
    const r3 = gj.validateJudgement({ ...good, roundIds: ['r1', 'r1'] }, ctx);
    ok('**同 roundId 写两遍 → TOO_FEW_ROUNDS**', r3.code === 'TOO_FEW_ROUNDS', r3.code);

    // ③ history 里没有
    const r4 = gj.validateJudgement({ ...good, roundIds: ['r1', 'r2'] }, {
      ...ctx, historyRounds: new Set(['r1'])   // r2 不在真实 history
    });
    ok('**ROUND_ID_MISSING**', r4.code === 'ROUND_ID_MISSING', r4.code);

    // ④ text 是复述
    const r5 = gj.validateJudgement({ ...good, text: '问老大回来没' }, ctx);
    ok('**TEXT_IS_OBJECTIVE**', r5.code === 'TEXT_IS_OBJECTIVE', r5.code);

    // ⑤ summary 引用不在 roundIds
    const r6 = gj.validateJudgement({
      ...good,
      evidenceSummary: [{ roundId: 'r3', support: 'x' }]
    }, ctx);
    ok('**SUMMARY_MISMATCH（引用了不在 roundIds 的）**', r6.code === 'SUMMARY_MISMATCH', r6.code);

    // ⑤ support 为空
    const r7 = gj.validateJudgement({
      ...good,
      evidenceSummary: [{ roundId: 'r1', support: '' }]
    }, ctx);
    ok('**SUMMARY_MISMATCH（support 空）**', r7.code === 'SUMMARY_MISMATCH', r7.code);

    // ⑧ 字段缺失
    ok('candidate 不是 boolean → BAD_FORMAT', gj.validateJudgement({ candidate: 'yes' }, ctx).code === 'BAD_FORMAT');
    ok('text 为空 → BAD_FORMAT', gj.validateJudgement({ ...good, text: '' }, ctx).code === 'BAD_FORMAT');
    ok('reason 为空 → BAD_FORMAT', gj.validateJudgement({ ...good, reason: '' }, ctx).code === 'BAD_FORMAT');
    ok('roundIds 不是数组 → BAD_FORMAT', gj.validateJudgement({ ...good, roundIds: 'r1' }, ctx).code === 'BAD_FORMAT');
    ok('evidenceSummary 不是数组 → SUMMARY_MISMATCH', gj.validateJudgement({ ...good, evidenceSummary: null }, ctx).code === 'SUMMARY_MISMATCH');
  }

  console.log('\n【⑧ validateJudgement：evidence 只带 type/roundIds/reason】');
  {
    const r = gj.validateJudgement({
      candidate: true,
      text: '持续关注老大的 AI 伙伴项目',
      roundIds: ['r1', 'r2'],
      reason: '两轮同一个项目',
      evidenceSummary: [{ roundId: 'r1', support: 'a' }, { roundId: 'r2', support: 'b' }]
    }, {
      digestRoundIds: new Set(['r1', 'r2']),
      historyRounds: new Set(['r1', 'r2']),
      objectives: []
    });
    ok('evidence.type 是 cross_round_continuity', r.evidence.type === 'cross_round_continuity');
    ok('evidence.roundIds 是去重后的', JSON.stringify(r.evidence.roundIds) === JSON.stringify(['r1', 'r2']));
    ok('**evidence 里没有 evidenceSummary**（那只是说明）', r.evidence.evidenceSummary === undefined);
  }

  console.log('\n【⑨ 预算计数：按本地时区的天】');
  {
    const now = Date.now();
    const dk = gj.dayKeyOf(now);
    ok('dayKey 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(dk), dk);

    let c = {};
    c = gj.bumpJudgeCount(c, dk, now);
    ok('第一次 = 1', c[dk] === 1);
    c = gj.bumpJudgeCount(c, dk, now);
    ok('第二次 = 2', c[dk] === 2);

    // 8 天前的计数会被清掉
    const old = gj.dayKeyOf(now - 8 * 86400e3);
    c[old] = 99;
    c = gj.bumpJudgeCount(c, dk, now);
    ok('**超过 7 天的计数被清掉**', c[old] === undefined, JSON.stringify(c));
  }

  console.log('\n【⑩ goalJudgeLog：追加与裁剪】');
  {
    let lg = [];
    for (let i = 0; i < 5; i += 1) {
      lg = gj.appendJudgeLog(lg, { roundId: 'r' + i, outcome: 'skipped', code: 'X' });
    }
    ok('5 条都在', lg.length === 5);

    // 同 roundId 覆盖
    lg = gj.appendJudgeLog(lg, { roundId: 'r0', outcome: 'created', goalId: 'g-1' });
    ok('**同 roundId 不重复，覆盖**', lg.length === 5 && lg.find((x) => x.roundId === 'r0').outcome === 'created');

    // 超过 7 天的清掉
    lg.push({ roundId: 'r-old', at: new Date(Date.now() - 10 * 86400e3).toISOString(), outcome: 'x' });
    lg = gj.appendJudgeLog(lg, { roundId: 'r-new', outcome: 'skipped' });
    ok('**7 天前的被清掉**', !lg.some((x) => x.roundId === 'r-old'));
  }

  console.log('\n【⑪ 源码级：不传 knownRounds、不调 createGoal】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const i = src.indexOf('async function judgeGoalCandidate');
    const seg = src.slice(i, i + 3000);
    ok('**调的是 createAutonomousGoal**', seg.includes('createAutonomousGoal({'));
    ok('**没传 knownRounds**', !/createAutonomousGoal\(\{[^}]*knownRounds/.test(seg));
    ok('**不调 createGoal**', !/createGoal\(/.test(seg));
    ok('**不调 setGoal**', !/setGoal\(/.test(seg));
    ok('purpose 是 autonomous.goal_candidate', src.includes("purpose: 'autonomous.goal_candidate'"));
  }

  console.log('\n【⑫ 接入点：finish 里 writeState 之后、不 await】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const iWrite = src.indexOf("try { writeState(STORE, st); } catch (e) { warn(`状态写入失败");
    const iJudge = src.indexOf('4.0 / 2.6-B5b：本轮已落盘');
    const iLog = src.indexOf('appendActivityLog(rec)', iWrite);
    ok('**在 writeState 之后**', iJudge > iWrite, `${iWrite} -> ${iJudge}`);
    ok('在 appendActivityLog 之前', iJudge < iLog, `${iJudge} < ${iLog}`);
    ok('**没有 await**（不阻塞本轮结束）', !/await judgeGoalCandidate/.test(src));
    ok('有 catch 兜底', src.slice(iJudge, iJudge + 900).includes('.catch('));
  }

  console.log('\n【⑬ 判断结果不进 history】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const i = src.indexOf('async function judgeGoalCandidate');
    const seg = src.slice(i, i + 3000);
    ok('**没有 pushHistory**', !seg.includes('pushHistory'));
    ok('**改的是 st.goalJudgeLog**', seg.includes('st.goalJudgeLog'));
    ok('**改的是 st.goalJudgeCount**', seg.includes('st.goalJudgeCount'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
