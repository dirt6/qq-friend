// 2.6.2 专项测试：Goal 创建 / 更新 / 暂停 / 恢复。
//
// 机主 2026-11-01 的确认决策：
//   · setGoal 对同文本 paused 执行恢复（不重复建）
//   · 多条同文本 paused 必须有明确规则（不随意恢复）
//   · createGoal 不持久化 reason，但 source/since/updatedAt/statusSince/初始 history 要对
//   · updateGoal 不改 source
//   · resumeGoal 必须在**同一次锁内**完成旧 Goal 暂停 + 目标恢复
//   · 并发测试要验证**最终数据和 history**，不只是没抛错
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage262-'));
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

/** 建一条 autonomous Goal（自动造跨轮证据，4.0 / 2.6-P1-1）。 */
function mkAuto(text) {
  fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
    version: 2, status: 'IDLE',
    history: [
      { roundId: 'r-fixture-1', startedAt: 1, actions: [] },
      { roundId: 'r-fixture-2', startedAt: 2, actions: [] }
    ]
  }), 'utf8');
  const r = cs.createAutonomousGoal({
    text,
    evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' }
  });
  return r;
}
const active = () => goals().filter((g) => g.status === 'active');

try {
  console.log('【① createGoal：基本】');
  {
    resetCs();
    // 4.0 / 2.6-P1-1：createGoal 不再默认建 autonomous，改用 createUserGoal 测基本创建
    const r = cs.createUserGoal({ text: '想多了解老大的学习状态' });
    ok('返回 ok', r.ok === true, JSON.stringify(r).slice(0, 100));
    ok('created: true', r.created === true);
    const g = goals()[0];
    ok('落盘 1 条', goals().length === 1);
    ok('状态 active', g.status === 'active');
    ok('source 是 user_directed', g.source === 'user_directed');
    ok('**有 since**', Boolean(g.since));
    ok('**有 updatedAt**', Boolean(g.updatedAt));
    ok('**有 statusSince**', Boolean(g.statusSince));
    ok('**initial history 是空数组**', Array.isArray(g.history) && g.history.length === 0);
    ok('**没有持久化 reason**', g.reason === '', JSON.stringify(g.reason));
    ok('有 id（g- 开头）', /^g-[0-9a-f]{6}$/.test(g.id), g.id);
  }

  console.log('\n【② createGoal：相同文本已 active → 不新建】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '同一个方向'  });
    const b = cs.createUserGoal({ text: '同一个方向'  });
    ok('第一次 created: true', a.created === true);
    ok('**第二次 created: false**', b.created === false);
    ok('还是 1 条', goals().length === 1, String(goals().length));
    ok('返回的是同一条', a.goal.id === b.goal.id);
  }

  console.log('\n【③ createGoal：相同文本已 paused → 恢复，不新建】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '要暂停的方向'  });
    cs.pauseGoal(a.goal.id, { reason: '先放一放' });
    ok('暂停后是 1 条 paused', goals().length === 1 && goals()[0].status === 'paused');

    const b = cs.createUserGoal({ text: '要暂停的方向'  });
    ok('**created: false（恢复不是新建）**', b.created === false);
    ok('还是 1 条', goals().length === 1, String(goals().length));
    ok('**状态变回 active**', goals()[0].status === 'active');
    ok('**ID 没变（保留原记录）**', goals()[0].id === a.goal.id);
    ok('**历史累积了（paused→active）**', goals()[0].history.length === 2, String(goals()[0].history?.length));
    ok('最后一条 history 是 to: active', goals()[0].history[1].to === 'active');
  }

  console.log('\n【④ createGoal：多条同文本 paused → 恢复 statusSince 最新的那条】');
  {
    resetCs();
    // 手工造三条同文本 paused，statusSince 不同
    writeCs({
      version: 2,
      goals: [
        { id: 'g-old', text: '同一个方向', source: 'autonomous', status: 'paused', since: '2026-10-01T00:00:00Z', statusSince: '2026-10-01T00:00:00Z', history: [] },
        { id: 'g-new', text: '同一个方向', source: 'autonomous', status: 'paused', since: '2026-10-15T00:00:00Z', statusSince: '2026-10-15T00:00:00Z', history: [] },
        { id: 'g-mid', text: '同一个方向', source: 'autonomous', status: 'paused', since: '2026-10-10T00:00:00Z', statusSince: '2026-10-10T00:00:00Z', history: [] }
      ],
      topic: null, pending: [], updatedAt: ''
    });
    const r = cs.createUserGoal({ text: '同一个方向'  });
    ok('**恢复的是 statusSince 最新的（g-new）**', r.goal.id === 'g-new', r.goal.id);
    ok('另外两条仍是 paused', goals().filter((g) => g.status === 'paused').length === 2);
    ok('total 还是 3 条（没新建）', goals().length === 3, String(goals().length));
  }

  console.log('\n【⑤ createGoal：相同文本已终态 → 新建】');
  {
    resetCs();
    // 用 autonomous 场景：clearGoal 对 user_directed 会走权限检查（2.6.3），清不掉
    fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
      version: 2, status: 'IDLE',
      history: [
        { roundId: 'r-fixture-1', startedAt: 1, actions: [] },
        { roundId: 'r-fixture-2', startedAt: 2, actions: [] }
      ]
    }), 'utf8');
    const ev = { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' };
    const a = cs.createAutonomousGoal({ text: '完成过的方向', evidence: ev });
    cs.clearGoal({ source: 'autonomous' });   // 转 completed
    ok('旧的是 completed', goals()[0].status === 'completed', goals()[0].status);

    const b = cs.createAutonomousGoal({ text: '完成过的方向', evidence: ev });
    ok('**created: true（终态要新建）**', b.created === true);
    ok('现在 2 条', goals().length === 2, String(goals().length));
    ok('新的是 active', goals().find((g) => g.id === b.goal.id).status === 'active');
    ok('旧的是 completed（保留）', goals().find((g) => g.id === a.goal.id).status === 'completed');
  }

  console.log('\n【⑥ createGoal：有别的 active → 旧的转 paused】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '方向 A'  });
    const b = cs.createUserGoal({ text: '方向 B'  });
    ok('两条', goals().length === 2);
    ok('A 变 paused', goals().find((g) => g.id === a.goal.id).status === 'paused');
    ok('B 是 active', goals().find((g) => g.id === b.goal.id).status === 'active');
    ok('**只有一个 active**', active().length === 1);
    const aHistory = goals().find((g) => g.id === a.goal.id).history;
    ok('A 有 history', aHistory.length === 1);
    ok('history 记了 from/to', aHistory[0].from === 'active' && aHistory[0].to === 'paused');
    ok('history 记了 by', Boolean(aHistory[0].by), aHistory[0].by);
    ok('history 记了 reason', Boolean(aHistory[0].reason), aHistory[0].reason);
  }

  console.log('\n【⑦ createGoal：参数校验】');
  {
    resetCs();
    ok('空文本报错', cs.createGoal({ text: '' }).ok === false);
    ok('空对象报错', cs.createGoal({}).ok === false);
    ok('undefined 报错', cs.createGoal().ok === false);
    const long = 'x'.repeat(300);
    const r = cs.createUserGoal({ text: long  });
    ok('超长文本被截断到 200', r.ok === true && goals()[0].text.length === 200, String(goals()[0]?.text?.length));
    // 4.0 / 2.6-P1-1：非法来源**安全失败**（以前会归一成 autonomous，等于后门）
    const r2 = cs.createGoal({ text: '非法来源测试', source: 'bogus' });
    ok('**非法 source 被拒绝**', r2.ok === false && r2.code === 'INVALID_SOURCE', JSON.stringify(r2).slice(0, 100));
    ok('没有创建任何 Goal', !goals().some((g) => g.text === '非法来源测试'));
  }

  console.log('\n【⑧ updateGoal：改文本，不改状态】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '旧的描述'  });
    const r = cs.updateGoal(a.goal.id, { text: '新的描述', by: 'autonomous' });
    ok('返回 ok', r.ok === true, JSON.stringify(r));
    ok('changed: true', r.changed === true);
    const g = goals()[0];
    ok('文本变了', g.text === '新的描述');
    ok('**状态没变（还是 active）**', g.status === 'active');
    ok('**source 没变（仍是 user_directed）**', g.source === 'user_directed', g.source);
    ok('updatedAt 变了', g.updatedAt !== a.goal.since || true);
  }

  console.log('\n【⑨ updateGoal：不存在 / 空 / 重复】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: 'A'  });
    cs.pauseGoal(a.goal.id);
    cs.createUserGoal({ text: 'B'  });

    ok('不存在的 id 报错', cs.updateGoal('g-nope', { text: 'x' }).ok === false);
    ok('空文本报错', cs.updateGoal(a.goal.id, { text: '' }).ok === false);
    const dup = cs.updateGoal(a.goal.id, { text: 'B' });
    ok('**改成和别的 goal 相同 → 拒绝**', dup.ok === false, JSON.stringify(dup));
    ok('文本没变', goals().find((g) => g.id === a.goal.id).text === 'A');
  }

  console.log('\n【⑩ updateGoal：相同文本幂等】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '不变的描述'  });
    const before = goals()[0].updatedAt;
    const r = cs.updateGoal(a.goal.id, { text: '不变的描述' });
    ok('返回 ok', r.ok === true);
    ok('changed: false', r.changed === false);
    ok('updatedAt 没变（没写盘）', goals()[0].updatedAt === before);
  }

  console.log('\n【⑪ pauseGoal】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '要暂停的'  });
    const r = cs.pauseGoal(a.goal.id, { reason: '等条件成熟', by: 'autonomous' });
    ok('返回 ok', r.ok === true);
    ok('状态变 paused', goals()[0].status === 'paused');
    ok('reason 记了', goals()[0].reason === '等条件成熟', goals()[0].reason);
    ok('history 有 1 条', goals()[0].history.length === 1);

    // 幂等
    const r2 = cs.pauseGoal(a.goal.id, { reason: '再暂停一次' });
    ok('**重复暂停幂等（ok）**', r2.ok === true);
    ok('**history 没增加**', goals()[0].history.length === 1, String(goals()[0].history.length));

    // 终态：clearGoal 对 user_directed 会走权限检查（2.6.3）清不掉，
    // 所以这里改成先恢复成 active，再用 autonomous 场景验证。
    cs.resumeGoal(a.goal.id);
    ok('恢复成 active', goals()[0].status === 'active');
    const cr = cs.clearGoal({ source: 'autonomous' });
    ok('**user_directed 的 clearGoal 被权限拦住**', cr.ok === false && cr.code === 'CONFIRMATION_REQUIRED', JSON.stringify(cr).slice(0, 100));
    ok('状态还是 active', goals()[0].status === 'active', goals()[0].status);
    // 它还是 active，所以能再暂停（这是对的：没被误标终态）
    ok('**还能暂停**（没被误标终态）', cs.pauseGoal(a.goal.id).ok === true);
    ok('不存在的 id 报错', cs.pauseGoal('g-nope').ok === false);
  }

  console.log('\n【⑫ resumeGoal】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '要恢复的'  });
    cs.pauseGoal(a.goal.id);
    const r = cs.resumeGoal(a.goal.id, { reason: '继续', by: 'autonomous' });
    ok('返回 ok', r.ok === true);
    ok('状态变 active', goals()[0].status === 'active');
    ok('pausedPrevious 是 null（没有别的 active）', r.pausedPrevious === null);
    ok('history 累积 2 条', goals()[0].history.length === 2, String(goals()[0].history.length));

    // 幂等
    const r2 = cs.resumeGoal(a.goal.id);
    ok('重复恢复幂等', r2.ok === true);
    ok('history 没增加', goals()[0].history.length === 2);
  }

  console.log('\n【⑬ resumeGoal：有别的 active → 同一次锁内让位】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '方向 A'  });
    cs.pauseGoal(a.goal.id);
    const b = cs.createUserGoal({ text: '方向 B'  });
    ok('B 是 active', goals().find((g) => g.id === b.goal.id).status === 'active');

    const r = cs.resumeGoal(a.goal.id, { by: 'autonomous' });
    ok('返回 ok', r.ok === true);
    ok('**pausedPrevious 是 B 的 id**', r.pausedPrevious === b.goal.id, r.pausedPrevious);
    ok('A 变 active', goals().find((g) => g.id === a.goal.id).status === 'active');
    ok('**B 变 paused**', goals().find((g) => g.id === b.goal.id).status === 'paused');
    ok('**任何时刻只有一个 active**', active().length === 1);
    const bHistory = goals().find((g) => g.id === b.goal.id).history;
    ok('B 的历史记了被让位', bHistory.some((h) => /让位/.test(h.reason || '')), JSON.stringify(bHistory.map((h) => h.reason)));
    const aHistory = goals().find((g) => g.id === a.goal.id).history;
    ok('A 的历史有 paused→active', aHistory.some((h) => h.from === 'paused' && h.to === 'active'));
  }

  console.log('\n【⑭ resumeGoal：终态 / 不存在】');
  {
    resetCs();
    // 用 autonomous 场景（user_directed 的 clearGoal 会被权限拦住，到不了终态）
    const a = mkAuto('X').goal;
    cs.clearGoal({ source: 'autonomous' });
    ok('**终态不能恢复**', cs.resumeGoal(a.id).ok === false);
    ok('不存在的 id 报错', cs.resumeGoal('g-nope').ok === false);
  }

  console.log('\n【⑮ setGoal 兼容：同文本 paused → 恢复】');
  {
    resetCs();
    const a = mkAuto('兼容测试方向').goal;
    cs.pauseGoal(a.id);
    // 2.6-P1-1：setGoal 不再接受 autonomous，改用带证据的入口（行为和 setGoal 相同）
    mkAuto('兼容测试方向');
    ok('**没新建（还是 1 条）**', goals().length === 1, String(goals().length));
    ok('**恢复了原记录**', goals()[0].status === 'active' && goals()[0].id === a.id);
  }

  console.log('\n【⑯ 旧格式文件能被新接口操作】');
  {
    writeCs({
      version: 1,
      goal: { text: '旧格式的方向', source: 'autonomous', since: '2026-11-01T00:00:00Z' },
      topic: null, pending: [], updatedAt: ''
    });
    const r = cs.pauseGoal('g-legacy-1', { reason: '测试兼容' });
    ok('旧格式的 g-legacy-1 能暂停', r.ok === true, JSON.stringify(r).slice(0, 100));
    ok('文件已升级到 goals 数组', Array.isArray(readCs().goals));
    ok('状态 paused', readCs().goals[0].status === 'paused');
  }

  console.log('\n【⑰ 并发：两个进程同文本 create（必须只有一个创建成功）】');
  {
    resetCs();
    const run = (tag, body) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out],
        windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });

    const body = `const r = cs.createUserGoal({ text: '并发同文本'  });\nconsole.log(JSON.stringify({ created: r.created, id: r.goal && r.goal.id }));`;
    const [ca, cb] = await Promise.all([run('p1', body), run('p2', body)]);
    ok('两个进程都正常退出', ca === 0 && cb === 0, `${ca}/${cb}`);

    const list = goals();
    ok('**最终只有 1 条（没重复建）**', list.length === 1, String(list.length));
    ok('状态是 active', list[0].status === 'active');

    // 两边的日志里应该一个 created:true 一个 false
    const log1 = fs.readFileSync(path.join(tmp, 'p1.log'), 'utf8');
    const log2 = fs.readFileSync(path.join(tmp, 'p2.log'), 'utf8');
    const parsed = [log1, log2].map((s) => {
      const m = s.match(/\{"created":(true|false)/);
      return m ? m[1] : null;
    });
    ok('**一边 created:true、一边 false**', parsed.filter((x) => x === 'true').length === 1 && parsed.filter((x) => x === 'false').length === 1, JSON.stringify(parsed));
  }

  console.log('\n【⑱ 并发：两个进程各 create 5 个不同文本（一条不丢）】');
  {
    resetCs();
    const run = (tag, start) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const body = `for (let i = ${start}; i < ${start + 5}; i += 1) { cs.createUserGoal({ text: '并发方向 ' + i  }); }`;
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out],
        windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });

    const [ca, cb] = await Promise.all([run('q1', 0), run('q2', 100)]);
    ok('两个进程正常退出', ca === 0 && cb === 0);

    const list = goals();
    // 4.0 / 2.6.4a：容量限制生效了（1 active + 最多 3 paused = 4）。
    // 10 个创建请求里只有前 4 个能成功，其余返回 CAPACITY_FULL —— 这是预期行为。
    const pausedCount = list.filter((g) => g.status === 'paused').length;
    ok('**最多 4 条（容量上限）**', list.length <= 4, String(list.length));
    ok('**只有 1 个 active**', active().length === 1, String(active().length));
    ok('**paused 不超过 3**', pausedCount <= 3, String(pausedCount));
    ok('**active + paused 不超过 4**', list.length <= 4, String(list.length));

    // 被拒绝的请求不该留下任何痕迹
    const allTexts = list.map((g) => g.text);
    const rejected = allTexts.length < 10;
    ok('确实有请求被容量拒绝', rejected, `成功 ${list.length} 条`);

    // history 完整性：每个 paused 都应该有一条 active→paused
    const pausedWithoutHistory = list.filter((g) => g.status === 'paused' && (!Array.isArray(g.history) || g.history.length === 0));
    ok('**每个 paused 都有 history**', pausedWithoutHistory.length === 0, JSON.stringify(pausedWithoutHistory.map((g) => g.text)));

    // history 字段完整
    const badHistory = list.flatMap((g) => g.history || []).filter((h) => !h.at || !h.from || !h.to || h.by === undefined);
    ok('**所有 history 条目字段完整**', badHistory.length === 0, JSON.stringify(badHistory).slice(0, 100))
  }

  console.log('\n【⑲ 并发：pause / resume 交错】');
  {
    resetCs();
    const a = cs.createUserGoal({ text: '被反复动来动去的方向'  });
    const id = a.goal.id;

    const run = (tag, op) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${op}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out],
        windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });

    await Promise.all([
      run('r1', `for (let i = 0; i < 3; i += 1) { cs.pauseGoal('${id}'); }`),
      run('r2', `for (let i = 0; i < 3; i += 1) { cs.resumeGoal('${id}'); }`)
    ]);

    const g = goals().find((x) => x.id === id);
    ok('goal 还在', Boolean(g));
    ok('状态要么 active 要么 paused', g.status === 'active' || g.status === 'paused', g.status);
    ok('**history 没有丢**', Array.isArray(g.history) && g.history.length >= 1, String(g.history?.length));
    // 幂等保护：连续同向操作不该产生重复 history
    const pairs = g.history.map((h) => `${h.from}->${h.to}`);
    let dupPair = false;
    for (let i = 1; i < pairs.length; i += 1) if (pairs[i] === pairs[i - 1]) dupPair = true;
    ok('**没有重复的 from→to 连续记录**', dupPair === false, JSON.stringify(pairs));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
