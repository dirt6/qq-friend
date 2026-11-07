// 星图核心纯函数：分层布局 / 旋臂 / 确定性 / 扩散激活 / 上限 / 关键词种子。
// 用 vm 加载 ui/app/star-map-core.js（与浏览器同一份文件）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const code = fs.readFileSync(path.join(ROOT, 'ui', 'app', 'star-map-core.js'), 'utf8');
const sandbox = { console };
vm.runInNewContext(code, sandbox);
const core = sandbox.__starMapCore;

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const angleNear = (a, b, eps = 0.08) => {
  const d = Math.abs((((a - b) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI);
  return d <= eps;
};

// ── 分层布局 ────────────────────────────────────────────────
const nodes = [
  { id: 'c1', layer: 'core', topic: -1, heat: 0.9 },
  { id: 'c2', layer: 'core', topic: -1, heat: 0.2 },
  { id: 'a1', layer: 'arm', topic: 0, heat: 0.9 },
  { id: 'a2', layer: 'arm', topic: 0, heat: 0.5 },
  { id: 'a3', layer: 'arm', topic: 1, heat: 0.4 },
  { id: 'g1', layer: 'general', topic: 0, heat: 0.6 },
  { id: 'g2', layer: 'general', topic: -2, heat: 0.3 },
  { id: 'b1', layer: 'belt', topic: -1, heat: 0.1 },
  { id: 'b2', layer: 'belt', topic: -1, heat: 0.1 }
];
const L1 = core.layout(nodes);
const L2 = core.layout(nodes);
ok('布局确定性（两次完全一致）', JSON.stringify([...L1.positions]) === JSON.stringify([...L2.positions]));
ok('所有节点都有位置', L1.positions.size === nodes.length);
ok('银心半径最小', Math.max(L1.positions.get('c1').radius, L1.positions.get('c2').radius)
  < Math.min(L1.positions.get('a1').radius, L1.positions.get('a2').radius, L1.positions.get('a3').radius));
ok('旋臂/旋臂间都在中心与外圈之间', ['a1','a2','a3','g1','g2'].every((id) => { const r = L1.positions.get(id).radius; return r >= 0.12 && r <= 0.58; }));
ok('小行星带在最外圈', Math.min(L1.positions.get('b1').radius, L1.positions.get('b2').radius) > 0.9
  && Math.min(L1.positions.get('b1').radius, L1.positions.get('b2').radius) > L1.positions.get('g1').radius);
ok('热节点更靠近银心', L1.positions.get('c1').radius < L1.positions.get('c2').radius);
ok('arm 节点都带话题（含 -2 其他旋臂）', nodes.filter((n) => n.layer === 'arm').every((n) => L1.positions.get(n.id).topic >= -2));
ok('星座基准角均分', L1.arms.length === 3 && near(Math.abs(L1.arms[1].angle - L1.arms[0].angle), (Math.PI * 2) / 3, 0.01));
const SPIRAL = core.SPIRAL;
const baseOf = new Map(L1.arms.map((a) => [a.topic, a.angle]));
const phase = (id) => { const p = L1.positions.get(id); return p.angle - SPIRAL * p.radius; };
ok('同话题 arm 沿同一条螺旋', near(phase('a1'), phase('a2'), 0.03) && near(phase('a1'), baseOf.get(0), 0.03));
ok('general 贴着同话题旋臂（相位差小）', Math.abs(phase('g1') - baseOf.get(0)) < 0.35);
ok('不同话题的星座基准角不同', Math.abs(baseOf.get(0) - baseOf.get(1)) > 0.5);
const L3 = core.layout(nodes, [{ index: 0, angle: 1.0 }, { index: 1, angle: 2.0 }, { index: -2, angle: 0.5 }]);
ok('topics 的手工角度覆盖基准角',
  near(L3.arms.find((a) => a.topic === 0).angle, 1.0) && near(L3.arms.find((a) => a.topic === 1).angle, 2.0));

// ── 激活：单链 ──────────────────────────────────────────────
const chainNodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
const chainEdges = [{ from: 'A', to: 'B', weight: 1 }, { from: 'B', to: 'C', weight: 1 }];
const a1 = core.activate(chainNodes, chainEdges, new Map([['A', 1]]));
ok('1 跳 = 1 × 1 × 0.55', near(a1.get('B').a, 0.55), String(a1.get('B')?.a));
ok('2 跳 = 0.55 × 1 × 0.55', near(a1.get('C').a, 0.3025), String(a1.get('C')?.a));
ok('种子 hop=0 / 1 跳 hop=1 / 2 跳 hop=2', a1.get('A').hop === 0 && a1.get('B').hop === 1 && a1.get('C').hop === 2);

// ── 激活：菱形多路径叠加 ────────────────────────────────────
const diaNodes = [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }];
const diaEdges = [
  { from: 'A', to: 'B', weight: 1 }, { from: 'A', to: 'C', weight: 1 },
  { from: 'B', to: 'D', weight: 1 }, { from: 'C', to: 'D', weight: 1 }
];
const a2 = core.activate(diaNodes, diaEdges, new Map([['A', 1]]));
const perPath = 0.55 * 0.55;
const expectedD = 1 - (1 - perPath) ** 2;
ok('多路径叠加 1-Π(1-a)', near(a2.get('D').a, expectedD, 1e-9), `${a2.get('D')?.a} vs ${expectedD}`);

// ── 阈值 / 2 跳截止 / 无边 ──────────────────────────────────
const weak = core.activate([{ id: 'A' }, { id: 'B' }], [{ from: 'A', to: 'B', weight: 0.1 }], new Map([['A', 1]]));
ok('低于 0.12 不点亮', !weak.has('B'));
const noEdge = core.activate([{ id: 'A' }, { id: 'B' }], [], new Map([['A', 1]]));
ok('没有边只亮种子', noEdge.size === 1 && noEdge.has('A'));
const tooFar = core.activate(
  [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
  [{ from: 'A', to: 'B', weight: 1 }, { from: 'B', to: 'C', weight: 1 }, { from: 'C', to: 'D', weight: 1 }],
  new Map([['A', 1]])
);
ok('第 3 跳不扩散', !tooFar.has('D'));

// ── 上限 80 ─────────────────────────────────────────────────
const hubNodes = [{ id: 'A' }];
const hubEdges = [];
for (let i = 0; i < 100; i += 1) {
  hubNodes.push({ id: `N${i}` });
  hubEdges.push({ from: 'A', to: `N${i}`, weight: 1 });
}
const capped = core.activate(hubNodes, hubEdges, new Map([['A', 1]]));
ok('激活上限 80', capped.size === 80, String(capped.size));
ok('上限保留最高激活（种子仍在）', capped.has('A'));

// ── 关键词种子 ──────────────────────────────────────────────
const searchNodes = [
  { id: 'x1', content: '今天在写星图的投影层', mood: '平静' },
  { id: 'x2', content: '把旧交接文档删掉了', mood: '踏实' }
];
const seeds = core.searchSeeds(searchNodes, '星图');
ok('中文关键词命中做种子', seeds.has('x1') && !seeds.has('x2'), JSON.stringify([...seeds]));
ok('无命中返回空', core.searchSeeds(searchNodes, '量子力学').size === 0);
ok('空查询返回空', core.searchSeeds(searchNodes, '').size === 0);
ok('tokenize 2–4 字切片', core.tokenize('星图').has('星图') && core.tokenize('星图').size === 1);

console.log(`\nStar map core: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
