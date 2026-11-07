// 阶段 3.0-R2 专项测试：经验记忆 + 聊天记忆的元数据结构化。
//
// 机主 2026-11-02 定的维度：
//   · contentType   ：fact / preference / event / plan / other
//   · epistemicType ：direct / inferred / unknown
//   · correction    ：独立结构，含 count / events / historicalUnresolved
//
// 实测发现（本测试要钉住）：
//   · 生产上 22 条 learn 全部 corrections:1、history 全空 → 1 是"新建默认值"，不是"被纠正"
//   · impressions 已经是对象数组 {content, createdAt}，不是字符串数组
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r2-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' }, memberNotes: {} }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const L = await import(pathToFileURL(path.join(ROOT, 'src', 'learned.js')).href);
const M = await import(pathToFileURL(path.join(ROOT, 'src', 'memory.js')).href);
const LEARNED = path.join(tmp, 'learned.json');
const readL = () => JSON.parse(fs.readFileSync(LEARNED, 'utf8'));
const resetL = () => { try { fs.rmSync(LEARNED, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 常量枚举】');
  {
    ok('CONTENT_TYPES 五个', JSON.stringify(L.CONTENT_TYPES) === JSON.stringify(['fact', 'preference', 'event', 'plan', 'other']), JSON.stringify(L.CONTENT_TYPES));
    ok('EPISTEMIC_TYPES 三个', JSON.stringify(L.EPISTEMIC_TYPES) === JSON.stringify(['direct', 'inferred', 'unknown']), JSON.stringify(L.EPISTEMIC_TYPES));
    ok('**preference 在 contentType 里，不在 epistemicType 里**',
      L.CONTENT_TYPES.includes('preference') && !L.EPISTEMIC_TYPES.includes('preference'));
  }

  console.log('\n【② withMeta：旧数据默认值（只读）】');
  {
    const old = { id: 'x', text: '旧经验', status: 'pending', corrections: 1 };
    const m = L.withMeta(old);
    ok('contentType = other', m.contentType === 'other', m.contentType);
    ok('epistemicType = unknown', m.epistemicType === 'unknown', m.epistemicType);
    ok('origin.kind = unknown', m.origin.kind === 'unknown', m.origin.kind);
    ok('**旧数据无状态 → correction.state = unknown**', m.correction.state === 'unknown');
    ok('correction.count 沿用 corrections', m.correction.count === 1, String(m.correction.count));
    ok('**不修改原对象**', old.contentType === undefined);
  }

  console.log('\n【③ addExperience：写元数据】');
  {
    resetL();
    const r = L.addExperience({
      text: '老大不喜欢被 @',
      contentType: 'preference',
      epistemicType: 'direct',
      origin: { kind: 'user_stated', ref: 'chat-1', at: new Date().toISOString(), quote: '别 @ 我' }
    });
    ok('创建成功', r.ok === true && r.merged === false);
    const it = readL().items[0];
    ok('contentType 落盘', it.contentType === 'preference', it.contentType);
    ok('epistemicType 落盘', it.epistemicType === 'direct', it.epistemicType);
    ok('origin 落盘', it.origin.kind === 'user_stated', it.origin.kind);
    ok('**correction 落盘，events 空**', it.correction.count === 1 && it.correction.events.length === 0);
    ok('**新建的 correction.state = clear**（没有纠正历史）', it.correction.state === 'clear');
    ok('corrections 旧字段仍是 1', it.corrections === 1);
  }

  console.log('\n【④ 非法枚举值 → 回退默认，不崩】');
  {
    resetL();
    L.addExperience({ text: '测试非法值', contentType: 'bogus', epistemicType: 'bogus' });
    const it = readL().items[0];
    ok('contentType 回退 other', it.contentType === 'other', it.contentType);
    ok('epistemicType 回退 unknown', it.epistemicType === 'unknown', it.epistemicType);
  }

  console.log('\n【⑤ 合并时记录 correction.events】');
  {
    resetL();
    // 第一次
    L.addExperience({ text: '不要每次都叫老大' });
    const first = readL().items[0];
    ok('第一条创建', first.corrections === 1);

    // 高相似 → 合并
    const r2 = L.addExperience({ text: '不要每次都叫老大，称呼自然点' });
    ok('**触发合并**', r2.merged === true, JSON.stringify(r2).slice(0, 100));
    const it = readL().items[0];
    ok('**correction.events 有 1 条**', it.correction.events.length === 1, String(it.correction.events.length));
    ok('correctedFrom 是旧文本', it.correction.events[0].correctedFrom === '不要每次都叫老大', it.correction.events[0].correctedFrom);
    ok('correctedTo 是新文本', it.correction.events[0].correctedTo === '不要每次都叫老大，称呼自然点');
    ok('by 是 user_directed', it.correction.events[0].by === 'user_directed');
    ok('**state 变 unresolved**（合并后新版本未确认）', it.correction.state === 'unresolved');
    ok('count 递增到 2', it.correction.count === 2, String(it.correction.count));
    ok('**旧字段 corrections 同步到 2**', it.corrections === 2, String(it.corrections));
  }

  console.log('\n【⑥ listAll 读时补默认值，不写盘】');
  {
    resetL();
    fs.writeFileSync(LEARNED, JSON.stringify({
      version: 1,
      items: [{ id: 'old-1', text: '旧经验一', status: 'pending', corrections: 1 }]
    }));
    const before = fs.readFileSync(LEARNED, 'utf8');
    const list = L.listAll();
    const after = fs.readFileSync(LEARNED, 'utf8');
    ok('读到了', list.length === 1);
    ok('有默认元数据', list[0].contentType === 'other');
    ok('**文件字节级没变**', before === after);
  }

  console.log('\n【⑦ impressionIdOf：稳定 ID（64 bit）】');
  {
    ok('同内容同 ID', M.impressionIdOf('abc') === M.impressionIdOf('abc'));
    ok('不同内容不同 ID', M.impressionIdOf('abc') !== M.impressionIdOf('abd'));
    ok('前缀是 imp-', M.impressionIdOf('abc').startsWith('imp-'));
    ok('空内容给空串', M.impressionIdOf('') === '');
    // 4.0 / 3.0-R3：机主 2026-11-02 指出 24 bit 会碰撞，改成 64 bit
    ok('**ID 是 16 位十六进制（64 bit）**', /^imp-[0-9a-f]{16}$/.test(M.impressionIdOf('abc')), M.impressionIdOf('abc'));
  }

  console.log('\n【⑦b resolveImpressionId：碰撞检测】');
  {
    const idA = M.impressionIdOf('内容A');
    ok('没冲突 → 用 base', M.resolveImpressionId('内容A', []) === idA);
    ok('**同内容 → 仍是 base（幂等）**', M.resolveImpressionId('内容A', [{ id: idA, content: '内容A' }]) === idA);
    ok('**不同内容占了 base → 加后缀**',
      M.resolveImpressionId('内容B', [{ id: M.impressionIdOf('内容B'), content: '别的内容' }]) === M.impressionIdOf('内容B') + '-2',
      M.resolveImpressionId('内容B', [{ id: M.impressionIdOf('内容B'), content: '别的内容' }]));
    ok('空内容给空串', M.resolveImpressionId('', []) === '');
  }

  console.log('\n【⑧ withImpressionMeta：旧数据补默认】');
  {
    const old = { content: '旧的印象', createdAt: 1 };
    const m = M.withImpressionMeta(old);
    ok('补了 id', Boolean(m.id) && m.id.startsWith('imp-'));
    ok('contentType = other', m.contentType === 'other');
    ok('epistemicType = unknown', m.epistemicType === 'unknown');
    ok('origin.kind = unknown', m.origin.kind === 'unknown');
    ok('**不修改原对象**', old.id === undefined);
  }

  console.log('\n【⑨ editMemberImpression：编辑不丢 ID 和元数据】');
  {
    const store = new M.MemoryStore();
    const chatKey = 'private_10001';
    // 先写一条
    await store.editMemberImpression(chatKey, {
      userId: '10001', name: '测试', impressions: ['她喜欢猫']
    });
    let mem = store.getMember(chatKey, '10001');
    const id1 = mem.impressions[0].id;
    ok('第一次有 id', Boolean(id1), id1);

    // 再写（内容完全相同）→ id 应保持
    await store.editMemberImpression(chatKey, {
      userId: '10001', name: '测试', impressions: ['她喜欢猫']
    });
    mem = store.getMember(chatKey, '10001');
    ok('**内容不变 → ID 保持**', mem.impressions[0].id === id1, `${id1} vs ${mem.impressions[0].id}`);

    // 内容变了 → 新 ID
    await store.editMemberImpression(chatKey, {
      userId: '10001', name: '测试', impressions: ['她喜欢狗']
    });
    mem = store.getMember(chatKey, '10001');
    ok('**内容变了 → 新 ID**', mem.impressions[0].id !== id1);
  }

  console.log('\n【⑩ 源码级：没有从内容里猜性质】');
  {
    const l = fs.readFileSync(path.join(ROOT, 'src', 'learned.js'), 'utf8');
    const m = fs.readFileSync(path.join(ROOT, 'src', 'memory.js'), 'utf8');
    // 不该出现「根据文本判断是 fact 还是 inference」这类逻辑
    ok('**learned 里没有 guess/infer 性质的代码**', !/guessEpistemic|inferEpistemic|detectFact/.test(l));
    ok('**memory 里没有**', !/guessEpistemic|inferEpistemic|detectFact/.test(m));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
