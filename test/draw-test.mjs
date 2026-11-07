// 画画（qq_draw / scripts/draw/render.py）的离线测试
//
// 锁住四件事：
//   ① 渲染器真能出图：PNG 魔数、尺寸、背景色、主体色、文字像素都在该在的位置
//   ② 非法场景不会把进程搞崩：空 shapes 要**明确报错**，看不懂的图形跳过
//   ③ 尺寸/图形数有上限（模型传 99999 不能把内存打爆）
//   ④ 她画的图落在发图白名单目录里（否则网关发不出去）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-draw-'));
const PY = 'C:\\Program Files\\Python314\\python.exe';
const RENDER = path.resolve('scripts/draw/render.py');
const READY = fs.existsSync(PY) && fs.existsSync(RENDER);

// 归档模块必须在 DATA_DIR 指向临时目录之后才能导入：config.js 在 import
// 那一刻就把 DATA_DIR 定死了，晚了就会写进真实 data/drawings。
process.env.QQ_AGENT_DATA_DIR = path.join(TMP, 'data');
const drawMod = await import('../src/draw.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

/**
 * 把场景喂给渲染器，返回它 stdout 最后一行解析出来的 JSON。
 *
 * 用**文件重定向**而不是管道：DSH 的受限模式不允许 Node 用 pipe 抓子进程输出
 * （spawn 的默认 stdio: 'pipe' 会直接 EPERM）。生产环境（Electron 里的
 * qq_draw）用管道没问题，但测试要在沙箱里也能跑。
 */
function render(scene, name = 'out.png') {
  const stem = name.replace(/\.png$/, '');
  const out = path.join(TMP, name);
  const sceneFile = path.join(TMP, `${stem}.scene.json`);
  const outLog = path.join(TMP, `${stem}.stdout.txt`);
  const errLog = path.join(TMP, `${stem}.stderr.txt`);
  fs.writeFileSync(sceneFile, JSON.stringify(scene), 'utf8');
  const fdOut = fs.openSync(outLog, 'w');
  const fdErr = fs.openSync(errLog, 'w');
  const r = spawnSync(PY, [RENDER, '--scene', sceneFile, '--out', out], {
    stdio: ['ignore', fdOut, fdErr], timeout: 60_000, windowsHide: true
  });
  fs.closeSync(fdOut);
  fs.closeSync(fdErr);
  const stdout = fs.readFileSync(outLog, 'utf8');
  const stderr = fs.readFileSync(errLog, 'utf8');
  const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
  let parsed = null;
  try { parsed = JSON.parse(last); } catch { parsed = null; }
  return { parsed, out, stderr, code: r.status };
}

/** PNG 宽高从 IHDR 读，不引入图片库。 */
function pngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** 采几个点的颜色，用来证明「画上去的东西真的在那个位置」。 */
function probe(png, points) {
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const outFile = path.join(TMP, `probe-${tag}.json`);
  const errFile = path.join(TMP, `probe-${tag}.err.txt`);
  const code = 'import json,sys;'
    + 'from PIL import Image;'
    + 'im=Image.open(sys.argv[1]).convert("RGB");'
    + 'print(json.dumps([[p[0],p[1],list(im.getpixel((int(p[0]),int(p[1]))))] for p in json.loads(sys.argv[2])]))';
  const fd = fs.openSync(outFile, 'w');
  const efd = fs.openSync(errFile, 'w');
  spawnSync(PY, ['-c', code, png, JSON.stringify(points)], {
    stdio: ['ignore', fd, efd], encoding: 'utf8', windowsHide: true
  });
  fs.closeSync(fd);
  fs.closeSync(efd);
  try { return JSON.parse(fs.readFileSync(outFile, 'utf8')); } catch { return []; }
}

const near = (a, b, tol = 12) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);

if (!READY) {
  console.log('  ⚠ 跳过：找不到 Python 或 render.py（PY=' + PY + '）');
  console.log(`\n通过 0 / 失败 0（跳过）`);
  process.exit(0);
}

