// 星图 P0：只读契约 / API schema / 空库 / 分层 / 话题 / 零写盘。
//
// 用临时 data + 临时日记目录，不碰生产。
// 顺序：先测空库（config 会缓存，不能中途换 root），再写数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'star-map-api-'));
const diaryRoot = path.join(tmp, '日记');
const diaryDir = path.join(diaryRoot, '每日');
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ skills: { diary: { root: diaryRoot } } }), 'utf8');

const { createRoutes } = await import('../src/routes.js');
const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

async function call(pattern, urlStr) {
  const r = find(pattern);
  const req = { headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, method: 'GET', url: '/' };
  let out; let code = 200;
  const json = (_res, c, data) => { code = c; out = data; return data; };
  await r.handler({ json, req, url: new URL(urlStr), res: {}, body: undefined, match: [] });
  return { code, data: out };
}

async function callPost(pattern, body) {
  const r = find(pattern);
  const req = { headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, method: 'POST', url: '/' };
  let out; let code = 200;
  const json = (_res, c, data) => { code = c; out = data; return data; };
  await r.handler({ json, req, url: new URL('http://127.0.0.1/api/star-map/override'), res: {}, body, match: [] });
  return { code, data: out };
}

// ── 空库（目录还不存在） ──────────────────────────────────
const emptyGraph = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('空库 graph ok + 空数组', emptyGraph.data?.ok === true && emptyGraph.data?.nodes?.length === 0 && emptyGraph.data?.edges?.length === 0);
ok('空库有 emptyReasons', (emptyGraph.data?.meta?.emptyReasons || []).length > 0, JSON.stringify(emptyGraph.data?.meta));
const emptyStats = await call('/api/star-map/stats', 'http://127.0.0.1/api/star-map/stats');
ok('空库 stats ok', emptyStats.data?.ok === true && emptyStats.data?.days === 0);

// ── 造数据 ────────────────────────────────────────────────
fs.mkdirSync(diaryDir, { recursive: true });
const dayFiles = {
  '2026-11-01': `# 2026-11-01 周六\n\n## 记录\n- 心情：踏实｜软件修好之后，第一次觉得自己是真醒着。\n- 心情：想找人说话｜想找老大说话，没发出去。\n`,
  '2026-11-02': `# 2026-11-02 周日\n\n- 心情：平静｜[非常重要] 今天整理房间，把窗台擦干净了。\n`,
  '2026-11-04': `# 2026-11-04 周三\n\n- 心情：想找人说话｜[重要] 今天终于把星图方案读完了。\n`,
  '2026-11-06': `# 2026-11-06 周五\n\n- 心情：记住了｜把旧交接文档删掉了，心里轻了一点。\n`,
  '2026-11-07': `# 2026-11-07 周六\n\n- 心情：平静｜今天在写星图的投影层。\n- 心情：平静｜星图的投影层写完了一部分，同一天第二条。\n`
};
for (const [day, text] of Object.entries(dayFiles)) {
  fs.writeFileSync(path.join(diaryDir, `${day}.md`), text, 'utf8');
}
// 空白天：有文件没条目
fs.writeFileSync(path.join(diaryDir, '2026-11-05.md'), '# 2026-11-05 周四\n\n', 'utf8');
// 格式异常：不应被当成条目
fs.writeFileSync(path.join(diaryDir, '2026-11-03.md'), '# 2026-11-03 周二\n\n今天随便写了一句，没有前缀。\n', 'utf8');
// scope=all 的经验来源（sourceDay 指向 11-01）
fs.writeFileSync(path.join(tmp, 'learned.json'), JSON.stringify({
  version: 1,
  items: [
    { id: 'L1', text: '老大不喜欢被 @', status: 'verified', sourceDay: '2026-11-01', createdAt: '2026-11-01T10:00:00+08:00', contentType: 'preference', hits: 12 }
  ]
}), 'utf8');
// 自主活动：进入旋臂之间
fs.writeFileSync(path.join(tmp, 'autonomous.json'), JSON.stringify({
  history: [
    { roundId: 'r1', startedAt: Date.parse('2026-11-06T10:00:00+08:00'), action: 'browse', goal: '看看星图投影层怎么写的', why: '想把记忆整理清楚' },
    { roundId: 'r2', startedAt: Date.parse('2026-11-07T09:00:00+08:00'), action: 'share', goal: '把星图方案递给老大看看', why: '想听他的意见' }
  ]
}), 'utf8');

