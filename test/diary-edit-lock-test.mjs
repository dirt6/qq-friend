// D1-2a 专项：日记改/删收口到 Writer（锁、唯一匹配、备份、原子写、委托一致）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}


const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, 'diary-edit-worker.mjs');
const tmp = fs.mkdtempSync(path.join(process.env.DIARY_TEST_TMP || os.tmpdir(), 'diary-edit-'));
const dayDir = path.join(tmp, '日记', '每日');
const day = '2026-11-03';
const file = path.join(dayDir, `${day}.md`);
const c = createChecker('D1-2a 日记改删收口');

const writeDay = (lines) => {
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(file, `# ${day} 周一\n\n## 记录\n\n${lines.join('\n')}\n`, 'utf8');
};
const readText = () => fs.readFileSync(file, 'utf8');

const { removeLine, relevelLine, readDay } = await import('../src/diary/index.js');
const autonomous = await import('../plugins/autonomous/index.js');

const runWorker = (op, match, arg = '') => new Promise((resolve) => {
  const out = path.join(tmp, `w-${process.hrtime.bigint()}.json`);
  const fd = fs.openSync(out, 'w');
  const child = spawn(process.execPath, [WORKER, dayDir, op, match, arg, out], {
    stdio: ['ignore', fd, 'ignore'], windowsHide: true
  });
  child.on('exit', () => {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { resolve(JSON.parse(fs.readFileSync(out, 'utf8'))); } catch { resolve({ ok: false, reason: 'no-output' }); }
  });
});

try {
  c.section('1. removeLine：唯一匹配删除 + 备份');
  {
    writeDay(['- 心情：平静｜A 的内容', '- 心情：平静｜B 的内容', '- 心情：平静｜[重要] C 的内容']);
    const r = removeLine({ match: 'A 的内容', day, root: dayDir });
    await c.check('删除成功且返回原文', () => {
      if (!r.ok || !String(r.removed).includes('A 的内容')) throw new Error(JSON.stringify(r));
    });
    await c.check('B/C 保留、A 消失', () => {
      const t = readText();
      if (t.includes('A 的内容') || !t.includes('B 的内容') || !t.includes('C 的内容')) throw new Error(t);
    });
    await c.check('备份文件存在', () => {
      const trash = path.join(tmp, '日记', '.trash');
      if (!fs.existsSync(trash) || !fs.readdirSync(trash).some((n) => n.endsWith('.bak'))) throw new Error('无备份');
    });
  }

  c.section('2. 多条/无匹配：拒绝，不猜');
  {
    writeDay(['- 心情：平静｜共同词 1', '- 心情：平静｜共同词 2']);
    const multi = removeLine({ match: '共同词', day, root: dayDir });
    await c.check('多条命中 → 拒绝并给候选', () => {
      if (multi.ok || !Array.isArray(multi.candidates) || multi.candidates.length < 2) throw new Error(JSON.stringify(multi));
      if (readText() !== `# ${day} 周一\n\n## 记录\n\n- 心情：平静｜共同词 1\n- 心情：平静｜共同词 2\n`) throw new Error('文件被改了');
    });
    const none = removeLine({ match: '不存在的词', day, root: dayDir });
    await c.check('无匹配 → 拒绝', () => {
      if (none.ok) throw new Error(JSON.stringify(none));
    });
  }

  c.section('3. relevelLine：改级 / 同等级 / 非法等级');
  {
    writeDay(['- 心情：平静｜B 的内容']);
    const r1 = relevelLine({ match: 'B 的内容', importance: '重要', day, root: dayDir });
    await c.check('改级成功（插入 [重要]）', () => {
      if (!r1.ok || !r1.changed) throw new Error(JSON.stringify(r1));
      if (!readText().includes('- 心情：平静｜[重要] B 的内容')) throw new Error(readText());
    });
    const r2 = relevelLine({ match: 'B 的内容', importance: '重要', day, root: dayDir });
    await c.check('同等级 → changed=false', () => {
      if (!r2.ok || r2.changed !== false) throw new Error(JSON.stringify(r2));
    });
    const r3 = relevelLine({ match: 'B 的内容', importance: '超级重要', day, root: dayDir });
    await c.check('非法等级 → 拒绝', () => {
      if (r3.ok) throw new Error(JSON.stringify(r3));
    });
    const r4 = relevelLine({ match: 'B 的内容', importance: '一般', day, root: dayDir });
    await c.check('改回一般 → 去掉标记', () => {
      if (!r4.ok || !r4.changed) throw new Error(JSON.stringify(r4));
      if (readText().includes('[重要]')) throw new Error(readText());
    });
  }

  c.section('4. 写失败不覆盖原文件');
  {
    writeDay(['- 心情：平静｜只读测试']);
    const before = readText();
    try { fs.chmodSync(file, 0o444); } catch { /* ignore */ }
    let r;
    try { r = removeLine({ match: '只读测试', day, root: dayDir }); } catch (e) { r = { ok: false, reason: e.message }; }
    try { fs.chmodSync(file, 0o666); } catch { /* ignore */ }
    await c.check('失败返回、原文件不变', () => {
      if (r.ok) throw new Error('竟然成功了');
      if (readText() !== before) throw new Error('原文件被改');
    });
  }

  c.section('5. 跨进程并发改删不同行');
  {
    writeDay(['- 心情：平静｜甲 的内容', '- 心情：平静｜乙 的内容', '- 心情：平静｜丙 的内容']);
    const [a, b] = await Promise.all([runWorker('remove', '甲 的内容'), runWorker('remove', '乙 的内容')]);
    await c.check('两个进程都成功，只剩丙', () => {
      if (!a.ok || !b.ok) throw new Error(JSON.stringify({ a, b }));
      const t = readText();
      if (t.includes('甲 的内容') || t.includes('乙 的内容') || !t.includes('丙 的内容')) throw new Error(t);
    });
  }

  c.section('6. 委托一致：autonomous 与 writer 行为相同');
  {
    writeDay(['- 心情：平静｜委托测试']);
    const r = autonomous.removeDiaryLine({ match: '委托测试', day, root: path.join(tmp, '日记') });
    await c.check('autonomous.removeDiaryLine 走 writer 并成功', () => {
      if (!r.ok) throw new Error(JSON.stringify(r));
      if (readText().includes('委托测试')) throw new Error(readText());
    });
  }

  c.section('7. 格式不变：readDay 仍能解析');
  {
    writeDay(['- 心情：平静｜格式 A', '- 心情：平静｜[非常重要] 格式 B']);
    await c.check('readDay 解析出 2 条', () => {
      const list = readDay(day, dayDir);
      if (list.length !== 2) throw new Error(JSON.stringify(list));
      if (list[1].importance !== '非常重要') throw new Error(JSON.stringify(list[1]));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
