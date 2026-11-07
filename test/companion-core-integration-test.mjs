// R8-C2 专项：聊天与自主是否真正共享同一套伙伴状态（隔离数据）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-integration-'));
const diaryRoot = path.join(tmp, 'diary');
process.env.QQ_AGENT_DATA_DIR = tmp;

const c = createChecker('R8-C2 伙伴状态共享');
const { createCompanionCore } = await import('../src/companion-core/index.js');
const learned = await import('../src/learned.js');
const core = createCompanionCore();

try {
  c.section('1. 聊天写入 → 自主检索同一长期记忆');
  {
    const created = learned.addExperience({
      text: '老大说最近想吃火锅，等周末一起去',
      sourceDay: '2026-11-03',
      origin: { kind: 'user_stated', ref: 'chat:test', at: new Date().toISOString(), quote: '想吃火锅' }
    });
    await c.check('聊天侧写入成功', () => {
      if (!created.ok) throw new Error(JSON.stringify(created));
    });
    const found = core.memory.search({ query: '火锅', layers: ['learned'], limit: 5 });
    await c.check('自主侧通过核心能检索到', () => {
      if (!found.items.some((x) => x.content.includes('火锅'))) throw new Error(JSON.stringify(found.items));
    });
    await c.check('来源/类型元数据带出', () => {
      const it = found.items.find((x) => x.content.includes('火锅'));
      if (!it || it.type !== 'learned') throw new Error(JSON.stringify(it));
    });
  }

  c.section('2. 自主写日记 → 聊天可检索');
  {
    const w = core.diary.write({ content: '今天在窗台看见一只橘猫，蹲了很久', root: path.join(diaryRoot, '每日'), source: 'autonomous' });
    await c.check('日记写入成功', () => {
      if (!w.ok) throw new Error(JSON.stringify(w));
    });
    const found = core.memory.search({ layers: ['diary'], diaryRoot, limit: 5 });
    await c.check('聊天侧通过核心能检索到日记', () => {
      if (!found.items.some((x) => x.content.includes('橘猫'))) throw new Error(JSON.stringify(found.items));
    });
  }

  c.section('3. 自主更新 Pending → 聊天可见');
  {
    const added = core.pending.add({ text: '提醒老大买猫粮', source: 'autonomous' });
    await c.check('Pending 写入成功', () => {
      if (!added || added.ok === false) throw new Error(JSON.stringify(added));
    });
    await c.check('state.get 能看到', () => {
      const st = core.state.get();
      const list = Array.isArray(st.pending) ? st.pending : [];
      if (!list.some((p) => String(p.text || '').includes('猫粮'))) throw new Error(JSON.stringify(list));
    });
    await c.check('聊天侧的 prompt 段能看到', () => {
      const text = core.state.prompt();
      if (!String(text).includes('猫粮')) throw new Error(text);
    });
  }

  c.section('4. Goal 不重复创建');
  {
    const before = (core.state.get().goals || []).length;
    core.goals.create({ text: '长期学吉他', source: 'autonomous' });
    core.goals.create({ text: '长期学吉他', source: 'autonomous' });
    await c.check('同文本重复创建不增加条目', () => {
      const after = (core.state.get().goals || []).length;
      if (after > before + 1) throw new Error(`before=${before} after=${after}`);
    });
  }

  c.section('5. 并发更新不互相覆盖');
  {
    core.pending.add({ text: '并行事项 A', source: 'test' });
    core.pending.add({ text: '并行事项 B', source: 'test' });
    await c.check('两次写入都保留', () => {
      const st = core.state.get();
      const texts = (st.pending || []).map((p) => String(p.text || ''));
      if (!texts.includes('并行事项 A') || !texts.includes('并行事项 B')) throw new Error(JSON.stringify(texts));
    });
  }

  c.section('6. 空数据/缺失文件不崩');
  {
    await c.check('空群聊检索 → 空结果', () => {
      const r = core.memory.search({ layers: ['impression'], chatKey: 'group:999', limit: 5 });
      if (!r.ok || r.items.length !== 0) throw new Error(JSON.stringify(r));
    });
    await c.check('不存在的日记日 → 空数组', () => {
      const r = core.diary.readDay('1999-01-01', diaryRoot);
      if (!Array.isArray(r)) throw new Error(JSON.stringify(r));
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
