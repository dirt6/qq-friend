// 记忆库（skills/diary）的单元测试
//
// 锁住五件事：
//   ① 提议不落盘；同一轮自己确认会被拒绝；老大回话之后才能写
//   ② 四类写入格式：promises/wishlist 是复选框清单，日记是两个固定小节，核心档案按日期追加
//   ③ 文件都在 <root> 这一层（不再套 diary\ 子目录）
//   ④ 读：约定/愿望/日记/核心档案/关键词
//   ⑤ 动态提示词带上未完成的约定与愿望；关掉 autoRecall 就不注入
import fs from 'node:fs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'qq-agent-mem-'));
// 4.0 / 1.5.2：日记写入走统一 Writer 后，幂等表落在 DATA_DIR。
// 这里必须把它指到临时目录，否则测试会读写生产幂等表（真踩过）。
const DATA_TMP = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'qq-agent-mem-data-'));
fs.mkdirSync(DATA_TMP, { recursive: true });
process.env.QQ_AGENT_DATA_DIR = DATA_TMP;
const p2 = (n) => String(n).padStart(2, '0');
const NOW = new Date();
const TODAY = `${NOW.getFullYear()}-${p2(NOW.getMonth() + 1)}-${p2(NOW.getDate())}`;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const { clearRegistry, registerTool, listTools } = await import('../src/tool-registry.js');
const { executeTool } = await import('../src/tools.js');
const mem = await import('../skills/diary/index.js');

const cfgState = { root: TMP, requireConfirm: true, autoRecall: true, maxInjectItems: 5, maxRecallChars: 1500 };
clearRegistry();
mem.setup({ config: () => cfgState, log: () => {}, registerTool });

const defs = listTools();
const BASE = Date.parse('2026-10-17T10:00:00+08:00');
const mkCtx = (ts = BASE) => ({
  chatKey: 'private:1846383180',
  session: { id: 'sess-1' },
  store: { recent: () => [{ ts, self: false, text: '好' }] }
});
const run = async (id, args = {}, ctx = mkCtx()) => {
  const r = await executeTool(defs, ctx, id, JSON.stringify(args));
  const text = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? r);
  return { r, text, isError: !!r?.isError };
};
const readFile = (name) => {
  const f = path.join(TMP, name);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
};

ok('注册了 5 个工具（提议/确认/翻记忆/目录/忘掉）', ['propose', 'commit', 'read', 'list', 'forget'].every((id) => defs.some((d) => d.id === id)));

