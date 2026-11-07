// 自主活动（plugins/autonomous）的单元测试
//
// 锁住四件事：
//   ① token 估算与裁剪：先减候选、再压摘要、裁不动就整轮跳过（绝不能把超限请求发出去）
//   ② 来源解析：排行榜/热门 JSON 归一化、去重键、失败分类（401/403/429/登录墙）
//   ③ 模型决策：宽松 JSON 解析 + 白名单校验（越界一律降级成安全动作）
//   ④ 日记：格式与现有 diary 技能一致、与最近两天去重
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { estimateText, estimateMessages, fitToBudget, promptTokensOf, recordCalibration } from '../plugins/autonomous/lib/budget.js';
import { parseRanking, parsePopular, normalizeBili, contentKeyOf, classifyHttpFailure, resolveSources, isSafeCandidate, stripSearchHtml, normalizeSearchItem, parseSearch, searchBili, resetSearchThrottle } from '../plugins/autonomous/lib/sources.js';
import { makeBuilder, parseDecision, validateDecision } from '../plugins/autonomous/lib/planner.js';

// 2026-11-04 事故修复：本测试只传了临时日记 root，但 appendDiaryLine 还会写
// DATA_DIR 下的 pending/idem。必须在**导入插件前**把 DATA_DIR 指向临时目录，
// 否则会污染生产 pending/idem。用动态 import 保证 env 先生效。
const ISOLATED_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-data-'));
process.env.QQ_AGENT_DATA_DIR = ISOLATED_DATA_DIR;
const { inQuietRange, appendDiaryLine, readRecentDiary, isDuplicateDiary } = await import('../plugins/autonomous/index.js');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` -> ${extra}` : ''}`); }
};

/* ── 一、token 估算与裁剪 ─────────────────────────────────────────────── */
console.log('=== 一、token 估算与裁剪 ===');
{
  ok('空文本 = 0', estimateText('') === 0);
  const cn = estimateText('这是一段中文测试文字'.repeat(10));   // 100 字
  ok('100 个汉字 → 90~110 tokens', cn >= 90 && cn <= 110, `实际 ${cn}`);
  const en = estimateText('abcdefghij'.repeat(10));             // 100 字符
  ok('100 个英文字符 → 30~45 tokens', en >= 30 && en <= 45, `实际 ${en}`);
  ok('messages 比单条文本多（含 role 开销）',
    estimateMessages([{ role: 'system', content: '你好' }]) > estimateText('你好'));
  ok('usage 取 prompt_tokens', promptTokensOf({ prompt_tokens: 321 }) === 321);
  ok('usage 兼容 input_tokens', promptTokensOf({ input_tokens: 99, prompt_tokens: 0 }) === 99);
}

{
  const candidates = Array.from({ length: 10 }, (_, i) => ({
    title: `候选标题第 ${i + 1} 条`, summary: '摘要'.repeat(60), url: `https://example.com/${i}`, tags: ['测试']
  }));
  const build = makeBuilder({ candidates, personaSnippet: '测试人设片段'.repeat(10), state: {} });

  const loose = fitToBudget({ limit: 20000, build, candidates });
  ok('预算充足 → 全量候选', loose.ok && loose.plan.candidates === 10, JSON.stringify(loose.plan));

  const tight = fitToBudget({ limit: 900, build, candidates });
  ok('预算紧张 → 仍能给出方案', tight.ok === true);
  ok('预算紧张 → 候选数下降', tight.ok && tight.plan.candidates < 10, JSON.stringify(tight.plan));
  ok('预算紧张 → 结果确实在限内', tight.ok && tight.tokens <= 900, `${tight.tokens}`);

  const impossible = fitToBudget({ limit: 120, build, candidates });
  ok('压到最少仍超 → 整轮跳过（ok:false）', impossible.ok === false, JSON.stringify(impossible));
  ok('跳过时给出原因', Boolean(impossible.reason));

  // 安全规则/任务说明永远在 system 里，不参与裁剪
  const msgs = build(1, 0);
  ok('裁剪后 system 规则仍在', msgs[0].role === 'system' && msgs[0].content.includes('规则'));
}

{
  const st = { calibration: 1, calibrationSamples: [] };
  recordCalibration(st, 1000, 800);
  ok('校准系数被记录', st.calibration > 0 && st.calibration < 1, `${st.calibration}`);
  recordCalibration(st, 1000, 1000);
  ok('样本累积不超过 20', st.calibrationSamples.length <= 20);
}

