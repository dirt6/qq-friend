// 「改等级」工具的测试（2026-10-29 加）。
//
// 为什么单独测：这是唯一一个**只改标记、不动正文**的写操作。改错一个字
// 就是把她写过的日记改坏，而且改完看不出来 —— 必须锁住"正文原样"。
import fs from 'node:fs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'qq-agent-level-'));
const DAY = '2026-10-29';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const { clearRegistry, registerTool, listTools } = await import('../src/tool-registry.js');
const { executeTool } = await import('../src/tools.js');
const mem = await import('../skills/diary/index.js');

const cfgState = { root: TMP, requireConfirm: false, autoRecall: true, maxInjectItems: 5, maxRecallChars: 1500 };
clearRegistry();
mem.setup({ config: () => cfgState, log: () => {}, registerTool });

const defs = listTools();
const ctx = { chatKey: 'private:1846383180', session: { id: 'sess-1' }, store: { recent: () => [] } };
const run = async (id, args = {}) => {
  const r = await executeTool(defs, ctx, id, JSON.stringify(args));
  const text = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? r);
  return { text, isError: !!r?.isError };
};

const diaryFile = path.join(TMP, '每日', `${DAY}.md`);
const readDiary = () => fs.readFileSync(diaryFile, 'utf8');

console.log('【注册】');
ok('注册了 level 工具', defs.some((d) => d.id === 'level'));
ok('原来是 5 个，现在 6 个', ['propose', 'commit', 'read', 'list', 'forget', 'level'].every((id) => defs.some((d) => d.id === id)));

console.log('\n【准备数据】');
fs.mkdirSync(path.join(TMP, '每日'), { recursive: true });
fs.writeFileSync(diaryFile, `# ${DAY} 周四\n\n## 记录\n\n`
  + '- 心情：开心｜画了张画，猫和鱼并排坐着\n'
  + '- 心情：一般｜老大明天有早八，不想上\n', 'utf8');

console.log('\n【升到重要】');
{
  const r = await run('level', { match: '画了张画', importance: '重要', date: DAY });
  ok('执行成功', !r.isError, r.text.slice(0, 80));
  const t = readDiary();
  ok('写入了 [重要] 标记', t.includes('[重要] 画了张画'), t);
  ok('正文一个字没动', t.includes('画了张画，猫和鱼并排坐着'));
  ok('心情原样保留', t.includes('- 心情：开心｜'));
  ok('另一条没被牵连', t.includes('- 心情：一般｜老大明天有早八'));
}

console.log('\n【再升到非常重要（替换而不是叠加）】');
{
  const r = await run('level', { match: '画了张画', importance: '非常重要', date: DAY });
  ok('执行成功', !r.isError, r.text.slice(0, 80));
  const t = readDiary();
  ok('是 [非常重要] 而不是两个标记叠一起', t.includes('[非常重要] 画了张画') && !t.includes('[重要] [非常重要]'));
  ok('旧的 [重要] 已经没了', (t.match(/\[重要\]/g) || []).length === 0, t);
}

console.log('\n【降回一般：标记应当消失】');
{
  const r = await run('level', { match: '画了张画', importance: '一般', date: DAY });
  ok('执行成功', !r.isError, r.text.slice(0, 80));
  const t = readDiary();
  ok('标记被去掉', !/\[(一般|重要|非常重要)\]/.test(t), t);
  ok('正文还在', t.includes('画了张画，猫和鱼并排坐着'));
}

console.log('\n【错误处理】');
{
  // 再加一条也含「老大」的，用来测"多条命中不猜"
  fs.appendFileSync(diaryFile, '- 心情：好｜老大说画得不错\n', 'utf8');

  const r1 = await run('level', { match: '画', importance: '重要', date: DAY });
  ok('match 太短被拒', r1.isError, r1.text.slice(0, 60));

  const r2 = await run('level', { match: '画了张画', importance: '有点重要', date: DAY });
  ok('非法等级被拒', r2.isError, r2.text.slice(0, 60));

  const r3 = await run('level', { match: '画了张画', importance: '重要', date: '2026/10/29' });
  ok('date 格式错被拒', r3.isError, r3.text.slice(0, 60));

  const r4 = await run('level', { match: '不存在的一段话', importance: '重要', date: DAY });
  ok('找不到条目被拒', r4.isError, r4.text.slice(0, 60));

  const r5 = await run('level', { match: '老大', importance: '重要', date: DAY });
  ok('多条命中被拒（不猜）', r5.isError, r5.text.slice(0, 60));

  const r6 = await run('level', { match: '画了张画', importance: '重要', date: '2026-01-01' });
  ok('那天没日记被拒', r6.isError, r6.text.slice(0, 60));
}

console.log('\n【重复设置同一等级：不动】');
{
  await run('level', { match: '老大明天有早八', importance: '重要', date: DAY });
  const r = await run('level', { match: '老大明天有早八', importance: '重要', date: DAY });
  ok('第二次提示"本来就是这个等级"', !r.isError && /本来就是这个等级/.test(r.text), r.text.slice(0, 80));
  const t = readDiary();
  ok('标记没有重复叠加', (t.match(/\[重要\]/g) || []).length === 1, t);
}

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