// ── ① 提议不落盘 ──
{
  const r = await run('propose', { kind: 'promise', content: '周末陪她看一场电影' });
  ok('提议成功且带 id', !r.isError && /\[m_/.test(r.text), r.text.slice(0, 100));
  ok('提议阶段不写任何文件', !fs.existsSync(TMP) || fs.readdirSync(TMP).length === 0, JSON.stringify(fs.existsSync(TMP) ? fs.readdirSync(TMP) : []));
}

// ── ② 同一轮自己确认：必须拒绝 ──
{
  const r = await run('commit', {}, mkCtx());
  ok('同一轮 commit 被拒（老大还没回话）', r.isError && /还没回话/.test(r.text), r.text.slice(0, 120));
  ok('被拒后仍然没有文件', fs.readdirSync(TMP).length === 0, JSON.stringify(fs.readdirSync(TMP)));
}

// ── ③ 老大回话后：写入成功（约定已并入日记，标 [非常重要]）──
{
  const r = await run('commit', {}, mkCtx(BASE + 60000));
  const text = readFile(path.join('每日', `${TODAY}.md`));
  ok('回话后 commit 成功', !r.isError && /记下了/.test(r.text), r.text.slice(0, 120));
  ok('约定写进日记且标 [非常重要]', new RegExp(`- 心情：\\S+｜\\[非常重要\\] 约定：周末陪她看一场电影`).test(text), text.slice(0, 220));
  ok('不再生成独立的 promises.md', !fs.existsSync(path.join(TMP, 'promises.md')));
  ok('写在 每日/ 子目录', fs.existsSync(path.join(TMP, '每日', `${TODAY}.md`)));
}

// ── ④ 关掉 requireConfirm：提议即写（愿望同样进日记）──
{
  cfgState.requireConfirm = false;
  const r = await run('propose', { kind: 'wish', content: '想要一个能捏的鲸鱼抱枕' });
  const text = readFile(path.join('每日', `${TODAY}.md`));
  ok('关掉确认后提议直接写盘', !r.isError && /已写进/.test(r.text), r.text.slice(0, 120));
  ok('愿望写进日记且标 [非常重要]', /\[非常重要\] 愿望：想要一个能捏的鲸鱼抱枕/.test(text), text.slice(0, 220));
  cfgState.requireConfirm = true;
}

// ── ⑤ 日记：一天一个文件（每日/），只记 日期·心情·记录 ──
{
  await run('propose', { kind: 'diary', content: '他说我今天的语气像在笑', mood: '开心' });
  await run('commit', {}, mkCtx(BASE + 120000));
  await run('propose', { kind: 'diary', content: '有一点点舍不得今天结束', mood: '舍不得' });
  await run('commit', {}, mkCtx(BASE + 180000));
  const text = readFile(path.join('每日', `${TODAY}.md`));
  ok('日记在 每日/ 子目录（与 promises 同级）', fs.existsSync(path.join(TMP, '每日', `${TODAY}.md`)));
  ok('日记只有 ## 记录 一个段', /## 记录/.test(text) && !/今天最值得记住|我的小情绪/.test(text), text.slice(0, 200));
  ok('每条记录带心情', /- 心情：开心｜.*像在笑/.test(text) && /- 心情：舍不得｜.*舍不得/.test(text), text.slice(0, 240));
  ok('两次写入互不覆盖', /像在笑/.test(text) && /舍不得/.test(text));
}

// ── ⑥ 核心档案 ──
{
  await run('propose', { kind: 'core', content: '他说不用总说"好的"，随便一点更像你' });
  await run('commit', {}, mkCtx(BASE + 240000));
  const text = readFile('core_profile.md');
  ok('core_profile.md 按日期追加', /## \d{4}-\d{2}-\d{2}/.test(text) && /不用总说/.test(text), text.slice(0, 160));
}

// ── ⑦ 读 ──
{
  const promise = await run('read', { target: 'promise' });
  ok('读约定', !promise.isError && /电影/.test(promise.text) && /还没做到/.test(promise.text), promise.text.slice(0, 160));
  const wish = await run('read', { target: 'wish' });
  ok('读愿望', !wish.isError && /抱枕/.test(wish.text), wish.text.slice(0, 120));
  const core = await run('read', { target: 'core' });
  ok('读核心档案', !core.isError && /不用总说/.test(core.text), core.text.slice(0, 120));
  const diary = await run('read', { target: 'diary', date: TODAY });
  ok('按日期读日记', !diary.isError && /像在笑/.test(diary.text), diary.text.slice(0, 120));
  const recent = await run('read', { target: 'diary', days: 2 });
  ok('读最近几天', !recent.isError && /舍不得/.test(recent.text));
  const kw = await run('read', { keyword: '抱枕' });
  ok('关键词跨文件搜索', !kw.isError && /抱枕/.test(kw.text), kw.text.slice(0, 160));
  const miss = await run('read', { keyword: '这个词肯定没有' });
  ok('搜不到时说没有', !miss.isError && /没有提到/.test(miss.text));
  const noDay = await run('read', { target: 'diary', date: '1999-01-01' });
  ok('没写过的日期明确说没有', /没写过/.test(noDay.text));
}

// ── ⑧ 目录 ──
{
  const r = await run('list');
  ok('目录显示未完成约定与愿望', !r.isError && /未完成 1 条/.test(r.text) && /鲸鱼抱枕/.test(r.text), r.text.slice(0, 200));
  ok('目录显示日记天数', /日记：1 天/.test(r.text), r.text.slice(0, 200));
}

// ── ⑨ 动态提示词 ──
{
  const secs = mem.promptSections();
  ok('autoRecall 开：注入未完成约定与愿望', secs.length === 1 && /未完成的约定/.test(secs[0].content) && /抱枕/.test(secs[0].content), JSON.stringify(secs).slice(0, 200));
  ok('摘要不带日记全文', !secs[0].content.includes('舍不得'), secs[0].content.slice(0, 160));
  cfgState.autoRecall = false;
  ok('autoRecall 关：不注入', mem.promptSections().length === 0);
  cfgState.autoRecall = true;
}

// ── ⑩ 空记忆库 ──
{
  const EMPTY = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'qq-agent-mem-empty-'));
  const old = cfgState.root;
  cfgState.root = EMPTY;
  const secs = mem.promptSections();
  ok('空库时提示"还空着"', secs.length === 1 && /还空着/.test(secs[0].content), JSON.stringify(secs).slice(0, 120));
  const r = await run('read', { target: 'promise' });
  ok('空库读约定不报错', !r.isError && /还是空的/.test(r.text), r.text.slice(0, 80));
  cfgState.root = old;
  fs.rmSync(EMPTY, { recursive: true, force: true });
}

// ── ⑪ 过期的提议不能用 ──
{
  mem.internals.clearPending();
  await run('propose', { kind: 'promise', content: '这条不该被写进去' });
  const entry = [...mem.internals.pending.values()][0];
  if (entry) entry.createdAt = Date.now() - 31 * 60 * 1000;   // 手工改成 31 分钟前
  const r = await run('commit', {}, mkCtx(BASE + 999000));
  ok('过期提议被清掉并提示重新提议', r.isError && /没有待确认/.test(r.text), r.text.slice(0, 120));
  ok('过期内容确实没落盘', !readFile(path.join('每日', `${TODAY}.md`)).includes('这条不该被写进去'));
}

// ── ⑫ 删除 / 修改（约定/愿望已并入日记，删改也在日记里）──
{
  const dayFile = path.join('每日', `${TODAY}.md`);
  const before = readFile(dayFile);
  const r = await run('forget', { kind: 'promise', match: '电影' });
  const after = readFile(dayFile);
  ok('删除约定', !r.isError && before.includes('电影') && !after.includes('电影'), r.text.slice(0, 120));
  ok('删除后日记文件还在', fs.existsSync(path.join(TMP, dayFile)));
  const trash = path.join(TMP, '.trash');
  ok('删除前留了备份（.trash）', fs.existsSync(trash) && fs.readdirSync(trash).length > 0);
}
{
  const r = await run('forget', { kind: 'wish', match: '鲸鱼抱枕', replace: '鲸鱼抱枕（先买个小的）' });
  ok('修改愿望', !r.isError && readFile(path.join('每日', `${TODAY}.md`)).includes('先买个小的'), r.text.slice(0, 120));
}
{
  // 两条都含"打游戏"：必须拒绝，不能硬删
  await run('propose', { kind: 'promise', content: '周末陪老大打游戏', day: TODAY });
  await run('commit', {}, mkCtx(BASE + 1000000));
  await run('propose', { kind: 'promise', content: '下次还陪老大打游戏', day: TODAY });
  await run('commit', {}, mkCtx(BASE + 1100000));
  const r = await run('forget', { kind: 'promise', match: '打游戏' });
  const text = readFile(path.join('每日', `${TODAY}.md`));
  ok('匹配多条时拒绝并列出候选', r.isError && /有 2 条/.test(r.text), r.text.slice(0, 160));
  ok('拒绝时一条都没删', text.includes('周末陪老大打游戏') && text.includes('下次还陪老大打游戏'));
}
{
  const r = await run('forget', { kind: 'promise', match: '游' });
  ok('match 太短（1 字）被拒', r.isError && /至少给两个字/.test(r.text), r.text.slice(0, 100));
}
{
  const r = await run('forget', { kind: 'diary', match: '像在笑', date: TODAY });
  ok('删除日记里的一条', !r.isError && !readFile(path.join('每日', `${TODAY}.md`)).includes('像在笑'), r.text.slice(0, 120));
  ok('删掉一条不影响同篇其他条目', readFile(path.join('每日', `${TODAY}.md`)).includes('舍不得'));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