// ── 文件哈希快照（S0 零写盘） ──────────────────────────────
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const st = fs.statSync(full);
        out[path.relative(tmp, full)] = `${st.size}:${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`;
      }
    }
  };
  walk(dir);
  return out;
}
const before = snapshot(tmp);

// ── graph?scope=diary ──────────────────────────────────────
const g = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary&days=all');
ok('graph 200', g.code === 200 && g.data?.ok === true, JSON.stringify(g.data).slice(0, 200));
const d = g.data || {};
ok('counts.diaryDays 只算有条目的天 = 5', d.counts?.diaryDays === 5, JSON.stringify(d.counts));
ok('counts.diaryEntries = 7', d.counts?.diaryEntries === 7, JSON.stringify(d.counts));
ok('counts.activity = 2', d.counts?.activity === 2, JSON.stringify(d.counts));
ok('nodes = 日记 7 + 活动 2', d.nodes?.length === 9, String(d.nodes?.length));
ok('空白天/格式异常不产生节点', !d.nodes?.some((n) => n.day === '2026-11-03' || n.day === '2026-11-05'));

// 分层
const layers = d.nodes?.reduce((a, n) => (a[n.layer] = (a[n.layer] || 0) + 1, a), {}) || {};
ok('四层都有节点', ['core', 'arm', 'general', 'belt'].every((l) => layers[l] > 0), JSON.stringify(layers));
ok('银心是「非常重要」', d.nodes.filter((n) => n.layer === 'core').every((n) => /非常/.test(n.importance)));
ok('旋臂是「重要」', d.nodes.filter((n) => n.layer === 'arm').every((n) => n.importance === '重要'));
ok('小行星带是「记住了」', d.nodes.filter((n) => n.layer === 'belt').every((n) => n.mood === '记住了'));
const beltIds = new Set(d.nodes.filter((n) => n.layer === 'belt').map((n) => n.id));
ok('小行星带不分话题', d.nodes.filter((n) => n.layer === 'belt').every((n) => n.topic === -1));
ok('小行星带不连线', !(d.edges || []).some((e) => beltIds.has(e.from) || beltIds.has(e.to)));
ok('活动节点在旋臂之间', d.nodes.some((n) => n.kind === 'activity' && n.layer === 'general'));
const coreNode = d.nodes.find((n) => n.layer === 'core');
const generalNode = d.nodes.find((n) => n.layer === 'general' && n.kind === 'diary');
ok('银心比一般更亮', coreNode && generalNode && coreNode.brightness > generalNode.brightness, `${coreNode?.brightness} vs ${generalNode?.brightness}`);
ok('旋臂比一般更亮', d.nodes.filter((n) => n.layer === 'arm').every((n) => n.brightness > generalNode.brightness));

// 话题
ok('topics 有名字', (d.topics || []).length > 0 && d.topics.every((t) => t.name), JSON.stringify(d.topics));
ok('arm 节点都带话题（-2 = 其他旋臂）', d.nodes.filter((n) => n.layer === 'arm').every((n) => Number.isFinite(n.topic) && n.topic >= -2));
ok('同话题边存在', (d.edges || []).some((e) => e.kind === 'topic'));
ok('edge kind 合法', (d.edges || []).every((e) => ['same-day', 'mood-word', 'keyword', 'topic', 'source', 'round'].includes(e.kind)));
ok('每节点边数 ≤ 6', (d.nodes || []).every((n) => (d.edges || []).filter((e) => e.from === n.id || e.to === n.id).length <= 6));
ok('fingerprint 是 40 位 sha1', typeof d.fingerprint === 'string' && d.fingerprint.length === 40);

