// D1-2c-2c 专项：日记测试隔离门禁。
// 必须通过 test/run-diary-test.mjs 运行（由启动器注入 DIARY_TEST_TMP / DIARY_TEST_GUARD）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';
if (String(process.env.DIARY_TEST_RUNNER || '') !== '1') {
  console.error('[diary-test] 必须通过 test/run-diary-test.mjs 运行（未检测到隔离启动器）');
  process.exit(2);
}


const c = createChecker('D1-2c-2c 隔离门禁');
const { assertDiaryWritePath, __internals } = await import('../src/diary/test-guard.js');

const TMP = process.env.DIARY_TEST_TMP || '';
const PROD = __internals.PROD_DATA;
const prodHash = () => {
  const list = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { list.push(p + ':' + fs.statSync(p).size); } catch { /* ignore */ } }
    }
  };
  walk(path.join(PROD, 'diary-meta'));
  return list.sort().join('|');
};
const expectThrow = (fn, label) => {
  try { fn(); throw new Error(`${label}: 没有抛错`); }
  catch (e) { if (String(e.message).includes('没有抛错')) throw e; }
};

try {
  c.section('1. 启动器未提供临时根 → 安全失败');
  {
    const saved = process.env.DIARY_TEST_TMP;
    process.env.DIARY_TEST_TMP = '';
    await c.check('空 DIARY_TEST_TMP → 抛 EDiaryGuard', () => {
      expectThrow(() => assertDiaryWritePath(path.join(os.tmpdir(), 'x.md')), '空根');
    });
    process.env.DIARY_TEST_TMP = saved;
  }

  c.section('2. 临时根内路径 → 通过');
  {
    await c.check('TMP 内文件通过', () => {
      assertDiaryWritePath(path.join(TMP, '日记', '每日', '2026-11-03.md'));
    });
  }

  c.section('3. 门禁基准以启动器 TMP 为准（改 QQ_AGENT_DATA_DIR 不能扩大范围）');
  {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-guard-other-'));
    await c.check('改 DATA_DIR 后，写它但不在 TMP 内 → 拒绝', () => {
      const saved = process.env.QQ_AGENT_DATA_DIR;
      process.env.QQ_AGENT_DATA_DIR = other;
      try {
        expectThrow(() => assertDiaryWritePath(path.join(other, 'diary-meta', 'x.json')), '越界');
      } finally {
        process.env.QQ_AGENT_DATA_DIR = saved;
      }
    });
    fs.rmSync(other, { recursive: true, force: true });
  }

  c.section('4-7. writer / outbox / meta / 正文 写生产路径 → 拒绝');
  {
    await c.check('writer 正文（生产每日目录）', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD, '..', '日记', '每日', '2026-11-03.md')), '正文');
    });
    await c.check('outbox（生产 data/diary-meta/pending.json）', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD, 'diary-meta', 'pending.json')), 'outbox');
    });
    await c.check('meta（生产 data/diary-meta/<date>.json）', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD, 'diary-meta', '2026-11-03.json')), 'meta');
    });
    await c.check('幂等表（生产 data/diary-idempotency.json）', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD, 'diary-idempotency.json')), 'idem');
    });
  }

  c.section('8. .. 穿越 → 拒绝');
  {
    await c.check('含 .. 的原始路径直接拒绝', () => {
      expectThrow(() => assertDiaryWritePath(path.join(TMP, '..', '..', 'x.md')), '..');
    });
  }

  c.section('9. 大小写/分隔符不能绕过');
  {
    await c.check('大小写变体仍被识别为生产', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD.toUpperCase(), 'diary-meta', 'x.json')), '大小写');
    });
    await c.check('正斜杠变体仍被识别为生产', () => {
      expectThrow(() => assertDiaryWritePath(String(path.join(PROD, 'diary-meta', 'x.json')).replace(/\\/g, '/')), '分隔符');
    });
  }

  c.section('10. 符号链接（权限不足则 INCONCLUSIVE）');
  {
    const link = path.join(TMP, 'link-out');
    let ok = false;
    try {
      fs.symlinkSync(os.tmpdir(), link, 'junction');
      ok = true;
    } catch { /* 需要权限 */ }
    if (ok) {
      await c.check('链接指向 TMP 外 → 解析后拒绝', () => {
        expectThrow(() => assertDiaryWritePath(path.join(link, 'x.md')), '符号链接');
      });
      try { fs.unlinkSync(link); } catch { /* ignore */ }
    } else {
      console.log('  INCONCLUSIVE 符号链接（Windows 权限不足，未验证）');
    }
  }

  c.section('11. 多进程不同根互不污染');
  {
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-guard-a-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-guard-b-'));
    const run = (dir) => new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        import fs from 'node:fs'; import path from 'node:path';
        const { assertDiaryWritePath } = await import('file:///E:/dsh/QQ-agent/src/diary/test-guard.js');
        process.env.DIARY_TEST_TMP = ${JSON.stringify(dir)};
        process.env.DIARY_TEST_GUARD = '1';
        assertDiaryWritePath(path.join(${JSON.stringify(dir)}, 'own.txt'));
        fs.writeFileSync(path.join(${JSON.stringify(dir)}, 'own.txt'), 'x');
      `], { stdio: 'ignore', env: { ...process.env, DIARY_TEST_TMP: dir, DIARY_TEST_GUARD: '1' } });
      child.on('exit', (code) => resolve(code));
    });
    const [ca, cb] = await Promise.all([run(a), run(b)]);
    await c.check('两个进程各写各的，互不污染', () => {
      if (ca !== 0 || cb !== 0) throw new Error(`exit ${ca}/${cb}`);
      if (!fs.existsSync(path.join(a, 'own.txt')) || !fs.existsSync(path.join(b, 'own.txt'))) throw new Error('文件缺失');
    });
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }

  c.section('12. 进程异常退出后生产不变');
  {
    const before = prodHash();
    await new Promise((resolve) => {
      const child = spawn(process.execPath, ['-e', `
        import fs from 'node:fs'; import path from 'node:path';
        const { assertDiaryWritePath } = await import('file:///E:/dsh/QQ-agent/src/diary/test-guard.js');
        assertDiaryWritePath(path.join(process.env.DIARY_TEST_TMP, 'crash.txt'));
        fs.writeFileSync(path.join(process.env.DIARY_TEST_TMP, 'crash.txt'), 'x');
        process.kill(process.pid, 'SIGKILL');
      `], { stdio: 'ignore', env: { ...process.env } });
      child.on('exit', resolve);
    });
    await c.check('生产 diary-meta 未新增/变化', () => {
      if (prodHash() !== before) throw new Error('生产 diary-meta 变了');
    });
  }
  c.section('13. realish 的错误分类（fail-closed）');
  {
    await c.check('权限不可达路径 → 拒绝，不回退原始 abs', () => {
      expectThrow(() => assertDiaryWritePath('C:\\System Volume Information\\x.md'), 'EACCES');
    });
    await c.check('根不可达（不存在驱动器）→ 拒绝', () => {
      expectThrow(() => assertDiaryWritePath('Q:\\nope\\x.md'), '根不可达');
    });
  }

  c.section('14. 事件目录（appendEvent）写生产 → 拒绝');
  {
    await c.check('companion-events/active.ndjson 生产路径', () => {
      expectThrow(() => assertDiaryWritePath(path.join(PROD, 'companion-events', 'active.ndjson')), '事件');
    });
  }

  c.section('15. 未经启动器直接运行日记测试 → 拒绝启动');
  {
    const target = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'diary-append-identity-test.mjs');
    const result = await new Promise((resolve) => {
      const env = { ...process.env };
      delete env.DIARY_TEST_RUNNER;
      delete env.DIARY_TEST_GUARD;
      const child = spawn(process.execPath, [target], { stdio: 'ignore', env });
      child.on('exit', (code) => resolve(code));
    });
    await c.check('直接运行 exit=2（守卫拒绝）', () => {
      if (result !== 2) throw new Error(`exit=${result}`);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