/* ── 二、来源解析 ─────────────────────────────────────────────────────── */
console.log('\n=== 二、来源解析 ===');
{
  const rankJson = {
    code: 0,
    data: {
      list: [
        { bvid: 'BV1aa411c7dd', aid: 1, title: '第一个视频', tname: '数码', desc: '这是简介', stat: { view: 123456 }, pubdate: 1700000000 },
        { bvid: '', aid: 99, title: '第二个视频', tname: '游戏', desc: '', stat: { view: 0 }, pubdate: 0 },
        { bvid: 'BV1bb411c7ee', title: '', tname: '生活' }
      ]
    }
  };
  const r = parseRanking(rankJson);
  ok('ranking 解析成功', r.ok === true);
  ok('缺标题的条目被丢掉', r.ok && r.items.length === 2, `${r.items?.length}`);
  ok('bvid 归一成完整链接', r.ok && r.items[0].url === 'https://www.bilibili.com/video/BV1aa411c7dd');
  ok('分区进 tags', r.ok && r.items[0].tags[0] === '数码');
  ok('摘要被截短（不超过 160）', r.ok && r.items[0].summary.length <= 160);
  ok('播放量保留', r.ok && r.items[0].stats.view === 123456);

  ok('code 非 0 → 失败', parseRanking({ code: -412, message: '风控' }).ok === false);
  ok('缺 data.list → 失败', parseRanking({ code: 0, data: {} }).ok === false);
  ok('popular 解析成功', parsePopular({ code: 0, data: { list: [{ bvid: 'BV1x', title: '热门' }] } }).ok === true);
  ok('popular 空列表 → ok 但 0 条', (() => { const x = parsePopular({ code: 0, data: { list: [] } }); return x.ok && x.items.length === 0; })());
}

{
  ok('BV 链接抽出稳定键', contentKeyOf({ url: 'https://www.bilibili.com/video/BV1aa411c7dd?spm=1' }) === 'bili:BV1aa411c7dd');
  ok('av 链接抽出稳定键', contentKeyOf({ url: 'https://www.bilibili.com/video/av12345' }) === 'bili:av12345');
  ok('带 contentId 时优先用它', contentKeyOf({ source: 'bili', contentId: 'BVx' }) === 'bili:BVx');
  ok('缺字段不崩', typeof contentKeyOf({}) === 'string');
}

{
  ok('403 判失败', Boolean(classifyHttpFailure(403, '')));
  ok('429 判失败', Boolean(classifyHttpFailure(429, '')));
  ok('401 判失败', Boolean(classifyHttpFailure(401, '')));
  ok('登录墙识别', classifyHttpFailure(200, '请先登录后查看') === '登录墙');
  ok('验证码页识别', Boolean(classifyHttpFailure(200, '<div>人机验证</div>')));
  ok('正常页面不算失败', classifyHttpFailure(200, '{"code":0}') === '');
}

{
  const r = resolveSources('bili, xiaoheihe, unknown-x');
  ok('已知来源被解析', r.sources.map((s) => s.id).join(',') === 'bili,xiaoheihe');
  ok('未知来源单独列出', r.unknown.includes('unknown-x'));
  ok('小黑盒带不可用原因', Boolean(resolveSources('xiaoheihe').sources[0].unavailableReason));
  ok('安全过滤：命中敏感词被拦', isSafeCandidate({ title: '某赌博网站推广', summary: '' }) === false);
  ok('安全过滤：正常内容放行', isSafeCandidate({ title: '用鱼缸改的路由器', summary: '挺有意思' }) === true);
  ok('安全过滤：摘要里出现也拦', isSafeCandidate({ title: '正常标题', summary: '涉及色情内容' }) === false);
}

