// 三层记忆里的「已学经验」层（src/learned.js）
//
// 锁六件事：
//   ① 入库会合并同义条目，不让「别每次叫老大」和「别每句话都叫老大」并存
//   ② 再犯会把状态打回 pending（之前"已验证"不可信了）
//   ③ 状态只能由机主升级 —— 她自己不能把「待验证」改成「已验证」
//   ④ 选取按 相关性 + 状态 + 时效 打分，不是"最新 N 条"
//   ⑤ 硬上限 15，默认只带 6
//   ⑥ 30 天没用的 stable 会归档（不删，检索时还能翻出来）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-learned-store-'));
process.env.QQ_AGENT_DATA_DIR = path.join(TMP, 'data');
const L = await import('../src/learned.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const reset = () => { try { fs.rmSync(L.LEARNED_FILE, { force: true }); } catch { /* ignore */ } };

console.log('入库与合并');
{
  reset();
  const a = L.addExperience({ text: '不要每次都叫老大', sourceDay: '2026-10-20' });
  ok('新增成功', a.ok && a.merged === false, JSON.stringify(a));
  ok('状态是待验证', L.listAll()[0].status === 'pending');

  const b = L.addExperience({ text: '别每句话都叫老大，称呼自然点', sourceDay: '2026-10-21' });
  ok('相似条目被合并，不新增', b.merged === true && b.corrections === 2, JSON.stringify(b));
  ok('库里仍然只有一条', L.listAll().length === 1, String(L.listAll().length));
  ok('文本更新成新表述', L.listAll()[0].text.includes('称呼自然点'));

  const c = L.addExperience({ text: '发图不要逐个解释画面', sourceDay: '2026-10-22' });
  ok('不相似的正常新增', c.merged === false && L.listAll().length === 2);
  ok('太短的拒绝', L.addExperience({ text: '好' }).ok === false);
}

console.log('状态机');
{
  const id = L.listAll()[0].id;
  ok('她自己不能升到已验证', L.setStatus(id, 'verified', { source: 'her' }).ok === false);
  ok('机主可以升到已验证', L.setStatus(id, 'verified', { source: 'owner' }).ok === true);
  ok('状态真的变了', L.listAll({ status: 'verified' }).length === 1);

  // 再犯：同一句被重新纠正 → 退回 pending
  L.addExperience({ text: '不要每次都叫老大，称呼自然点', sourceDay: '2026-10-23' });
  const again = L.listAll().find((x) => x.id === id);
  ok('再犯后状态退回待验证', again.status === 'pending', again.status);
  ok('再犯次数累加', again.corrections >= 3, String(again.corrections));
}

console.log('选取');
{
  reset();
  L.addExperience({ text: '聊游戏时可以顺手问一句要不要一起玩' });
  L.addExperience({ text: '他说累的时候先别给建议，先理解' });
  L.addExperience({ text: '发图不要逐个解释画面' });
  L.addExperience({ text: '讨论技术问题时可以详细一点' });

  const ctx = '今天好累啊，什么都不想干';
  const picked = L.selectForContext({ contextText: ctx, limit: 6 });
  ok('带上了相关的那条', picked.items.some((x) => x.text.includes('累')), JSON.stringify(picked.items.map((x) => x.text)));
  ok('没把全部塞进去', picked.items.length < picked.total || picked.total <= 6, `${picked.items.length}/${picked.total}`);

  // 相关性应该让"累"那条排在"发图"那条前面
  const idxRel = picked.items.findIndex((x) => x.text.includes('累'));
  const idxIrrel = picked.items.findIndex((x) => x.text.includes('发图'));
  ok('相关的排在无关的前面', idxRel >= 0 && (idxIrrel < 0 || idxRel < idxIrrel), `${idxRel} vs ${idxIrrel}`);

  ok('默认只带 6 条', L.selectForContext({ contextText: '', limit: 6 }).items.length <= 6);
  // 20 条主题各异、句式也不同的经验（同一句式会被合并逻辑正确吃掉）
  const sentences = [
    '游戏存档别乱删，先备份', '下雨天出门记得带伞', '咖啡放凉了就不好喝',
    '猫粮别买太便宜的', '代码缩进统一两个空格', '音乐音量太大会伤耳朵',
    '快递最好放代收点', '记账要当天记不然会忘', '睡眠少于六小时第二天废',
    '地铁换乘留十分钟', '快递纸箱攒着能卖钱', '桌游规则先看说明书',
    '相机宁可欠曝别过曝', '炒菜火候看油温', '球赛比分不如过程重要',
    '键盘轴体选静音款', '末班车别卡点去', '折叠伞比长柄好带',
    '降噪耳机通勤真的有用', '日历提醒设提前十分钟'
  ];
  for (const s of sentences) L.addExperience({ text: s });
  ok('硬上限 15 生效', L.selectForContext({ contextText: '', limit: 99 }).items.length === 15);
}

console.log('归档');
{
  reset();
  L.addExperience({ text: '这条会变成稳定且长期没用' });
  const id = L.listAll()[0].id;
  L.setStatus(id, 'verified', { source: 'owner' });
  L.setStatus(id, 'stable', { source: 'owner' });
  const before = L.selectForContext({ contextText: '' }).items.length;
  const r = L.archiveStale({ days: 0 });   // 立刻视为过期
  ok('归档了', r.archived === 1, JSON.stringify(r));
  ok('归档后不再进上下文', L.selectForContext({ contextText: '' }).items.length === before - 1);
  ok('但还在库里（可检索）', L.listAll().length === 1);
  ok('统计能看出分布', L.stats().by.archived === 1, JSON.stringify(L.stats()));
}

console.log('渲染');
{
  reset();
  L.addExperience({ text: '他说累的时候先别给建议' });
  const s = L.renderForPrompt({ contextText: '好累' });
  ok('有标题且换行正确', s.startsWith('【你记住的经验】\n- '), JSON.stringify(s.slice(0, 40)));
  ok('带状态标记', s.includes('（待验证）'));
  ok('空库返回空串', (() => { reset(); return L.renderForPrompt({}) === ''; })());
}

console.log('同义词');
{
  reset();
  const a = L.normalizeSynonyms('今天心情很差');
  const b = L.normalizeSynonyms('我好难受');
  ok('两种说法都归一到「难受」', a.includes('难受') && b.includes('难受'), `${a} / ${b}`);
  L.addExperience({ text: '老大说难受的时候先别给建议' });
  const picked = L.selectForContext({ contextText: '今天心情很差，不想动' });
  ok('换个说法也能命中', picked.items.length === 1, JSON.stringify(picked.items.map((x) => x.text)));
  ok('相似度不再为 0', L.similarity('我好难受', '今天心情很差') > 0);
}

console.log('合并保留历史');
{
  reset();
  L.addExperience({ text: '不要每次都叫老大' });
  const r = L.addExperience({ text: '别每句话都叫老大，称呼自然点' });
  ok('合并时返回上一条原文', /不要每次都叫老大/.test(r.previous || ''), JSON.stringify(r.previous));
  const item = L.listAll()[0];
  ok('history 里存着旧表述', Array.isArray(item.history) && item.history.some((h) => /不要每次都叫老大/.test(h.text)), JSON.stringify(item.history));
  ok('当前文本是新表述', item.text.includes('称呼自然点'));
  ok('旧文本没丢', item.history[0].text.includes('不要每次都叫老大'));
}

console.log('稳定经验不被惩罚');
{
  reset();
  L.addExperience({ text: '他说累的时候先别给建议' });
  const id = L.listAll()[0].id;
  L.setStatus(id, 'verified', { source: 'owner' });
  L.setStatus(id, 'stable', { source: 'owner' });
  // 稳定 + 从没用过 + 有相关性 → 仍然应该被选中
  const picked = L.selectForContext({ contextText: '好累啊什么都不想干' });
  ok('稳定经验靠相关性仍能进来', picked.items.some((x) => x.text.includes('累')), JSON.stringify(picked.items.map((x) => x.text)));
}

console.log('归档可召回');
{
  reset();
  L.addExperience({ text: '聊到难受的时候先听他说完，别急着给建议' });
  const id = L.listAll()[0].id;
  L.setStatus(id, 'verified', { source: 'owner' });
  L.setStatus(id, 'stable', { source: 'owner' });
  L.archiveStale({ days: 0 });
  ok('归档后无关话题不出现', L.selectForContext({ contextText: '今天天气不错' }).items.length === 0);
  const hit = L.selectForContext({ contextText: '难受的时候给建议是不是不好，先听他说完对吗' });
  ok('强相关时能被捞回来', hit.items.some((x) => x.text.includes('先听他说完')), JSON.stringify(hit.items.map((x) => x.text)));
}

console.log('编辑 / 拆分 / 删除');
{
  reset();
  L.addExperience({ text: '老大纠正我说话的主语，别把事说到他头上；他还说别对他太客气' });
  const id = L.listAll()[0].id;

  // 单行 = 改这一条
  const one = L.saveItem(id, '老大纠正我说话的主语，别把事说到他头上');
  ok('单行是修改', one.ok && one.created === 0, JSON.stringify(one));
  ok('文本真的改了', L.listAll()[0].text === '老大纠正我说话的主语，别把事说到他头上');

  // 多行 = 拆成多条
  const two = L.saveItem(id, '老大纠正我说话的主语，别把事说到他头上\n他还说别对他太客气');
  ok('多行是拆分', two.ok && two.created === 1 && two.total === 2, JSON.stringify(two));
  ok('总数变成 2', L.listAll().length === 2, String(L.listAll().length));
  ok('第二条是拆出来的', L.listAll().some((x) => x.text.includes('别对他太客气')));

  // 拆出来的状态是 pending
  const split = L.listAll().find((x) => x.text.includes('别对他太客气'));
  ok('拆出来的重新待验证', split.status === 'pending');

  ok('空内容拒绝', L.saveItem(id, '   ').ok === false);
  ok('每行太短拒绝', L.saveItem(id, '好\n行').ok === false);
  ok('对不存在的 id 失败', L.saveItem('l-nope', '这是一条够长的经验').ok === false);

  // 删除
  const del = L.removeItem(split.id);
  ok('删掉了', del.ok === true, JSON.stringify(del));
  ok('库里只剩 1 条', L.listAll().length === 1);
  ok('删不存在的失败', L.removeItem('l-nope').ok === false);
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
