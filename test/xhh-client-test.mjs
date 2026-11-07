// 小黑盒只读客户端（plugins/autonomous/lib/xhh/client.js）的单元测试。
//
// 锁住三件事：
//   ① 帖子归一化：linkid 是 32 位十六进制、标签是对象数组、标题带 <em>
//   ② 登录态加载：文件缺失/损坏时 loggedIn=false 且给出原因（不崩）
//   ③ 错误分类：401 抛 XhhAuthError（登录失效，上层该停）；status=failed 当普通失败
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { XhhClient, XhhAuthError, normalizePost } from '../plugins/autonomous/lib/xhh/client.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` -> ${extra}` : ''}`); }
};

console.log('=== 一、帖子归一化 ===');
{
  const info = {
    linkid: '293f7143d341',
    title: 'steam<em>独立游戏</em>好评率前100名',
    description: '一个<b>推荐</b>帖',
    share_url: 'https://api.xiaoheihe.cn/v3/bbs/app/api/web/share?link_id=293f7143d341',
    create_at: 1766102400,
    comment_num: 42,
    user: { username: '某作者' },
    content_tags: [{ name: 'steam游戏' }, { tag_name: '独立游戏推荐' }],
    hashtags: [{ name: '单机游戏' }]
  };
  const it = normalizePost(info);
  ok('16 进制 linkid 保留', it && it.contentId === '293f7143d341', it?.contentId);
  ok('标题去 HTML', it.title === 'steam独立游戏好评率前100名', it.title);
  ok('标签对象取 name/tag_name', it.tags.join('/') === 'steam游戏/独立游戏推荐/单机游戏', it.tags.join('/'));
  ok('标签最多 3 个', it.tags.length <= 3);
  ok('作者取 user.username', it.author === '某作者');
  ok('评论数进 stats', it.stats?.comments === 42);
  ok('日期从 create_at 转', /^\d{4}-\d{2}-\d{2}$/.test(it.publishedAt), it.publishedAt);
  ok('链接用站内帖子页（不是 api share 地址）', it.url === 'https://www.xiaoheihe.cn/app/bbs/link/293f7143d341', it.url);

  ok('缺 linkid → null', normalizePost({ title: '无 ID' }) === null);
  ok('空标题 → null', normalizePost({ linkid: 'abc', title: '<em></em>' }) === null);
  ok('非对象 → null', normalizePost(null) === null);
  const noUrl = normalizePost({ linkid: 'abc123', title: '有 ID 没链接' });
  ok('没有 share_url 时拼站内链接', noUrl.url === 'https://www.xiaoheihe.cn/app/bbs/link/abc123', noUrl.url);
}

console.log('\n=== 二、登录态加载 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh-'));
  const authFile = path.join(dir, 'auth.json');

  const missing = new XhhClient({ authFile });
  ok('文件不存在时 loggedIn=false', missing.loggedIn === false);
  ok('给出原因', /导入|ENOENT|还没/.test(missing.lastAuthError), missing.lastAuthError);

  fs.writeFileSync(authFile, '{坏 JSON', 'utf8');
  const broken = new XhhClient({ authFile });
  ok('坏文件不崩且 loggedIn=false', broken.loggedIn === false);

  fs.writeFileSync(authFile, JSON.stringify({ uid: '123', cookies: { user_pkey: 'x' } }), 'utf8');
  const good = new XhhClient({ authFile });
  ok('正常文件 loggedIn=true', good.loggedIn === true);
  ok('uid 读出来', good.uid === '123');
  ok('cookie 头拼好', good.cookieHeader() === 'user_pkey=x');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log('\n=== 三、错误分类 ===');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhh2-'));
  const authFile = path.join(dir, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ uid: '1', cookies: { user_pkey: 'x' } }), 'utf8');

  const mk = (status, body) => new XhhClient({
    authFile,
    fetchImpl: async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) })
  });

  let threw = '';
  try { await mk(401, { status: 'failed' }).search('游戏'); } catch (e) { threw = e.name; }
  ok('401 抛 XhhAuthError', threw === 'XhhAuthError', threw);

  const failed = await mk(200, { status: 'failed', msg: '暂无权限' }).search('游戏');
  ok('status=failed 当普通失败', failed.ok === false && /暂无权限/.test(failed.error));

  const badJson = await mk(200, '<html>页面</html>').search('游戏');
  ok('非 JSON 判失败', badJson.ok === false && /不是 JSON/.test(badJson.error));

  const good = await mk(200, { status: 'ok', result: { items: [{ info: { linkid: 'aa11', title: '第一篇' } }] } }).search('游戏');
  ok('正常搜索解析出条目', good.ok === true && good.items.length === 1 && good.items[0].contentId === 'aa11');

  const empty = await mk(200, { status: 'ok', result: { items: [] } }).search('游戏');
  ok('空结果 ok=true（不是错误）', empty.ok === true && empty.items.length === 0);

  const tooLong = await mk(200, { status: 'ok', result: { items: [] } }).search('');
  ok('空关键词直接拒绝', tooLong.ok === false && tooLong.error === '关键词为空');

  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗ 失败' : '✓ 全部通过'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