/* ── 二·五、B 站搜索 ──────────────────────────────────────────────────── */
console.log('\n=== 二·五、B 站搜索 ===');
{
  ok('去 em 高亮标签', stripSearchHtml('【<em class="keyword">钓鱼</em>焚诀】教你速升') === '【钓鱼焚诀】教你速升');
  ok('解 HTML 实体', stripSearchHtml('&quot;你好&quot; &amp; 再见') === '"你好" & 再见');
  ok('去多余空白', stripSearchHtml('  a \n  b  ') === 'a b');
  ok('空值不崩', stripSearchHtml(undefined) === '');

  const raw = {
    bvid: 'BV1xx411c7mD',
    title: '【<em class="keyword">钓鱼</em>】三天速成',
    description: '教你怎么<b>钓</b>',
    author: '某UP',
    play: 123456,
    pubdate: 1700000000,
    tag: '钓鱼 教学 生活'
  };
  const it = normalizeSearchItem(raw);
  ok('搜索结果归一化', it && it.url === 'https://www.bilibili.com/video/BV1xx411c7mD');
  ok('标题已清洗', it.title === '【钓鱼】三天速成', it.title);
  ok('摘要已清洗', it.summary === '教你怎么钓', it.summary);
  ok('tag 拆成数组且最多 3 个', it.tags.length === 3 && it.tags[0] === '钓鱼');
  ok('播放量保留', it.stats.view === 123456);
  ok('source 标记为搜索', it.source === 'bili-search');
  ok('缺 bvid 丢弃', normalizeSearchItem({ title: '无号' }) === null);
  ok('标题清洗后为空则丢弃', normalizeSearchItem({ bvid: 'BV1', title: '<em></em>' }) === null);

  ok('parseSearch 正常', parseSearch({ code: 0, data: { result: [raw] } }).ok === true);
  ok('parseSearch code!=0', parseSearch({ code: -412, message: '风控' }).ok === false);
  ok('parseSearch 缺 result', parseSearch({ code: 0, data: {} }).ok === false);
  ok('parseSearch 空结果', (() => { const r = parseSearch({ code: 0, data: { result: [] } }); return r.ok && r.items.length === 0; })());
}

{
  // 用假 fetch 验证 searchBili 的成功/失败分支（不打网络）
  const mkFetch = (payload, status = 200) => async () => ({
    status,
    ok: status < 400,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload))
  });
  const good = { code: 0, data: { result: [{ bvid: 'BV1a', title: '结果一', play: 1000 }, { bvid: 'BV1b', title: '结果二', play: 2000 }] } };

  resetSearchThrottle();
  const okRes = await searchBili(mkFetch(good), '钓鱼');
  ok('搜索成功返回条目', okRes.ok && okRes.items.length === 2);
  ok('结果带关键词', okRes.keyword === '钓鱼');
  resetSearchThrottle();
  ok('limit 生效', (await searchBili(mkFetch(good), '钓鱼', { limit: 1 })).items.length === 1);

  resetSearchThrottle();
  const kwEmpty = await searchBili(mkFetch(good), '   ');
  ok('空关键词直接拒绝', kwEmpty.ok === false && kwEmpty.error === '关键词为空');

  resetSearchThrottle();
  const forbidden = await searchBili(mkFetch({ code: -412, message: 'request was banned' }), '钓鱼');
  ok('code=-412 判失败并标记 banned', forbidden.ok === false && forbidden.banned === true);
  // 冷却期内再搜：不发请求、直接拒绝
  const afterBan = await searchBili(mkFetch(good), '钓鱼');
  ok('冷却期内第二次搜索被直接拦住', afterBan.ok === false && afterBan.banned === true);
  resetSearchThrottle();

  const http403 = await searchBili(mkFetch('<html>403</html>', 403), '钓鱼');
  ok('HTTP 403 判失败且带原因', http403.ok === false && http403.error.includes('403'));

  resetSearchThrottle();
  const badJson = await searchBili(mkFetch('not json at all'), '钓鱼');
  ok('非 JSON 判失败', badJson.ok === false);

  resetSearchThrottle();
  const unsafe = { code: 0, data: { result: [{ bvid: 'BV1c', title: '某赌博平台推广' }] } };
  ok('全被安全过滤 → 失败并说明', (await searchBili(mkFetch(unsafe), '赌')).ok === false);

  resetSearchThrottle();
  const empty = { code: 0, data: { result: [] } };
  ok('无结果明确报出来', (await searchBili(mkFetch(empty), '不存在的词')).error === '搜索无结果');
  resetSearchThrottle();
}

