// R8-B0 专项：Memory Hub readImpressions 的 chatKey 归一化。
//
// 规则：只在适配器边界把 `group:1` → `group_1`；严格匹配，不扩大范围。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-impression-key-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
const memoryRoot = path.join(tmp, 'memory');

const writeMember = (chatDir, userId, name, impressions) => {
  const dir = path.join(memoryRoot, chatDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${userId}.json`), JSON.stringify({
    userId, name, impressions, updatedAt: 1700000000000
  }), 'utf8');
};

writeMember('group_1', '10001', '甲', [
  { id: 'imp-1', content: '她喜欢猫', createdAt: 1700000000000, contentType: 'preference', epistemicType: 'direct' },
  { id: 'imp-2', content: '最近在学吉他', createdAt: 1700100000000, contentType: 'event', epistemicType: 'unknown' }
]);
writeMember('group_2', '20001', '乙', [
  { id: 'imp-3', content: '不喜欢被叫全名', createdAt: 1700200000000, contentType: 'preference', epistemicType: 'direct' }
]);
writeMember('private_2', '2', '丙', [
  { id: 'imp-4', content: '私聊里说过怕黑', createdAt: 1700300000000, contentType: 'fact', epistemicType: 'user_stated' }
]);
fs.mkdirSync(path.join(memoryRoot, 'group_9'), { recursive: true });   // 空目录
fs.writeFileSync(path.join(memoryRoot, 'group_1.json'), '{"legacy":true}', 'utf8'); // 旧单文件

const hub = await import('../src/memory-hub/index.js');
const { MemoryStore } = await import('../src/memory.js');

const c = createChecker('R8-B0 impression chatKey 归一化');
const searchImp = (chatKey) => hub.search({ layers: ['impression'], chatKey, limit: 0 });
const texts = (r) => r.items.map((x) => x.content).sort();

try {
  c.section('1. group:1 → group_1');
  {
    const r = searchImp('group:1');
    await c.check('读到 2 条', () => {
      if (!r.ok || r.items.length !== 2) throw new Error(JSON.stringify(r));
    });
    await c.check('内容是 group_1 的', () => {
      const got = texts(r);
      if (JSON.stringify(got) !== JSON.stringify(['她喜欢猫', '最近在学吉他'])) throw new Error(JSON.stringify(got));
    });
  }

  c.section('2. 隔离：group:2 不读 group_1；private:2 不读 group_2');
  {
    const r2 = searchImp('group:2');
    await c.check('group:2 只读到 1 条且不含 group_1 内容', () => {
      if (r2.items.length !== 1) throw new Error(String(r2.items.length));
      if (r2.items.some((x) => x.content.includes('猫'))) throw new Error('串群了');
    });
    const rp = searchImp('private:2');
    await c.check('private:2 只读到 1 条且不含 group_2 内容', () => {
      if (rp.items.length !== 1) throw new Error(String(rp.items.length));
      if (rp.items.some((x) => x.content.includes('全名'))) throw new Error('私聊误读群聊');
    });
  }

  c.section('3. 旧输入兼容：group_1 仍然可读');
  {
    const r = searchImp('group_1');
    await c.check('group_1 读到 2 条', () => {
      if (r.items.length !== 2) throw new Error(String(r.items.length));
    });
  }

  c.section('4. 不传 chatKey：跨群检索行为不变');
  {
    const r = searchImp('');
    await c.check('读到 4 条（2+1+1）', () => {
      if (r.items.length !== 4) throw new Error(String(r.items.length));
    });
  }

  c.section('5. 空目录 / 无匹配 / 非法 key：返回空，不扩大范围');
  {
    for (const key of ['group:9', 'group', 'group:x', 'group:1:2', 'foo:1']) {
      const r = searchImp(key);
      await c.check(`「${key}」→ 0 条且 ok`, () => {
        if (!r.ok) throw new Error('ok=false');
        if (r.items.length !== 0) throw new Error(`读到 ${r.items.length} 条`);
      });
    }
  }

  c.section('6. MemoryStore 与 Hub 对同一群聊一致');
  {
    const store = new MemoryStore();
    const members = store.members('group:1');
    const msContents = members.flatMap((m) => m.impressions.map((x) => x.content)).sort();
    const hubContents = texts(searchImp('group:1'));
    await c.check('数量与内容一致', () => {
      if (msContents.length !== hubContents.length) throw new Error(`${msContents.length} vs ${hubContents.length}`);
      if (JSON.stringify(msContents) !== JSON.stringify(hubContents)) throw new Error(JSON.stringify({ msContents, hubContents }));
    });
  }

  c.section('7. 多群数据隔离');
  {
    const g1 = texts(searchImp('group:1'));
    const g2 = texts(searchImp('group:2'));
    await c.check('两个群的条目没有交集', () => {
      if (g1.some((x) => g2.includes(x))) throw new Error('有交集');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
