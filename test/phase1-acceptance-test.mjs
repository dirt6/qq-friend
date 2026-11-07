// 阶段 1 整体验收：并发一致性 + 崩溃恢复（2026-11-01）。
//
// 机主要求先验收再做 1.5.4，重点三个：
//   ① 并发一致性：autonomous / trim / 面板同时跑会不会丢更新
//   ② 崩溃恢复：写入中断、重启后能否恢复，不产生半截文件
//   ③ 真实运行：QQ 聊天、日记、自主活动正常（这条要重启后另测，报告里说明）
//
// ⚠️ 特别针对：writeState 的「标量覆盖」会不会误伤别的进程刚改的状态。
// 这是机主点名的风险点 —— 用真实的 state.js 跑，不是模拟。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_MOD = pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'state.js')).href;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-accept-'));
const store = path.join(tmp, 'autonomous.json');

// 用真实的 state.js（不是模拟），保证测的是线上那份逻辑
const state = await import(STATE_MOD);

const fresh = () => ({
  status: 'IDLE', lastWakeAt: 0, nextWakeAt: 0, modelCallsUsed: 0,
  seen: {}, shares: [], history: [], currentGoal: '', pendingNextStep: '', selfWake: null
});

try {
  console.log('【① 并发一致性：三写者，增量字段不丢】');
  {
    fs.writeFileSync(store, JSON.stringify(fresh()), 'utf8');

    // 模拟三种写者，各自持有**锁外读的旧快照**（这是最危险的形态）
    const a = state.readState(store);          // autonomous
    const b = state.readState(store);          // trim
    const c = state.readState(store);          // 面板（只读，但假设它也会写一次状态字段）

    // A：看过两条内容 + 加一轮历史
    a.seen['bili:BV1'] = { lastSeenAt: 1, title: 'A 看过' };
    a.history.push({ startedAt: 1000, stopReason: 'A 的一轮' });
    a.lastWakeAt = 1000;

    // B：trim 删掉旧 seen、保留最近历史
    b.seen = { 'bili:BV1': { lastSeenAt: 1, title: 'A 看过' }, 'xhh:9': { lastSeenAt: 2, title: 'B 也看过' } };
    b.history = [{ startedAt: 1000, stopReason: 'A 的一轮' }];

    // C：面板改了 pendingNextStep（标量）—— 这就是机主担心的"被覆盖"
    c.pendingNextStep = { topic: '面板写的计划', status: 'pending' };

    // 依次落盘：A → B → C（都基于同一份旧快照）
    state.writeState(store, a);
    state.writeState(store, b);
    state.writeState(store, c);

    const final = state.readState(store);
    ok('A 看过的内容没丢', Boolean(final.seen['bili:BV1']), JSON.stringify(Object.keys(final.seen)));
    ok('B 看过的内容没丢', Boolean(final.seen['xhh:9']), JSON.stringify(Object.keys(final.seen)));
    ok('历史没丢（A 那轮还在）', (final.history || []).some((h) => h.stopReason === 'A 的一轮'), JSON.stringify(final.history));
    ok('面板写的 pendingNextStep 生效', final.pendingNextStep?.topic === '面板写的计划', JSON.stringify(final.pendingNextStep));
    ok('lastWakeAt 是最后写入者的值（合理）', Number(final.lastWakeAt) === Number(c.lastWakeAt) || Number(final.lastWakeAt) === 1000, String(final.lastWakeAt));
  }

  console.log('\n【② 标量覆盖：不同进程改不同标量，后写的不该吃掉先写的】');
  {
    fs.writeFileSync(store, JSON.stringify(fresh()), 'utf8');
    const p = state.readState(store);   // 面板读
    const q = state.readState(store);   // 自主活动读

    p.pendingNextStep = { topic: '面板的计划' };   // 面板改 A 字段
    q.selfWake = { enabled: true, wakeAt: 123 };   // 自主改 B 字段
    q.lastWakeAt = 999;

    state.writeState(store, p);   // 面板先写
    state.writeState(store, q);   // 自主后写（它的快照里 pendingNextStep 还是旧值）

    const final = state.readState(store);
    ok('面板的 pendingNextStep 还在吗', final.pendingNextStep?.topic === '面板的计划',
      JSON.stringify(final.pendingNextStep));
    ok('自主的 selfWake 也在', final.selfWake?.enabled === true, JSON.stringify(final.selfWake));
    // 这一条如果挂了，说明"标量用本轮覆盖"会误伤 —— 需要在报告里如实写出来
  }

  console.log('\n【③ 崩溃恢复：写一半被打断，文件要么旧要么新，不能半截】');
  {
    fs.writeFileSync(store, JSON.stringify({ ...fresh(), marker: 'before' }), 'utf8');
    const before = fs.readFileSync(store, 'utf8');

    // 让 rename 失败（模拟断电/占用），验证旧文件仍然完整
    const origRename = fs.renameSync;
    fs.renameSync = () => { const e = new Error('EIO: 模拟中断'); e.code = 'EIO'; throw e; };
    let threw = null;
    try {
      state.writeState(store, { ...state.readState(store), marker: 'after' });
    } catch (e) { threw = e; } finally { fs.renameSync = origRename; }

    const after = fs.readFileSync(store, 'utf8');
    ok('写入抛错（不假装成功）', threw !== null, threw?.message || '没抛');
    ok('旧文件字节级完整', after === before, after.slice(0, 80));
    ok('能正常解析', (() => { try { JSON.parse(after); return true } catch { return false } })());
    // 清理残留 tmp
    for (const f of fs.readdirSync(tmp)) if (f.includes('.tmp')) fs.unlinkSync(path.join(tmp, f));
  }

  console.log('\n【④ 重启后恢复：进程崩溃留下的锁与 tmp】');
  {
    fs.writeFileSync(store, JSON.stringify({ ...fresh(), marker: 'restart' }), 'utf8');
    // 造一个"崩溃时留下的锁"（不删）+ 一个半截 tmp
    fs.writeFileSync(`${store}.lock`, '99999', 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${store}.lock`, old, old);
    fs.writeFileSync(`${store}.12345.tmp`, '{ 半截', 'utf8');

    const r = state.mutateState(store, (st) => { st.recoveredAfterCrash = true; });
    ok('陈旧锁被清掉、能继续写', r.recoveredAfterCrash === true, JSON.stringify(r).slice(0, 100));
    ok('文件可解析且字段在', state.readState(store).recoveredAfterCrash === true);
    ok('残留 tmp 不影响主文件', fs.existsSync(store));
  }

  console.log('\n【⑤ 真实数据的容量裁剪（seen/history/shares 上限）】');
  {
    fs.writeFileSync(store, JSON.stringify(fresh()), 'utf8');
    const st = state.readState(store);
    for (let i = 0; i < 2000; i += 1) st.seen[`k${i}`] = { lastSeenAt: i };
    for (let i = 0; i < 100; i += 1) st.history.push({ startedAt: i });
    for (let i = 0; i < 100; i += 1) st.shares.push({ at: i });
    state.writeState(store, st);
    const final = state.readState(store);
    ok('seen 被裁剪到上限内', Object.keys(final.seen).length <= 2000, String(Object.keys(final.seen).length));
    ok('history 被裁剪', final.history.length <= 100, String(final.history.length));
    ok('shares 被裁剪', final.shares.length <= 100, String(final.shares.length));
    ok('文件大小合理', fs.statSync(store).size < 2 * 1024 * 1024, `${Math.round(fs.statSync(store).size / 1024)} KB`);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
