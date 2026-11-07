// 浏览 / 评论能力的离线测试（不联网、不发真实请求）。
//
// 覆盖：
//   · 来源猜测（BV 号 / 帖子 id / 关键词）
//   · 列表格式化
//   · 小黑盒正文抽取（text 可能是 JSON 字符串、段落数组、HTML）
//   · B 站未登录时的报错路径（必须是 BiliAuthError，而不是笼统失败）
//   · 小黑盒幂等台账（同一指纹不重发、pending 卡住时拒发）
//   · B 站错误码翻成人话
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert';
import { guessSource, formatItemList, xhhBodyText, detailXhh } from '../plugins/autonomous/lib/social/browse.js';
import { BiliWriter, BiliAuthError, explainCode } from '../plugins/autonomous/lib/social/bili-write.js';
import { XhhWriter, fingerprint } from '../plugins/autonomous/lib/social/xhh-write.js';

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}

console.log('来源猜测');
ok('BV 号 → bili', () => assert.equal(guessSource('BV1xwnE6jEUZ'), 'bili'));
ok('短 BV 也算 bili', () => assert.equal(guessSource('BV1kS8H6VERt'), 'bili'));
ok('纯数字 → xhh', () => assert.equal(guessSource('194851015'), 'xhh'));
ok('32 位十六进制 → xhh', () => assert.equal(guessSource('0123456789abcdef0123456789abcdef'), 'xhh'));
ok('关键词 → 空（表示两边搜）', () => assert.equal(guessSource('黑神话'), ''));
ok('前后空格不影响', () => assert.equal(guessSource('  BV1xwnE6jEUZ  '), 'bili'));

console.log('列表格式化');
ok('B 站条目带播放量', () => {
  const t = formatItemList('bili', [{ title: '测试', url: 'https://b/v', play: 12, duration: '1:00', source: 'bili-search' }]);
  assert.match(t, /1\. 测试/);
  assert.match(t, /12 播放/);
});
ok('小黑盒条目带评论数', () => {
  const t = formatItemList('xhh', [{ title: '帖子', url: 'https://x/1', stats: { comments: 3 } }]);
  assert.match(t, /3 评论/);
});
ok('空列表不炸', () => assert.match(formatItemList('bili', []), /没搜到/));

console.log('小黑盒正文抽取');
ok('普通字符串原样', () => assert.equal(xhhBodyText({ text: '一句话正文' }), '一句话正文'));
ok('HTML 去标签', () => assert.equal(xhhBodyText({ text: '<p>你好</p><p>世界</p>' }), '你好 世界'));
ok('JSON 字符串里的段落数组', () => {
  const raw = JSON.stringify([{ text: '第一段' }, { text: '第二段' }]);
  assert.equal(xhhBodyText({ text: raw }), '第一段\n第二段');
});
ok('没有 text 时退回 description', () => assert.equal(xhhBodyText({ description: '简介内容' }), '简介内容'));
ok('空对象返回空串', () => assert.equal(xhhBodyText({}), ''));