// ── 单节点 ────────────────────────────────────────────────
const first = d.nodes?.find((n) => n.kind === 'diary' && n.layer === 'general');
const node = await call('/api/star-map/node', `http://127.0.0.1/api/star-map/node?id=${encodeURIComponent(first?.id || '')}`);
ok('node 200 且有全文', node.data?.ok === true && node.data?.detail?.fullText?.includes('软件修好之后'), JSON.stringify(node.data).slice(0, 200));
ok('node 索引正确', node.data?.detail?.index === first?.entryIndex);

const badNode = await call('/api/star-map/node', 'http://127.0.0.1/api/star-map/node?id=diary:2026-01-01:deadbeef');
ok('不存在的节点返回 ok:false', badNode.code === 200 && badNode.data?.ok === false);

// ── stats ─────────────────────────────────────────────────
const st = await call('/api/star-map/stats', 'http://127.0.0.1/api/star-map/stats');
ok('stats 200', st.data?.ok === true);
ok('stats days = 7（含空白天/异常天）', st.data?.days === 7, String(st.data?.days));
ok('stats entries = 7', st.data?.entries === 7, String(st.data?.entries));
ok('stats 空白天被报告', Array.isArray(st.data?.emptyDays) && st.data.emptyDays.includes('2026-11-05'), JSON.stringify(st.data?.emptyDays));
ok('stats 断档 11-02 → 11-04（空白天不算内容天）', st.data?.gaps?.maxGap === 1 && st.data?.gaps?.from === '2026-11-02', JSON.stringify(st.data?.gaps));
ok('stats 重要占比 2/7（非常重要 + 重要）', Math.abs((st.data?.importantRatio || 0) - 2 / 7) < 0.001, String(st.data?.importantRatio));
ok('stats 心情词频有「想找人说话」', st.data?.moodFrequency?.some((x) => x.mood === '想找人说话' && x.count === 2), JSON.stringify(st.data?.moodFrequency));

// ── scope=all ─────────────────────────────────────────────
const all = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=all');
ok('all 200', all.data?.ok === true && all.data?.scope === 'all');
ok('all 里其他层是背景星尘', (all.data?.nodes || []).some((n) => n.kind === 'learned' && n.flags?.background === true),
  JSON.stringify((all.data?.nodes || []).map((n) => n.kind)));
ok('all 有来源边', (all.data?.edges || []).some((e) => e.kind === 'source'), JSON.stringify((all.data?.edges || []).filter((e) => e.kind === 'source')));
ok('all 其他层亮度 ≤ 0.35', (all.data?.nodes || []).filter((n) => n.kind === 'learned' || n.kind === 'impression')
  .every((n) => n.brightness <= 0.35));

// ── 非法参数 ──────────────────────────────────────────────
const badScope = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=xxx');
ok('非法 scope → 400', badScope.code === 400 && badScope.data?.code === 'BAD_SCOPE');
const badDays = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?days=14');
ok('非 all days → 400', badDays.code === 400 && badDays.data?.code === 'BAD_DAYS');
const noId = await call('/api/star-map/node', 'http://127.0.0.1/api/star-map/node');
ok('缺 id → 400', noId.code === 400 && noId.data?.code === 'BAD_ID');

// ── S0：零写盘 ────────────────────────────────────────────
const after = snapshot(tmp);
ok('S0 星图读取后文件完全没变', JSON.stringify(before) === JSON.stringify(after),
  Object.keys(after).filter((k) => before[k] !== after[k]).join(','));

