import assert from 'node:assert/strict';
import {
  buildSiteSearchUrl,
  extractImageUrls,
  extractPageDigest,
  parseBingResults,
  sanitizeQuery,
  queryKeywords,
  simplifyQuery
} from '../src/web-search.js';

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL ${name}: ${error.message}`);
  }
}

test('buildSiteSearchUrl 替换模板并编码关键词', () => {
  assert.equal(
    buildSiteSearchUrl('https://example.com/search?q={query}', 'C++ 教程'),
    'https://example.com/search?q=C%2B%2B%20%E6%95%99%E7%A8%8B'
  );
});

test('buildSiteSearchUrl 无占位符时追加 q 参数（保留已有参数）', () => {
  // 当前实现契约：模板无占位符时拼 &q=（已实现且文档化；不是"原样保留"）
  assert.equal(
    buildSiteSearchUrl('https://example.com/search?type=post', 'ignored'),
    'https://example.com/search?type=post&q=ignored'
  );
});

test('buildSiteSearchUrl 裸地址补充 q 参数（URL 编码）', () => {
  assert.equal(buildSiteSearchUrl('https://example.com/search', 'hello world'), 'https://example.com/search?q=hello%20world');
});

test('extractImageUrls 补全相对路径并去重（返回字符串数组）', () => {
  // 当前实现契约：返回绝对 URL 字符串数组（不带 alt；og:image 暂不提取）
  const images = extractImageUrls(`
    <img src="images/a.png" alt="A">
    <img data-src="images/a.png" alt="duplicate">
    <img srcset="/photo.webp 1x, /photo@2x.webp 2x" alt="P">
  `, 'https://example.com/articles/post');
  assert.deepEqual(images, [
    'https://example.com/articles/images/a.png',
    'https://example.com/photo.webp'
  ]);
});

test('extractImageUrls 限制结果数量', () => {
  const images = extractImageUrls('<img src="a.jpg"><img src="b.jpg">', 'https://example.com/', 1);
  assert.equal(images.length, 1);
  assert.equal(images[0], 'https://example.com/a.jpg');
});

test('extractPageDigest 提炼正文（maxChars 有 200 下限，超下限才截断）', () => {
  // 当前实现契约：截断下限 200 字符（Math.max(200, maxChars)），防止把正文截成残句
  const digest = extractPageDigest('<script>ignore()</script><p>第一段正文</p><p>第二段正文</p>', 'https://example.com/', { maxChars: 5 });
  assert.equal(digest.text, '第一段正文 第二段正文');   // 12 字符 < 200 下限，不截断
  assert.equal(digest.images.length, 0);
});

test('sanitizeQuery 清除 CQ 码和控制字符', () => {
  assert.equal(sanitizeQuery('[CQ:image,file=x]  hello\nworld\u0000'), 'hello world');
});

test('simplifyQuery 去除时间与搜索口语', () => {
  assert.equal(simplifyQuery('帮我搜一下 今日 AI 新闻'), 'AI 新闻');
});

test('queryKeywords 提取拉丁词和中文二元词', () => {
  const keywords = queryKeywords('今日 OpenAI 人工智能新闻');
  assert.deepEqual(keywords.latin, ['OpenAI']);
  assert.ok(keywords.bigrams.includes('人工'));
  assert.ok(keywords.bigrams.includes('智能'));
});

// ── Bing 结果解析（parseBingResults） ─────────────────────────────────────
// 真实页面结构取自 cn.bing.com 实测（<li class="b_algo"> + h2>a + b_caption>p），
// 实体也是实测的那几种：&ensp; &#0183; &amp; &middot;

const BING_HTML = [
  '<ol id="b_results">',
  '<li class="b_algo" data-id="1"><h2><a href="https://www.gov.cn/zhengce/content/202511/content_7047090.htm">国务院办公厅关于 2026 年部分节假日安排的通知</a></h2>',
  '<div class="b_caption"><p class="b_lineclamp4">2025年11月4日&ensp;&#0183;&ensp;经国务院批准，现将2026年元旦、春节、清明节放假调休日期安排通知如下&nbsp;……</p></div></li>',
  '<li class="b_algo" data-id="2"><h2><a href="https://example.com/a?x=1&amp;y=2">A &amp; B 对比 &mdash; 站点</a></h2>',
  '<div class="b_caption"><p>第一段 &#x4E2D;&#25991; 与 <strong>加粗</strong> 混排</p>',
  '<p>第二段不该被当成摘要</p></div></li>',
  '<li class="b_algo" data-id="3"><div class="b_algoheader"><h2><a href="https://example.com/c">第三条</a></h2></div>',
  '<div class="b_caption"><p>第三条摘要 &hellip; 结束</p></div></li>',
  '</ol>'
].join('\n');

test('parseBingResults 解析 b_algo 块的标题/链接/摘要', () => {
  const results = parseBingResults(BING_HTML, 6);
  assert.equal(results.length, 3);
  assert.equal(results[0].url, 'https://www.gov.cn/zhengce/content/202511/content_7047090.htm');
  assert.equal(results[0].title, '国务院办公厅关于 2026 年部分节假日安排的通知');
  assert.ok(results[0].snippet.includes('经国务院批准'));
});

test('parseBingResults 解掉 &ensp;/&#0183; 等实体，摘要里不留字面量', () => {
  const results = parseBingResults(BING_HTML, 6);
  for (const r of results) {
    assert.doesNotMatch(r.title + r.snippet, /&[a-z]+;|&#\d+;|&#x[0-9a-f]+;/i, `残留实体：${r.title} / ${r.snippet}`);
  }
  // &ensp; 与 &#0183;（·）都要还原成可读字符
  assert.ok(results[0].snippet.includes('·'), `中间点未还原：${results[0].snippet}`);
  assert.ok(results[0].snippet.includes('2025年11月4日 · 经国务院批准'), `空白实体未处理：${results[0].snippet}`);
});

test('parseBingResults 只取第一段 <p> 作摘要（不吞后续段落）', () => {
  const results = parseBingResults(BING_HTML, 6);
  assert.equal(results[1].snippet, '第一段 中文 与 加粗 混排');
  assert.doesNotMatch(results[1].snippet, /第二段/);
});

test('parseBingResults 在属性里解 &amp;，标题保留原字符', () => {
  const results = parseBingResults(BING_HTML, 6);
  assert.equal(results[1].url, 'https://example.com/a?x=1&y=2');
  assert.equal(results[1].title, 'A & B 对比 — 站点');
});

test('parseBingResults 遵守 maxResults 上限', () => {
  assert.equal(parseBingResults(BING_HTML, 2).length, 2);
  assert.equal(parseBingResults(BING_HTML, 0).length, 1);   // 0 → 至少 1（Math.max(1, …) 语义在调用方，这里按上限截断）
});

test('parseBingResults 对空/畸形输入返回空数组而不抛错', () => {
  assert.deepEqual(parseBingResults('', 6), []);
  assert.deepEqual(parseBingResults(null, 6), []);
  assert.deepEqual(parseBingResults('<li class="b_algo"没有链接或标题</li>', 6), []);
});

if (fail) {
  console.error(`失败 ${fail} 项，通过 ${pass} 项`);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过`);
