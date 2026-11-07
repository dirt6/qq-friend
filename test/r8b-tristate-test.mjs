// R8-B 三态专项：resolveCorrectionState 与新建初始化（B2 部分）。
//
// 规则见 docs/roadmap/R8-B-TRISTATE-DESIGN.md。
// 只碰临时 DATA_DIR；不读不写生产 learned.json / memory。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r8b-tristate-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });

const L = await import('../src/learned.js');

const c = createChecker('R8-B 三态（B2）');

const clone = (x) => JSON.parse(JSON.stringify(x));
const readDisk = () => JSON.parse(fs.readFileSync(L.LEARNED_FILE, 'utf8'));

try {
  c.section('1. 规范三态');
  await c.check('CORRECTION_STATES = clear/unresolved/unknown', () => {
    if (JSON.stringify(L.CORRECTION_STATES) !== JSON.stringify(['clear', 'unresolved', 'unknown'])) {
      throw new Error(JSON.stringify(L.CORRECTION_STATES));
    }
  });

  c.section('2. 新建 / 合并的显式状态');
  {
    const r = await c.check('新建经验 → correction.state = clear', () => {
      const created = L.addExperience({ text: '老大不喜欢被 @' });
      if (!created.ok) throw new Error(JSON.stringify(created));
      const it = readDisk().items.find((x) => x.id === created.id);
      if (it.correction.state !== 'clear') throw new Error(JSON.stringify(it.correction));
      if (it.correction.historicalUnresolved !== undefined) throw new Error('不应再写 historicalUnresolved 默认值');
      return 'state=clear';
    });
    c.section('3. 合并 → unresolved');
    await c.check('相似文本合并后 state = unresolved', () => {
      const merged = L.addExperience({ text: '老大不喜欢被 @，称呼自然点' });
      if (!merged.merged) throw new Error(JSON.stringify(merged));
      const it = readDisk().items.find((x) => x.id === merged.id);
      if (it.correction.state !== 'unresolved') throw new Error(JSON.stringify(it.correction));
    });
  }

  c.section('4. 纯函数：各种历史数据的判定');
  const cases = [
    ['新建（显式 clear）', { correction: { state: 'clear', count: 1, events: [] } }, 'clear'],
    ['旧条目没有 correction 字段', { corrections: 2 }, 'unknown'],
    ['只有 corrections 计数', { corrections: 5 }, 'unknown'],
    ['只有 correction.count', { correction: { count: 3 } }, 'unknown'],
    ['count:0 + events:[]', { correction: { count: 0, events: [] } }, 'unknown'],
    ['count:1 单独', { correction: { count: 1, events: [] } }, 'unknown'],
    ['historicalUnresolved:true', { correction: { historicalUnresolved: true, events: [] } }, 'unresolved'],
    ['true + 用户认可 events（true 优先）', { correction: { historicalUnresolved: true, events: [{ source: 'user_stated' }] } }, 'unresolved'],
    ['false + 最后一条 user_stated', { correction: { historicalUnresolved: false, events: [{ source: 'model' }, { source: 'user_stated' }] } }, 'clear'],
    ['false + 最后一条 model', { correction: { historicalUnresolved: false, events: [{ source: 'model' }] } }, 'unknown'],
    ['false + 空 events', { correction: { historicalUnresolved: false, events: [] } }, 'unknown'],
    ['显式 unresolved', { correction: { state: 'unresolved', events: [] } }, 'unresolved'],
    ['显式 unknown', { correction: { state: 'unknown', events: [{ source: 'user_stated' }] } }, 'unknown'],
    ['矛盾：state clear + true', { correction: { state: 'clear', historicalUnresolved: true, events: [] } }, 'clear'],
    ['非法 state（yes）', { correction: { state: 'yes' } }, 'unknown'],
    ['非法 state（null）', { correction: { state: null } }, 'unknown']
  ];
  for (const [name, item, expected] of cases) {
    await c.check(`${name} → ${expected}`, () => {
      const got = L.resolveCorrectionState(item);
      if (got !== expected) throw new Error(`得到 ${got}`);
    });
  }

  c.section('5. 只读：不修改入参、重复读一致');
  {
    const item = { id: 'x', text: 't', correction: { state: 'clear', count: 2, events: [{ source: 'model' }] } };
    const before = clone(item);
    L.resolveCorrectionState(item);
    await c.check('不修改输入对象', () => {
      if (JSON.stringify(item) !== JSON.stringify(before)) throw new Error(JSON.stringify(item));
    });
    await c.check('重复读取结果一致', () => {
      if (L.resolveCorrectionState(item) !== L.resolveCorrectionState(item)) throw new Error('不一致');
    });
  }

  c.section('6. withMeta：读时补全、不污染历史');
  {
    const old = { id: 'legacy', text: '旧经验', status: 'pending', corrections: 1 };
    const before = clone(old);
    const m = L.withMeta(old);
    await c.check('旧数据 → state unknown', () => {
      if (m.correction.state !== 'unknown') throw new Error(m.correction.state);
    });
    await c.check('不修改入参、不新增 historicalUnresolved 默认值', () => {
      if (JSON.stringify(old) !== JSON.stringify(before)) throw new Error('入参被改');
      if (m.correction.historicalUnresolved !== undefined) throw new Error('凭空补了 old 字段');
    });
    await c.check('显式 clear 透传', () => {
      const m2 = L.withMeta({ id: 'y', text: 't', correction: { state: 'clear', count: 0, events: [] } });
      if (m2.correction.state !== 'clear') throw new Error(m2.correction.state);
    });
    await c.check('旧 boolean 原样保留（兼容）', () => {
      const m3 = L.withMeta({ id: 'z', text: 't', correction: { historicalUnresolved: true, events: [] } });
      if (m3.correction.historicalUnresolved !== true) throw new Error('旧字段丢了');
      if (m3.correction.state !== 'unresolved') throw new Error(m3.correction.state);
    });
  }
  c.section('7. 晋升门禁：unknown / unresolved 阻止，clear 放行');
  {
    const now = Date.now();
    const mk = (id, correction) => ({
      id, status: 'pending', text: 'x', createdAt: new Date(now - 10 * 86400000).toISOString(),
      origin: { kind: 'user_stated' }, epistemicType: 'direct', corrections: 1, correction
    });
    const r1 = L.suggestPromotion({ items: [mk('u', { state: 'unknown' })] }, { now });
    await c.check('unknown → 不产生候选且理由含 unknown', () => {
      if (r1.candidates.length !== 0) throw new Error(JSON.stringify(r1.candidates));
      if (!/unknown/.test(JSON.stringify(r1.blocked))) throw new Error(JSON.stringify(r1.blocked));
    });
    const r2 = L.suggestPromotion({ items: [mk('r', { state: 'unresolved', events: [] })] }, { now });
    await c.check('unresolved → 不产生候选且理由含 unresolved', () => {
      if (r2.candidates.length !== 0) throw new Error(JSON.stringify(r2.candidates));
      if (!/unresolved/.test(JSON.stringify(r2.blocked))) throw new Error(JSON.stringify(r2.blocked));
    });
    const r3 = L.suggestPromotion({ items: [mk('c', { state: 'clear' })] }, { now });
    await c.check('clear + user_stated → 产生候选', () => {
      if (r3.candidates.length !== 1) throw new Error(JSON.stringify(r3));
    });
  }

  c.section('8. 归档门禁：unknown / unresolved 跳过，clear 可归档');
  {
    const now = Date.now();
    const old = new Date(now - 90 * 86400000).toISOString();
    const mk = (id, correction) => ({
      id, status: 'stable', text: 'x', createdAt: old, lastUsedAt: old, updatedAt: old, correction
    });
    const res = L.archiveStale({
      days: 30, now, dryRun: true,
      store: { items: [mk('a', { state: 'unknown' }), mk('b', { state: 'unresolved' }), mk('c', { state: 'clear' })] }
    });
    await c.check('只归档 clear 的那条', () => {
      if (res.archived !== 1) throw new Error(JSON.stringify(res));
      if (JSON.stringify(res.ids) !== JSON.stringify(['c'])) throw new Error(JSON.stringify(res.ids));
    });
    await c.check('unknown / unresolved 都有明确 skipped 理由', () => {
      const reasons = res.skipped.map((s) => s.id + ':' + s.reason).join(' | ');
      if (!/a:.*unknown/.test(reasons)) throw new Error(reasons);
      if (!/b:.*unresolved/.test(reasons)) throw new Error(reasons);
    });
  }

  c.section('9. memory.js：新建 clear、变更 unresolved');
  {
    const M = await import('../src/memory.js');
    const store = new M.MemoryStore();
    await store.editMemberImpression('private:1', { userId: '1', name: 'T', impressions: ['她喜欢猫'] });
    const imp = store.getMember('private:1', '1').impressions[0];
    await c.check('新建印象 state=clear', () => {
      if (imp.correction.state !== 'clear') throw new Error(JSON.stringify(imp.correction));
    });
    await store.editMemberImpression('private:1', { userId: '1', name: 'T', impressions: [{ id: imp.id, content: '她其实喜欢狗' }] });
    const imp2 = store.getMember('private:1', '1').impressions[0];
    await c.check('内容变更后 state=unresolved', () => {
      if (imp2.correction.state !== 'unresolved') throw new Error(JSON.stringify(imp2.correction));
    });
  }

  c.section('10. adapters：三态透传，不再 Boolean(undefined)=false');
  {
    const A = await import('../src/memory-hub/adapters.js');
    fs.writeFileSync(L.LEARNED_FILE, JSON.stringify({
      version: 1,
      items: [{ id: 'old1', text: '旧条目没有 correction 字段', status: 'stable', createdAt: new Date().toISOString() }]
    }), 'utf8');
    const res = A.readLearned({ query: '' });
    const item = res.items.find((x) => x.id === 'old1');
    await c.check('旧条目 correctionState=unknown', () => {
      if (!item) throw new Error('没读到');
      if (item.extra.correctionState !== 'unknown') throw new Error(JSON.stringify(item.extra));
    });
    await c.check('historicalUnresolved 为 null（不伪造 false）', () => {
      if (item.extra.historicalUnresolved !== null) throw new Error(JSON.stringify(item.extra));
    });
  }

  c.section('11. dry-run 只读隔离：打桩写入抛错也不写');
  {
    const now = Date.now();
    const old = new Date(now - 90 * 86400000).toISOString();
    const before = fs.readFileSync(L.LEARNED_FILE, 'utf8');
    const orig = fs.writeFileSync;
    fs.writeFileSync = () => { throw new Error('测试：dry-run 不允许写盘'); };
    let res = null;
    let threw = null;
    try {
      res = L.archiveStale({
        days: 30, now, dryRun: true,
        store: { items: [{ id: 'x', status: 'stable', text: 't', createdAt: old, lastUsedAt: old, correction: { state: 'clear' } }] }
      });
    } catch (e) {
      threw = e;
    } finally {
      fs.writeFileSync = orig;
    }
    await c.check('dry-run 不触发任何写入', () => {
      if (threw) throw new Error(threw.message);
      if (!res || res.dryRun !== true) throw new Error(JSON.stringify(res));
    });
    await c.check('磁盘文件未被改动', () => {
      if (fs.readFileSync(L.LEARNED_FILE, 'utf8') !== before) throw new Error('文件被改了');
    });
  }

  c.section('12. 历史异常数据不崩');
  {
    const cases = [
      ['correction 是字符串', { correction: 'bad' }, 'unknown'],
      ['events 不是数组', { correction: { historicalUnresolved: false, events: 'nope' } }, 'unknown'],
      ['state 带空格大写', { correction: { state: ' CLEAR ' } }, 'clear'],
      ['state 大小写混合', { correction: { state: 'Clear' } }, 'clear'],
      ['item 为 null', null, 'unknown']
    ];
    for (const [name, item, expected] of cases) {
      await c.check(`${name} → ${expected}`, () => {
        const got = L.resolveCorrectionState(item);
        if (got !== expected) throw new Error(`得到 ${got}`);
      });
    }
  }

} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