const FISH = {
  width: 900,
  height: 600,
  background: '#1e2a45',
  style: 'flat',          // 像素断言必须用 flat：crayon 会抖、会加纸纹，颜色对不上
  shapes: [
    { type: 'polygon', points: [[495, 340], [590, 275], [590, 405]], fill: '#6fb0dc' },
    { type: 'ellipse', cx: 370, cy: 340, rx: 140, ry: 90, fill: '#8cc5ea' },
    { type: 'circle', cx: 285, cy: 318, r: 25, fill: '#ffffff' },
    { type: 'text', x: 450, y: 62, text: '爸爸和我', size: 40, fill: '#ffffff', anchor: 'mt' }
  ]
};

console.log('基础渲染');
const base = render(FISH, 'fish.png');
ok('渲染成功', base.parsed?.ok === true, base.stderr.slice(-200));
ok('返回了真实路径', fs.existsSync(base.parsed?.path || ''), base.parsed?.path);
ok('报告尺寸 900x600', base.parsed?.width === 900 && base.parsed?.height === 600);
ok('统计到 4 个图形', base.parsed?.shapes === 4, String(base.parsed?.shapes));

const buf = fs.readFileSync(base.parsed?.path || base.out);
const size = pngSize(buf);
ok('是合法 PNG', !!size);
ok('PNG 实际尺寸 900x600', size?.width === 900 && size?.height === 600, JSON.stringify(size));

console.log('像素位置');
const pts = probe(base.parsed?.path || base.out, [
  [10, 10],           // 背景
  [370, 340],         // 鱼身中心
  [285, 318],         // 眼白
  [520, 340],         // 鱼尾
  [450, 82]           // 标题附近
]);
const colorAt = (x, y) => pts.find((p) => p[0] === x && p[1] === y)?.[2];
ok('背景色是深蓝', near(colorAt(10, 10), [30, 42, 69]), JSON.stringify(colorAt(10, 10)));
ok('鱼身是浅蓝', near(colorAt(370, 340), [140, 197, 234]), JSON.stringify(colorAt(370, 340)));
ok('眼白是白', near(colorAt(285, 318), [255, 255, 255]), JSON.stringify(colorAt(285, 318)));
ok('鱼尾是中间色', near(colorAt(520, 340), [111, 176, 220]), JSON.stringify(colorAt(520, 340)));
const titleBand = probe(base.parsed?.path || base.out, Array.from({ length: 40 }, (_, i) => [380 + i * 4, 82]));
ok('标题区域有白字', titleBand.some((p) => near(p[2], [255, 255, 255], 30)), '没有找到白色像素');

console.log('容错');
const empty = render({ width: 300, height: 200, shapes: [] }, 'empty.png');
ok('空 shapes 明确报错', empty.parsed?.ok === false && /shapes|空/.test(empty.parsed?.error || ''),
  empty.parsed?.error);

const weird = render({
  width: 200, height: 200, background: '#fff',
  shapes: [
    { type: 'starfish_dance', cx: 10, cy: 10 },      // 看不懂的类型
    { type: 'circle', cx: 100, cy: 100, r: 20, fill: 'not-a-color' }, // 非法颜色
    { type: 'text', x: 5, y: 5, text: '' },          // 空文字
    null, 'nonsense'                                  // 垃圾项
  ]
}, 'weird.png');
ok('怪图形不崩、整体仍成功', weird.parsed?.ok === true, JSON.stringify(weird.parsed));
ok('怪图形被跳过（只画成 1 个）', weird.parsed?.shapes === 1, String(weird.parsed?.shapes));

const huge = render({ width: 99999, height: 99999, background: '#000', shapes: [{ type: 'rect', x: 0, y: 0, w: 10, h: 10, fill: '#fff' }] }, 'huge.png');
ok('超大尺寸被夹到 2000', huge.parsed?.ok === true && huge.parsed?.width === 2000 && huge.parsed?.height === 2000,
  `${huge.parsed?.width}x${huge.parsed?.height}`);

