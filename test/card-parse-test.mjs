// QQ 卡片 / 名片 / xml 消息的解析测试
//
// 锁住一件事：**她不能再只收到一个「[卡片消息]」的壳**。
// 2026-10-26 实测：机主发小黑盒分享卡片，她回「卡片我这儿只见到个壳，没链接」，
// 最后只能让机主把标题打出来她去搜。根因是 segmentsToText 里 json 段直接
// push 了一个占位符，名片和 xml 更是掉进 default。
import { parseJsonCard, parseXmlCard, segmentsToText } from '../src/onebot.js';
import { parseShareLink } from '../plugins/autonomous/lib/social/browse.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('json 卡片');
{
  // 小黑盒这类小程序分享卡片
  const miniapp = JSON.stringify({
    app: 'com.tencent.miniapp_01',
    prompt: '[QQ小程序]小黑盒',
    meta: {
      detail_1: {
        title: '大肥鱼不知道去哪玩被骂了跑来告状，艰难绷住',
        desc: '下载小黑盒查看更多精彩内容',
        qqdocurl: 'https://www.xiaoheihe.cn/app/bbs/post_share?link_id=11b572b24619',
        preview: 'https://img.example.com/a.jpg'
      }
    }
  });
  const t = parseJsonCard(miniapp);
  ok('拿到标题', t.includes('大肥鱼不知道去哪玩'));
  ok('拿到链接', t.includes('https://www.xiaoheihe.cn/app/bbs/post_share'));
  ok('拿到简介', t.includes('下载小黑盒'));
  ok('带 [卡片] 标记', t.startsWith('[卡片]'));

  // 图文卡片：字段名是 jumpUrl
  const news = JSON.stringify({
    app: 'com.tencent.structmsg',
    meta: { news: { title: '标题党一篇', desc: '简介', jumpUrl: 'https://example.com/n/1' } }
  });
  const t2 = parseJsonCard(news);
  ok('jumpUrl 也算链接', t2.includes('https://example.com/n/1'), t2);

  // 音乐卡片
  const music = JSON.stringify({
    app: 'com.tencent.music.lua',
    meta: { music: { title: '朗朗晴天', desc: '羽生まゐご', jumpUrl: 'https://y.qq.com/n/ryqq/song/1' } }
  });
  ok('音乐卡片同样能捞', parseJsonCard(music).includes('朗朗晴天'));

  // 没有链接的卡片
  const noUrl = JSON.stringify({ meta: { detail_1: { title: '只有标题' } } });
  ok('没链接时不硬编链接', !parseJsonCard(noUrl).includes('http'));

  // 非 http 的跳转（小程序路径）不该当成链接塞进去
  const appPath = JSON.stringify({ meta: { detail_1: { title: 'x', qqdocurl: 'pages/index?foo=1' } } });
  ok('非 http 的 qqdocurl 被丢掉', !parseJsonCard(appPath).includes('pages/index'));

  // 坏数据
  ok('坏 JSON 返回空串而不是抛错', parseJsonCard('{ not json') === '');
  ok('空对象返回空串', parseJsonCard('{}') === '');
  ok('null 不崩', parseJsonCard(null) === '');
}

console.log('xml 卡片');
{
  const xml = `<msg serviceID="1" templateID="1"><item layout="2"><title>分享的文章</title><summary>这是摘要</summary><url>https://example.com/a</url></item></msg>`;
  const t = parseXmlCard(xml);
  ok('xml 拿到标题', t.includes('分享的文章'));
  ok('xml 拿到摘要', t.includes('这是摘要'));
  ok('xml 拿到链接', t.includes('https://example.com/a'));

  const cdata = '<msg><item><title><![CDATA[带 CDATA 的标题]]></title><url>https://x.test/1</url></item></msg>';
  ok('CDATA 被剥掉', parseXmlCard(cdata).includes('带 CDATA 的标题'), parseXmlCard(cdata));

  ok('空 xml 返回空串', parseXmlCard('') === '');
  ok('没字段的 xml 返回空串', parseXmlCard('<msg></msg>') === '');
}

console.log('进入消息正文');
{
  const segs = [
    { type: 'text', data: { text: '看这个 ' } },
    { type: 'json', data: { data: JSON.stringify({ meta: { detail_1: { title: '小黑盒帖子', qqdocurl: 'https://x.test/p' } } }) } }
  ];
  const t = await segmentsToText(segs);
  ok('卡片和文字拼在一起', t.includes('看这个') && t.includes('小黑盒帖子'), t);

  const badCard = await segmentsToText([{ type: 'json', data: { data: 'broken' } }]);
  ok('解析不了时保留占位符', badCard.includes('[卡片消息]'), badCard);

  const contact = await segmentsToText([{ type: 'contact', data: { nickname: '小明', qq: '12345' } }]);
  ok('名片有昵称和 QQ 号', contact.includes('小明') && contact.includes('12345'), contact);

  const oldContact = await segmentsToText([{ type: 'contact', data: {} }]);
  ok('空名片不崩', oldContact.includes('[名片'), oldContact);

  const xmlSeg = await segmentsToText([{ type: 'xml', data: { data: '<msg><item><title>XML 卡片</title></item></msg>' } }]);
  ok('xml 段走通了', xmlSeg.includes('XML 卡片'), xmlSeg);
}

console.log('不影响原有类型');
{
  const t = await segmentsToText([{ type: 'text', data: { text: '普通一句话' } }]);
  ok('纯文本原样', t === '普通一句话', t);
  const face = await segmentsToText([{ type: 'face', data: { id: '178' } }]);
  ok('表情占位不变', face === '[表情178]', face);
  const img = await segmentsToText([{ type: 'image', data: { file: 'x.jpg' } }]);
  ok('图片占位不变', img === '[图片]', img);
}

console.log('分享链接解析');
{
  const xhh = parseShareLink('https://www.xiaoheihe.cn/app/bbs/post_share?link_id=11b572b24619&qq_aio_chat_type=2&h_src=abc');
  ok('小黑盒分享链接抠出 link_id', xhh?.source === 'xhh' && xhh?.id === '11b572b24619', JSON.stringify(xhh));
  const detail = parseShareLink('https://www.xiaoheihe.cn/app/bbs/link/194128541');
  ok('小黑盒详情链接也能认', detail?.id === '194128541', JSON.stringify(detail));
  const bili = parseShareLink('https://www.bilibili.com/video/BV1xx411c7mD?spm=333.999');
  ok('B 站视频链接 → BV 号', bili?.source === 'bili' && bili?.id === 'BV1xx411c7mD', JSON.stringify(bili));
  const short = parseShareLink('https://b23.tv/abc123');
  ok('b23 短链：认得域名但没有 id', short?.source === 'bili' && short?.id === '', JSON.stringify(short));
  ok('普通关键词不是链接', parseShareLink('黑神话悟空') === null);
  ok('不相干的网站不认', parseShareLink('https://example.com/a') === null);
  ok('带空格包裹的链接也能抠', parseShareLink('看这个 https://b23.tv/x1 挺好笑') !== null);
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
