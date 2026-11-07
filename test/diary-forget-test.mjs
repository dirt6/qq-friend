// 删日记的单元测试
//
// 为什么单独测：这是**破坏性操作**，而且是替她在 QQ 里执行（她说「删了」就真删）。
// 边界错一个，删掉的就是她不想删的那条记忆。
// 锁四件事：唯一匹配才删、多条拒绝、备份存在、match 太短拒绝。
import fs from 'node:fs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

import os from 'node:os';
import path from 'node:path';
import { removeDiaryLine } from '../plugins/autonomous/index.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const ROOT = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'qq-agent-forget-'));
const DIR = path.join(ROOT, '每日');
fs.mkdirSync(DIR, { recursive: true });

const day1 = path.join(DIR, '2026-10-25.md');
const day2 = path.join(DIR, '2026-10-26.md');
fs.writeFileSync(day1, [
  '# 2026-10-25 周日',
  '',
  '## 记录',
  '- 心情：记住了｜看到好笑的先截图',
  '- 心情：开心｜今天吃了个梨',
  ''
].join('\n'), 'utf8');
fs.writeFileSync(day2, [
  '# 2026-10-26 周一',
  '',
  '## 记录',
  '- 心情：记住了｜不发三个点',
  '- 心情：记住了｜三个点很烦人',
  '- 心情：心疼｜老大说了心里话',
  ''
].join('\n'), 'utf8');

console.log('唯一匹配');
{
  const r = removeDiaryLine({ match: '吃了个梨', root: ROOT });
  ok('删掉了', r.ok === true, JSON.stringify(r));
  ok('返回被删的原文', String(r.removed).includes('吃了个梨'));
  ok('指向正确的那天', r.file === '2026-10-25.md', r.file);
  const after = fs.readFileSync(day1, 'utf8');
  ok('文件里没有了', !after.includes('吃了个梨'));
  ok('其它条目还在', after.includes('看到好笑的先截图'));
  ok('标题和空行结构没坏', after.includes('# 2026-10-25') && after.includes('## 记录'));
}

console.log('安全边界');
{
  const many = removeDiaryLine({ match: '三个点', root: ROOT });
  ok('多条匹配时拒绝', many.ok === false, JSON.stringify(many));
  ok('列出候选', Array.isArray(many.candidates) && many.candidates.length === 2, JSON.stringify(many.candidates));
  const still = fs.readFileSync(day2, 'utf8');
  ok('拒绝时一条都没删', still.includes('不发三个点') && still.includes('三个点很烦人'));

  const none = removeDiaryLine({ match: '不存在的句子', root: ROOT });
  ok('找不到时明确报错', none.ok === false && /没找到/.test(none.reason), none.reason);

  const short = removeDiaryLine({ match: '点', root: ROOT });
  ok('match 太短拒绝', short.ok === false && /太短/.test(short.reason), short.reason);
}

console.log('备份');
{
  const trash = path.join(ROOT, '.trash');
  ok('备份目录建了', fs.existsSync(trash));
  const baks = fs.existsSync(trash) ? fs.readdirSync(trash) : [];
  ok('删除前留了备份', baks.some((f) => f.includes('2026-10-25')), JSON.stringify(baks));
  const bak = baks.find((f) => f.includes('2026-10-25'));
  if (bak) {
    const text = fs.readFileSync(path.join(trash, bak), 'utf8');
    ok('备份里还有被删那条', text.includes('吃了个梨'));
  }
}

console.log('限定日期');
{
  const r = removeDiaryLine({ match: '三个点', day: '2026-10-26', root: ROOT });
  ok('限定日期后仍是多条，还是拒绝', r.ok === false);
  const only = removeDiaryLine({ match: '老大说了心里话', day: '2026-10-26', root: ROOT });
  ok('限定日期能正常删', only.ok === true, JSON.stringify(only));
  ok('不会误删别天的', fs.readFileSync(day1, 'utf8').includes('2026-10-25'));
}

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
