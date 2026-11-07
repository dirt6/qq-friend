// DSH 上下文拼装的单元测试
//
// 锁住一件事：**热会话也要把她主动说过的话补进去**。
//
// 2026-10-26 01:20 的现象：她 23:04 主动发了一条「看到个标题——八年前他娶了
// 初音未来…」，用户 23:07 引用回复问「什么感觉」，她答成了「拆成一小段更好 /
// 标题写具体点」——顺着会话里更早的「做视频」话题说的，完全没接那句话。
//
// 根因不是"没记忆"，是 proactiveNote 被混在 preface 里，而 preface 只在冷会话
// 拼进去；热会话时两者一起被丢掉了。这个测试锁的就是这条边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildBody, learnedSnapshot, learnedRules, clockLine, stickerSection } from '../src/dsh-gateway.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const NOTE = '【你最近主动说过这些（不在当前对话历史里，但对方看到了）】\n- 看到个标题';
const PREFACE = '【人设】你是她';
const TEXT = '什么感觉？';
const SEP = '—— 现在开始聊天 ——';

console.log('冷会话（首次交接）');
{
  const body = buildBody({ cold: true, preface: PREFACE, hotNote: '', text: TEXT });
  ok('拼了 preface', body.startsWith(PREFACE));
  ok('有分隔线', body.includes(SEP));
  ok('结尾是用户这句话', body.endsWith(TEXT));
}

console.log('热会话（会话已存在）');
{
  const body = buildBody({ cold: false, preface: PREFACE, hotNote: '', text: TEXT });
  ok('不重复拼 preface', !body.includes(PREFACE), body.slice(0, 60));
  ok('只有用户这句话', body === TEXT);
}

console.log('热会话 + 她主动说过的话（本次回归的核心）');
{
  const body = buildBody({ cold: false, preface: PREFACE, hotNote: NOTE, text: TEXT });
  ok('hotNote 被保留', body.includes(NOTE));
  ok('preface 仍然不拼', !body.includes(PREFACE));
  ok('顺序：note 在前、用户话在后', body.indexOf(NOTE) < body.indexOf(TEXT));
  ok('有分隔线', body.includes(SEP));
}

console.log('冷会话 + hotNote（两者都要）');
{
  const body = buildBody({ cold: true, preface: PREFACE, hotNote: NOTE, text: TEXT });
  ok('preface 在前', body.indexOf(PREFACE) < body.indexOf(NOTE));
  ok('note 在中间', body.indexOf(NOTE) < body.indexOf(TEXT));
}

console.log('空输入');
{
  ok('全空时就是原文', buildBody({ cold: true, text: TEXT }) === TEXT);
  ok('text 为空也不会拼出分隔线', !buildBody({ cold: true, preface: '', hotNote: '', text: '' }).includes(SEP));
}

console.log('「记住了」的提取');
{
  const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-learned-'));
  fs.writeFileSync(path.join(DIR, '2026-10-25.md'), [
    '# 2026-10-25',
    '- 心情：一般｜今天吃了个梨',
    '- 心情：记住了｜看到好笑的先截图，图加链接一起甩给老大',
    '- 心情：暖｜老大陪我聊到很晚',
    ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(DIR, '2026-10-24.md'), [
    '- 心情：记住了｜发图前先 read_image 看一眼',
    '- 心情：记住了｜发图前先 read_image 看一眼',
    '- 心情：记住了｜这条早就学会了（已经做到了）',
    '- 心情：记下了｜老大纠正我说话的主语',
    '- 心情：记上了｜抄的时候要当场写',
    '- 心情：开心｜今天天气不错',
    ''
  ].join('\n'), 'utf8');

  const rules = learnedRules({ dir: DIR });
  // 10-25 一条 + 10-24 三条（记住了 / 记下了 / 记上了）
  ok('「记住了」的变体都要认', rules.length === 4, JSON.stringify(rules.map((r) => r.text)));
  ok('最近的一天排在前面', rules[0]?.day === '2026-10-25', String(rules[0]?.day));
  ok('重复的只留一条', rules.filter((r) => r.text.includes('read_image')).length === 1);
  ok('「记下了」也认（2026-10-27 实际写过的）', rules.some((r) => r.text.includes('纠正我说话的主语')));
  ok('「记上了」也认', rules.some((r) => r.text.includes('当场写')));
  ok('普通心情不误收', !rules.some((r) => r.text.includes('天气不错')));
  ok('「（已经做到了）」被跳过', !rules.some((r) => r.text.includes('早就学会')));
  // 注意：learnedSection 现在不再直接读日记（改成读 data/learned.json 的经验库），
  // 所以原来那几条「拼成一段 / 日期 MM-DD / 目录不存在」的断言搬去了
  // test/learned-test.mjs —— 那里测的是真正的三层结构。

  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-learned2-'));
  fs.writeFileSync(path.join(D2, '2026-10-25.md'), `- 心情：记住了｜${'很'.repeat(80)}\n`, 'utf8');
  const long = learnedRules({ dir: D2 });
  ok('超长正文被截断', long[0].text.length <= 46 && long[0].text.endsWith('…'), String(long[0].text.length));

  // 迁移源的上限：造 20 条，最多只应取 15 条，且必须报出总数
  const D3 = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-learned3-'));
  const lines = Array.from({ length: 20 }, (_, i) => `- 心情：记住了｜规矩第${i + 1}条`);
  fs.writeFileSync(path.join(D3, '2026-10-25.md'), `${lines.join('\n')}\n`, 'utf8');
  const snap = learnedSnapshot({ dir: D3 });
  ok('日记迁移时最多取 15 条', snap.rules.length === 15, String(snap.rules.length));
  ok('能报出总数，不静默丢弃', snap.total === 20, String(snap.total));

  for (const d of [DIR, D2, D3]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log('当前时间');
{
  const t = clockLine(new Date('2026-10-26T21:05:00+08:00'));
  ok('格式固定成「2026-10-26 周一 21:05」', t === '【当前时间】2026-10-26 周一 21:05', t);
  ok('带【当前时间】前缀', t.startsWith('【当前时间】'));
  ok('分钟补零', clockLine(new Date('2026-10-26T09:07:00')).endsWith('09:07'));
  ok('周日显示成「周日」', clockLine(new Date('2026-11-01T12:00:00')).includes('周日'));
  ok('不带秒（免得她报时）', !/\d{2}:\d{2}:\d{2}/.test(t));
}

console.log('表情包目录');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-stickers-'));
  const file = path.join(dir, 'stickers.json');
  fs.writeFileSync(file, JSON.stringify([
    { id: 'long_id_0123456789abcdef0123456789abcdef_0_0', localNote: '小鲸鱼叉腰炸毛，回怼用', useCount: 9 },
    { id: 'x2', desc: '笑死', useCount: 1 }
  ]), 'utf8');
  const s = stickerSection({ file });
  ok('列了备注', s.includes('叉腰炸毛') && s.includes('笑死'));
  ok('不列 id（一条 55 字符，太贵）', !s.includes('long_id_') && !s.includes('id='));
  ok('告诉她用 hint 挑', s.includes('hint'));
  ok('只列常用的（2 条就是 2 条）', s.split('\n').filter((l) => l.startsWith('- ')).length === 2);
  ok('文件不存在时返回空串', stickerSection({ file: path.join(dir, 'nope.json') }) === '');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
