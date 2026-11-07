// 2.6.1 状态模型与数据结构的验收测试。
//
// 四项验收（机主 2.6 设计第十五节）：
//   · 状态模型测试
//   · 旧数据兼容测试
//   · 迁移测试
//   · 不直接覆盖生产数据
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage261-'));
const dataDir = tmp;
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const CS = path.join(dataDir, 'companion-state.json');

/** 造一份测试用的 Round 历史（autonomous Goal 必须带跨轮证据）。 */
function seedRounds() {
  fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
    version: 2, status: 'IDLE',
    history: [
      { roundId: 'r-fixture-1', startedAt: 1, actions: [] },
      { roundId: 'r-fixture-2', startedAt: 2, actions: [] }
    ]
  }), 'utf8');
}

/** 建一条 autonomous Goal（自动造证据）。 */
function mkAuto(text) {
  seedRounds();
  const r = cs.createAutonomousGoal({
    text,
    evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' }
  });
  return r;
}
const writeCs = (o) => fs.writeFileSync(CS, JSON.stringify(o), 'utf8');
const readCs = () => JSON.parse(fs.readFileSync(CS, 'utf8'));
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 状态模型常量】');
  {
    ok('五个状态都在', JSON.stringify(cs.GOAL_STATUS) === JSON.stringify(['active', 'paused', 'completed', 'cancelled', 'superseded']), JSON.stringify(cs.GOAL_STATUS));
    ok('三种终态', JSON.stringify(cs.GOAL_STATUS_TERMINAL) === JSON.stringify(['completed', 'cancelled', 'superseded']));
    ok('两种来源', JSON.stringify(cs.GOAL_SOURCE) === JSON.stringify(['autonomous', 'user_directed']));
    ok('暂停上限是 3', cs.MAX_PAUSED_GOALS === 3);
  }

  console.log('\n【② 状态转换表】');
  {
    // active 能转四种
    for (const to of ['paused', 'completed', 'cancelled', 'superseded']) {
      ok(`active → ${to}`, cs.canTransition('active', to) === true);
    }
    // paused 只能转 active/cancelled/superseded
    ok('paused → active', cs.canTransition('paused', 'active') === true);
    ok('paused → cancelled', cs.canTransition('paused', 'cancelled') === true);
    ok('paused → superseded', cs.canTransition('paused', 'superseded') === true);
    ok('**paused → completed 不允许**', cs.canTransition('paused', 'completed') === false);
    // 终态没有出口
    for (const from of ['completed', 'cancelled', 'superseded']) {
      for (const to of ['active', 'paused', 'completed', 'cancelled', 'superseded']) {
        if (cs.canTransition(from, to)) { ok(`${from} → ${to} 不该允许`, false); }
      }
      ok(`${from} 是终态（没有任何出口）`, true);
    }
  }

  console.log('\n【③ 权限表：user_directed 不能擅自结束】');
  {
    // autonomous 全权限
    for (const op of ['pause', 'resume', 'complete', 'cancel', 'supersede']) {
      ok(`autonomous 可以 ${op}`, cs.canOperate('autonomous', op) === true);
    }
    // user_directed 只能暂停/恢复
    ok('user_directed 可以 pause', cs.canOperate('user_directed', 'pause') === true);
    ok('user_directed 可以 resume', cs.canOperate('user_directed', 'resume') === true);
    ok('**user_directed 不能 complete**', cs.canOperate('user_directed', 'complete') === false);
    ok('**user_directed 不能 cancel**', cs.canOperate('user_directed', 'cancel') === false);
    ok('**user_directed 不能 supersede**', cs.canOperate('user_directed', 'supersede') === false);
    ok('未知来源一律没权限', cs.canOperate('unknown', 'pause') === false);
  }

  console.log('\n【④ 旧数据兼容：单 goal → goals[0]】');
  {
    // 造一个 2.5 格式的文件（只有 goal，没有 goals）
    writeCs({
      version: 1,
      goal: { text: '问出老大昨晚真实睡眠情况', source: 'autonomous', since: '2026-11-01T07:29:56.666Z' },
      topic: null,
      pending: [],
      updatedAt: '2026-11-01T07:29:56.671Z'
    });
    const st = cs.readCompanion();
    ok('读到 goals 数组', Array.isArray(st.goals) && st.goals.length === 1, String(st.goals?.length));
    const g = st.goals[0];
    ok('文本正确', g.text === '问出老大昨晚真实睡眠情况', g.text);
    ok('来源正确', g.source === 'autonomous');
    ok('状态是 active', g.status === 'active');
    ok('id 是 g-legacy-1', g.id === 'g-legacy-1', g.id);
    ok('保留原 since', g.since === '2026-11-01T07:29:56.666Z');
    ok('**兼容视图 goal 也还在**', st.goal?.text === '问出老大昨晚真实睡眠情况');
    ok('文件本身没被改（只读兼容）', JSON.parse(fs.readFileSync(CS, 'utf8')).goals === undefined);
  }

  console.log('\n【⑤ setGoal：旧的转 paused，不删】');
  {
    writeCs({
      version: 1,
      goal: { text: '旧方向', source: 'autonomous', since: '2026-11-01T07:00:00.000Z' },
      topic: null, pending: [], updatedAt: ''
    });
    // 4.0 / 2.6-P1-1：autonomous 必须走带证据的入口
    mkAuto('新方向');
    const st = cs.readCompanion();
    ok('两条 goal', st.goals.length === 2, String(st.goals.length));
    const old = st.goals.find((g) => g.text === '旧方向');
    const now = st.goals.find((g) => g.text === '新方向');
    ok('**旧的变成 paused（不是删除）**', old.status === 'paused', old?.status);
    ok('旧的保留了 since', old.since === '2026-11-01T07:00:00.000Z');
    ok('新的 active', now.status === 'active');
    ok('**只有一个 active**', st.goals.filter((g) => g.status === 'active').length === 1);
    ok('旧的有历史记录', Array.isArray(old.history) && old.history.length === 1, JSON.stringify(old?.history));
    ok('历史记了 from/to', old.history[0].from === 'active' && old.history[0].to === 'paused');
  }

  console.log('\n【⑥ 相同文本不重复建】');
  {
    resetCs();
    // 4.0 / 2.6-P1-1：autonomous 走带证据的入口
    mkAuto('同一个方向');
    const n1 = readCs().goals.length;
    mkAuto('同一个方向');
    ok('还是一条', readCs().goals.length === n1, `${n1} → ${readCs().goals.length}`);
  }

  console.log('\n【⑦ promptSection 只注入 active】');
  {
    writeCs({
      version: 2,
      goals: [
        { id: 'g-a', text: '活跃的方向', source: 'autonomous', status: 'active', since: '2026-11-01T00:00:00Z' },
        { id: 'g-b', text: '暂停的方向', source: 'autonomous', status: 'paused', since: '2026-11-01T00:00:00Z' },
        { id: 'g-c', text: '完成的方向', source: 'autonomous', status: 'completed', since: '2026-11-01T00:00:00Z' },
        { id: 'g-d', text: '取消的方向', source: 'autonomous', status: 'cancelled', since: '2026-11-01T00:00:00Z' },
        { id: 'g-e', text: '被取代的方向', source: 'autonomous', status: 'superseded', since: '2026-11-01T00:00:00Z' }
      ],
      topic: null, pending: [], updatedAt: ''
    });
    const s = cs.promptSection();
    ok('注入 active', /活跃的方向/.test(s), s);
    ok('**不注入 paused**', !/暂停的方向/.test(s));
    ok('**不注入 completed**', !/完成的方向/.test(s));
    ok('**不注入 cancelled**', !/取消的方向/.test(s));
    ok('**不注入 superseded**', !/被取代的方向/.test(s));
  }

  console.log('\n【⑧ summary 的 goalCounts】');
  {
    const sum = cs.summary();
    ok('goal 是 active 那条', sum.goal === '活跃的方向', sum.goal);
    ok('active 计数 1', sum.goalCounts.active === 1, String(sum.goalCounts?.active));
    ok('paused 计数 1', sum.goalCounts.paused === 1);
    ok('completed 计数 1', sum.goalCounts.completed === 1);
    ok('cancelled 计数 1', sum.goalCounts.cancelled === 1);
    ok('superseded 计数 1', sum.goalCounts.superseded === 1);
  }

  console.log('\n【⑨ activeGoal / pausedGoals】');
  {
    const st = cs.readCompanion();
    ok('activeGoal 拿到 active 那条', cs.activeGoal(st)?.id === 'g-a');
    ok('pausedGoals 只有 1 条', cs.pausedGoals(st).length === 1);
  }

  console.log('\n【⑩ validateGoal】');
  {
    ok('合法 goal 通过', cs.validateGoal({ id: 'g-1', text: 'x', source: 'autonomous', status: 'active', since: '2026-11-01T00:00:00Z' }).ok === true);
    ok('缺 id 报错', cs.validateGoal({ text: 'x', source: 'autonomous', status: 'active' }).ok === false);
    ok('缺 text 报错', cs.validateGoal({ id: 'g-1', source: 'autonomous', status: 'active' }).ok === false);
    ok('非法 source 报错', cs.validateGoal({ id: 'g-1', text: 'x', source: 'bogus', status: 'active' }).ok === false);
    ok('非法 status 报错', cs.validateGoal({ id: 'g-1', text: 'x', source: 'autonomous', status: 'bogus' }).ok === false);
    ok('坏时间报错', cs.validateGoal({ id: 'g-1', text: 'x', source: 'autonomous', status: 'active', since: 'not-a-date' }).ok === false);
  }

  console.log('\n【⑪ clearGoal 转 completed，不删】');
  {
    writeCs({
      version: 2,
      goals: [{ id: 'g-1', text: '要清的方向', source: 'autonomous', status: 'active', since: '2026-11-01T00:00:00Z' }],
      topic: null, pending: [], updatedAt: ''
    });
    cs.clearGoal({ source: 'autonomous' });
    const st = cs.readCompanion();
    ok('还是 1 条（没删）', st.goals.length === 1, String(st.goals.length));
    ok('状态变 completed', st.goals[0].status === 'completed', st.goals[0].status);
    ok('**没有 active 了**', st.goals.filter((g) => g.status === 'active').length === 0);
    ok('有历史记录', st.goals[0].history.length === 1);
  }

  console.log('\n【⑫ 坏数据不炸】');
  {
    fs.writeFileSync(CS, '{ 坏的', 'utf8');
    const st = cs.readCompanion();
    ok('给空状态', Array.isArray(st.goals) && st.goals.length === 0);
    ok('goal 是 null', st.goal === null);
    ok('坏文件没被覆盖', fs.readFileSync(CS, 'utf8') === '{ 坏的');

    writeCs({ version: 2, goals: 'not-an-array', topic: null, pending: [], updatedAt: '' });
    ok('goals 不是数组时给空', cs.readCompanion().goals.length === 0);
  }

  console.log('\n【⑬ 写盘带 version: 2】');
  {
    resetCs();
    // 4.0 / 2.6-P1-1：autonomous 走带证据的入口
    mkAuto('测试 version');
    ok('version 是 2', readCs().version === 2, String(readCs().version));
    ok('goals 是数组', Array.isArray(readCs().goals));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
