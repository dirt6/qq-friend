// R7 当前验收（替换已删除 8899 面板的旧源码断言）：记忆管理 API 真实语义。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-current-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'learned.json'), JSON.stringify({ version: 2, items: [
  { id: 'i1', text: '苹果醋要稀释了喝', status: 'pending', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null, hits: 0, corrections: 1 },
  { id: 'i2', text: '地铁四号线早上七点半最挤', status: 'stable', tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastUsedAt: null, hits: 0, corrections: 1 }
] }), 'utf8');
const { createRoutes } = await import('../src/routes.js');
const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);
let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => { if (cond) { pass++; console.log(`OK    ${name}`); } else { fail++; console.log(`FAIL  ${name}${extra ? ` -> ${extra}` : ''}`); } };
const req = { headers: { origin: 'http://127.0.0.1', 'content-type': 'application/json' }, url: '/', method: 'POST' };
async function call(pattern, body, urlStr = 'http://127.0.0.1/') {
  const r = find(pattern); if (!r) return { code: 'NO_ROUTE' };
  let out; const json = (_res, _code, data) => { out = data; return data; };
  await r.handler({ json, req, url: new URL(urlStr), body, res: {}, match: [] });
  return out;
}

const list = await call('/api/learned/list', undefined, 'http://127.0.0.1/api/learned/list');
ok('list 只读返回 total/items', list.ok === true && list.total === 2 && list.items.length === 2, JSON.stringify(list));
const st = await call('/api/learned/status', { id: 'i1', status: 'verified' });
ok('status 由 owner 更新', st.ok === true && st.status === 'verified', JSON.stringify(st));
const bad = await call('/api/learned/status', { id: 'i1', status: 'hacked' });
ok('非法 status 拒绝', bad.ok === false && bad.code === 'BAD_STATUS', JSON.stringify(bad));
const save = await call('/api/learned/save', { id: 'i1', text: '苹果醋要稀释了喝\n新加一条经验' });
ok('save 返回 updated/created', save.ok === true && save.updated === 1 && save.created === 1, JSON.stringify(save));
const delNo = await call('/api/learned/delete', { id: 'i1' });
ok('delete 无 confirm 拒绝', delNo.ok === false && delNo.code === 'NO_CONFIRM', JSON.stringify(delNo));
const delMissing = await call('/api/learned/delete', { id: 'not-found', confirm: true });
ok('delete 不存在目标拒绝', delMissing.ok === false, JSON.stringify(delMissing));
const del = await call('/api/learned/delete', { id: 'i1', confirm: true });
ok('delete 存在目标成功', del.ok === true, JSON.stringify(del));
const arch = await call('/api/learned/archive', { days: 30 });
ok('archive 批量为 ok', arch.ok === true && typeof arch.archived === 'number', JSON.stringify(arch));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nR7 current: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
