// B站详情/热评只读：用 fake fetch 验证，不联网、不登录、不写。
import assert from 'node:assert/strict';
import { BiliClient, formatDetail } from '../plugins/autonomous/lib/bili/api.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const view = { code: 0, data: { bvid: 'BV1xx411c7mD', aid: 123, title: '测试视频', desc: '简介内容', tname: '科技', owner: { name: 'UP主' }, stat: { view: 1000, like: 50, reply: 2 } } };
const replies = { code: 0, data: { replies: [
  { member: { uname: '甲' }, content: { message: '热评一' }, like: 10 },
  { member: { uname: '乙' }, content: { message: '热评二' }, like: 5 }
] } };
const client = new BiliClient({ fetchImpl: async (url) => {
  const body = String(url).includes('/x/v2/reply') ? replies : view;
  return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
} });

const r = await client.detail('BV1xx411c7mD', { replyLimit: 2 });
ok('详情读取成功', r.ok === true, JSON.stringify(r));
ok('标题/UP/统计存在', r.title === '测试视频' && r.owner === 'UP主' && r.stat.view === 1000);
ok('热评两条', r.replies.length === 2 && r.replies[0].text === '热评一');
ok('格式化包含简介/热评', /简介内容/.test(formatDetail(r)) && /热评一/.test(formatDetail(r)));
const bad = await client.detail('');
ok('空 BV 明确失败', bad.ok === false);
console.log(`\nBili detail: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
