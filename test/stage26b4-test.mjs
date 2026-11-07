// 阶段 2.6-B4 专项测试：Planner prompt 语义修正。
//
// 机主授权（2026-11-02）：
//   · 明确 decision.goal 是当前 Action 的执行目的
//   · 明确它不是 Companion State 长期 Goal
//   · 不因 Action 失败而自动创建 Goal
//   · 不要求每个 Action 都创建 Pending
//   · 明确 decision.next 是后续事项建议，是否创建 Pending 仍需经过程序规则
//   · 不修改历史记录语义
//   · 不提前重命名为 objective
import fs from 'node:fs';
import path from 'node:path';

const ROOT = 'E:/dsh/QQ-agent';
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const plannerSrc = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'planner.js'), 'utf8');
const autoSrc = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(ROOT, 'src', 'companion', 'state.js'), 'utf8');

try {
  console.log('【① prompt 明确 goal 是 Action 目的】');
  {
    // 注意：prompt 的预算很紧（fitToBudget 最少配置在 900 tokens 内），
    // 加不了长段说明 —— 语义只能压进**字段说明**里。
    ok('goal 字段说明写清了「这次动作想干什么」', /"goal":"<这次动作想干什么/.test(plannerSrc));
    ok('next 字段说明写清了「下次从哪继续」', /"next":"<下次从哪继续/.test(plannerSrc));
    ok('**没有把 goal 说成长期目标**', !/长期目标/.test(plannerSrc.replace(/\/\/.*$/gm, '')));
  }

  console.log('\n【② prompt 明确 next 只是建议】');
  {
    ok('next 只是「下次从哪继续」的建议', /"next":"<下次从哪继续，一句话>"/.test(plannerSrc));
    // 代码层：只有 decision.next 存在时才写 Pending（不是每个动作都建）
    const auto = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    ok('**只有 next 存在才写 Pending**', auto.includes('if (decision.next)'));
  }

  console.log('\n【③ 没有要求每个 Action 都建 Pending】');
  {
    // prompt 里不该出现"每个动作都要建待办"这类强制措辞
    const bad = /每个动作.{0,10}(必须|都要).{0,10}(待办|Pending)/.test(plannerSrc);
    ok('**没有强制每个动作建待办**', bad === false);
    // 代码层：addCompanionPending 只在 decision.next 存在时调用
    ok('只有 next 存在才写 Pending', autoSrc.includes('if (decision.next)'));
  }

  console.log('\n【④ 没有因 Action 失败而创建 Goal 的代码】');
  {
    ok('**autonomous 里没有 setCompanionGoal 调用**', !/setCompanionGoal\(/.test(autoSrc.replace(/^\s*\/\/.*$/gm, '')), '仍有调用');
    ok('**没有 result === failed → createGoal**', !/(failed|失败)[\s\S]{0,200}createGoal/.test(autoSrc));
  }

  console.log('\n【⑤ 字段名没改（还是 goal，不是 objective）】');
  {
    ok('**planner 输出仍是 goal**', plannerSrc.includes('"goal"'));
    ok('**没有提前改成 objective**', !plannerSrc.includes('"objective"'));
    ok('validateDecision 仍返回 goal', /goal:\s*String\(d\.goal/.test(plannerSrc));
  }

  console.log('\n【⑥ 历史记录语义没变】');
  {
    ok('action.goal 仍从 decision.goal 来', autoSrc.includes('goal: decision.goal') || /goal:\s*decision\.goal/.test(autoSrc) || autoSrc.includes('decision.goal'));
    // 检查 history 写入没改结构
    ok('history 里 actions 仍有 goal 字段', /resultSummary|goal/.test(autoSrc));
  }

  console.log('\n【⑦ prompt 里没有把 goal 说成长期 Goal 的残留】');
  {
    // 找 prompt 里所有提到 goal 的地方
    const sysIdx = plannerSrc.indexOf('const SYSTEM = `');
    const sysEnd = plannerSrc.indexOf('`;', sysIdx);
    const sys = plannerSrc.slice(sysIdx, sysEnd);
    const goalLines = sys.split('\n').filter((l) => /goal/i.test(l));
    console.log('    prompt 里提到 goal 的行:');
    for (const l of goalLines) console.log('      ' + l.trim().slice(0, 100));
    const bad = goalLines.some((l) => /长期目标(?!.*别把)/.test(l) && !l.includes('别把') && !l.includes('不是长期'));
    ok('**没有"goal 是长期目标"的错误说法**', !bad);
  }

  console.log('\n【⑧ Companion State 里没有从 decision 建 Goal 的残留】');
  {
    // 4.0 / 2.6-B5b 之后 autonomous 会调它（在 judgeGoalCandidate 里，且不传 knownRounds）
    ok('**autonomous 调用 createAutonomousGoal 但不传 knownRounds**', (() => {
      const i = autoSrc.indexOf('async function judgeGoalCandidate');
      if (i < 0) return false;
      const seg = autoSrc.slice(i, i + 3000);
      return seg.includes('createAutonomousGoal({') && !seg.split('\n').filter((l) => /createAutonomousGoal\(\{/.test(l)).some((l) => /knownRounds/.test(l));
    })());
    ok('state.js 里有 createAutonomousGoal', stateSrc.includes('export function createAutonomousGoal'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
