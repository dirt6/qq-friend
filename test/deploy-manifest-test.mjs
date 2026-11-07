// D1-3c C2 专项：部署清单生成/校验（只读、隔离 fixture）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-3c C2 部署清单');
const { generateManifest, verifyManifest, ROOT } = await import('../scripts/deploy-manifest.mjs');

try {
  c.section('1. 当前仓库清单');
  {
    const m = generateManifest({ production: false });
    await c.check('HEAD 为非空 40 位 sha、版本号存在、文件数 > 0', () => {
      assert.match(m.git.head, /^[0-9a-f]{40}$/);
      assert.match(String(m.versions.app), /^\d+\.\d+\.\d+/);
      assert.ok(m.code.totals.files > 50, `files=${m.code.totals.files}`);
      assert.ok(m.code.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    });
    await c.check('清单可自校验（254 个文件 hash 一致）', () => {
      const r = verifyManifest(m);
      assert.equal(r.ok, true, JSON.stringify(r.problems.slice(0, 3)));
      assert.equal(r.checked, m.code.totals.files);
    });
    await c.check('篡改一个 hash → 校验失败且定位到文件', () => {
      const bad = JSON.parse(JSON.stringify(m));
      bad.code.files[0].sha256 = '0'.repeat(64);
      const r = verifyManifest(bad);
      assert.equal(r.ok, false);
      assert.ok(r.problems.some((p) => p.type === 'mismatch' && p.path === bad.code.files[0].path));
    });
  }

  c.section('2. 隔离 fixture：缺失/多余文件');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-manifest-'));
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'src', 'a.js'), 'export const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'src', 'b.js'), 'export const b = 2;\n', 'utf8');
    const m = generateManifest({ root: tmp, dirs: ['src'], files: [], production: false });
    await c.check('fixture 清单自校验通过、dirty 为 true（非 git 仓库）', () => {
      const r = verifyManifest(m, { root: tmp });
      assert.equal(r.ok, true);
      assert.equal(m.git.head, '');
      assert.equal(m.git.dirtyFiles.length, 0);
    });
    fs.unlinkSync(path.join(tmp, 'src', 'b.js'));
    await c.check('文件缺失 → missing', () => {
      const r = verifyManifest(m, { root: tmp });
      assert.equal(r.ok, false);
      assert.ok(r.problems.some((p) => p.type === 'missing' && p.path === 'src/b.js'));
    });
    fs.writeFileSync(path.join(tmp, 'src', 'c.js'), 'export const c = 3;\n', 'utf8');
    await c.check('多出未登记文件 → extra（只对运行时代码目录）', () => {
      const r = verifyManifest(m, { root: tmp });
      assert.ok(r.problems.some((p) => p.type === 'extra' && p.path === 'src/c.js'));
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  c.section('3. 清单不含生产数据内容');
  {
    const m = generateManifest({ production: false });
    await c.check('不含 data/ 文件、不含明文配置', () => {
      assert.ok(!m.code.files.some((f) => f.path.startsWith('data/')), '不应包含 data/');
      const text = JSON.stringify(m);
      assert.ok(!text.includes('apiKey'), '不应包含配置字段');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