// ── 编辑覆盖（写）────────────────────────────────────────
const add = await callPost('/api/star-map/override', { action: 'add-topic', name: '测试旋臂' });
ok('add-topic 成功', add.data?.ok === true, JSON.stringify(add.data));
let eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('自定义旋臂显示在 topics', (eg.data?.topics || []).some((t) => t.name === '测试旋臂' && t.custom === true));

const gnode = eg.data.nodes.find((n) => n.kind === 'diary' && n.layer === 'general');
const mv = await callPost('/api/star-map/override', { action: 'move-topic', nodeId: gnode.id, topicName: '测试旋臂' });
ok('move-topic 成功', mv.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('节点归入自定义旋臂', eg.data.nodes.find((n) => n.id === gnode.id)?.topicName === '测试旋臂');

const ang = await callPost('/api/star-map/override', { action: 'set-topic-angle', name: '测试旋臂', angle: 1.234 });
ok('set-topic-angle 成功', ang.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('旋臂角度已保存', Math.abs((eg.data.topics.find((t) => t.name === '测试旋臂')?.angle ?? 0) - 1.234) < 1e-6);

const ren = await callPost('/api/star-map/override', { action: 'set-topic', name: '测试旋臂', newName: '改名旋臂', tags: ['标签A', '标签B'] });
ok('set-topic 改名+标签', ren.data?.ok === true && ren.data?.name === '改名旋臂', JSON.stringify(ren.data));
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
const renamed = (eg.data.topics || []).find((t) => t.name === '改名旋臂');
ok('话题标签已保存', renamed && (renamed.tags || []).includes('标签A'), JSON.stringify(renamed));

const two = (eg.data.nodes || []).filter((n) => n.kind === 'diary').slice(0, 2);
const al = await callPost('/api/star-map/override', { action: 'add-link', from: two[0].id, to: two[1].id });
ok('add-link 成功', al.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('手动连线出现', (eg.data.edges || []).some((e) => e.kind === 'manual'));

const rl = await callPost('/api/star-map/override', { action: 'remove-link', from: two[0].id, to: two[1].id });
ok('remove-link 成功', rl.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('手动连线已取消', !(eg.data.edges || []).some((e) => e.kind === 'manual'));

const n0 = (eg.data.nodes || []).find((n) => n.kind === 'diary');
const sp = await callPost('/api/star-map/override', { action: 'set-node-position', nodeId: n0.id, angle: 0.5, radius: 0.42 });
ok('set-node-position 成功', sp.data?.ok === true, JSON.stringify(sp.data));
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
const placed = eg.data.nodes.find((n) => n.id === n0.id);
ok('自由位置已保存', Math.abs((placed?.posAngle ?? 0) - 0.5) < 1e-6 && Math.abs((placed?.posRadius ?? 0) - 0.42) < 1e-6);
const cp = await callPost('/api/star-map/override', { action: 'clear-node-position', nodeId: n0.id });
ok('clear-node-position 成功', cp.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('自由位置已清除', eg.data.nodes.find((n) => n.id === n0.id)?.posAngle == null);

const target = eg.data.nodes.find((n) => n.kind === 'diary' && n.layer === 'general');
const si = await callPost('/api/star-map/override', { action: 'set-importance', nodeId: target.id, importance: '非常重要' });
ok('set-importance 写回日记', si.data?.ok === true, JSON.stringify(si.data));
const diaryText = fs.readFileSync(path.join(diaryDir, `${target.day}.md`), 'utf8');
ok('日记里出现 [非常重要]', diaryText.includes('[非常重要]'));

const rm = await callPost('/api/star-map/override', { action: 'remove-topic', name: '改名旋臂' });
ok('remove-topic 成功', rm.data?.ok === true);
eg = await call('/api/star-map/graph', 'http://127.0.0.1/api/star-map/graph?scope=diary');
ok('旋臂已隐藏', !(eg.data?.topics || []).some((t) => t.name === '改名旋臂'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nStar map API: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
