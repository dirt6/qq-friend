// 2.6.3 专项测试：完成 / 取消 / 取代（三种确认语义）。
//
// 机主 2026-11-01 确认的实现约束：
//   · NO_PROPOSAL 和 CONFIRMATION_REQUIRED 分开
//   · autonomous 的合法终态操作**不能被 NO_PROPOSAL 阻断**
//   · answerConfirmation 特殊顺序：先定位 → 过期就 PROPOSAL_EXPIRED → 不存在才 NO_PROPOSAL
//   · 覆盖 proposal 不继承旧字段
//   · 过期只清 proposal，状态不变
//   · isProposalExpired 用同一批操作的统一时间快照
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage263-'));
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

/** 造一条 autonomous Goal（走带证据的正规入口，4.0 / 2.6-P1-1）。 */
function mkAutoGoal(text) {
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
  return r.goal;
}

/** 造一条指定来源的 goal（user_directed 走 createUserGoal，autonomous 走 createAutonomousGoal）。 */
function mkGoal(text, source) {
  if (source === 'autonomous') return mkAutoGoal(text);
  const r = cs.createUserGoal({ text });
  return r.goal;
}

/** 造一条 user_directed 的 goal 并走完"提议 + 问 + 答"流程。 */
function mkConfirmed(text, kind, answer, quote = '好') {
  const g = mkGoal(text, 'user_directed');
  cs.proposeCompletion(g.id, { kind, reason: '测试' });
  cs.markConfirmationAsked(g.id, { roundId: 'round-test' });
  cs.answerConfirmation(g.id, { answer, quote });
  return g;
}

