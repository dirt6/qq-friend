// D1-2c-2a 专项：日记路径契约（diaryRoot / dayFile 唯一解析）。
import path from 'node:path';
import { createChecker } from './_harness.mjs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}


const c = createChecker('D1-2c-2a 路径契约');
const { dayFileOf, dayFileIn, dailyDirOf, diaryRootFromDayDir } = await import('../src/diary/paths.js');

try {
  c.section('1. diaryRoot + dateKey → dayFile');
  {
    const root = path.join('E:', 'dsh', '日记');
    await c.check('dayFile 在 <root>/每日/<date>.md', () => {
      const f = dayFileOf(root, '2026-11-03');
      if (f !== path.join(root, '每日', '2026-11-03.md')) throw new Error(f);
    });
    await c.check('dailyDirOf 与 dayFileOf 一致', () => {
      const f = dayFileOf(root, '2026-11-03');
      if (path.dirname(f) !== dailyDirOf(root)) throw new Error(path.dirname(f));
    });
  }

  c.section('2. writer 的「每日目录」与 meta 的「日记根」等价');
  {
    const root = path.join('E:', 'dsh', '日记');
    const dayDir = dailyDirOf(root);
    await c.check('dayFileIn(dayDir) === dayFileOf(root)', () => {
      const a = dayFileIn(dayDir, '2026-11-03');
      const b = dayFileOf(root, '2026-11-03');
      if (a !== b) throw new Error(`${a} vs ${b}`);
    });
    await c.check('diaryRootFromDayDir 反向一致', () => {
      if (diaryRootFromDayDir(dayDir) !== root) throw new Error(diaryRootFromDayDir(dayDir));
    });
  }

  c.section('3. meta.sourceFile 使用同一解析');
  {
    process.env.QQ_AGENT_DATA_DIR = path.join('C:', 'tmp', 'diary-paths-test');
    const meta = await import('../src/diary/meta.js');
    const root = path.join('E:', 'dsh', '日记');
    await c.check('sourceFile(key, root) === dayFileOf(root,key)', () => {
      if (meta.sourceFile('2026-11-03', root) !== dayFileOf(root, '2026-11-03')) throw new Error('不一致');
    });
  }

  c.section('4. 默认 root 行为不崩（只解析，不写）');
  {
    const fs = await import('node:fs');
    const before = fs.existsSync('E:/dsh/日记/每日');
    await c.check('不传 root 时返回合法路径', () => {
      process.env.QQ_AGENT_DATA_DIR = path.join('C:', 'tmp', 'diary-paths-test');
      const f = dayFileOf('E:/dsh/日记', '2026-11-03');
      if (!f.endsWith(path.join('每日', '2026-11-03.md'))) throw new Error(f);
    });
    await c.check('该测试没有创建/修改生产日记目录', () => {
      const after = fs.existsSync('E:/dsh/日记/每日');
      if (before !== after) throw new Error('生产目录状态被改变');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
