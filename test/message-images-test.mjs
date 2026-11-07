// get_message_images：老消息图片的取图路径（协议端缓存优先）。
//
// ── 这个测试守的是什么 ────────────────────────────────────────────────────
// 实测（NapCat + QQ 9.9.36）：消息段里的 url 是腾讯 CDN 直链，**约 1 小时就失效**
// （11 小时前的图直接 HTTP 400），而 NapCat 的 get_image 能按 file key 取回已经
// 落盘的原始文件。旧实现只看 media[].url，于是"引用较早消息里的图片"必失败。
// 下面用"必然失败的 url"来固定这条契约：只要缓存这条路还在，工具就还能出图。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 数据目录隔离：下面的 memory_remove 用例会真的建 MemoryStore 并落盘。
// config.js 在加载时就把 DATA_DIR 定死，所以必须先设环境变量、再动态 import
// （静态 import 会被提升，写在后面的赋值来不及生效）。不隔离就会往你真实的
// data/memory/ 里写测试印象。
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-msgimg-'));
process.env.QQ_AGENT_DATA_DIR = tmpData;

const { buildToolDefs } = await import('../src/tools.js');   // 内置工具是惰性注册的，必须先 build
const { getTool } = await import('../src/tool-registry.js');
const { MemoryStore } = await import('../src/memory.js');
const { updateConfig } = await import('../src/config.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL ${name}: ${error?.stack ?? error}`);
  }
}

// 1x1 GIF89a（合法图片字节；按魔法字节会被识别为 image/gif）
const GIF_1PX = Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-msgimg-files-'));
const cachePath = path.join(tmpDir, 'cached-image.gif');
fs.writeFileSync(cachePath, GIF_1PX);

buildToolDefs();
const tool = getTool('get_message_images');
assert.ok(tool, 'get_message_images 必须已注册');

/** 造一个最小 ctx：store 里放一条带媒体的消息，onebot 用假实现。 */
function makeCtx({ media, imageResult }) {
  const entry = { mid: 12345, ts: Date.now(), senderName: '甲', senderId: '10001', text: '[图片]', media };
  const calls = [];
  return {
    calls,
    ctx: {
      chatKey: 'group:1',
      store: {
        findByMid: (chatKey, mid) => (String(mid) === '12345' ? entry : null),
        recent: () => [],
        activeMembers: () => []
      },
      onebot: {
        async call(action, params) {
          calls.push({ action, params });
          if (action !== 'get_image') throw new Error(`未预期的动作 ${action}`);
          return imageResult;
        }
      }
    }
  };
}

const partsOf = (result) => (Array.isArray(result?.content) ? result.content : []);
const imageParts = (result) => partsOf(result).filter((p) => p.type === 'image_url' || p.type === 'video_url');

await test('老消息：直链已失效（HTTP 400）时，仍能从协议端缓存取出图片', async () => {
  const { ctx, calls } = makeCtx({
    // 127.0.0.1:1 是必然连不上的地址：只要实现还在依赖 url，这条用例就会失败。
    media: [{ kind: 'image', file: 'ABC123.jpg', url: 'http://127.0.0.1:1/expired.jpg' }],
    imageResult: { status: 'ok', retcode: 0, data: { file: cachePath, url: 'http://127.0.0.1:1/also-dead.jpg' } }
  });
  const result = await tool.execute(ctx, { messageId: 12345 });
  assert.notEqual(result.isError, true, `不该报错：${JSON.stringify(result.content).slice(0, 200)}`);
  assert.equal(calls.length, 1, '应该调用一次 get_image');
  assert.equal(calls[0].params.file, 'ABC123.jpg', 'get_image 必须收到消息里的 file key');
  const imgs = imageParts(result);
  assert.equal(imgs.length, 1, '应当返回一张图');
  assert.match(String(imgs[0].image_url.url), /^data:image\//, '应当是内联图片数据');
});

await test('回归：只有 file、没有 url 的图片段以前会被当成"没有可查看的图片"', async () => {
  const { ctx } = makeCtx({
    media: [{ kind: 'image', file: 'ABC123.jpg', url: '' }],
    imageResult: { status: 'ok', retcode: 0, data: { file: cachePath } }
  });
  const result = await tool.execute(ctx, { messageId: 12345 });
  assert.notEqual(result.isError, true);
  assert.equal(imageParts(result).length, 1);
});

await test('缓存被清掉（get_image 返回空）时，回落到直链下载', async () => {
  // 该用例的"直链"是本机 HTTP 服务，而 safe-fetch 默认拒绝内网/本机地址（SSRF 防护，
  // 这是对的）。要测的是**回落链路**而不是 SSRF 判定，所以这里显式放开
  // allowPrivateImageHosts —— 真机上正因为 Clash Fake-IP 才需要它（见 config.json）。
  updateConfig({ security: { allowPrivateImageHosts: true } });
  const server = (await import('node:http')).createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(GIF_1PX);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const { ctx } = makeCtx({
      media: [{ kind: 'image', file: 'GONE.jpg', url: `http://127.0.0.1:${port}/pic.gif` }],
      imageResult: { status: 'ok', retcode: 0, data: { file: path.join(tmpDir, 'not-there.gif') } }
    });
    const result = await tool.execute(ctx, { messageId: 12345 });
    assert.notEqual(result.isError, true, `直链可用时不该失败：${JSON.stringify(result.content).slice(0, 200)}`);
    assert.equal(imageParts(result).length, 1);
  } finally {
    await new Promise((r) => server.close(r));
    updateConfig({ security: { allowPrivateImageHosts: false } });
  }
});

