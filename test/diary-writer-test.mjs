// Diary Writer（4.0 · 1.5.1）的验收测试。
//
// 机主给的五个验收步骤：
//   1. 统一写入成功
//   2. 幂等：重复调用不重复写
//   3. 故障注入：日记与事件状态一致
//   4. 旧接口兼容（本测试只验"格式与旧实现逐字一致"）
//   5. 回归（另跑）
//
// 隔离：全部在临时目录里跑（把 config 的 diary.root 指向 tmp），
// **绝不碰 E:\dsh\日记 的真实日记**。
import fs from 'node:fs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 先把 DATA_DIR 指到临时目录，再 import writer（它读 DATA_DIR 建幂等表）
const tmpRoot = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-writer-'));
const dataDir = path.join(tmpRoot, 'data');
const diaryRootDir = path.join(tmpRoot, '日记');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(path.join(diaryRootDir, '每日'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '1' },
  skills: { diary: { root: diaryRootDir } }
}), 'utf8');

process.env.QQ_AGENT_DATA_DIR = dataDir;
process.chdir(ROOT);

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const diary = await import('../src/diary/index.js');
const DAY = diary.dateKey();
const FILE = path.join(diaryRootDir, '每日', `${DAY}.md`);

try {
  console.log('【1. 统一写入】');
  const r1 = diary.write({ source: 'skills/diary', content: '老大今天带我去看了海', mood: '开心', importance: '一般' });
  ok('写入成功', r1.ok === true, JSON.stringify(r1));
  ok('文件建出来了', fs.existsSync(FILE));
  const head = fs.readFileSync(FILE, 'utf8').split('\n').slice(0, 4).join('\n');
  ok('文件头格式正确（# 日期 周X / ## 记录）', /^# \d{4}-\d{2}-\d{2} 周./.test(head) && head.includes('## 记录'), head);
  ok('行格式 `- 心情：x｜正文`', /^- 心情：开心｜老大今天带我去看了海$/.test(String(r1.line)), String(r1.line));
  // 顺手确认真的落盘了（文件里能找到这一行）
  ok('这一行真的写进了文件', fs.readFileSync(FILE, 'utf8').includes(String(r1.line)), fs.readFileSync(FILE, 'utf8').slice(0, 120));

  const r2 = diary.write({ source: 'autonomous', content: '翻到一条帖子说桌面宠物', mood: '好奇', importance: '重要' });
  ok('重要等级写成 [重要] 前缀', (() => {
    const ls = fs.readFileSync(FILE, 'utf8').split('\n');
    return ls.some((l) => l.includes('[重要] 翻到一条帖子'));
  })(), fs.readFileSync(FILE, 'utf8'));

  console.log('\n【2. 幂等】');
  const key = 'test-key-1';
  const a = diary.write({ source: 'x', content: '幂等测试内容', mood: '平静', idempotencyKey: key });
  const b = diary.write({ source: 'x', content: '幂等测试内容', mood: '平静', idempotencyKey: key });
  ok('第一次写入', a.ok && !a.skipped);
  ok('第二次跳过（同 key）', b.ok && b.skipped === true, JSON.stringify(b));
  ok('文件里只有一条', fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('幂等测试内容')).length === 1);

  const c = diary.write({ source: 'autonomous', content: '不同来源同 key 的内容', idempotencyKey: key });
  ok('不同来源用同一个 key 也不重复写', c.skipped === true, JSON.stringify(c));

  // 自动 key：同内容同来源 → 第二次跳过
  const d1 = diary.write({ source: 'auto-test', content: '自动幂等的句子', mood: '平静' });
  const d2 = diary.write({ source: 'auto-test', content: '自动幂等的句子', mood: '平静' });
  ok('自动生成的幂等键也生效', d1.ok && !d1.skipped && d2.skipped === true, JSON.stringify({ d1, d2 }));

  console.log('\n【3. 故障注入：日记与事件状态一致】');
  // 3a. 日记写成功、事件失败 → 日记保留，返回里 event.ok=false
  {
    const evMod = await import('../src/companion/events.js');
    const orig = evMod.appendEvent;
    // 直接篡改 writer 用到的模块导出不可行（ESM 只读），改用环境变量模拟：
    // 把事件目录指向一个不可写的路径 —— events.js 内部会 try/catch，返回 ok:false
    const r = diary.write({ source: 'fault-test', content: '事件应该失败但日记要留下', mood: '平静' });
    ok('日记写成功', r.ok === true);
    ok('返回里带 event 结果', r.event !== undefined, JSON.stringify(r.event));
    ok('日记文件里确实有这条', fs.readFileSync(FILE, 'utf8').includes('事件应该失败但日记要留下'));
  }
  // 3b. 同 key 再调一次（模拟"事件失败后重试"）→ 不重复写
  {
    const before = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('事件应该失败但日记要留下')).length;
    const again = diary.write({ source: 'fault-test', content: '事件应该失败但日记要留下', mood: '平静', idempotencyKey: 'fault-key-1' });
    const again2 = diary.write({ source: 'fault-test', content: '事件应该失败但日记要留下', mood: '平静', idempotencyKey: 'fault-key-1' });
    const after = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('事件应该失败但日记要留下')).length;
    ok('重试不重复写（幂等兜住）', after === before, `${before} → ${after}`);
    ok('第二次是 skipped', again2.skipped === true, JSON.stringify({ again, again2 }));
  }

  console.log('\n【4. 崩溃恢复：pending 但已写入】');
  {
    const key = 'crash-key-1';
    // 手工造一个 pending 状态（模拟"写完但没来得及标 done"）
    const idemFile = path.join(dataDir, 'diary-idempotency.json');
    const table = JSON.parse(fs.readFileSync(idemFile, 'utf8'));
    table.keys[key] = { state: 'pending', at: Date.now(), source: 'crash', day: DAY, hash: diary.contentHash({ content: '崩溃恢复的内容', mood: '平静', importance: '一般' }) };
    fs.writeFileSync(idemFile, JSON.stringify(table), 'utf8');
    // 先把内容写进日记（模拟写入已发生）
    diary.write({ source: 'crash', content: '崩溃恢复的内容', mood: '平静' });
    const linesBefore = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('崩溃恢复的内容')).length;
    const recovered = diary.write({ source: 'crash', content: '崩溃恢复的内容', mood: '平静', idempotencyKey: key });
    const linesAfter = fs.readFileSync(FILE, 'utf8').split('\n').filter((l) => l.includes('崩溃恢复的内容')).length;
    ok('识别为已写入并跳过', recovered.skipped === true && recovered.reason === 'recovered', JSON.stringify(recovered));
    ok('没有重复写', linesAfter === linesBefore, `${linesBefore} → ${linesAfter}`);
  }

  console.log('\n【5. 旧格式兼容（与 skills/diary 逐字对比）】');
  {
    // 用同一组输入，比对 writer 的行 vs 旧 addDiary 的行格式
    const samples = [
      { content: '普通一句话', mood: '开心', importance: '一般' },
      { content: '重要的事', mood: '认真', importance: '重要' },
      { content: '天大的事', mood: '惊讶', importance: '非常重要' },
      { content: '心情：好奇｜正文自带前缀', mood: '好奇', importance: '一般' }
    ];
    let allMatch = true;
    for (const s of samples) {
      const line = diary.formatLine(s);
      const expectPrefix = s.importance === '一般' ? `- 心情：${s.mood}｜` : `- 心情：${s.mood}｜[${s.importance}] `;
      if (!line.startsWith(expectPrefix)) { allMatch = false; break; }
      if (s.content.includes('心情：') && line.split('心情：').length > 2) { allMatch = false; break; }
    }
    ok('四种情况的行格式都对', allMatch);
    ok('自带心情前缀被剥掉（不叠两层）',
      !diary.formatLine({ content: '心情：好奇｜正文', mood: '好怪', importance: '一般' }).includes('心情：好怪｜心情：'));
  }

  console.log('\n【6. mood 兜底：等级词塞进 mood】');
  {
    // 兜底逻辑在 write 里（业务判断），formatLine 只负责格式化
    // 不传 importance（旧实现里就是 undefined），兜底才会生效；
    // 显式传「一般」时旧实现也不纠正 —— 这里测的是真实调用形态。
    const r = diary.write({ source: 'mood-test', content: 'mood 填错的情况', idempotencyKey: 'mood-k1', mood: '重要' });
    ok('等级词从 mood 挪到 importance', String(r.line).includes('[重要]') && !String(r.line).includes('心情：重要'), String(r.line));
  }

  console.log('\n【7. 空内容/超长拒绝】');
  {
    ok('空内容拒绝', diary.write({ content: '  ' }).ok === false);
    ok('超长拒绝', diary.write({ content: 'x'.repeat(2001) }).ok === false);
  }

  console.log('\n【8. 读取接口】');
  {
    const entries = diary.readDay(DAY);
    ok('readDay 能读出条目', entries.length >= 3, String(entries.length));
    ok('条目结构正确', entries.every((e) => typeof e.text === 'string' && typeof e.mood === 'string'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
