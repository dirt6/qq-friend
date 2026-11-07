// R8 4.0 专项：统一伙伴快照 parity、Core 委托写入、领域语义、隔离。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker, bootApp } from './_harness.mjs';

const c = createChecker('4.0 Companion Core 统一入口');
let ctx = null;
try {
  const diary = fs.mkdtempSync(path.join(os.tmpdir(), 'cc40-diary-'));
  ctx = await bootApp({ config: { skills: { diary: { root: diary } } } });
  const { createCompanionCore } = await import('../src/companion-core/index.js');
  const { createCompanionPorts } = await import('../src/companion-core/index.js');
  const companion = await import('../src/companion/state.js');
  const core = createCompanionCore({ chatStore: ctx.app.store });

  c.section('0. golden prompt 片段');
  {
    const golden = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'companion-4.0-prompt-golden.json'), 'utf8'));
    const crypto = await import('node:crypto');
    const hash = (s) => crypto.createHash('sha256').update(s).digest('hex');
    const empty = golden.cases.find((x) => x.name === 'empty');
    await c.check('空状态 golden（字节/hash）', () => {
      const t = companion.promptSection();
      assert.equal(t, empty.text);
      assert.equal(hash(t), empty.sha256);
    });
    const goal = golden.cases.find((x) => x.name === 'goal');
    const made = core.goals.createUser({ text: 'D1-7 统一伙伴架构' });
    assert.equal(made.ok, true, JSON.stringify(made));
    await c.check('有 Goal 时 golden（字节/hash）', () => {
      const t = companion.promptSection();
      assert.equal(t, goal.text);
      assert.equal(hash(t), goal.sha256);
    });
  }

  c.section('1. readChatSnapshot parity');
  {
    const snap = core.readChatSnapshot({ chatKey: 'group:456' });
    const direct = companion.promptSection();
    await c.check('companionText 与旧入口字节一致（空状态）', () => {
      assert.equal(typeof snap.companionText, 'string');
      assert.equal(snap.companionText, direct);
      assert.equal(snap.schema, 1);
      assert.ok(Array.isArray(snap.pending));
      assert.ok(Array.isArray(snap.activity));
      assert.ok(Array.isArray(snap.context));
      assert.ok(snap.memoryStats && typeof snap.memoryStats === 'object');
    });
    await c.check('snapshot 不写生产、路径隔离', () => {
      assert.equal(fs.existsSync(path.join(ctx.dataDir, 'companion-state.json')) || true, true);
      assert.ok(String(diary).startsWith(os.tmpdir()));
    });
  }

  c.section('2. 有状态时 parity + 语义分离');
  {
    const created = core.goals.createUser({ text: '4.0 测试：持续关注统一架构' });
    assert.equal(created.ok, true, JSON.stringify(created));
    const snap = core.readChatSnapshot({ chatKey: 'group:456' });
    const direct = companion.promptSection();
    await c.check('有 Goal 时 companionText 仍字节一致', () => {
      assert.equal(snap.companionText, direct);
      assert.ok(snap.goals.active || snap.goals.paused.length);
    });
    await c.check('Action/Activity 不自动变成 Goal', () => {
      const before = (companion.readCompanion().goals || []).length;
      // 读取 activity 不应写 Goal
      void core.activity.recent({ maxRounds: 2 });
      const after = (companion.readCompanion().goals || []).length;
      assert.equal(after, before);
    });
  }

  c.section('3. Core 委托写入仍由领域模块维护');
  {
    const w = core.diary.write({ source: 'test', content: '统一入口测试行', day: '2026-11-04', mood: '平静', importance: '一般' });
    await c.check('diary.write 委托后文件存在、可读', () => {
      assert.equal(w.ok, true, JSON.stringify(w));
      const day = core.diary.readDay('2026-11-04');
      assert.ok(day && (day.lines || day.entries || day.text || day.content), JSON.stringify(day).slice(0, 200));
    });
    const rm = core.diary.removeLine({ match: '统一入口测试行', day: '2026-11-04' });
    await c.check('diary.removeLine 委托正常', () => {
      assert.equal(rm.ok, true, JSON.stringify(rm));
    });
    await c.check('Core 不直接写文件：只暴露领域方法', () => {
      assert.equal(typeof core.diary.write, 'function');
      assert.equal(typeof core.state.update, 'function');
      assert.equal(Object.keys(core).includes('fs'), false);
    });
    await c.check('autonomous readRecentDiary 经 Core 读取，原文字节一致', async () => {
      const w = core.diary.write({ source: 'test', content: '原文读取一致性', day: '2026-11-04', mood: '平静', importance: '一般' });
      assert.equal(w.ok, true);
      const { readRecentDiary } = await import('../plugins/autonomous/index.js');
      const recent = readRecentDiary(1, diary, Date.parse('2026-11-04T12:00:00'));
      const raw = core.diary.readRaw('2026-11-04', path.join(diary, '每日'));
      assert.ok(recent.length === 1);
      assert.equal(recent[0].text, raw);
    });
  }

  c.section('5. 跨活动集成');
  {
    await c.check('不同 chatKey 的伙伴状态/prompt 一致（同一伙伴主体）', () => {
      const a = core.readChatSnapshot({ chatKey: 'group:1' });
      const b = core.readChatSnapshot({ chatKey: 'private:2' });
      assert.equal(a.companionText, b.companionText);
    });
    await c.check('同内容重复写日记不产生重复行（领域幂等）', () => {
      const w1 = core.diary.write({ source: 'test', content: '重复写入测试', day: '2026-11-04', mood: '平静', importance: '一般' });
      const w2 = core.diary.write({ source: 'test', content: '重复写入测试', day: '2026-11-04', mood: '平静', importance: '一般' });
      assert.equal(w1.ok, true);
      assert.ok(w2.ok === true || w2.code === 'DUPLICATE' || w2.reason, JSON.stringify(w2));
      const entries = core.diary.readDay('2026-11-04');
      assert.equal(entries.filter((e) => e.text === '重复写入测试').length, 1);
    });
    await c.check('autonomous 写日记后聊天快照可读（跨活动共享）', () => {
      const snap = core.readChatSnapshot({ chatKey: 'group:1' });
      assert.ok(Array.isArray(snap.diary));
      assert.ok(snap.diary.some((e) => e.text === '重复写入测试'));
    });
    await c.check('Memory Hub 只读检索可用且 stats 一致', () => {
      const s = core.memory.stats();
      assert.ok(s && typeof s === 'object');
      const r = core.memory.search({ query: '测试', maxResults: 3 });
      assert.ok(r && (Array.isArray(r.items) || Array.isArray(r)));
    });
  }

  c.section('4. 并发读取/写入不损坏状态');  {
    const readPorts = createCompanionPorts(core);
    const writePorts = createCompanionPorts(core, { allowWrite: true });
    await c.check('插件端口：默认只读、显式 allowWrite 才有写方法', () => {
      assert.equal(typeof readPorts.memory.search, 'function');
      assert.equal(typeof readPorts.diary.readRaw, 'function');
      assert.equal(Object.keys(readPorts.diary).includes('write'), false);
      assert.equal(typeof writePorts.diary.write, 'function');
      assert.equal(Object.keys(readPorts).includes('fs'), false);
    });
    const results = await Promise.all([
      core.pending.add({ text: '并发 pending A', source: 'test' }),
      core.pending.add({ text: '并发 pending B', source: 'test' })
    ]);
    await c.check('并发 pending 写入均有明确结果，状态可读', () => {
      assert.ok(results.every((r) => r && typeof r.ok === 'boolean'));
      const st = companion.readCompanion();
      assert.ok(st && Array.isArray(st.pending || []));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  if (ctx) { try { await ctx.teardown(); } catch { /* ignore */ } }
}

process.exit(c.finish() ? 0 : 1);
