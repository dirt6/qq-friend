// 空闲活动的「动作」测试：评论、搜索，以及它们的降级规则
//
// 为什么单独测这一层：这两个动作和 share/chat 不一样 ——
//   · comment 是**写操作**，会真的发到公开社区，降级规则错一次就是一条不该发的评论
//   · search 会改变下一轮的候选来源
// 所以 validateDecision 的边界必须钉死。
import { ALLOWED_ACTIONS, validateDecision } from '../plugins/autonomous/lib/planner.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('白名单');
ok('comment 在白名单', ALLOWED_ACTIONS.has('comment'));
ok('search 在白名单', ALLOWED_ACTIONS.has('search'));
ok('未知动作仍降级 explore', validateDecision({ action: 'hack_the_gibson' }, 3).action === 'explore');

console.log('评论');
{
  const d = validateDecision({
    action: 'comment', pick: 1, comment: { text: '这条说得挺对的，我也这么觉得', mention: 'owner' }
  }, 3);
  ok('正常评论被接受', d.action === 'comment', d.action);
  ok('正文保留', d.comment.text.includes('我也这么觉得'));
  ok('mention=owner 被保留', d.comment.mention === 'owner');

  // 太短 = 刷存在感，必须降级
  const short = validateDecision({ action: 'comment', comment: { text: '好' } }, 3);
  ok('一个字判「没话说」降级', short.action === 'explore', short.action);
  const medium = validateDecision({ action: 'comment', comment: { text: '说得对' } }, 3);
  ok('五个字也降级（阈值 6）', medium.action === 'explore', medium.action);

  const noText = validateDecision({ action: 'comment', comment: {} }, 3);
  ok('没给正文降级', noText.action === 'explore');

  const otherMention = validateDecision({ action: 'comment', comment: { text: '这是一条够长的评论', mention: 'someone' } }, 3);
  ok('只认 owner，其它 @ 目标清空', otherMention.comment.mention === '');

  const longText = validateDecision({ action: 'comment', comment: { text: '很'.repeat(300) } }, 3);
  ok('超长正文被截到 200', longText.comment.text.length === 200);
}

console.log('搜索');
{
  const d = validateDecision({ action: 'search', search: { keyword: '黑神话 更新', source: 'xhh' } }, 3);
  ok('正常搜索被接受', d.action === 'search');
  ok('关键词和来源都在', d.search.keyword === '黑神话 更新' && d.search.source === 'xhh');

  const noKw = validateDecision({ action: 'search', search: {} }, 3);
  ok('没关键词降级', noKw.action === 'explore');
  const oneChar = validateDecision({ action: 'search', search: { keyword: '游' } }, 3);
  ok('单个字也算太短', oneChar.action === 'explore');

  const badSource = validateDecision({ action: 'search', search: { keyword: '测试关键词', source: 'weibo' } }, 3);
  ok('非法来源回落 bili', badSource.search.source === 'bili');
}

console.log('发帖');
{
  ok('publish 在白名单', ALLOWED_ACTIONS.has('publish'));
  const good = validateDecision({
    action: 'publish',
    publish: { title: '今天通关了', body: '打了一下午终于过了那个 boss，手都在抖。', topics: '游戏,日常' }
  }, 3);
  ok('正常发帖被接受', good.action === 'publish', good.action);
  ok('标题正文都保留', good.publish.title === '今天通关了' && good.publish.body.includes('boss'));
  ok('话题保留', good.publish.topics === '游戏,日常');

  const shortBody = validateDecision({ action: 'publish', publish: { title: '标题', body: '太短了' } }, 3);
  ok('正文不足 20 字判水贴，降级', shortBody.action === 'explore', shortBody.action);
  const shortTitle = validateDecision({ action: 'publish', publish: { title: '一', body: '这是一段足够长的正文内容用来测试长度限制的。' } }, 3);
  ok('标题太短降级', shortTitle.action === 'explore');
  const noPost = validateDecision({ action: 'publish' }, 3);
  ok('什么都没给降级', noPost.action === 'explore');

  const longBody = validateDecision({
    action: 'publish', publish: { title: '标题', body: '很'.repeat(2000) }
  }, 3);
  ok('超长正文截到 1500', longBody.publish.body.length === 1500, String(longBody.publish.body.length));
}

console.log('不影响原有动作');
{
  const share = validateDecision({ action: 'share', message: '给你看这个' }, 3);
  ok('share 正常', share.action === 'share');
  const chat = validateDecision({ action: 'chat', message: '在吗' }, 3);
  ok('chat 正常', chat.action === 'chat');
  const draw = validateDecision({ action: 'draw', message: '画了', draw: { preset: 'cat' } }, 3);
  ok('draw 正常', draw.action === 'draw' && draw.draw.preset === 'cat');
  const none = validateDecision({ action: 'share' }, 3);
  ok('share 没内容仍降级', none.action === 'explore');
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
