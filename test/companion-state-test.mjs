// Companion State 的验收测试（4.0 · 阶段 2.2）。
//
// 机主定稿的四条：
//   · mood 不纳入
//   · pending 允许多条 + 四个状态 + 完成的不立刻删
//   · 聊天侧保守触发（两个条件）
//   · **聊天和自主活动同时更新不同事项时不能互相覆盖**（专门加的测试）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-state-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const FILE = path.join(tmp, 'companion-state.json');
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
// 2.6.1 起文件里是 goals 数组，旧的单 goal 只是兼容视图
const activeG = (st) => {
  const s = read();
  // 2.6.1：文件可能是旧格式（只有 goal），也可能是新格式（goals 数组）
  if (Array.isArray(s.goals)) return s.goals.find((g) => g.status === 'active') || null;
  return s.goal && s.goal.text ? s.goal : null;
};
const reset = () => { try { fs.rmSync(FILE, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 空状态：读得到、结构对】');
  {
    reset();
    const st = cs.readCompanion();
    ok('goal/topic 是 null', st.goal === null && st.topic === null);
    ok('pending 是空数组', Array.isArray(st.pending) && st.pending.length === 0);
    ok('promptSection 为空串', cs.promptSection() === '');
  }

  console.log('\n【② goal：只有一个，新的替换旧的】');
  {
    reset();
    cs.setGoal('继续完善小镇游戏的故事', { source: 'user_directed' });
    ok('写进去了', activeG()?.text === '继续完善小镇游戏的故事');
    ok('带来源和时间', activeG()?.source === 'user_directed' && Boolean(activeG()?.since));

    const since1 = activeG().since;
    cs.setGoal('继续完善小镇游戏的故事', { source: 'autonomous' });
    ok('同一个目标不重置 since', activeG().since === since1);

    cs.setGoal('换个方向', { source: 'user_directed' });
    ok('新目标替换旧的', activeG()?.text === '换个方向');
    ok('仍然只有一条 active', (read().goals || []).filter((g) => g.status === 'active').length === 1);

    // 2.6.3 起 clearGoal 会走权限检查：
    // user_directed 的方向没经过老大确认 → **清不掉**（这是有意为之）
    const cr = cs.clearGoal({ source: 'owner' });
    ok('user_directed 的 goal 清不掉', cr.ok === false, JSON.stringify(cr));
    ok('错误码是 CONFIRMATION_REQUIRED', cr.code === 'CONFIRMATION_REQUIRED', cr.code);
    ok('**goal 仍然是 active**（没被绕过确认）', Boolean(activeG()));

    // autonomous 的可以清
    cs.pauseGoal(activeG().id);
    // 4.0 / 2.6-P1-1：autonomous Goal 只能走 createAutonomousGoal（要带跨轮证据）
    fs.writeFileSync(path.join(tmp, 'autonomous.json'), JSON.stringify({
      version: 2, status: 'IDLE',
      history: [
        { roundId: 'r-fixture-1', startedAt: 1, actions: [] },
        { roundId: 'r-fixture-2', startedAt: 2, actions: [] }
      ]
    }), 'utf8');
    cs.createAutonomousGoal({
      text: '自主方向',
      evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' }
    });
    const cr2 = cs.clearGoal({ source: 'autonomous' });
    ok('autonomous 的能清', cr2.ok === true, JSON.stringify(cr2));
    ok('清完没有 active 了', !activeG());
  }

  console.log('\n【③ pending：多条 + 四个状态】');
  {
    reset();
    const a = cs.addPending({ text: '等老大有空继续聊视频花费的事', source: 'autonomous', status: 'waiting' });
    const b = cs.addPending({ text: '明天再查查这个话题的资料', source: 'chat', status: 'pending' });
    ok('加了两条', read().pending.length === 2, String(read().pending.length));
    ok('id 不同', a.pending.id !== b.pending.id, `${a.pending.id} / ${b.pending.id}`);
    ok('状态各自保留', a.pending.status === 'waiting' && b.pending.status === 'pending');
    ok('都有来源', a.pending.source === 'autonomous' && b.pending.source === 'chat');

    const st1 = cs.settlePending(a.pending.id, 'done', { source: 'chat' });
    ok('结算为 done', st1.ok && read().pending.find((p) => p.id === a.pending.id).status === 'done');
    ok('记了 settledAt', Boolean(read().pending.find((p) => p.id === a.pending.id).settledAt));
    ok('**没有立刻删**', read().pending.some((p) => p.id === a.pending.id));

    const st2 = cs.settlePending(b.pending.id, 'cancelled');
    ok('能结算成 cancelled', read().pending.find((p) => p.id === b.pending.id).status === 'cancelled');
  }

  console.log('\n【④ 结算幂等】');
  {
    reset();
    const a = cs.addPending({ text: '测试幂等的待办事项', source: 'chat' });
    cs.settlePending(a.pending.id, 'done');
    const t1 = read().pending[0].settledAt;
    cs.settlePending(a.pending.id, 'done');
    ok('再结算一次不改变 settledAt', read().pending[0].settledAt === t1);
    ok('状态还是 done', read().pending[0].status === 'done');
  }

  console.log('\n【⑤ 去重：同文本未结算的不会重复加】');
  {
    reset();
    cs.addPending({ text: '等老大回话再继续', source: 'chat' });
    const again = cs.addPending({ text: '等老大回话再继续', source: 'autonomous' });
    ok('只有一条', read().pending.length === 1, String(read().pending.length));
    ok('返回的是已有那条', again.pending?.id === read().pending[0].id);

    // 结算后可以再加（这是新的一次等待）
    cs.settlePending(read().pending[0].id, 'done');
    cs.addPending({ text: '等老大回话再继续', source: 'chat' });
    ok('结算后能重新加', read().pending.length === 2, String(read().pending.length));
  }

  console.log('\n【⑥ 并发：聊天和自主同时更新不同事项不互相覆盖】');
  {
    reset();
    const runChild = (tag, body) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.out`), 'a');
      const err = fs.openSync(path.join(tmp, `${tag}.err`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT,
        env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, err],
        windowsHide: true
      });
      c.on('exit', (code) => {
        try { fs.closeSync(out) } catch { /* ignore */ }
        try { fs.closeSync(err) } catch { /* ignore */ }
        resolve(code);
      });
    });

    // 两个进程各加 5 条不同的待办
    const bodyA = `for (let i = 0; i < 5; i += 1) { cs.addPending({ text: '聊天侧事项 ' + i, source: 'chat' }); }`;
    const bodyB = `for (let i = 0; i < 5; i += 1) { cs.addPending({ text: '自主侧事项 ' + i, source: 'autonomous' }); }`;
    const [ca, cb] = await Promise.all([runChild('a', bodyA), runChild('b', bodyB)]);
    ok('两个子进程都正常退出', ca === 0 && cb === 0, `${ca}/${cb}`);

    const list = read().pending;
    ok('10 条都在（一条不丢）', list.length === 10, String(list.length));
    const chats = list.filter((p) => p.source === 'chat').length;
    const autos = list.filter((p) => p.source === 'autonomous').length;
    ok('聊天侧 5 条', chats === 5, String(chats));
    ok('自主侧 5 条', autos === 5, String(autos));
    ok('文件没坏、能解析', Boolean(read().version));

    // 再并发改不同字段
    const bodyC = `cs.setGoal('聊天侧设的目标', { source: 'user_directed' });`;
    const bodyD = `cs.setTopic('自主侧设的话题', { source: 'autonomous' });`;
    await Promise.all([runChild('c', bodyC), runChild('d', bodyD)]);
    ok('goal 和 topic 各自生效，不互相覆盖',
      activeG()?.text === '聊天侧设的目标' && read().topic?.text === '自主侧设的话题',
      JSON.stringify({ goal: read().goal?.text, topic: read().topic?.text }));
  }

  console.log('\n【⑦ 过期：只标记，不判定完成】');
  {
    reset();
    const a = cs.addPending({ text: '等老大回话，然后继续聊', source: 'chat', expiresInDays: 0 });
    ok('过期天数 0 时 expiresAt 是 null', a.pending.expiresAt === null);
    const b = cs.addPending({ text: '另一条要过期的待办', source: 'chat', expiresInDays: 1 });
    // 手工把它改成昨天过期
    const st = read();
    st.pending.find((p) => p.id === b.pending.id).expiresAt = new Date(Date.now() - 86400e3).toISOString();
    fs.writeFileSync(FILE, JSON.stringify(st), 'utf8');

    // 4.0 / 2.6-B2：expiredPending 只返回已标记的；读操作不触发清理。
    // 先触发一次写入，过期的会被标记成 'expired'（不是 done，也不是删除）。
    ok('清理前是空（读不触发清理）', cs.expiredPending().length === 0);
    cs.addPending({ text: '触发清理', source: 'chat' });
    const expired = cs.expiredPending();
    ok('**清理后能查出过期项**', expired.length === 1 && expired[0].id === b.pending.id, String(expired.length));
    ok('**过期不等于完成**（状态是 expired，不是 done）',
      read().pending.find((p) => p.id === b.pending.id).status === 'expired',
      read().pending.find((p) => p.id === b.pending.id).status);
  }

  console.log('\n【⑧ 上限：不会无限积累】');
  {
    reset();
    for (let i = 0; i < 30; i += 1) cs.addPending({ text: '批量事项 ' + i, source: 'chat' });
    const n = read().pending.length;
    ok('条数被限制在 20 以内', n <= 20, String(n));
    ok('留下的是最近的', read().pending.some((p) => p.text === '批量事项 29'));
  }

  console.log('\n【⑨ 保守触发：canAddPending 的两个条件】');
  {
    const cases = [
      ['等你有空，我们继续聊这个', true, '明确约定继续'],
      ['明天我再查查这个问题', true, '明确后续任务'],
      ['回头有机会再说吧', true, '回头 + 再说 —— 有信号'],   // 机主说"暂不写"，但这里文本确实有信号
      ['这个话题挺有意思的', false, '只是表达兴趣'],
      ['今天先聊到这里', false, '不一定存在待办'],
      ['算了不用了', false, '明确放弃'],
      ['嗯', false, '太短']
    ];
    for (const [t, expect, why] of cases) {
      const r = cs.canAddPending(t);
      ok(`「${t}」→ ${r.ok ? '记' : '不记'}（${why}）`, r.ok === expect, JSON.stringify(r));
    }
  }

  console.log('\n【⑩ promptSection 很短且诚实】');
  {
    reset();
    ok('什么都没有时是空串', cs.promptSection() === '');
    // 4.0 / 2.6-P1-1：'chat' 不在 GOAL_SOURCE 里（以前会归一成 autonomous，现在安全失败）
    cs.setGoal('继续完善小镇游戏', { source: 'user_directed' });
    cs.setTopic('警察助手的人设', { source: 'chat' });
    cs.addPending({ text: '继续讨论警察助手的人物设定', source: 'chat', status: 'waiting' });
    const s = cs.promptSection();
    ok('有内容时非空', s.length > 0);
    // 4.0 / P0：waiting 不再混进"还没做完的"，单独进"在等他回的"段
  ok('包含方向/话题/待办', /方向/.test(s) && /在聊/.test(s) && /在等他回的/.test(s), s);
    ok('标注了"在等"', /在等/.test(s), s);
    ok('长度克制（< 300 字）', s.length < 300, String(s.length));
  }

  console.log('\n【⑪ 坏文件不炸】');
  {
    reset();
    fs.writeFileSync(FILE, '{ 这不是 json', 'utf8');
    const st = cs.readCompanion();
    ok('读坏文件给空状态', st.goal === null && st.pending.length === 0);
    const r = cs.addPending({ text: '坏文件之后还能写', source: 'chat' });
    ok('还能继续写', r.ok === true, JSON.stringify(r).slice(0, 80));
    ok('写进去的是干净结构', Boolean(read().version) && Array.isArray(read().pending));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