try {
  console.log('【① 权限边界：autonomous 直接过，user_directed 要确认】');
  {
    resetCs();
    const a = mkGoal('自主目标', 'autonomous');
    const r1 = cs.completeGoal(a.id, { by: 'autonomous' });
    ok('autonomous + complete 成功', r1.ok === true, JSON.stringify(r1).slice(0, 120));
    ok('**没有返回 NO_PROPOSAL**', r1.code !== 'NO_PROPOSAL');
    ok('状态变 completed', byId(a.id).status === 'completed');

    const b = mkGoal('自主目标2', 'autonomous');
    ok('autonomous + cancel 成功', cs.cancelGoal(b.id, { by: 'autonomous' }).ok === true);
    ok('状态变 cancelled', byId(b.id).status === 'cancelled');

    const c = mkGoal('自主目标3', 'autonomous');
    ok('autonomous + supersede 成功', cs.supersedeGoal(c.id, { by: 'autonomous' }).ok === true);
    ok('状态变 superseded', byId(c.id).status === 'superseded');
  }

  console.log('\n【② user_directed 的四种拒绝】');
  {
    resetCs();
    const g = mkGoal('老大交代的目标', 'user_directed');

    const r1 = cs.completeGoal(g.id, { by: 'autonomous' });
    ok('**无 proposal → CONFIRMATION_REQUIRED**', r1.code === 'CONFIRMATION_REQUIRED', r1.code);
    ok('状态没变', byId(g.id).status === 'active');

    cs.proposeCompletion(g.id, { kind: 'complete', reason: '觉得做完了' });
    const r2 = cs.completeGoal(g.id, { by: 'autonomous' });
    ok('**有 proposal 没问 → NOT_ASKED**', r2.code === 'NOT_ASKED', r2.code);

    cs.markConfirmationAsked(g.id, { roundId: 'round-1' });
    const r3 = cs.completeGoal(g.id, { by: 'autonomous' });
    ok('**问了没答 → NOT_CONFIRMED**', r3.code === 'NOT_CONFIRMED', r3.code);

    cs.answerConfirmation(g.id, { answer: 'no', quote: '还没完' });
    const r4 = cs.completeGoal(g.id, { by: 'autonomous' });
    ok('**答了 no → CONFIRMATION_REQUIRED（proposal 被清）**', r4.code === 'CONFIRMATION_REQUIRED', r4.code);
    ok('状态没变', byId(g.id).status === 'active');
  }

  console.log('\n【③ user_directed 答 yes 才能执行】');
  {
    resetCs();
    const g = mkGoal('要完成的目标', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete', reason: '做完了' });
    cs.markConfirmationAsked(g.id, { roundId: 'r1' });
    const ans = cs.answerConfirmation(g.id, { answer: 'yes', quote: '对，可以了' });
    ok('answer yes 返回 applied: true', ans.ok === true && ans.applied === true, JSON.stringify(ans).slice(0, 120));
    ok('状态变 completed', byId(g.id).status === 'completed');
    // 2.6.3 补丁：执行成功后 proposal **保留**（带 usedAt），审计信息留在里面
    ok('proposal 保留（带 usedAt 审计）', Boolean(byId(g.id).proposal?.usedAt));
    ok('answer 记了 yes', byId(g.id).proposal?.answer === 'yes');
    ok('history 记了 from/to', byId(g.id).history.some((h) => h.from === 'active' && h.to === 'completed'));
    ok('history 的 by 是 owner', byId(g.id).history.some((h) => h.by === 'owner'));
  }

  console.log('\n【④ kind 不匹配 → KIND_MISMATCH】');
  {
    resetCs();
    const g = mkGoal('A', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete', reason: 'x' });
    cs.markConfirmationAsked(g.id, { roundId: 'r' });
    cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    // answer yes 已经执行了 complete。换一条测不匹配
    resetCs();
    const g2 = mkGoal('B', 'user_directed');
    cs.proposeCompletion(g2.id, { kind: 'complete', reason: 'x' });
    cs.markConfirmationAsked(g2.id, { roundId: 'r' });
    // 手工把 answer 设成 yes 但不执行（模拟异常状态）
    const st = readCs();
    st.goals.find((x) => x.id === g2.id).proposal.answer = 'yes';
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');
    const r = cs.cancelGoal(g2.id, { by: 'autonomous' });
    ok('**proposal 是 complete，不能当 cancel 执行**', r.code === 'KIND_MISMATCH', r.code);
  }

  console.log('\n【⑤ 提议不改状态】');
  {
    resetCs();
    const g = mkGoal('提议测试', 'user_directed');
    const before = byId(g.id).status;
    cs.proposeCompletion(g.id, { kind: 'complete', reason: '觉得可以' });
    ok('状态没变', byId(g.id).status === before);
    const p = byId(g.id).proposal;
    ok('有 proposal', Boolean(p));
    ok('kind 对', p.kind === 'complete');
    ok('**askedAt 是 null（还没问）**', p.askedAt === null, String(p.askedAt));
    ok('**expiresAt 是 null（未询问不启动倒计时）**', p.expiresAt === null, String(p.expiresAt));
    ok('answer 是空串', p.answer === '');
  }

  console.log('\n【⑥ 问了才开始倒计时】');
  {
    resetCs();
    const g = mkGoal('倒计时测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete' });
    const r1 = cs.markConfirmationAsked(g.id, { roundId: 'round-abc' });
    ok('第一次 shouldAsk: true', r1.shouldAsk === true);
    const p = byId(g.id).proposal;
    ok('写了 askedAt', Boolean(p.askedAt));
    ok('**写了 askedRound**', p.askedRound === 'round-abc', p.askedRound);
    ok('**写了 expiresAt**', Boolean(p.expiresAt));
    // 7 天左右
    const days = (Date.parse(p.expiresAt) - Date.parse(p.askedAt)) / 86400e3;
    ok('**expiresAt 是 askedAt + 7 天**', Math.abs(days - 7) < 0.01, String(days));

    const r2 = cs.markConfirmationAsked(g.id, { roundId: 'round-xyz' });
    ok('第二次 shouldAsk: false', r2.shouldAsk === false);
    ok('askedRound 没被覆盖', byId(g.id).proposal.askedRound === 'round-abc');
  }

  console.log('\n【⑦ 覆盖 proposal 不继承旧字段】');
  {
    resetCs();
    const g = mkGoal('覆盖测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete', reason: '第一次' });
    cs.markConfirmationAsked(g.id, { roundId: 'r1' });
    cs.answerConfirmation(g.id, { answer: 'no', quote: '还不行' });
    // no 之后 proposal 被清，重新提议
    ok('答 no 后 proposal 是 null', byId(g.id).proposal === null);
    cs.proposeCompletion(g.id, { kind: 'cancel', reason: '第二次' });
    const p = byId(g.id).proposal;
    ok('新 proposal 的 kind 是 cancel', p.kind === 'cancel');
    ok('**askedAt 被重置为 null**', p.askedAt === null);
    ok('**answer 被重置为空**', p.answer === '');
    ok('**answerQuote 被重置为空**', p.answerQuote === '');
    ok('**expiresAt 被重置为 null**', p.expiresAt === null);

    // 覆盖时不继承（同一个 proposal 再提一次）
    cs.markConfirmationAsked(g.id, { roundId: 'r2' });
    cs.proposeCompletion(g.id, { kind: 'supersede', reason: '第三次' });
    const p2 = byId(g.id).proposal;
    ok('**同一条上覆盖也重置 askedAt**', p2.askedAt === null, String(p2.askedAt));
    ok('kind 变 supersede', p2.kind === 'supersede');
  }

  console.log('\n【⑧ 过期：只清 proposal，状态不变】');
  {
    resetCs();
    const g = mkGoal('过期测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete' });
    cs.markConfirmationAsked(g.id, { roundId: 'r' });
    // 手工把 expiresAt 改到过去
    const st = readCs();
    st.goals.find((x) => x.id === g.id).proposal.expiresAt = new Date(Date.now() - 86400e3).toISOString();
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');

    const r = cs.expireProposals();
    ok('expireProposals 返回 expired 列表', r.ok === true && r.expired.includes(g.id), JSON.stringify(r));
    ok('**proposal 被清掉**', byId(g.id).proposal === null);
    ok('**状态仍是 active**', byId(g.id).status === 'active');
  }

  console.log('\n【⑨ 过期后回答 → PROPOSAL_EXPIRED（不是 NO_PROPOSAL）】');
  {
    resetCs();
    const g = mkGoal('过期回答测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete' });
    cs.markConfirmationAsked(g.id, { roundId: 'r' });
    const st = readCs();
    st.goals.find((x) => x.id === g.id).proposal.expiresAt = new Date(Date.now() - 86400e3).toISOString();
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');

    const r = cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('**返回 PROPOSAL_EXPIRED**', r.code === 'PROPOSAL_EXPIRED', r.code);
    ok('不是 NO_PROPOSAL', r.code !== 'NO_PROPOSAL');
    ok('状态没变', byId(g.id).status === 'active');
    ok('**proposal 被清掉**', byId(g.id).proposal === null);
  }

  console.log('\n【⑩ 过期后不能执行】');
  {
    resetCs();
    const g = mkGoal('过期执行测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete' });
    cs.markConfirmationAsked(g.id, { roundId: 'r' });
    const st = readCs();
    st.goals.find((x) => x.id === g.id).proposal.expiresAt = new Date(Date.now() - 86400e3).toISOString();
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');
    // 手工塞一个 yes（模拟异常状态）
    const st2 = readCs();
    st2.goals.find((x) => x.id === g.id).proposal.answer = 'yes';
    fs.writeFileSync(CS, JSON.stringify(st2), 'utf8');

    const r = cs.completeGoal(g.id, { by: 'owner' });
    ok('**过期 proposal 不能执行**', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('状态没变', byId(g.id).status === 'active');
  }

  console.log('\n【⑪ NO_PROPOSAL：回答时没有 proposal】');
  {
    resetCs();
    const g = mkGoal('没有提议', 'user_directed');
    const r = cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('**返回 NO_PROPOSAL**', r.code === 'NO_PROPOSAL', r.code);
    ok('和 CONFIRMATION_REQUIRED 不同', r.code !== 'CONFIRMATION_REQUIRED');
  }

  console.log('\n【⑫ 幂等：重复 yes 不重复写 history】');
  {
    resetCs();
    const g = mkGoal('幂等测试', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete' });
    cs.markConfirmationAsked(g.id, { roundId: 'r' });
    cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    const h1 = byId(g.id).history.length;

    // proposal 的审计信息在调 completeGoal 之前验证（endGoal 成功后会把 proposal 清掉）

    // 再调一次 completeGoal（已经是 completed）
    const r2 = cs.completeGoal(g.id, { by: 'owner' });
    ok('第二次是幂等（ok）', r2.ok === true, JSON.stringify(r2).slice(0, 120));
    ok('**history 没增加**', byId(g.id).history.length === h1, `${h1} → ${byId(g.id).history.length}`);

    // 再 answer 一次（proposal 已经没了）
    const r3 = cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    // 2.6.3 补丁：proposal 保留做审计，所以再回答会走到 TERMINAL_STATE（已终态）
    ok('再回答不会重复执行', r3.ok === false && ['NO_PROPOSAL', 'TERMINAL_STATE'].includes(r3.code), r3.code);
    ok('history 还是没增加', byId(g.id).history.length === h1);
  }

  console.log('\n【⑬ 终态不能提议 / 不能执行】');
  {
    resetCs();
    const a = mkGoal('A', 'autonomous');
    cs.completeGoal(a.id, { by: 'autonomous' });
    ok('**终态不能提议**', cs.proposeCompletion(a.id, { kind: 'cancel' }).code === 'TERMINAL_STATE');
    const r = cs.cancelGoal(a.id, { by: 'autonomous' });
    ok('**终态不能执行别的操作**', r.code === 'TERMINAL_STATE', r.code);
  }

  console.log('\n【⑭ clearGoal 方案 B】');
  {
    resetCs();
    // autonomous → 能清
    const a = mkGoal('自主的', 'autonomous');
    const r1 = cs.clearGoal({ source: 'autonomous' });
    ok('autonomous 的能清', r1.ok === true, JSON.stringify(r1));
    ok('状态变 completed', byId(a.id).status === 'completed');

    // user_directed → 清不掉
    resetCs();
    const b = mkGoal('老大交代的', 'user_directed');
    const r2 = cs.clearGoal({ source: 'autonomous' });
    ok('**user_directed 清不掉**', r2.ok === false, JSON.stringify(r2).slice(0, 120));
    ok('**错误码 CONFIRMATION_REQUIRED**', r2.code === 'CONFIRMATION_REQUIRED', r2.code);
    ok('状态仍是 active', byId(b.id).status === 'active');

    // 没有 active → skipped
    resetCs();
    const r3 = cs.clearGoal({ source: 'autonomous' });
    ok('没有 active 时返回 skipped', r3.ok === true && r3.skipped === 'no-active-goal', JSON.stringify(r3));
  }

  console.log('\n【⑮ 非法参数】');
  {
    resetCs();
    const g = mkGoal('参数测试', 'user_directed');
    ok('propose kind 非法', cs.proposeCompletion(g.id, { kind: 'bogus' }).code === 'INVALID_KIND');
    ok('propose 不存在的 id', cs.proposeCompletion('g-nope', { kind: 'complete' }).code === 'NOT_FOUND');
    ok('answer 非法值', cs.answerConfirmation(g.id, { answer: 'bogus' }).code === 'INVALID_ANSWER');
    ok('markAsked 不存在的 id', cs.markConfirmationAsked('g-nope').code === 'NOT_FOUND');
    ok('markAsked 没有 proposal', cs.markConfirmationAsked(g.id).code === 'NO_PROPOSAL');
  }

  console.log('\n【⑯ createGoal 清掉旧 proposal】');
  {
    resetCs();
    const g = mkGoal('有提议的方向', 'user_directed');
    cs.proposeCompletion(g.id, { kind: 'complete', reason: 'x' });
    ok('有 proposal', Boolean(byId(g.id).proposal));
    // 用同样文本再 create（走 sameActive 分支）
    cs.createUserGoal({ text: '有提议的方向' });
    ok('**同文本 create 清掉了旧 proposal**', byId(g.id).proposal === null);
  }

  console.log('\n【⑰ 并发：两进程同时 propose】');
  {
    resetCs();
    const g = mkGoal('并发提议', 'user_directed');
    const run = (tag, kind) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\ncs.proposeCompletion('${g.id}', { kind: '${kind}', reason: '${tag}' });\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });

    const [ca, cb] = await Promise.all([run('p1', 'complete'), run('p2', 'cancel')]);
    ok('两个进程正常退出', ca === 0 && cb === 0);
    const p = byId(g.id).proposal;
    ok('**只有一个 proposal**', Boolean(p));
    ok('**kind 是其中之一（后覆盖前）**', p.kind === 'complete' || p.kind === 'cancel', p.kind);
    ok('文件能解析', Boolean(readCs().version));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
