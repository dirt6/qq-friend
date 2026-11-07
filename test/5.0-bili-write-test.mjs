// B站评论写适配器：预览/确认/限频；fake writer/client，不联网不真发。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createBiliWriteAdapter } from '../src/bili-write-adapter.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-write-'));
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const make = ({ loggedIn = true, sendOk = true } = {}) => {
  let sends = 0;
  const writer = {
    loggedIn,
    async comment(bvid, text, { mention }) {
      sends += 1;
      if (!sendOk) return { ok: false, error: '评论被拦截' };
      return { ok: true, rpid: 123, text: `@${mention} ${text}` };
    }
  };
  const client = { async video() { return { ok: true, aid: 456 }; } };
  const a = createBiliWriteAdapter({ writer, client, journalFile: path.join(tmp, `j-${Math.random()}.json`) });
  return { a, sends: () => sends };
};

const { a, sends } = make();
const p = a.preview({ bvid: 'BV1xx411c7mD', text: '测试@功能', mention: '小鲸鱼' });
ok('预览成功且不发送', p.ok === true && p.sent !== true && p.text.startsWith('@小鲸鱼 '), JSON.stringify(p));
ok('正文里的 @ 被转全角', p.text.includes('＠功能'));
const pre = await a.comment({ bvid: 'BV1xx411c7mD', text: '测试@功能', mention: '小鲸鱼' });
ok('默认不确认不发送', pre.ok === true && pre.sent === false && sends() === 0);
const sent = await a.comment({ bvid: 'BV1xx411c7mD', text: '测试@功能', mention: '小鲸鱼', confirm: true });
ok('确认后发送', sent.ok === true && sent.sent === true && sent.rpid === 123 && sends() === 1, JSON.stringify(sent));
const noAuth = make({ loggedIn: false });
const r2 = await noAuth.a.comment({ bvid: 'BV1xx411c7mD', text: 'x', confirm: true });
ok('未登录拒绝发送', r2.ok === false && /未登录/.test(r2.error) && noAuth.sends() === 0);
const bad = make({ sendOk: false });
const r3 = await bad.a.comment({ bvid: 'BV1xx411c7mD', text: 'x', confirm: true });
ok('B站拒绝返回失败', r3.ok === false && /拦截/.test(r3.error) && bad.sends() === 1);
const tooLong = a.preview({ bvid: 'BV1xx411c7mD', text: 'x'.repeat(201) });
ok('超长拒绝', tooLong.ok === false);
const { a: limited } = make();
for (let i = 0; i < 3; i++) await limited.comment({ bvid: 'BV1xx411c7mD', text: `第${i}条`, confirm: true });
const r4 = await limited.comment({ bvid: 'BV1xx411c7mD', text: '第4条', confirm: true });
ok('每小时最多 3 条', r4.ok === false && /上限/.test(r4.error));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nBili write: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
