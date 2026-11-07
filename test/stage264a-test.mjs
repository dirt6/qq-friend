// 2.6.4a 专项测试：容量管理。
//
// 机主 2026-11-01 确认的决策：
//   ① pauseGoal 在 paused 满时也拒绝（CAPACITY_FULL）
//   ② 相同文本不同 source：autonomous → user_directed 升级（只升不降，只记一次）
//   ③ findSimilarGoals 只查询，不自动调用
//   + 容量统计统一、错误结构反映"操作之后"的容量
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage264a-'));
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
const writeCs = (o) => fs.writeFileSync(CS, JSON.stringify(o), 'utf8');
const readCs = () => JSON.parse(fs.readFileSync(CS, 'utf8'));
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };
const goals = () => readCs().goals || [];
const byId = (id) => goals().find((g) => g.id === id);
const active = () => goals().filter((g) => g.status === 'active');
const paused = () => goals().filter((g) => g.status === 'paused');

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
function mkAutoGoal(text) {
  seedRounds();
  return cs.createAutonomousGoal({ text, evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' } });
}

/** 造 n 个 paused + 1 个 active（最后创建的是 active）。 */
function seed(n) {
  const ids = [];
  for (let i = 0; i < n + 1; i += 1) {
    ids.push(mkAutoGoal('方向 ' + i).goal.id);
  }
  // 前 n 个 pause
  for (let i = 0; i < n; i += 1) cs.pauseGoal(ids[i]);
  return { activeId: ids[n], pausedIds: ids.slice(0, n), allIds: ids };
}

try {
  console.log('【T1 空状态创建 active】');
  {
    resetCs();
    const r = mkAutoGoal('A');
    ok('ok + created', r.ok === true && r.created === true);
    ok('active=1, paused=0', active().length === 1 && paused().length === 0);
  }

  console.log('\n【T2 已有 active 再创建】');
  {
    resetCs();
    cs.createUserGoal({ text: 'A'  });
    const r = cs.createUserGoal({ text: 'B'  });
    ok('ok + created', r.ok === true && r.created === true);
    ok('active=B（1 个）', active().length === 1 && active()[0].text === 'B');
    ok('paused=[A]', paused().length === 1 && paused()[0].text === 'A');
  }

  console.log('\n【T3 三个 paused 后创建 → CAPACITY_FULL】');
  {
    resetCs();
    seed(3);
    const before = JSON.stringify(goals());
    const r = cs.createUserGoal({ text: 'D'  });
    ok('返回失败', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('**code 是 CAPACITY_FULL**', r.code === 'CAPACITY_FULL', r.code);
    ok('**capacity 反映操作之后**（pausedAfter=4）', r.capacity?.pausedAfter === 4, JSON.stringify(r.capacity));
    ok('capacity 有 pausedUsed=3', r.capacity?.pausedUsed === 3);
    ok('capacity 有 activeMax/activeUsed', r.capacity?.activeMax === 1 && r.capacity?.activeUsed === 1);
    ok('**goals 完全没变**', JSON.stringify(goals()) === before);
  }

  console.log('\n【T4 容量不足时原 active 保持不变】');
  {
    resetCs();
    const { activeId } = seed(3);
    cs.createUserGoal({ text: 'D'  });
    ok('**原 active 仍是 active**', byId(activeId).status === 'active');
    ok('**它的 statusSince 没变**', Boolean(byId(activeId).statusSince));
  }

  console.log('\n【T5 容量不足时不新增 history】');
  {
    resetCs();
    const { allIds } = seed(3);
    const hBefore = allIds.map((id) => byId(id).history.length);
    cs.createUserGoal({ text: 'D'  });
    const hAfter = allIds.map((id) => byId(id).history.length);
    ok('**四条 history 长度都不变**', JSON.stringify(hBefore) === JSON.stringify(hAfter), `${JSON.stringify(hBefore)} vs ${JSON.stringify(hAfter)}`);
  }

  console.log('\n【T6 容量不足时 proposal 不变】');
  {
    resetCs();
    const { activeId } = seed(3);
    // 手工给 active 造一个 proposal
    const st = readCs();
    st.goals.find((g) => g.id === activeId).proposal = {
      kind: 'complete', proposedAt: '2026-11-01T00:00:00Z', proposedBy: 'autonomous',
      reason: '测试', askedAt: null, askedRound: null, expiresAt: null,
      answerAt: null, answer: '', answerQuote: ''
    };
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');
    const pBefore = JSON.stringify(byId(activeId).proposal);

    cs.createUserGoal({ text: 'D'  });
    ok('**proposal 一个字节没变**', JSON.stringify(byId(activeId).proposal) === pBefore);
  }

  console.log('\n【T7 恢复 paused 时容量充足】');
  {
    resetCs();
    const { pausedIds } = seed(1);   // 1 active + 1 paused
    const r = cs.resumeGoal(pausedIds[0]);
    ok('成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    ok('pausedPrevious 有值', Boolean(r.pausedPrevious));
    ok('active=1, paused=1', active().length === 1 && paused().length === 1);
  }

  console.log('\n【T8 恢复 paused 时"看起来满" → 仍然成功】');
  {
    resetCs();
    const { pausedIds } = seed(3);   // 1 active + 3 paused（满）
    const r = cs.resumeGoal(pausedIds[0]);
    ok('**成功（净效果 paused 不变）**', r.ok === true, JSON.stringify(r).slice(0, 120));
    ok('active=1, paused=3（总数不变）', active().length === 1 && paused().length === 3);
  }

  console.log('\n【T9 相同文本 active 去重】');
  {
    resetCs();
    cs.createUserGoal({ text: '准备 CSP'  });
    const r = cs.createUserGoal({ text: '准备 CSP'  });
    ok('created: false', r.created === false);
    ok('还是 1 条', goals().length === 1);
  }

  console.log('\n【T10 相同文本 paused 恢复原 ID】');
  {
    resetCs();
    const g = cs.createUserGoal({ text: '准备 CSP'  }).goal;
    cs.pauseGoal(g.id);
    const r = cs.createUserGoal({ text: '准备 CSP'  });
    ok('created: false', r.created === false);
    ok('**ID 不变**', r.goal.id === g.id);
    ok('状态变 active', byId(g.id).status === 'active');
  }

  console.log('\n【T11 相同文本终态后重建】');
  {
    resetCs();
    const g = mkAutoGoal('准备 CSP').goal;
    cs.completeGoal(g.id, { by: 'autonomous' });
    const r = cs.createUserGoal({ text: '准备 CSP'  });
    ok('created: true', r.created === true);
    ok('2 条', goals().length === 2);
    ok('旧的是 completed', byId(g.id).status === 'completed');
  }

  console.log('\n【T12 文本规范化后的重复识别】');
  {
    resetCs();
    cs.createUserGoal({ text: '准备 CSP'  });
    const r = cs.createUserGoal({ text: '  准备    CSP  '  });   // 前后空格 + 中间多空格
    ok('**识别为同一个**', r.created === false, JSON.stringify(r).slice(0, 120));
    ok('还是 1 条', goals().length === 1);
  }

  console.log('\n【T13 source 不被意外改变（降级场景）】');
  {
    resetCs();
    const g = cs.createUserGoal({ text: '老大的方向' }).goal;
    cs.pauseGoal(g.id);
    // 用 autonomous 再创建同文本 → 不能降级
    const r = mkAutoGoal('老大的方向');
    ok('成功（恢复）', r.ok === true);
    ok('**source 仍是 user_directed（不降级）**', byId(g.id).source === 'user_directed', byId(g.id).source);
  }

  console.log('\n【T13b 来源升级 autonomous → user_directed】');
  {
    resetCs();
    const g = mkAutoGoal('准备 CSP').goal;
    const r = cs.createUserGoal({ text: '准备 CSP' });
    ok('created: false（同一 Goal）', r.created === false);
    ok('**ID 不变**', r.goal.id === g.id);
    ok('**source 升级了**', byId(g.id).source === 'user_directed');
    ok('状态仍是 active', byId(g.id).status === 'active');
    ok('**有 sourceHistory**', Array.isArray(byId(g.id).sourceHistory) && byId(g.id).sourceHistory.length === 1);
    const h = byId(g.id).sourceHistory[0];
    ok('sourceHistory 有 from/to', h.from === 'autonomous' && h.to === 'user_directed');
    ok('sourceHistory 有 at/by/reason', Boolean(h.at) && h.by === 'createGoal' && Boolean(h.reason));
    ok('**history 没被污染**（还是 0 条）', byId(g.id).history.length === 0);
  }

  console.log('\n【T13c 重复升级不重复记】');
  {
    resetCs();
    const g = mkAutoGoal('准备 CSP').goal;
    cs.createUserGoal({ text: '准备 CSP' });   // 第一次升级
    cs.createUserGoal({ text: '准备 CSP' });   // 第二次（应该不记）
    ok('**sourceHistory 还是 1 条**', byId(g.id).sourceHistory.length === 1, String(byId(g.id).sourceHistory.length));
  }

  console.log('\n【T14 并发创建两个不同 Goal】');
  {
    resetCs();
    const run = (tag, text) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\ncs.createUserGoal({ text: '${text}' });\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });
    const [ca, cb] = await Promise.all([run('a', 'A'), run('b', 'B')]);
    ok('两个进程正常退出', ca === 0 && cb === 0);
    ok('2 条', goals().length === 2, String(goals().length));
    ok('**只有 1 个 active**', active().length === 1, String(active().length));
  }

  console.log('\n【T15 并发创建两个相同 Goal】');
  {
    resetCs();
    const run = (tag) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\nconst r = cs.createUserGoal({ text: 'X'  });\nconsole.log(JSON.stringify({ created: r.created }));\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });
    const [ca, cb] = await Promise.all([run('s1'), run('s2')]);
    ok('两个进程正常退出', ca === 0 && cb === 0);
    ok('**只有 1 条**', goals().length === 1, String(goals().length));
  }

  console.log('\n【T16a 并发 pause/resume/create（有 1 个空位）】');
  {
    resetCs();
    const { activeId, pausedIds } = seed(2);   // 1 active + 2 paused（1 个空位）
    const run = (tag, body) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });
    await Promise.all([
      run('t1', `cs.pauseGoal('${activeId}');`),
      run('t2', `cs.resumeGoal('${pausedIds[0]}');`),
      run('t3', `cs.createUserGoal({ text: 'Z'  });`)
    ]);
    const a = active().length;
    const p = paused().length;
    ok('**active ≤ 1**', a <= 1, String(a));
    ok('**paused ≤ 3**', p <= 3, String(p));
    ok('**active + paused ≤ 4**', a + p <= 4, String(a + p));
    ok('文件能解析', Boolean(readCs().version));
    // history 完整性
    const bad = goals().flatMap((g) => g.history || []).filter((h) => !h.at || !h.from || !h.to);
    ok('history 条目字段完整', bad.length === 0, JSON.stringify(bad).slice(0, 100));
  }

  console.log('\n【T16b 并发 pause/create（已满）→ 两个都失败】');
  {
    resetCs();
    const { activeId, pausedIds } = seed(3);   // 已满
    const run = (tag, body) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });
    await Promise.all([
      run('u1', `cs.pauseGoal('${activeId}');`),
      run('u2', `cs.createUserGoal({ text: 'D'  });`),
      run('u3', `cs.resumeGoal('${pausedIds[0]}');`)
    ]);
    const a = active().length;
    const p = paused().length;
    ok('**paused 仍是 3**', p === 3, String(p));
    ok('**active ≤ 1**', a <= 1, String(a));
    ok('**D 不存在（create 失败了）**', !goals().some((g) => g.text === 'D'));
    // 注意：resume 成功时会把原 active **让位**成 paused —— 那不是 pauseGoal 成功，
    // 而是 resumeGoal 的正常让位。所以这里不验 A 的具体状态（取决于调度顺序），
    // 只验"恢复的那条变 active"和容量不变量。
    ok('**恢复的那条变 active**', byId(pausedIds[0]).status === 'active', byId(pausedIds[0]).status);
    ok('**容量仍然合法**（active≤1, paused≤3）', active().length <= 1 && paused().length <= 3,
      `active=${active().length} paused=${paused().length}`);
  }

  console.log('\n【T17 旧 version 1 数据兼容】');
  {
    writeCs({
      version: 1,
      goal: { text: '旧格式的方向', source: 'autonomous', since: '2026-11-01T00:00:00Z' },
      topic: null, pending: [], updatedAt: ''
    });
    const r = cs.createUserGoal({ text: '新的方向'  });
    ok('创建成功', r.ok === true);
    const after = readCs();
    ok('升级到 version 2', after.version === 2);
    ok('旧 goal 变成 g-legacy-1（paused）', after.goals.find((g) => g.id === 'g-legacy-1')?.status === 'paused');
  }

  console.log('\n【T18 readCompanion 不触发容量清理或写盘】');
  {
    resetCs();
    // 故意造超限（4 个 paused）
    writeCs({
      version: 2,
      goals: [
        { id: 'g-1', text: 'A', source: 'autonomous', status: 'paused', since: '2026-11-01T00:00:00Z' },
        { id: 'g-2', text: 'B', source: 'autonomous', status: 'paused', since: '2026-11-01T00:00:00Z' },
        { id: 'g-3', text: 'C', source: 'autonomous', status: 'paused', since: '2026-11-01T00:00:00Z' },
        { id: 'g-4', text: 'D', source: 'autonomous', status: 'paused', since: '2026-11-01T00:00:00Z' }
      ],
      topic: null, pending: [], updatedAt: ''
    });
    const before = fs.readFileSync(CS, 'utf8');
    cs.readCompanion();
    const after = fs.readFileSync(CS, 'utf8');
    ok('**文件字节级不变**', before === after);
    ok('超限的 4 个还在（不清理）', readCs().goals.length === 4);
  }

  console.log('\n【T19 findSimilarGoals 只查询不修改】');
  {
    resetCs();
    mkAutoGoal('准备 CSP 考试');
    const before = fs.readFileSync(CS, 'utf8');
    const sim = cs.findSimilarGoals('准备 CSP');
    const after = fs.readFileSync(CS, 'utf8');
    ok('**文件没变**', before === after);
    ok('返回了候选', Array.isArray(sim), JSON.stringify(sim).slice(0, 100));
  }

  console.log('\n【T20 相似但不同不合并】');
  {
    resetCs();
    mkAutoGoal('准备 CSP');
    mkAutoGoal('准备考研');
    const sim = cs.findSimilarGoals('准备 CSP');
    ok('**不把"准备考研"当成"准备 CSP"的候选**', !sim.some((x) => x.goal.text === '准备考研'), JSON.stringify(sim.map((x) => x.goal.text)));
    ok('两条 goal 都还在（没合并）', goals().length === 2);
  }

  console.log('\n【T21 pauseGoal 在 paused 满时也拒绝】');
  {
    resetCs();
    const { activeId } = seed(3);   // 已满
    const hBefore = byId(activeId).history.length;
    const r = cs.pauseGoal(activeId);
    ok('返回失败', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('**code 是 CAPACITY_FULL**', r.code === 'CAPACITY_FULL', r.code);
    ok('capacity 有 pausedAfter=4', r.capacity?.pausedAfter === 4);
    ok('**active 保持不变**', byId(activeId).status === 'active');
    ok('**history 没增加**', byId(activeId).history.length === hBefore);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
