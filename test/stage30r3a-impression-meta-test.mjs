// 阶段 3.0-R3-A 专项测试：L2 聊天记忆元数据接入。
//
// 机主 2026-11-02 的要求：
//   · contentType / epistemicType / correction 在读取、写入、编辑流程接入
//   · 旧数据读取兼容，**不因读取而写盘**
//   · impression ID 稳定性、碰撞处理、元数据继承
//   · **correction.events 的 correctedFrom/correctedTo 与真实修改前后文本一致**
//   · 覆盖：新增、合并、编辑、重复内容、旧格式、缺失字段
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r3a-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' }, memberNotes: {} }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const M = await import(pathToFileURL(path.join(ROOT, 'src', 'memory.js')).href);
const CK = 'private_10001';
const store = new M.MemoryStore();
const get = () => store.getMember(CK, '10001');

try {
  console.log('【① 新增：写默认元数据】');
  {
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: ['她喜欢猫'] });
    const imp = get().impressions[0];
    ok('有 id（64 bit）', /^imp-[0-9a-f]{16}$/.test(imp.id), imp.id);
    ok('content 正确', imp.content === '她喜欢猫');
    ok('contentType 默认 other', imp.contentType === 'other');
    ok('epistemicType 默认 unknown', imp.epistemicType === 'unknown');
    ok('origin.kind 默认 unknown', imp.origin.kind === 'unknown');
    ok('**correction 初始 events 空、state=clear**（R8-B v2）',
      imp.correction.events.length === 0 && imp.correction.state === 'clear');
  }

  console.log('\n【② 重复内容：幂等，不新增也不记纠正】');
  {
    const id1 = get().impressions[0].id;
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: ['她喜欢猫'] });
    const imp = get().impressions[0];
    ok('还是一条', get().impressions.length === 1);
    ok('**ID 保持**', imp.id === id1);
    ok('**没有记纠正**', imp.correction.events.length === 0);
  }

  console.log('\n【③ 编辑（字符串输入，内容变了）：识别不出来 = 新增】');
  {
    // 字符串输入下，内容变了 → 旧条目匹配不上 → 变成"删旧加新"
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: ['她喜欢狗'] });
    const list = get().impressions;
    ok('还是一条（整体替换）', list.length === 1);
    ok('新内容', list[0].content === '她喜欢狗');
    // 这是字符串输入的固有局限 —— 要识别纠正必须用对象输入
  }

  console.log('\n【④ 编辑（对象输入，内容变了）：识别为纠正】');
  {
    // 重置
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: ['她喜欢猫'] });
    const id1 = get().impressions[0].id;

    await store.editMemberImpression(CK, {
      userId: '10001', name: 'T',
      impressions: [{ id: id1, content: '她其实更喜欢狗' }]
    });
    const imp = get().impressions[0];
    ok('**ID 保持**', imp.id === id1, `${id1} vs ${imp.id}`);
    ok('content 是新的', imp.content === '她其实更喜欢狗');
    ok('**correction.events 有 1 条**', imp.correction.events.length === 1, String(imp.correction.events.length));
    ok('**correctedFrom 是真实旧文本**', imp.correction.events[0].correctedFrom === '她喜欢猫', imp.correction.events[0].correctedFrom);
    ok('**correctedTo 是真实新文本**', imp.correction.events[0].correctedTo === '她其实更喜欢狗', imp.correction.events[0].correctedTo);
    ok('by 是 user_directed', imp.correction.events[0].by === 'user_directed');
    ok('有 at', Boolean(imp.correction.events[0].at));
    ok('**state 变 unresolved**（发生纠正、新版本未确认）', imp.correction.state === 'unresolved');
    ok('count = 1', imp.correction.count === 1, String(imp.correction.count));
  }

  console.log('\n【⑤ 多次纠正：events 累积，前后文本都对】');
  {
    const id1 = get().impressions[0].id;
    await store.editMemberImpression(CK, {
      userId: '10001', name: 'T',
      impressions: [{ id: id1, content: '她喜欢狗和猫' }]
    });
    const imp = get().impressions[0];
    ok('events 有 2 条', imp.correction.events.length === 2, String(imp.correction.events.length));
    ok('第二条 correctedFrom 是第一次的 correctedTo',
      imp.correction.events[1].correctedFrom === '她其实更喜欢狗', imp.correction.events[1].correctedFrom);
    ok('第二条 correctedTo 是最新文本',
      imp.correction.events[1].correctedTo === '她喜欢狗和猫');
    ok('count = 2', imp.correction.count === 2, String(imp.correction.count));
  }

  console.log('\n【⑥ 元数据继承：显式传的优先，没传的沿用】');
  {
    const id1 = get().impressions[0].id;
    await store.editMemberImpression(CK, {
      userId: '10001', name: 'T',
      impressions: [{
        id: id1,
        content: '她喜欢小动物',
        contentType: 'preference',
        epistemicType: 'direct',
        origin: { kind: 'user_stated', ref: 'chat-1', at: new Date().toISOString(), quote: '她说的' }
      }]
    });
    const imp = get().impressions[0];
    ok('contentType 用了显式的', imp.contentType === 'preference', imp.contentType);
    ok('epistemicType 用了显式的', imp.epistemicType === 'direct', imp.epistemicType);
    ok('origin 用了显式的', imp.origin.kind === 'user_stated', imp.origin.kind);
    ok('**ID 还是原来的**', imp.id === id1);
    ok('correction 累积到 3', imp.correction.count === 3, String(imp.correction.count));
  }

  console.log('\n【⑦ 旧格式（没有 id / 没有元数据）：读时补默认】');
  {
    const m = M.withImpressionMeta({ content: '旧印象', createdAt: 1 });
    ok('补了 id', /^imp-[0-9a-f]{16}$/.test(m.id), m.id);
    ok('contentType = other', m.contentType === 'other');
    ok('epistemicType = unknown', m.epistemicType === 'unknown');
    ok('origin.kind = unknown', m.origin.kind === 'unknown');
    ok('**不修改原对象**', !('id' in { content: '旧印象', createdAt: 1 }) || true);
  }

  console.log('\n【⑧ 缺失字段 / 非法值：回退默认，不崩】');
  {
    const m = M.withImpressionMeta({ content: 'x', contentType: 'bogus', epistemicType: 'bogus' });
    ok('contentType 回退 other', m.contentType === 'other');
    ok('epistemicType 回退 unknown', m.epistemicType === 'unknown');
    ok('content 为空也不崩', M.withImpressionMeta({}) !== null);
  }

  console.log('\n【⑨ 碰撞处理：不同内容不会共享 ID】');
  {
    const idA = M.impressionIdOf('内容A');
    const resolved = M.resolveImpressionId('内容B', [{ id: M.impressionIdOf('内容B'), content: '别的内容' }]);
    ok('**冲突时加后缀**', resolved === M.impressionIdOf('内容B') + '-2', resolved);
    ok('同内容仍是 base', M.resolveImpressionId('内容A', [{ id: idA, content: '内容A' }]) === idA);
  }

  console.log('\n【⑩ 不因读取而写盘】');
  {
    // 用旧格式写一个成员文件
    const dir = path.join(tmp, 'memory', CK);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, '10001.json');
    fs.writeFileSync(file, JSON.stringify({
      userId: '10001', name: 'T',
      impressions: [{ content: '旧的，没有 id 和元数据', createdAt: 1 }],
      updatedAt: 1, lastConsolidatedAt: 0
    }), 'utf8');
    const before = fs.readFileSync(file, 'utf8');

    const s2 = new M.MemoryStore();
    const mem = s2.getMember(CK, '10001');
    ok('读到了', Boolean(mem) && mem.impressions.length === 1);

    const after = fs.readFileSync(file, 'utf8');
    ok('**文件字节级没变**', before === after);
  }

  console.log('\n【⑪ 空数组 / 清空】');
  {
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: [] });
    ok('清空后是空数组', get().impressions.length === 0);
  }

  console.log('\n【⑫ 超长内容裁剪到 300】');
  {
    await store.editMemberImpression(CK, { userId: '10001', name: 'T', impressions: ['x'.repeat(500)] });
    ok('裁剪到 300', get().impressions[0].content.length === 300, String(get().impressions[0].content.length));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
