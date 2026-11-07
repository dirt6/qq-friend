// 自主活动记忆接通的验收测试（2026-10-31 按机主给的规格逐条对）。
//
// 这些断言故意写得"死"一点：这套东西的价值就在于**不把没做的事写成做了**，
// 措辞一旦松掉，日记和上下文里就会出现她根本没经历过的"事实"。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
const {
  activityMemory, buildAutonomousNote, isActivityRecorded, appendDiaryLine
} = await import('../plugins/autonomous/index.js');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const BASE = {
  goal: '把部署的那个坑提醒给老大',
  why: '他正在搞部署，这个坑可能撞上',
  next: '看他回不回，回了就接着聊'
};

console.log('【1. chat：记下想做什么、以及为什么】');
{
  const m = activityMemory({ ...BASE, action: 'chat', chat: '老大你看这个', shareMode: 'live' });
  ok('有记录', !!m);
  ok('是「已发」状态', m.status === 'sent', m.status);
  ok('日记里有"说了句话"', m.diary.includes('说了句话'), m.diary);
  ok('日记里有原因', m.diary.includes('正在搞部署'), m.diary);
  ok('摘要里也有原因', m.summary.includes('部署'), m.summary);
}

console.log('\n【2. share：已分享 vs 计划分享必须分开】');
{
  const sent = activityMemory({ ...BASE, action: 'share', picked: '帖子A（https://x）', shareMode: 'live' });
  const dry = activityMemory({ ...BASE, action: 'share', picked: '帖子A（https://x）', shareMode: 'dryRun' });
  const quiet = activityMemory({ ...BASE, action: 'share', picked: '帖子A（https://x）', shareMode: 'quiet' });
  const failed = activityMemory({ ...BASE, action: 'share', picked: '帖子A（https://x）', shareMode: 'failed' });

  ok('真发：说"拎给老大看了"', sent.diary.includes('拎给老大看了'), sent.diary);
  ok('真发：状态 sent', sent.status === 'sent');
  ok('演练：不说已发', !dry.diary.includes('拎给老大看了'), dry.diary);
  ok('演练：说明演练里没发', dry.diary.includes('演练里没发'), dry.diary);
  ok('演练：状态 unsent', dry.status === 'unsent');
  ok('安静时段：说明没发', quiet.diary.includes('安静时段没发'), quiet.diary);
  ok('发送失败：说明发失败了', failed.diary.includes('发失败'), failed.diary);
  ok('三种没发成的情况都不含"拎给老大看了"',
    ![dry, quiet, failed].some((m) => m.diary.includes('拎给老大看了')));
}

console.log('\n【3. 下一次对话能看到摘要】');
{
  const now = Date.now();
  const acts = [
    { ...BASE, action: 'share', picked: '帖子A（https://x）', shareMode: 'live', endedAt: now - 2000 },
    { ...BASE, action: 'search', search: 'dsh 部署坑', endedAt: now - 1000 }
  ];
  const built = buildAutonomousNote(acts, { since: 0 });
  ok('生成了注入块', built.note.includes('你近期的自主活动经历'), built.note);
  ok('含第一条摘要', built.note.includes('帖子A'), built.note);
  ok('含第二条（还没搜的计划）', built.note.includes('还没搜'), built.note);
  ok('记录了注入到哪一刻', built.injectedUpTo === now - 1000, String(built.injectedUpTo));
  ok('两条都进去了', built.count === 2, String(built.count));
}

console.log('\n【4. 未完成的计划不能写成已完成】');
{
  const m = activityMemory({ ...BASE, action: 'share', picked: '帖子A', shareMode: 'live' });
  ok('日记带「下次想」', m.diary.includes('下次想'), m.diary);
  ok('hasPlan 为 true', m.hasPlan === true);

  const search = activityMemory({ ...BASE, action: 'search', search: 'dsh 部署坑' });
  ok('search 是计划状态', search.status === 'planned', search.status);
  ok('search 明说"还没搜"', search.summary.includes('还没搜'), search.summary);
  ok('search 日记说"下次醒来先搜"', search.diary.includes('下次醒来先搜'), search.diary);

  const now = Date.now();
  const built = buildAutonomousNote([{ ...BASE, action: 'chat', shareMode: 'live', endedAt: now }], { since: 0 });
  ok('摘要里标注「还没做完」', built.note.includes('还没做完'), built.note);
  ok('finish 不产生记忆', activityMemory({ ...BASE, action: 'finish' }) === null);
}

