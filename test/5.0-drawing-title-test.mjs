// 画作标题：索引更新、旧字段保留、非法文件名拒绝（临时 DATA_DIR）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'draw-title-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const draw = await import('../src/draw.js');
fs.mkdirSync(draw.DRAW_DIR, { recursive: true });
const file = 'draw-20261105-150000-abcd.png';
fs.writeFileSync(path.join(draw.DRAW_DIR, file), Buffer.from('not-a-real-png'));
draw.recordDrawing({ file, title: '旧标题', note: '旧备注', style: 'picturebook', source: 'autonomous', width: 900, height: 600, bytes: 15, createdAt: '2026-11-05T07:00:00.000Z' });
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`OK    ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? ` -> ${extra}` : ''}`); } };

ok('索引读出标题', draw.listDrawings({ limit: 10 }).find((x) => x.file === file)?.title === '旧标题');
const r = draw.updateDrawingTitle(file, '新标题');
ok('更新标题成功', r.ok === true && r.title === '新标题', JSON.stringify(r));
const item = draw.listDrawings({ limit: 10 }).find((x) => x.file === file);
ok('标题已变', item?.title === '新标题');
ok('旧 style/source/createdAt 保留', item?.style === 'picturebook' && item?.source === 'owner' && item?.createdAt === '2026-11-05T07:00:00.000Z', JSON.stringify(item));
ok('非法路径拒绝', draw.updateDrawingTitle('../x.png', 'x').ok === false);
ok('不存在文件拒绝', draw.updateDrawingTitle('nope.png', 'x').ok === false);
// 真实路由：列表带标题、标题 API 可改写
const { createRoutes } = await import('../src/routes.js');
const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);
const req = { headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, url: '/', method: 'POST' };
async function call(pattern, body, urlStr = 'http://127.0.0.1/') {
  const r = find(pattern); let out; const json = (_res, _code, data) => { out = data; return data; };
  await r.handler({ json, req, url: new URL(urlStr), body, res: {}, match: [] });
  return out;
}
const listApi = await call('/api/drawings', undefined, 'http://127.0.0.1/api/drawings');
ok('列表 API 带标题', listApi.ok === true && listApi.items?.[0]?.title === '新标题', JSON.stringify(listApi).slice(0, 200));
const titleApi = await call('/api/drawings/title', { name: file, title: '路由改的标题' });
ok('标题 API 改写成功', titleApi.ok === true && titleApi.title === '路由改的标题', JSON.stringify(titleApi));
const after = draw.listDrawings({ limit: 10 }).find((x) => x.file === file);
ok('路由改后索引一致', after?.title === '路由改的标题');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nDrawing title: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
