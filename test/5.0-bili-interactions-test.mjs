// B站回复/收件箱：回复只验证参数传递；收件箱用 fake fetch，不联网。
import assert from 'node:assert/strict';
import { createBiliWriteAdapter } from '../src/bili-write-adapter.js';
import { inboxBili } from '../plugins/autonomous/lib/social/inbox.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
let captured = null;
const writer = {
  loggedIn: true,
  async comment(bvid, text, opts) { captured = { bvid, text, opts }; return { ok: true, rpid: 999, text }; }
};
const client = { async video() { return { ok: true, aid: 123 }; } };
const a = createBiliWriteAdapter({ writer, client, journalFile: process.env.TEMP + '/bili-reply-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json' });
const pre = a.preview({ bvid: 'BV1xx411c7mD', text: '回复热评', root: '321' });
ok('预览不发送', pre.ok === true && pre.sent !== true);
await a.comment({ bvid: 'BV1xx411c7mD', text: '回复热评', root: '321', parent: '322', confirm: true });
ok('writer 收到 root/parent', captured?.opts?.root === '321' && captured?.opts?.parent === '322', JSON.stringify(captured));
const empty = await inboxBili({ cookie: 'SESSDATA=x', limit: 2, fetchImpl: async (url) => {
  const b = String(url).includes('/x/msgfeed/reply')
    ? { code: 0, data: { items: [{ item: { source_content: '回复内容', uri: 'https://www.bilibili.com/video/BV1xx411c7mD', root_id: '1', source_id: '2', title: '视频' }, user: { nickname: '甲', mid: 1 }, reply_time: 1 }] } }
    : { code: 0, data: { items: [] } };
  return { ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b };
} });
ok('收件箱读取回复', empty.ok === true && empty.items[0]?.target === 'BV1xx411c7mD' && empty.items[0]?.replyTo === '2', JSON.stringify(empty));
console.log(`\nBili interactions: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