console.log('\n【5. 同一活动不重复写日记】');
{
  const rec = { ...BASE };
  ok('今天已经写过 → 判定重复', isActivityRecorded(rec, [{ text: `- 心情：想找人说话｜${BASE.goal.slice(0, 12)}了` }]));
  ok('没写过 → 不判重复', !isActivityRecorded(rec, [{ text: '- 心情：开心｜今天吃了面' }]));
  ok('goal 为空不误判', isActivityRecorded({}, [{ text: '随便什么' }]) === false);
}

console.log('\n【6. 写日记失败不能影响主流程】');
{
  // 拿一个「文件」当 root：往里建子目录必然失败（比不存在的盘符可靠）
  const asFile = path.join(os.tmpdir(), `not-a-dir-${Date.now()}`);
  fs.writeFileSync(asFile, 'x', 'utf8');
  const bad = appendDiaryLine({ content: '测试', root: asFile });
  ok('写失败返回 ok:false 而不是抛异常', bad && bad.ok === false, JSON.stringify(bad));
  ok('activityMemory 对空输入不抛', activityMemory({}) === null);
  ok('activityMemory 对畸形输入不抛', typeof activityMemory({ action: 'share' }) === 'object');
}

console.log('\n【7. 不增加模型调用】');
{
  const start = SRC.indexOf('export function activityMemory');
  const end = SRC.indexOf('export function recentActivity');
  const body = SRC.slice(start, end);
  ok('activityMemory 体内没有模型调用', !/callModel|callModelWithBudget|fetch\(|api\?\./.test(body));
  const start2 = SRC.indexOf('export function buildAutonomousNote');
  const end2 = SRC.indexOf('export function appendDiaryLine');
  const body2 = SRC.slice(start2, end2);
  ok('buildAutonomousNote 体内没有模型调用', !/callModel|callModelWithBudget|fetch\(|api\?\./.test(body2));
}

console.log('\n【8. 预算与频率没被动过】');
{
  ok('调度仍用 intervalHours', SRC.includes('nextWakeAt(rec.endedAt, s.intervalHours)'));
  ok('预算闸门还在', SRC.includes('budgetGate'));
  ok('每轮调用上限还在', SRC.includes('maxModelCalls'));
}

console.log('\n【9. 与 hotNote 不重复】');
{
  const now = Date.now();
  const acts = [{ ...BASE, action: 'chat', shareMode: 'live', endedAt: now - 1000 }];
  const covered = buildAutonomousNote(acts, { since: 0, hotCoveredUntil: now });
  ok('已被 hotNote 覆盖时不重复说"说了什么"', covered.note.includes('原文已经补进对话了'), covered.note);
  const notCovered = buildAutonomousNote(acts, { since: 0, hotCoveredUntil: 0 });
  ok('没覆盖时正常描述', notCovered.note.includes('主动跟老大说了句话'), notCovered.note);
}

console.log('\n【10. 过期计划不无限保留】');
{
  const now = Date.now();
  const old = [{ ...BASE, action: 'share', picked: '很久以前', shareMode: 'live', endedAt: now - 48 * 3600 * 1000 }];
  const built = buildAutonomousNote(old, { since: 0 });
  ok('48 小时前的活动不再注入', built.note === '', built.note);
  const recent = [{ ...BASE, action: 'share', picked: '新鲜', shareMode: 'live', endedAt: now - 3600 * 1000 }];
  ok('1 小时前的照常注入', buildAutonomousNote(recent, { since: 0 }).note.includes('新鲜'));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
