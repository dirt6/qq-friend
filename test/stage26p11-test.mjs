// 阶段 2.6-P1-1 专项测试：自主 Goal 创建入口收口。
//
// 机主授权（2026-11-02）：
//   · createAutonomousGoal 是唯一允许创建 autonomous Goal 的公开入口
//   · 普通 createGoal 不得创建 autonomous Goal；缺少合法来源时安全失败
//   · setGoal 不得间接绕过
//   · 不重复实现创建逻辑（去重 / 容量 / 来源升级 / 并发都不分叉）
//   · 不允许通过伪造 evidence 对象绕过（证据必须由可信 Round 历史验证）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p11-'));
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
const goals = () => readCs().goals || [];
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };
const seedRounds = (ids = ['r-fix-1', 'r-fix-2']) => {
  fs.writeFileSync(AUTO, JSON.stringify({
    version: 2, status: 'IDLE',
    history: ids.map((id, i) => ({ roundId: id, startedAt: i + 1, actions: [] }))
  }), 'utf8');
};
const EV = (ids = ['r-fix-1', 'r-fix-2']) => ({
  type: 'cross_round_continuity', roundIds: ids, reason: '测试夹具'
});

try {
  console.log('【① createGoal({ text }) 不再默认建 autonomous】');
  {
    resetCs();
    const r = cs.createGoal({ text: '默认来源测试' });
    ok('**被拒绝**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('code 是 EVIDENCE_REQUIRED', r.code === 'EVIDENCE_REQUIRED', r.code);
    ok('没有创建任何 Goal', goals().length === 0);
  }

  console.log('\n【② createGoal({ source: "autonomous" }) 被拒绝】');
  {
    resetCs();
    const r = cs.createGoal({ text: 'x', source: 'autonomous' });
    ok('**被拒绝**', r.ok === false);
    ok('code 是 EVIDENCE_REQUIRED', r.code === 'EVIDENCE_REQUIRED', r.code);
  }

  console.log('\n【③ setGoal 显式 autonomous 不能绕过】');
  {
    resetCs();
    const r = cs.setGoal('x', { source: 'autonomous' });
    ok('**被拒绝**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('code 是 EVIDENCE_REQUIRED', r.code === 'EVIDENCE_REQUIRED', r.code);
    ok('没有创建任何 Goal', goals().length === 0);
  }

  console.log('\n【④ createAutonomousGoal：合法成功，非法拒绝】');
  {
    resetCs();
    seedRounds();
    const r = cs.createAutonomousGoal({ text: '持续关注 AI 进展', evidence: EV() });
    ok('合法证据成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    ok('created: true', r.created === true);
    ok('source 是 autonomous', goals()[0].source === 'autonomous');

    // 非法：没证据
    const r2 = cs.createAutonomousGoal({ text: '另一个方向' });
    ok('没证据被拒', r2.code === 'EVIDENCE_REQUIRED', r2.code);

    // 非法：只有一轮
    const r3 = cs.createAutonomousGoal({ text: 'x', evidence: EV(['r-fix-1']) });
    ok('只有一轮被拒', r3.code === 'EVIDENCE_SINGLE_ROUND', r3.code);

    // 非法：不存在的 Round
    const r4 = cs.createAutonomousGoal({ text: 'y', evidence: EV(['r-fix-1', 'r-不存在']) });
    ok('不存在的 Round 被拒', r4.code === 'EVIDENCE_ROUND_NOT_FOUND', r4.code);

    // **伪造证据**：调用方自己编 roundIds，但真实 history 里没有
    const r5 = cs.createAutonomousGoal({ text: 'z', evidence: EV(['fake-1', 'fake-2']) });
    ok('**伪造的 Round ID 被拒**', r5.code === 'EVIDENCE_ROUND_NOT_FOUND', r5.code);
  }

  console.log('\n【⑤ createUserGoal 正常创建】');
  {
    resetCs();
    const r = cs.createUserGoal({ text: '老大交代的方向' });
    ok('成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    ok('created: true', r.created === true);
    ok('source 是 user_directed', goals()[0].source === 'user_directed');
    ok('**不需要证据**', true);
  }

  console.log('\n【⑥ 旧 setGoal 的合法兼容行为不变】');
  {
    resetCs();
    const r = cs.setGoal('兼容方向', { source: 'user_directed' });
    ok('user_directed 仍能建', r.ok === true, JSON.stringify(r).slice(0, 120));
    ok('返回 { ok, state }', r.ok === true && Boolean(r.state));
    ok('goal 里是 user_directed', goals()[0].source === 'user_directed');
  }

  console.log('\n【⑦ 同文本去重 / paused 恢复 / 终态新建 不变】');
  {
    resetCs();
    // 同文本 active 去重
    const a = cs.createUserGoal({ text: '同一个' });
    const b = cs.createUserGoal({ text: '同一个' });
    ok('同文本 active 去重', b.created === false && goals().length === 1);

    // paused 恢复
    cs.pauseGoal(a.goal.id);
    const c = cs.createUserGoal({ text: '同一个' });
    ok('paused 恢复原记录', c.created === false && goals()[0].id === a.goal.id && goals()[0].status === 'active');

    // 终态新建（用 autonomous 才能走 clearGoal）
    resetCs();
    seedRounds();
    const d = cs.createAutonomousGoal({ text: '终态测试', evidence: EV() });
    cs.clearGoal({ source: 'autonomous' });
    ok('旧的是 completed', goals()[0].status === 'completed');
    const e = cs.createAutonomousGoal({ text: '终态测试', evidence: EV() });
    ok('**终态后新建**', e.created === true && goals().length === 2);
  }

  console.log('\n【⑧ 来源升级规则不变】');
  {
    resetCs();
    seedRounds();
    const a = cs.createAutonomousGoal({ text: '准备 CSP', evidence: EV() });
    ok('初始是 autonomous', goals()[0].source === 'autonomous');

    cs.createUserGoal({ text: '准备 CSP' });
    ok('**升级成 user_directed**', goals()[0].source === 'user_directed');
    ok('ID 不变', goals()[0].id === a.goal.id);
    ok('有 sourceHistory', (goals()[0].sourceHistory || []).length === 1);

    // 重复升级不重复记
    cs.createUserGoal({ text: '准备 CSP' });
    ok('重复升级不重复记', (goals()[0].sourceHistory || []).length === 1);
  }

  console.log('\n【⑨ 容量限制不变】');
  {
    resetCs();
    for (let i = 0; i < 4; i += 1) cs.createUserGoal({ text: '占位 ' + i });
    for (let i = 0; i < 3; i += 1) cs.pauseGoal(goals().find((g) => g.status === 'active').id);

    const r = cs.createUserGoal({ text: '第五条' });
    ok('**容量满被拒**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('code 是 CAPACITY_FULL', r.code === 'CAPACITY_FULL', r.code);
    ok('有 capacity 明细', Boolean(r.capacity));
  }

  console.log('\n【⑩ createGoalCore 没被导出（唯一内部实现）】');
  {
    ok('**createGoalCore 不是导出**', typeof cs.createGoalCore === 'undefined', String(typeof cs.createGoalCore));
  }

  console.log('\n【⑪ source 不在合法枚举 → 安全失败】');
  {
    resetCs();
    const r = cs.createGoal({ text: 'x', source: 'bogus' });
    ok('**被拒绝**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('code 是 INVALID_SOURCE', r.code === 'INVALID_SOURCE', r.code);
    ok('没有创建 Goal', goals().length === 0);
  }

  console.log('\n【⑫ 全仓库确认没有绕过路径（源码级）】');
  {
    const stateSrc = fs.readFileSync(path.join(ROOT, 'src', 'companion', 'state.js'), 'utf8');
    // 唯一允许建 autonomous 的调用
    const hits = stateSrc.split('\n').filter((l) => /createGoalCore\(\{ text, source: 'autonomous'/.test(l));
    ok('**只有 1 处能建 autonomous**', hits.length === 1, String(hits.length));

    // 生产代码里没有别的地方建 autonomous Goal
    const autoSrc = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    ok('autonomous 不调 createGoal', !/cs\.createGoal\(|state\.createGoal\(/.test(autoSrc));
    ok('autonomous 不调 setGoal', !/setCompanionGoal\(/.test(autoSrc.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*\*.*$/gm, '')));
    // 4.0 / 2.6-B5b 之后，autonomous 确实会调 createAutonomousGoal —— 但**只在 goal-judge 校验通过后**。
    // 这条断言改成：调用的地方必须是在 judgeGoalCandidate 里，且不传 knownRounds。
    ok('autonomous 调 createAutonomousGoal 是在 judgeGoalCandidate 里', (() => {
      const i = autoSrc.indexOf('async function judgeGoalCandidate');
      if (i < 0) return false;
      const seg = autoSrc.slice(i, i + 3000);
      return seg.includes('createAutonomousGoal({') && !seg.split('\n').filter((l) => /createAutonomousGoal\(\{/.test(l)).some((l) => /knownRounds/.test(l));
    })());
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
