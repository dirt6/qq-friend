// 小黑盒只读适配器：fake client，不联网。
import assert from 'node:assert/strict';
import { createXhhReader } from '../src/xhh-heybox.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const feedData = { result: { links: [{ linkid: '123', title: '帖子一', user: { username: '甲' }, link_award_num: 5, comment_num: 2 }] } };
const postData = { result: { link: { title: '帖子一', text: JSON.stringify([{ type: 'text', text: '正文内容' }]), user: { username: '甲' } }, comments: [{ commentid: 'c1', user: { username: '乙' }, text: '评论一', up: 1 }] } };
const client = {
  async get(path, params) {
    if (path.includes('/feeds')) return feedData;
    if (path.includes('/link/tree')) return postData;
    if (path.includes('/search')) return { result: { items: [{ info: { linkid: '456', title: '搜索结果' } }] } };
    if (path.includes('/user/message')) return { result: { messages: [{ comment_a_text: '回复你', linkid: '789', link_user: '丙', comment_a_id: 'c2' }] } };
    if (path.includes('notice')) return { result: { notices: [{ user: { username: '丙' }, comment_text: '回复你' }] } };
    if (path.includes('/restore_login')) return { result: { profile: { heybox_id: '9', username: '小号' } } };
    throw new Error('unexpected ' + path);
  }
};
const r = createXhhReader({ client });
const feed = await r.feed({ limit: 5 });
ok('feed 只读', feed.ok === true && feed.items[0]?.id === '123' && feed.items[0]?.url.includes('123'));
const post = await r.post('123');
ok('帖子正文/评论', post.ok === true && post.text === '正文内容' && post.comments.length === 1);
const search = await r.search('猫');
ok('搜索', search.ok === true && search.items[0]?.id === '456');
const notify = await r.notify();
ok('通知', notify.ok === true && notify.items[0]?.text === '回复你');
const who = await r.whoami();
ok('whoami', who.ok === true && who.uid === '9' && who.nickname === '小号');
const missing = await r.post('');
ok('空 id 拒绝', missing.ok === false);
console.log(`\nXHH reader: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