console.log('B 站未登录');
ok('没有 auth 文件 → loggedIn=false', () => {
  const w = new BiliWriter({ authFile: path.join(os.tmpdir(), '__no_bili_auth__.json') });
  assert.equal(w.loggedIn, false);
  assert.match(w.lastAuthError, /没导入/);
});
ok('缺 SESSDATA 也算没登录', () => {
  const f = path.join(os.tmpdir(), `bili-bad-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ cookies: { bili_jct: 'x' } }), 'utf8');
  const w = new BiliWriter({ authFile: f });
  assert.equal(w.loggedIn, false);
  assert.match(w.lastAuthError, /SESSDATA/);
  fs.rmSync(f, { force: true });
});
await okAsync('comment() 抛 BiliAuthError', async () => {
  const w = new BiliWriter({ authFile: path.join(os.tmpdir(), '__no_bili_auth__.json') });
  await assert.rejects(() => w.comment('BV1xwnE6jEUZ', 'hi', { resolveAid: async () => 1 }), BiliAuthError);
});
ok('错误码翻人话', () => {
  assert.match(explainCode(-101), /未登录/);
  assert.match(explainCode(12002), /关闭/);
  assert.equal(explainCode(-999), '');
});

console.log('B 站 @ 拼接与转义');
await okAsync('mention 拼到开头，正文其他 @ 转全角', async () => {
  const f = path.join(os.tmpdir(), `bili-auth-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ cookies: { SESSDATA: 's', bili_jct: 'j' } }), 'utf8');
  let sent = '';
  const w = new BiliWriter({
    authFile: f,
    fetchImpl: async (_url, opts) => {
      sent = new URLSearchParams(opts.body).get('message');
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { rpid: 1 } }) };
    }
  });
  const r = await w.comment('BV1xwnE6jEUZ', '你看 @功能 这个梗', {
    mention: '泥土如是说',
    resolveAid: async () => 42
  });
  assert.equal(r.ok, true);
  assert.equal(sent, '@泥土如是说 你看 ＠功能 这个梗');
  fs.rmSync(f, { force: true });
});
await okAsync('不传 mention 时也转义正文里的 @', async () => {
  const f = path.join(os.tmpdir(), `bili-auth2-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ cookies: { SESSDATA: 's', bili_jct: 'j' } }), 'utf8');
  let sent = '';
  const w = new BiliWriter({
    authFile: f,
    fetchImpl: async (_url, opts) => {
      sent = new URLSearchParams(opts.body).get('message');
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { rpid: 1 } }) };
    }
  });
  await w.comment('BV1xwnE6jEUZ', '@某人 你好', { resolveAid: async () => 42 });
  assert.equal(sent, '＠某人 你好');
  fs.rmSync(f, { force: true });
});

console.log('小黑盒幂等');
ok('指纹对同内容稳定', () => {
  assert.equal(
    fingerprint({ linkId: '1', replyId: '-1', text: 'abc' }),
    fingerprint({ linkId: '1', replyId: '-1', text: '  abc  ' })
  );
});
ok('不同父评论指纹不同', () => {
  assert.notEqual(
    fingerprint({ linkId: '1', replyId: '2', text: 'abc' }),
    fingerprint({ linkId: '1', replyId: '3', text: 'abc' })
  );
});
await okAsync('pending 时不重发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhhw-'));
  const outbox = path.join(dir, 'outbox.json');
  const fp = fingerprint({ linkId: '194851015', replyId: '-1', text: '同一句话' });
  fs.writeFileSync(outbox, JSON.stringify({
    version: 1,
    items: [{ fp, state: 'pending', at: Date.now(), linkId: '194851015', text: '同一句话' }]
  }), 'utf8');
  const w = new XhhWriter({
    authFile: 'E:/dsh/QQ-agent/data/xhh-auth.json',
    outboxFile: outbox,
    fetchImpl: async () => { throw new Error('不应该发出请求'); }
  });
  const r = await w.comment({ linkId: '194851015', text: '同一句话' });
  assert.equal(r.ok, false);
  assert.equal(r.duplicated, true);
  assert.match(r.error, /不重发|还没确认/);
  fs.rmSync(dir, { recursive: true, force: true });
});
await okAsync('没有 auth 文件时 comment 返回错误而不是抛异常', async () => {
  const w = new XhhWriter({
    authFile: path.join(os.tmpdir(), '__no_xhh_auth__.json'),
    outboxFile: path.join(os.tmpdir(), `xhh-out-${Date.now()}.json`)
  });
  const r = await w.comment({ linkId: '194851015', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /没导入/);
});

console.log('小黑盒详情解析（假数据）');
await okAsync('comments 是 [{comment:[...]}] 结构', async () => {
  const fake = {
    linkTree: async () => ({
      ok: true,
      json: {
        result: {
          link: { linkid: '194851015', title: '标题X', text: '正文X', user: { username: '作者' } },
          comments: [
            { comment: [{ commentid: 111, text: '主评论', up: 9, child_num: 2, user: { username: '甲' } },
              { commentid: 112, text: '楼中楼', up: 0, user: { username: '乙' } }] }
          ]
        }
      }
    })
  };
  const d = await detailXhh(fake, '194851015', { replyLimit: 5 });
  assert.equal(d.ok, true);
  assert.match(d.text, /标题X/);
  assert.match(d.text, /主评论/);
  assert.match(d.text, /楼中楼/);
  assert.equal(d.replies.length, 2);
  assert.equal(d.replies[0].replyId, '111');
});

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