const many = render({ width: 200, height: 200, shapes: Array.from({ length: 401 }, () => ({ type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#000' })) }, 'many.png');
ok('图形数超上限会拒绝', many.parsed?.ok === false && /图形太多/.test(many.parsed?.error || ''), many.parsed?.error);

const badJsonFile = path.join(TMP, 'bad.scene.json');
const badOut = path.join(TMP, 'bad.png');
const badLog = path.join(TMP, 'bad.stdout.txt');
const badErr = path.join(TMP, 'bad.stderr.txt');
fs.writeFileSync(badJsonFile, '{ not json', 'utf8');
const badFd = fs.openSync(badLog, 'w');
const badEfd = fs.openSync(badErr, 'w');
spawnSync(PY, [RENDER, '--scene', badJsonFile, '--out', badOut], {
  stdio: ['ignore', badFd, badEfd], windowsHide: true
});
fs.closeSync(badFd);
fs.closeSync(badEfd);
ok('坏 JSON 不抛栈到 stdout', (() => {
  try {
    const line = fs.readFileSync(badLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).pop() || '';
    return JSON.parse(line).ok === false;
  } catch { return false; }
})());

console.log('特效');
const fx = render({
  width: 300, height: 200, background: '#000', style: 'flat',
  shapes: [
    { type: 'circle', cx: 100, cy: 100, r: 60, fill: '#ff0000', opacity: 0.5 },
    { type: 'rect', x: 150, y: 50, w: 60, h: 60, fill: '#00ff00', rotate: 45 }
  ]
}, 'fx.png');
ok('半透明 + 旋转能画', fx.parsed?.ok === true && fx.parsed?.shapes === 2, JSON.stringify(fx.parsed));
const fxPts = probe(fx.parsed?.path || fx.out, [[100, 100], [180, 80]]);
ok('半透明红和黑底混合成暗红', (() => {
  const c = fxPts[0]?.[2];
  return Array.isArray(c) && c[0] > 60 && c[0] < 180 && c[1] < 40;
})(), JSON.stringify(fxPts[0]?.[2]));

console.log('画风');
const catScene = {
  width: 400, height: 300, background: '#1c2541',
  shapes: [
    { type: 'circle', cx: 120, cy: 90, r: 40, fill: '#ffe9a8' },
    { type: 'ellipse', cx: 230, cy: 200, rx: 50, ry: 60, fill: '#f6a259' },
    { type: 'text', x: 200, y: 20, text: '月亮', size: 28, fill: '#ffe9a8', anchor: 'mt' }
  ]
};
const outs = {};
for (const s of ['flat', 'crayon', 'picturebook', 'pixel']) {
  const r = render({ ...catScene, style: s }, `style-${s}.png`);
  outs[s] = {
    ok: r.parsed?.ok === true,
    style: r.parsed?.style,
    bytes: fs.existsSync(r.parsed?.path || '') ? fs.statSync(r.parsed.path).size : 0,
    path: r.parsed?.path
  };
}
ok('四种画风都能出图', Object.values(outs).every((v) => v.ok));
ok('style 被回显', Object.entries(outs).every(([k, v]) => v.style === k),
  JSON.stringify(Object.fromEntries(Object.entries(outs).map(([k, v]) => [k, v.style]))));
ok('crayon 比 flat 大（纸纹+抖动让熵变高）', outs.crayon.bytes > outs.flat.bytes,
  `${outs.crayon.bytes} vs ${outs.flat.bytes}`);
ok('pixel 比 flat 小（色块压缩率高）', outs.pixel.bytes < outs.flat.bytes,
  `${outs.pixel.bytes} vs ${outs.flat.bytes}`);
ok('未知画风回落成默认 crayon', (() => {
  const r = render({ ...catScene, style: 'neon_baroque' }, 'style-alias.png');
  return r.parsed?.style === 'crayon';
})());
ok('同场景重复画结果一致（固定随机种子）', (() => {
  const a = render({ ...catScene, style: 'crayon' }, 'seed-a.png');
  const b = render({ ...catScene, style: 'crayon' }, 'seed-b.png');
  const ba = fs.readFileSync(a.parsed.path);
  const bb = fs.readFileSync(b.parsed.path);
  return ba.equals(bb);
})());
ok('文字不被像素化（像素风里标题仍是清晰笔画）', (() => {
  const r = render({ ...catScene, style: 'pixel' }, 'style-pixel-text.png');
  const band = probe(r.parsed.path, Array.from({ length: 30 }, (_, i) => [120 + i * 5, 32]));
  // 像素风会把图形压成 6px 块；文字如果也被压，这一带就没有「接近纯白/纯色」的连续像素
  const colors = new Set(band.map((p) => p[2].join(',')));
  return colors.size > 3;
})());

console.log('归档与画廊');
const dDir = drawMod.DRAW_DIR;
ok('画作目录跟着 DATA_DIR 走（测试没有污染真实画廊）', dDir.startsWith(TMP), dDir);
fs.mkdirSync(dDir, { recursive: true });
fs.copyFileSync(base.parsed.path, path.join(dDir, 'draw-20261025-101010-aaaa.png'));
drawMod.recordDrawing({
  file: 'draw-20261025-101010-aaaa.png', title: '月亮和猫', style: 'crayon',
  source: 'chat', width: 900, height: 600
});
const list1 = drawMod.listDrawings();
ok('列表能列出刚记的画', list1.length === 1 && list1[0].title === '月亮和猫', JSON.stringify(list1));
ok('带上 hasTitle 标记', list1[0]?.hasTitle === true);
// 记过索引的用「记录那一刻」，不是从文件名推（文件名是造的 10-25 数据，跨天会误导）
ok('记过索引的用索引时间', (() => {
  const t = Date.parse(String(list1[0]?.createdAt));
  return Number.isFinite(t) && Math.abs(Date.now() - t) < 120_000;
})(), String(list1[0]?.createdAt));

fs.copyFileSync(base.parsed.path, path.join(dDir, 'draw-20260101-090000-bbbb.png'));
const list2 = drawMod.listDrawings();
ok('索引里没有的图也能列出来（磁盘为准）',
  list2.length === 2 && list2.some((x) => x.file.includes('bbbb') && x.hasTitle === false),
  JSON.stringify(list2.map((x) => x.file)));
ok('索引里没有的图，时间从文件名推', (() => {
  const b = list2.find((x) => x.file.includes('bbbb'));
  // created 是 ISO（UTC），比较要换成本地时间：文件名写的是本地 09:00
  const d = new Date(String(b?.createdAt));
  return d.getFullYear() === 2026 && d.getMonth() === 0 && d.getDate() === 1
    && d.getHours() === 9 && d.getMinutes() === 0;
})(), String(list2.find((x) => x.file.includes('bbbb'))?.createdAt));
ok('按时间倒序（新的在前）', list2[0]?.file.includes('aaaa'), list2[0]?.file);
ok('统计里有标题的张数', drawMod.drawingStats().titledCount === 1);

ok('删掉一张', (() => {
  const r = drawMod.deleteDrawing('draw-20260101-090000-bbbb.png');
  return r.ok === true && drawMod.listDrawings().length === 1;
})());
ok('删不存在的返回失败而不是崩', drawMod.deleteDrawing('draw-nope.png').ok === false);
ok('索引坏了不影响列表', (() => {
  fs.writeFileSync(path.join(dDir, 'index.json'), '{ broken json', 'utf8');
  return drawMod.listDrawings().length >= 1;
})());
ok('坏索引会被备份，不会被静默覆盖', (() => {
  // 上一条刚把索引写坏；这里再读一次，应该留下 index.broken.json
  drawMod.listDrawings();
  return fs.existsSync(path.join(dDir, 'index.broken.json'));
})());
ok('文件名穿越被拦', [
  drawMod.safeDrawingPath('../config.json'),
  drawMod.safeDrawingPath('..\\x.png'),
  drawMod.safeDrawingPath('C:\\Windows\\x.png'),
  drawMod.safeDrawingPath('a/b.png'),
  drawMod.safeDrawingPath('x.svg')
].every((v) => v === null) && drawMod.safeDrawingPath('ok.png') !== null);

console.log('构图模板');
for (const key of Object.keys(drawMod.PRESETS)) {
  const scene = drawMod.sceneFromPreset(key, { title: '测试' });
  ok(`模板 ${key} 结构合法`,
    !!scene && Array.isArray(scene.shapes) && scene.shapes.length >= 4 && !!scene.background);
}
ok('不认识的模板回落 night', drawMod.sceneFromPreset('unicorn').shapes.length > 0);
const presetRender = render(drawMod.sceneFromPreset('cat', { title: '猫' }), 'preset-cat.png');
ok('模板能真的渲染出来', presetRender.parsed?.ok === true && presetRender.parsed.shapes >= 6,
  JSON.stringify(presetRender.parsed));

console.log('自主活动的画图决策');
const planner = await import('../plugins/autonomous/lib/planner.js');
ok('draw 已进动作白名单', planner.ALLOWED_ACTIONS.has('draw'));
const d1 = planner.validateDecision(
  { action: 'draw', message: '给你画了', draw: { title: '月亮', preset: 'cat' } }, 3);
ok('draw 决策被接受', d1.action === 'draw' && d1.draw.title === '月亮' && d1.draw.preset === 'cat',
  JSON.stringify(d1));
const d2 = planner.validateDecision({ action: 'draw', message: 'x', draw: { preset: 'unicorn' } }, 3);
ok('未知 preset 回落 night', d2.draw.preset === 'night');
const d3 = planner.validateDecision({ action: 'draw', draw: { title: 'x' } }, 3);
ok('没配文时降级 explore（不发明内容）', d3.action === 'explore');
const d4 = planner.validateDecision(
  { action: 'draw', message: 'x', draw: { main: 'red', accent: '#123456' } }, 3);
ok('非法颜色丢掉、合法颜色保留', d4.draw.main === '' && d4.draw.accent === '#123456',
  JSON.stringify(d4.draw));
ok('标题被截断到 40 字', planner.validateDecision(
  { action: 'draw', message: 'x', draw: { title: '很'.repeat(80) } }, 3).draw.title.length === 40);

console.log('发图白名单');
const toolsSrc = fs.readFileSync(path.resolve('src/tools.js'), 'utf8');
ok('send_image 白名单包含 data/drawings', /data\/drawings/.test(toolsSrc));
const gwSrc = fs.readFileSync(path.resolve('dsh-plugins/qq-tools/index.mjs'), 'utf8');
ok('qq_draw 已注册', /name: 'qq_draw'/.test(gwSrc));
ok('qq_draw 会写 image outbox', /pushOutbox\(\{ type: 'image'/.test(gwSrc));
ok('qq_draw 复用共享渲染模块', /from '\.\.\/\.\.\/src\/draw\.js'/.test(gwSrc));

// 8899 面板已删除（2026-11-03），图库接口全部在 3210；这里改为检查 3210 侧。
console.log('图库接口（3210）');
const routesSrc = fs.readFileSync(path.resolve('src/routes.js'), 'utf8');
ok('3210 注册了 /api/drawings', /\/api\/drawings/.test(routesSrc));
ok('3210 有删除路由', /\/api\/drawings\/delete/.test(routesSrc));
ok('3210 图库路径限定在 DATA_DIR/drawings', /DATA_DIR,\s*'drawings'/.test(routesSrc));

console.log('硬路径');
const drawSrc = fs.readFileSync(path.resolve('src/draw.js'), 'utf8');
const pyConst = drawSrc.match(/QQ_DRAW_PYTHON \|\| '([^']+)'/)?.[1];
ok('draw.js 里的 python 真的存在', !!pyConst && fs.existsSync(pyConst), String(pyConst));
ok('draw.js 指向的渲染脚本存在',
  /'scripts',\s*'draw',\s*'render\.py'/.test(drawSrc) && fs.existsSync(RENDER));
ok('qq_draw 用同一个 Python 跑渲染器',
  !!pyConst && pyConst.replace(/\\\\/g, '\\') === PY,
  `${pyConst} vs ${PY}`);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
