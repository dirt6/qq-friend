// 日记面板增/改/删：走路由与统一 writer；临时 data + 临时日记目录。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-panel-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ skills: { diary: { root: path.join(tmp, '日记') } } }), 'utf8');
const { createRoutes } = await import('../src/routes.js');
const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const req = { headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, url: '/', method: 'POST' };
async function call(pattern, body, urlStr = 'http://127.0.0.1/') {
  const r = find(pattern); let out; const json = (_res, _code, data) => { out = data; return data; };
  await r.handler({ json, req, url: new URL(urlStr), body, res: {}, match: [] });
  return out;
}
const day = '2026-11-05';
const add = await call('/api/diary/add', { day, mood: '平静', content: '面板测试：今天有一只猫' });
ok('新增日记', add.ok === true, JSON.stringify(add));
let list = await call('/api/diary', undefined, 'http://127.0.0.1/api/diary?days=14');
const entry = list.days?.[0]?.entries?.[0];
ok('列表读到新增', entry?.text === '面板测试：今天有一只猫', JSON.stringify(list).slice(0, 300));
const edit = await call('/api/diary/edit', { day, match: entry.text, content: '面板测试：今天有两只猫', mood: '开心' });
ok('修改日记', edit.ok === true, JSON.stringify(edit));
list = await call('/api/diary', undefined, 'http://127.0.0.1/api/diary?days=14');
ok('修改后内容正确', list.days?.[0]?.entries?.[0]?.text === '面板测试：今天有两只猫', JSON.stringify(list).slice(0, 300));
const del = await call('/api/diary/delete', { day, match: '面板测试：今天有两只猫' });
ok('删除日记', del.ok === true, JSON.stringify(del));
list = await call('/api/diary', undefined, 'http://127.0.0.1/api/diary?days=14');
ok('删除后列表为空', !list.days?.[0]?.entries?.length, JSON.stringify(list).slice(0, 200));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nDiary panel: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
