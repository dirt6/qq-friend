// 阶段 3.0-R4 专项测试：Memory Hub 只读统一入口。
//
// 机主 2026-11-02 的要求：
//   · Memory Hub 是统一访问与管理层，**不得合并五层底层存储**
//   · R4 只做只读，不接入任何写入，不改变现有写入行为
//   · 统一结果 `{ type, id, source, content, timestamp, relevance }`
//   · `relevance` 只表示检索评分，不是可信度
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

/** 造隔离目录 + 各层数据。 */
function mkEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    persona: { roleText: 'x' },
    skills: { diary: { root: dir } }
  }), 'utf8');

  // learned
  fs.writeFileSync(path.join(dir, 'learned.json'), JSON.stringify({
    version: 1,
    items: [
      { id: 'l-1', text: '老大不喜欢被 @', status: 'pending', corrections: 1, createdAt: '2026-11-01T00:00:00Z', contentType: 'preference', epistemicType: 'direct' },
      { id: 'l-2', text: '下雨天她容易走神', status: 'pending', corrections: 1, createdAt: '2026-11-02T00:00:00Z' }
    ]
  }), 'utf8');

  // impressions
  const memDir = path.join(dir, 'memory', 'private_10001');
  fs.mkdirSync(memDir, { recursive: true });
  fs.writeFileSync(path.join(memDir, '10001.json'), JSON.stringify({
    userId: '10001', name: '老大',
    impressions: [
      { id: 'imp-aaaaaaaaaaaaaaaa', content: '他喜欢猫', createdAt: 1790000000000, contentType: 'preference', epistemicType: 'direct' }
    ],
    updatedAt: 1, lastConsolidatedAt: 0
  }), 'utf8');

  // diary
  const dayDir = path.join(dir, '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  fs.writeFileSync(path.join(dayDir, '2026-11-02.md'), '# 标题\n\n今天翻了架构帖。\n\n想了想管控的界限。\n', 'utf8');

  // autonomous
  fs.writeFileSync(path.join(dir, 'autonomous.json'), JSON.stringify({
    version: 2, status: 'IDLE',
    history: [
      { roundId: 'round-a', startedAt: 1790000000000, actions: [{ action: 'chat', goal: '问老大回来没', resultSummary: '说了句话', result: 'success' }] }
    ]
  }), 'utf8');

  // companion
  fs.writeFileSync(path.join(dir, 'companion-state.json'), JSON.stringify({
    version: 2,
    goals: [{ id: 'g-1', text: '持续关注架构帖', source: 'autonomous', status: 'active', since: '2026-11-01T00:00:00Z' }],
    pending: [{ id: 'p-1', text: '等老大回话', source: 'autonomous', status: 'waiting', at: '2026-11-02T00:00:00Z' }],
    topic: null, updatedAt: ''
  }), 'utf8');

  return dir;
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

async function main() {
  const dir = mkEnv();
  process.env.QQ_AGENT_DATA_DIR = dir;
  // 重要：要在 env 设好之后再 import（adapters 读 DATA_DIR 走 env）
  const H = await import('file://' + path.join(ROOT, 'src', 'memory-hub', 'index.js').replace(/\\/g, '/'));

  try {
    console.log('【① 六层都能读到】');
    {
      const s = H.stats();
      // stats 会读 diary，可能读生产 —— 单独验证 diary 层
      ok('learned 2 条', s.counts.learned === 2, String(s.counts.learned));
      ok('impression 1 条', s.counts.impression === 1, String(s.counts.impression));
      ok('diary ≥ 2 条', s.counts.diary >= 2, String(s.counts.diary));
      ok('activity 1 条', s.counts.activity === 1, String(s.counts.activity));
      ok('goal 1 条', s.counts.goal === 1, String(s.counts.goal));
      ok('pending 1 条', s.counts.pending === 1, String(s.counts.pending));
      ok('没有错误', s.errors.length === 0, JSON.stringify(s.errors));
    }

    console.log('\n【② 统一结果格式】');
    {
      const r = H.search({ limit: 0 });
      ok('有结果', r.items.length > 0);
      const need = ['type', 'id', 'source', 'content', 'timestamp', 'relevance', 'contentType', 'epistemicType'];
      ok('**每条都有统一字段**', r.items.every((x) => need.every((k) => k in x)), JSON.stringify(Object.keys(r.items[0])));
      ok('relevance 是 0~1', r.items.every((x) => x.relevance >= 0 && x.relevance <= 1));
      ok('type 都是合法值', r.items.every((x) => H.LAYERS.includes(x.type)), [...new Set(r.items.map((x) => x.type))].join(','));
    }

    console.log('\n【③ 关键词检索】');
    {
      const r = H.search({ query: '架构', layers: ['diary', 'activity'], diaryRoot: dir });
      ok('能搜到', r.items.length > 0, String(r.items.length));
      ok('**结果都含「架构」**', r.items.every((x) => x.content.includes('架构')), JSON.stringify(r.items.map((x) => x.content.slice(0, 20))));
      ok('按 relevance 降序', r.items.every((x, i) => i === 0 || r.items[i - 1].relevance >= x.relevance));
    }

    console.log('\n【④ 层过滤】');
    {
      const r = H.search({ layers: ['learned'], limit: 0 });
      ok('**只返回 learned**', r.items.every((x) => x.type === 'learned'), [...new Set(r.items.map((x) => x.type))].join(','));
    }

    console.log('\n【⑤ 时间过滤】');
    {
      const r = H.search({ since: Date.parse('2026-11-01T12:00:00Z'), limit: 0 });
      ok('**过滤掉了更早的**', r.items.every((x) => x.timestamp >= Date.parse('2026-11-01T12:00:00Z')),
        JSON.stringify(r.items.map((x) => x.timestamp)));
    }

    console.log('\n【⑥ 空查询 = 只按时间筛】');
    {
      const r = H.search({ query: '', layers: ['learned'], limit: 0 });
      ok('空查询返回全部 learned', r.items.length === 2, String(r.items.length));
    }

    console.log('\n【⑦ 元数据透传（不猜）】');
    {
      const r = H.search({ layers: ['learned'], limit: 0 });
      const l1 = r.items.find((x) => x.id === 'l-1');
      const l2 = r.items.find((x) => x.id === 'l-2');
      ok('l-1 的 contentType 透传', l1.contentType === 'preference', l1.contentType);
      ok('l-1 的 epistemicType 透传', l1.epistemicType === 'direct', l1.epistemicType);
      ok('**l-2 没有元数据 → 默认 other**', l2.contentType === 'other', l2.contentType);
      ok('**l-2 epistemicType → unknown**', l2.epistemicType === 'unknown', l2.epistemicType);
    }

    console.log('\n【⑧ get(type, id)】');
    {
      const g = H.get('learned', 'l-1');
      ok('取到', g.ok === true && g.item.id === 'l-1');
      ok('不存在 → 失败', H.get('learned', 'nope').ok === false);
      ok('空参 → 失败', H.get('', '').ok === false);
    }

    console.log('\n【⑨ 只读：跑完所有文件 hash 不变】');
    {
      const files = [
        path.join(dir, 'learned.json'),
        path.join(dir, 'memory', 'private_10001', '10001.json'),
        path.join(dir, '每日', '2026-11-02.md'),
        path.join(dir, 'autonomous.json'),
        path.join(dir, 'companion-state.json')
      ];
      const before = files.map((f) => (fs.existsSync(f) ? sha(f) : null));
      const beforeCount = fs.readdirSync(dir).length;

      H.search({ limit: 0 });
      H.search({ query: '架构', limit: 0 });
      H.stats();
      H.get('learned', 'l-1');

      const after = files.map((f) => (fs.existsSync(f) ? sha(f) : null));
      ok('**五个文件 hash 都没变**', JSON.stringify(before) === JSON.stringify(after),
        files.filter((f, i) => before[i] !== after[i]).join(','));
      ok('**没有新增文件**', fs.readdirSync(dir).length === beforeCount);
    }

    console.log('\n【⑩ 缺失文件 / 目录：返回空，不抛】');
    {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'r4-empty-'));
      process.env.QQ_AGENT_DATA_DIR = empty;
      // 只查**不依赖模块级缓存路径**的层：
      // · impression / activity / companion 每次读 env → 空目录就是 0 条
      // · **learned 不行** —— learned.js 的 LEARNED_FILE 是模块加载时固定的（已知限制）
      // · diary 用显式 diaryRoot → 可以指向空目录
      const r = H.search({ layers: ['impression', 'activity', 'goal', 'pending'], limit: 0, diaryRoot: empty });
      ok('**不抛异常**', r.ok === true);
      ok('**这四层都是空**', r.items.length === 0, String(r.items.length));
      ok('errors 是空（缺文件不算错）', r.errors.length === 0, JSON.stringify(r.errors));
      fs.rmSync(empty, { recursive: true, force: true });
      process.env.QQ_AGENT_DATA_DIR = dir;
    }

    console.log('\n【⑪ 源码级：Memory Hub 不写任何文件】');
    {
      for (const f of ['index.js', 'adapters.js', 'retrieval.js']) {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'memory-hub', f), 'utf8');
        const writes = /writeFileSync|writeFileAtomic|appendFileSync|unlinkSync|renameSync|mkdirSync/.test(src);
        ok(`**${f} 没有写操作**`, writes === false, writes ? '有写操作' : '');
      }
    }

    console.log('\n【⑫ 五层底层存储路径没变（不合并）】');
    {
      const src = fs.readFileSync(path.join(ROOT, 'src', 'memory-hub', 'adapters.js'), 'utf8');
      ok('读 learned.json', src.includes("'learned.json'") || src.includes('learnedListAll'));
      ok('读 memory/ 目录', src.includes("'memory'"));
      ok('读 每日/ 目录', src.includes("'每日'"));
      ok('读 autonomous.json', src.includes("'autonomous.json'"));
      ok('读 companion-state.json', src.includes("'companion-state.json'"));
      ok('**没有新建任何存储文件**', !/writeFileSync/.test(src));
    }
  } catch (e) {
    ok('测试执行不抛异常', false, e?.message || String(e));
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) process.exit(1);
  process.exit(0);
}

main();