await test('缓存与直链都拿不到时，如实报错（不静默返回"没有图片"）', async () => {
  const { ctx } = makeCtx({
    media: [{ kind: 'image', file: 'GONE.jpg', url: 'http://127.0.0.1:1/expired.jpg' }],
    imageResult: { status: 'ok', retcode: 0, data: { file: path.join(tmpDir, 'not-there.gif') } }
  });
  const result = await tool.execute(ctx, { messageId: 12345 });
  assert.equal(result.isError, true);
  assert.match(String(result.content), /图片获取失败/);
});

await test('消息确实没有图片时，返回提示而不是报错', async () => {
  const { ctx } = makeCtx({ media: [{ kind: 'face', faceId: '1' }], imageResult: {} });
  const result = await tool.execute(ctx, { messageId: 12345 });
  assert.notEqual(result.isError, true);
  assert.match(String(result.content), /没有可查看的图片/);
});

// ── memory_remove：清空本会话全部印象 ────────────────────────────────────
// 工具描述承诺"两者都不传 = 清空本会话全部印象"。实现里曾经没有这条分支，
// 静默返回 removed:false、一条都不删（2026-10-12 实测发现并修复）。
await test('memory_remove：只传 category 时真的清空本会话全部印象', async () => {
  const removeTool = getTool('memory_remove');
  assert.ok(removeTool, 'memory_remove 必须已注册');
  const store = new MemoryStore();
  const chatKey = 'group:999';
  await store.append(chatKey, 'memberImpression', '甲爱玩梗', { userId: '111', target: '甲' });
  await store.append(chatKey, 'memberImpression', '乙很安静', { userId: '222', target: '乙' });
  await store.append('group:888', 'memberImpression', '别的群的', { userId: '333', target: '丙' });
  assert.equal(store.query(chatKey).memberImpression.length, 2, '前置：本会话应有 2 条');

  const r = await removeTool.execute({ memory: store, chatKey }, { category: 'memberImpression' });
  assert.match(String(r.content), /"removed":\s*true/, `应报告删除成功：${String(r.content).slice(0, 120)}`);
  assert.equal(store.query(chatKey).memberImpression.length, 0, '本会话印象应清空');
  assert.equal(store.query('group:888').memberImpression.length, 1, '不能连累别的会话');
});

await test('memory_remove：指定 userId 只删那个人，别人保留', async () => {
  const removeTool = getTool('memory_remove');
  const store = new MemoryStore();
  const chatKey = 'group:997';
  await store.append(chatKey, 'memberImpression', '甲的印象', { userId: '111', target: '甲' });
  await store.append(chatKey, 'memberImpression', '乙的印象', { userId: '222', target: '乙' });
  await removeTool.execute({ memory: store, chatKey }, { category: 'memberImpression', userId: '111' });
  const left = store.query(chatKey).memberImpression;
  assert.equal(left.some((e) => String(e.userId) === '111'), false, '甲应被删');
  assert.equal(left.some((e) => String(e.userId) === '222'), true, '乙不该被删');
});

fs.rmSync(tmpDir, { recursive: true, force: true });
fs.rmSync(tmpData, { recursive: true, force: true });

if (fail) {
  console.error(`失败 ${fail} 项，通过 ${pass} 项`);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过`);
