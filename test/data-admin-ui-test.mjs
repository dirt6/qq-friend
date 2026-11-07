// D1-5D 专项：只读数据管理页面 + API（隔离实例）。
import assert from 'node:assert/strict';
import { createChecker, bootApp } from './_harness.mjs';

const c = createChecker('D1-5D 数据管理 UI');
let ctx = null;
try {
  ctx = await bootApp({ config: { skills: { diary: { root: process.env.TEMP + '/d5d-di ' + Date.now() } } } });
  const { request } = ctx;

  c.section('1. 页面与入口');
  {
    const page = await request('GET', '/data-admin.html');
    const js = await request('GET', '/data-admin.js');
    const index = await request('GET', '/');
    await c.check('页面/脚本可加载、首页有数据管理入口', () => {
      assert.equal(page.status, 200);
      assert.ok(page.text.includes('数据管理'));
      assert.equal(js.status, 200);
      assert.ok(js.text.includes('/api/data-management/idempotency'));
      assert.ok(index.text.includes('/data-admin.html'));
    });
    await c.check('页面只读：无任意路径/PID 输入、无生产执行按钮', () => {
      assert.ok(!/<input/i.test(page.text), '不应有输入框');
      assert.ok(page.text.includes('生产执行 · 未授权'));
      assert.ok(page.text.includes('只读查看 · 已启用'));
      assert.ok(!/id="btn-(delete|cleanup|quarantine)"/i.test(page.text));
    });
  }

  c.section('2. 只读 API');
  {
    const idem = await request('GET', '/api/data-management/idempotency');
    const trash = await request('GET', '/api/data-management/trash');
    const sessions = await request('GET', '/api/data-management/sessions');
    const backups = await request('GET', '/api/data-management/reset-backups');
    const life = await request('GET', '/api/data-management/lifecycle');
    await c.check('5 个 API 200 且返回结构化只读数据', () => {
      for (const r of [idem, trash, sessions, backups, life]) { assert.equal(r.status, 200, r.text); assert.equal(r.data.ok, true); }
      assert.ok(Array.isArray(idem.data.findings));
      assert.ok(Array.isArray(trash.data.files));
      assert.ok(Array.isArray(sessions.data.inventory.sessions));
      assert.ok(Array.isArray(backups.data.items));
      assert.ok(life.data.counts && typeof life.data.counts.warn === 'number');
    });
    await c.check('API 不接受路径/PID 参数（只读固定路由）', () => {
      assert.equal(idem.data.paths, undefined);
      assert.equal(sessions.data.inventory.sessions.some((s) => 'pid' in s), false);
      assert.equal(trash.data.files.some((f) => 'pid' in f), false);
    });
    await c.check('隔离数据下 Session 清单/备份清单为空或仅隔离项', () => {
      assert.ok(Array.isArray(trash.data.files));
      assert.ok(Array.isArray(backups.data.items));
      assert.ok(!String(JSON.stringify(sessions.data)).includes('E:\\\\dsh\\\\QQ-agent\\\\data'));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  if (ctx) { try { await ctx.teardown(); } catch { /* ignore */ } }
}

process.exit(c.finish() ? 0 : 1);
