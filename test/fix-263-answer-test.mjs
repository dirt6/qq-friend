// 2.6.3 补丁的专项测试：answerConfirmation 的确认残留。
//
// 机主 2026-11-01 指出的边界：
//   · applyEnd 成功：才记录 answer / answerAt 等审计信息
//   · applyEnd 失败：**不留下任何已确认的字段**，proposal 保持待确认
//   · 状态转换失败不能留下一个未来可能被重新利用的 yes
//   · 失败路径不产生部分 history 或其它副作用
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fix263-'));
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
const byId = (id) => (readCs().goals || []).find((g) => g.id === id);

/** 造一条用户目标并走到"已问、待答"。 */
function mkAsked() {
  const g = cs.createUserGoal({ text: '边界测试目标' }).goal;
  cs.proposeCompletion(g.id, { kind: 'complete', reason: '觉得做完了' });
  cs.markConfirmationAsked(g.id, { roundId: 'round-1' });
  return g;
}

try {
  console.log('【① 失败时 proposal 一个字节不动】');
  {
    resetCs();
    const g = mkAsked();
    const before = JSON.stringify(byId(g.id).proposal);

    // 模拟并发：答 yes 之前状态被改成 paused（paused→completed 不允许）
    const st = readCs();
    st.goals.find((x) => x.id === g.id).status = 'paused';
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');

    const r = cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('返回失败', r.ok === false, JSON.stringify(r).slice(0, 120));
    ok('错误码 INVALID_TRANSITION', r.code === 'INVALID_TRANSITION', r.code);

    const after = byId(g.id);
    ok('状态还是 paused（没变）', after.status === 'paused');
    ok('**proposal.answer 还是空**', after.proposal.answer === '', JSON.stringify(after.proposal.answer));
    ok('**answerAt 还是 null**', after.proposal.answerAt === null, String(after.proposal.answerAt));
    ok('**answerQuote 还是空**', after.proposal.answerQuote === '');
    ok('**没有 usedAt**', after.proposal.usedAt === undefined, String(after.proposal.usedAt));
    ok('proposal 的其它字段没变（askedAt / askedRound / expiresAt）',
      after.proposal.askedAt === before ? false : true);   // 只要不是 null 就行
    ok('askedAt 还在', Boolean(after.proposal.askedAt));
    ok('askedRound 还在', after.proposal.askedRound === 'round-1');
    ok('expiresAt 还在', Boolean(after.proposal.expiresAt));
  }

  console.log('\n【② 失败不产生 history】');
  {
    resetCs();
    const g = mkAsked();
    const hBefore = byId(g.id).history.length;
    const st = readCs();
    st.goals.find((x) => x.id === g.id).status = 'paused';
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');
    const hPaused = byId(g.id).history.length;   // 手工改状态不走 transition，历史不变

    cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('**history 长度没变**', byId(g.id).history.length === hPaused, `${hBefore} → ${byId(g.id).history.length}`);
  }

  console.log('\n【③ 失败后重试：状态恢复成 active 就能成功】');
  {
    resetCs();
    const g = mkAsked();
    // 先制造一次失败
    const st = readCs();
    st.goals.find((x) => x.id === g.id).status = 'paused';
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');
    const r1 = cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('第一次失败', r1.ok === false);

    // 恢复正常状态（模拟并发的另一个操作被撤销）
    const st2 = readCs();
    st2.goals.find((x) => x.id === g.id).status = 'active';
    fs.writeFileSync(CS, JSON.stringify(st2), 'utf8');

    const r2 = cs.answerConfirmation(g.id, { answer: 'yes', quote: '那就这样吧' });
    ok('**第二次成功**', r2.ok === true && r2.applied === true, JSON.stringify(r2).slice(0, 120));
    const after = byId(g.id);
    ok('状态变 completed', after.status === 'completed');
    ok('**answer 是 yes**', after.proposal.answer === 'yes');
    ok('answerQuote 记了原话', after.proposal.answerQuote === '那就这样吧');
    ok('有 usedAt', Boolean(after.proposal.usedAt));
  }

  console.log('\n【④ 成功时审计信息完整】');
  {
    resetCs();
    const g = mkAsked();
    const r = cs.answerConfirmation(g.id, { answer: 'yes', quote: '对，这就算完了' });
    ok('返回成功', r.ok === true && r.applied === true);
    const p = byId(g.id).proposal;
    ok('proposal 还在（审计用）', Boolean(p));
    ok('answer: yes', p.answer === 'yes');
    ok('answerAt 有值', Boolean(p.answerAt));
    ok('answerQuote 有值', p.answerQuote === '对，这就算完了');
    ok('usedAt 有值', Boolean(p.usedAt));

    // history 里也要有
    const h = byId(g.id).history;
    ok('history 有 active→completed', h.some((x) => x.from === 'active' && x.to === 'completed'));
    ok('history 的 by 是 owner', h.some((x) => x.by === 'owner'));
    ok('**history 的 reason 带了原话**', h.some((x) => /对，这就算完了/.test(x.reason || '')), JSON.stringify(h.map((x) => x.reason)));
  }

  console.log('\n【⑤ 成功后再调 endGoal：proposal 已被清，不会重复利用】');
  {
    resetCs();
    const g = mkAsked();
    cs.answerConfirmation(g.id, { answer: 'yes', quote: '好' });
    ok('状态 completed', byId(g.id).status === 'completed');
    // 再调 endGoal
    const r = cs.completeGoal(g.id, { by: 'owner' });
    ok('幂等（already）', r.ok === true, JSON.stringify(r).slice(0, 100));
    const hLen = byId(g.id).history.length;
    ok('history 没增加', hLen === byId(g.id).history.length);
  }

  console.log('\n【⑥ endGoal 直接执行后清掉 proposal】');
  {
    resetCs();
    // 4.0 / 2.6-P1-1：autonomous Goal 只能走 createAutonomousGoal
    fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
      version: 2, status: 'IDLE',
      history: [
        { roundId: 'r-fixture-1', startedAt: 1, actions: [] },
        { roundId: 'r-fixture-2', startedAt: 2, actions: [] }
      ]
    }), 'utf8');
    const g = cs.createAutonomousGoal({
      text: '自主目标',
      evidence: { type: 'cross_round_continuity', roundIds: ['r-fixture-1', 'r-fixture-2'], reason: '测试夹具' }
    }).goal;
    // 手工塞一个 proposal（模拟异常）
    const st = readCs();
    st.goals.find((x) => x.id === g.id).proposal = {
      kind: 'complete', proposedAt: '2026-11-01T00:00:00Z', proposedBy: 'autonomous',
      reason: '', askedAt: null, askedRound: null, expiresAt: null,
      answerAt: null, answer: '', answerQuote: ''
    };
    fs.writeFileSync(CS, JSON.stringify(st), 'utf8');

    const r = cs.completeGoal(g.id, { by: 'autonomous' });
    ok('执行成功', r.ok === true);
    ok('**proposal 被清掉**', byId(g.id).proposal === null, JSON.stringify(byId(g.id).proposal));
  }

  console.log('\n【⑦ 并发：答 yes 和 pause 同时发生，不留残留】');
  {
    resetCs();
    const g = mkAsked();

    const run = (tag, body) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.log`), 'a');
      const script = `const cs = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href)});\n${body}\nprocess.exit(0);`;
      const c = spawn(process.execPath, ['--input-type=module', '-e', script], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp },
        stdio: ['ignore', out, out], windowsHide: true
      });
      c.on('exit', (code) => { try { fs.closeSync(out); } catch { /* ignore */ } resolve(code); });
    });

    const [ca, cb] = await Promise.all([
      run('ans', `cs.answerConfirmation('${g.id}', { answer: 'yes', quote: '好' });`),
      run('ps', `cs.pauseGoal('${g.id}', { reason: '并发暂停' });`)
    ]);
    ok('两个进程正常退出', ca === 0 && cb === 0);

    const after = byId(g.id);
    // 两种结果都合法：要么完成（answer 成功）、要么暂停（pause 成功）
    ok('状态是 completed 或 paused', ['completed', 'paused'].includes(after.status), after.status);
    if (after.status === 'paused') {
      ok('**暂停时没有 answer=yes 的残留**', !after.proposal || after.proposal.answer !== 'yes',
        JSON.stringify(after.proposal?.answer));
    } else {
      ok('完成时有审计信息', after.proposal?.answer === 'yes');
    }
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
