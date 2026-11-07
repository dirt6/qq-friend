// 阶段 2.6-B5a 专项测试：Round 摘要（历史的索引）。
//
// 机主授权（2026-11-02）：
//   · B5a 只提取和保存轻量摘要，**不创建 Goal，也不调用模型**
//   · digest 至少有 { roundId, createdAt, status, intent, actions[{action, objective, result}] }
//   · objective 对应现有 actions[].goal，只是 digest 内部的清晰命名，**不改原字段**
//   · 跳过：rec.error 非空 / 记录未落盘 / Action 结构异常 / 无有效 Action / 历史读取失败
//   · 幂等：同一 roundId 不重复
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b5a-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const dg = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'round-digest.js')).href);

/** 造一份正常的 rec。 */
function mkRec(over = {}) {
  return {
    roundId: 'round-test-1',
    startedAt: Date.now(),
    endedAt: Date.now() + 1000,
    status: 'IDLE',
    error: '',
    stopReason: '完成',
    intent: { intent: 'explore', goal: '翻榜单看看', why: '闲' },
    actions: [
      { action: 'chat', goal: '问老大回来没', result: 'success' },
      { action: 'diary', goal: '写一句日记', result: 'success' }
    ],
    ...over
  };
}

try {
  console.log('【① buildDigest：正常轮次】');
  {
    const d = dg.buildDigest(mkRec());
    ok('返回对象', Boolean(d));
    ok('有 roundId', d.roundId === 'round-test-1');
    ok('有 createdAt（ISO）', /^\d{4}-\d{2}-\d{2}T/.test(d.createdAt), d.createdAt);
    ok('有 status', d.status === 'IDLE');
    ok('有 intent', d.intent?.intent === 'explore' && d.intent?.goal === '翻榜单看看');
    ok('有 actions', d.actions.length === 2);
    ok('**actions[].objective 来自 goal**', d.actions[0].objective === '问老大回来没', d.actions[0].objective);
    ok('有 action 名字', d.actions[0].action === 'chat');
    ok('有 result', d.actions[0].result === 'success');
    ok('有 stopReason', d.stopReason === '完成');
  }

  console.log('\n【② 跳过：异常轮次（rec.error 非空）】');
  {
    ok('**返回 null**', dg.buildDigest(mkRec({ error: '模型超时' })) === null);
    ok('空字符串 error 不算异常', Boolean(dg.buildDigest(mkRec({ error: '' }))));
    ok('只有空白的 error 也算异常', dg.buildDigest(mkRec({ error: '   ' })) === null);
  }

  console.log('\n【③ 跳过：没有 roundId】');
  {
    ok('**返回 null**', dg.buildDigest(mkRec({ roundId: '' })) === null);
    ok('undefined 也返回 null', dg.buildDigest(mkRec({ roundId: undefined })) === null);
  }

  console.log('\n【④ 跳过：actions 不是数组】');
  {
    ok('**返回 null**', dg.buildDigest(mkRec({ actions: null })) === null);
    ok('字符串也返回 null', dg.buildDigest(mkRec({ actions: 'not-array' })) === null);
  }

  console.log('\n【⑤ 跳过：没有有效 Action】');
  {
    ok('空数组返回 null', dg.buildDigest(mkRec({ actions: [] })) === null);
    ok('全是空对象返回 null', dg.buildDigest(mkRec({ actions: [{}, null] })) === null);
    ok('没有 action 名字的返回 null', dg.buildDigest(mkRec({ actions: [{ goal: 'x', result: 'success' }] })) === null);
  }

  console.log('\n【⑥ 跳过：rec 本身非法】');
  {
    ok('null 返回 null', dg.buildDigest(null) === null);
    ok('undefined 返回 null', dg.buildDigest(undefined) === null);
    ok('字符串返回 null', dg.buildDigest('x') === null);
  }

  console.log('\n【⑦ 文本裁剪】');
  {
    const long = 'x'.repeat(500);
    const d = dg.buildDigest(mkRec({
      actions: [{ action: 'chat', goal: long, result: 'success' }]
    }));
    ok('**objective 被裁剪到 120**', d.actions[0].objective.length === 120, String(d.actions[0].objective.length));
  }

  console.log('\n【⑧ Action 数量上限】');
  {
    const many = Array.from({ length: 30 }, (_, i) => ({ action: 'chat', goal: 'g' + i, result: 'success' }));
    const d = dg.buildDigest(mkRec({ actions: many }));
    ok('**最多 12 个**', d.actions.length === 12, String(d.actions.length));
  }

  console.log('\n【⑨ appendDigest：幂等】');
  {
    const d = dg.buildDigest(mkRec());
    const r1 = dg.appendDigest([], d);
    ok('第一次 added: true', r1.added === true && r1.list.length === 1);
    const r2 = dg.appendDigest(r1.list, d);
    ok('**同 roundId added: false**', r2.added === false && r2.list.length === 1);

    const d2 = dg.buildDigest(mkRec({ roundId: 'round-test-2' }));
    const r3 = dg.appendDigest(r1.list, d2);
    ok('不同 roundId 能加', r3.added === true && r3.list.length === 2);
  }

  console.log('\n【⑩ appendDigest：上限 50 条】');
  {
    let list = [];
    for (let i = 0; i < 60; i += 1) {
      const d = dg.buildDigest(mkRec({ roundId: 'r-' + i }));
      list = dg.appendDigest(list, d).list;
    }
    ok('**最多 50 条**', list.length === 50, String(list.length));
    ok('**留下的是最近的**', list[list.length - 1].roundId === 'r-59');
    ok('最老的被丢了', !list.some((x) => x.roundId === 'r-0'));
  }

  console.log('\n【⑪ recentDigests / hasDigest】');
  {
    let list = [];
    for (let i = 0; i < 5; i += 1) {
      const d = dg.buildDigest(mkRec({ roundId: 'r-' + i, startedAt: Date.now() + i * 1000 }));
      list = dg.appendDigest(list, d).list;
    }
    const recent = dg.recentDigests(3, list);
    ok('**返回最近 3 轮**', recent.length === 3, String(recent.length));
    ok('按时间正序', recent[recent.length - 1].roundId === 'r-4');
    ok('hasDigest 命中', dg.hasDigest('r-1', list) === true);
    ok('hasDigest 未命中', dg.hasDigest('r-99', list) === false);
    ok('空 roundId 返回 false', dg.hasDigest('', list) === false);
  }

  console.log('\n【⑫ readDigests：读失败给空数组】');
  {
    ok('文件不存在给 []', Array.isArray(dg.readDigests(path.join(tmp, 'nope.json'))));
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{ 坏的', 'utf8');
    ok('坏文件给 []', Array.isArray(dg.readDigests(path.join(tmp, 'bad.json'))));
  }

  console.log('\n【⑬ digest 不调模型、不建 Goal（源码级）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'lib', 'round-digest.js'), 'utf8');
    ok('**没有 import llm**', !/from '.*llm\.js'/.test(src));
    ok('**没有 import companion/state**', !/companion\/state/.test(src));
    ok('**没有调 createAutonomousGoal**', !src.includes('createAutonomousGoal'));
    ok('没有调 createGoal', !src.includes('createGoal'));
  }

  console.log('\n【⑭ 接入点：finish 里 pushHistory 之后、writeState 之前】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const iPush = src.indexOf('pushHistory(st, rec);');
    const iDigest = src.indexOf('4.0 / 2.6-B5a：把这一轮整理成轻量 digest');
    const iWrite = src.indexOf('writeState(STORE, st)', iPush);
    ok('**digest 在 pushHistory 之后**', iDigest > iPush, `${iPush} -> ${iDigest}`);
    ok('**digest 在 writeState 之前**（和 history 一起落盘）', iDigest < iWrite, `${iDigest} < ${iWrite}`);
    ok('包在 try/catch 里（失败不影响本轮）', src.slice(iDigest - 60, iDigest + 400).includes('catch'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