/* ── 三、模型决策 ─────────────────────────────────────────────────────── */
console.log('\n=== 三、模型决策 ===');
{
  ok('纯 JSON', parseDecision('{"pick":2,"action":"share","message":"hi"}').ok === true);
  ok('代码块包裹', parseDecision('```json\n{"pick":3}\n```').ok === true);
  ok('前后有废话也能抠出来', parseDecision('好的，我选这个：{"pick":4,"action":"diary"} 就这样').decision.pick === 4);
  ok('非 JSON → 失败', parseDecision('我不知道').ok === false);
  ok('空串 → 失败', parseDecision('').ok === false);
}

{
  const d = validateDecision({ pick: 99, action: 'share', message: '看这个' }, 5);
  ok('pick 越界被夹到范围内', d.pick === 5);
  ok('非法 action 降级为 explore', validateDecision({ pick: 1, action: 'delete_everything' }, 3).action === 'explore');
  ok('share 但没给话 → 降级 explore', validateDecision({ pick: 1, action: 'share', message: '' }, 3).action === 'explore');
  ok('chat 有内容 → 保留', validateDecision({ pick: 1, action: 'chat', message: '想起你昨天说的' }, 3).action === 'chat');
  ok('chat 没内容 → 降级 explore', validateDecision({ pick: 1, action: 'chat', message: '' }, 3).action === 'explore');
  ok('合法 share 保留', validateDecision({ pick: 1, action: 'share', message: '嗯' }, 3).action === 'share');
  ok('message 过长被截断', validateDecision({ pick: 1, action: 'share', message: 'x'.repeat(500) }, 3).message.length <= 300);
}

/* ── 四、安静时段 ─────────────────────────────────────────────────────── */
console.log('\n=== 四、安静时段 ===');
{
  const at = (h, m) => new Date(2026, 9, 20, h, m, 0).getTime();
  ok('23:45 落在 23:30-08:00 内', inQuietRange(at(23, 45), '23:30-08:00') === true);
  ok('02:00 落在跨零点区间内', inQuietRange(at(2, 0), '23:30-08:00') === true);
  ok('12:00 不在区间内', inQuietRange(at(12, 0), '23:30-08:00') === false);
  ok('留空 = 不设', inQuietRange(at(3, 0), '') === false);
  ok('同日区间也认（09:00-12:00）', inQuietRange(at(10, 0), '09:00-12:00') === true);
  ok('格式错误不崩', inQuietRange(at(10, 0), '随便写') === false);
}

/* ── 五、日记 ─────────────────────────────────────────────────────────── */
console.log('\n=== 五、日记 ===');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-diary-'));
  const r1 = appendDiaryLine({ content: '看到一个用鱼缸改的路由器', mood: '好奇', day: '2026-10-20', root });
  ok('写入成功', r1.ok === true, r1.reason);
  const file = path.join(root, '每日', '2026-10-20.md');
  ok('文件落在 每日/ 下', fs.existsSync(file));
  let text = fs.readFileSync(file, 'utf8');
  ok('标题格式正确', text.startsWith('# 2026-10-20 周二'), text.slice(0, 40));
  ok('有 ## 记录 小节', text.includes('## 记录'));
  ok('条目格式与 diary 技能一致', text.includes('- 心情：好奇｜看到一个用鱼缸改的路由器'));

  const r2 = appendDiaryLine({ content: '又看到一只会按按钮的猫', mood: '想笑', day: '2026-10-20', root });
  ok('第二条也写成功', r2.ok === true);
  text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n').filter((l) => l.startsWith('- 心情：'));
  ok('两条都在 ## 记录 下面', lines.length === 2 && text.indexOf(lines[1]) > text.indexOf('## 记录'));

  const recent = readRecentDiary(2, root, new Date(2026, 9, 20, 12).getTime());
  ok('readRecentDiary 能读回今天', recent.some((x) => x.day === '2026-10-20'));

  ok('前 12 字相同算重复', isDuplicateDiary('看到一个用鱼缸改的路由器，真会玩', recent) === true);
  ok('完全不同不算重复', isDuplicateDiary('今天在楼下闻到桂花香', recent) === false);
  ok('空内容当重复处理（不写）', isDuplicateDiary('', recent) === true);

  // 不存在的日期文件不该抛
  ok('读不存在的日子不崩', readRecentDiary(2, root, new Date(2020, 0, 1).getTime()).length === 0);

  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail ? '✗ 失败' : '✓ 全部通过'}：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
