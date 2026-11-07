// data/image-cache：消息图片留存（老图能不能看的根治手段）。
// 见 src/image-cache.js 顶部注释：URL 约 1 小时过期、QQ 也会清协议端缓存，
// 所以必须在收到消息时把字节留下来。这里验证"留得下、读得回、超限会淘汰"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 隔离：缓存目录由 config 的 DATA_DIR 决定，而真机上那个目录**正在被机器人使用**。
// 这里把数据目录指到临时目录再 import 模块 —— 避免"跑个测试顺手清掉库存图片/索引"
// 这种最恶心的副作用（DATA_DIR 是在 import config.js 时求值的，所以必须先设环境变量）。
const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'qqa-imgcache-'));
process.env.QQ_AGENT_DATA_DIR = tmpData;

const { updateConfig, getConfig, DATA_DIR } = await import('../src/config.js');
const {
  archiveImage,
  readCachedImage,
  cacheKeyOf,
  imageCacheDir,
  imageCacheStats,
  prune,
  queueImageArchive,
  cleanupOrphans
} = await import('../src/image-cache.js');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail++;
    console.error(`  FAIL ${name}: ${error?.message ?? error}`);
  }
}

const dir = imageCacheDir();
const indexFile = path.join(dir, 'index.json');
const readIndex = () => JSON.parse(fs.readFileSync(indexFile, 'utf8'));

// 每张图都 ≥1KB（低于 MIN_BYTES 的会被刻意忽略），用不同字节保证 sha1 key 不同
const png = (n) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, n)]);

assert.equal(dir, path.join(DATA_DIR, 'image-cache'), '缓存目录必须跟 config 的 DATA_DIR 走（多实例/自定义数据目录）');

await test('开启时：写入后能原样读回，且命中次数被记录', async () => {
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
  assert.equal(getConfig().media.imageCache.enabled, true, '测试前置：配置应已开启');
  const buffer = png(1);
  const dest = archiveImage({ mid: '111', file: 'A.jpg', buffer, chatKey: 'group:1' });
  assert.ok(dest && fs.existsSync(dest), '应当落盘');
  const got = readCachedImage({ mid: '111', file: 'A.jpg' });
  assert.ok(got, '应当读得回');
  assert.equal(Buffer.compare(got.buffer, buffer), 0, '字节必须一致');
  assert.equal(readCachedImage({ mid: '111', file: 'A.jpg' }).buffer.length, buffer.length);
  assert.ok((readIndex().entries[cacheKeyOf({ mid: '111', file: 'A.jpg' })].hits || 0) >= 2, '命中次数应累计');
});

await test('key 由 mid+file 决定：同一消息的多张图不会互相覆盖', async () => {
  const a = png(2);
  const b = png(3);
  archiveImage({ mid: '222', file: 'X.jpg', buffer: a });
  archiveImage({ mid: '222', file: 'Y.jpg', buffer: b });
  assert.equal(Buffer.compare(readCachedImage({ mid: '222', file: 'X.jpg' }).buffer, a), 0);
  assert.equal(Buffer.compare(readCachedImage({ mid: '222', file: 'Y.jpg' }).buffer, b), 0);
  assert.notEqual(cacheKeyOf({ mid: '222', file: 'X.jpg' }), cacheKeyOf({ mid: '222', file: 'Y.jpg' }));
});

await test('关闭时：不再留存新图', async () => {
  updateConfig({ media: { imageCache: { enabled: false } } });
  const dest = archiveImage({ mid: '333', file: 'C.jpg', buffer: png(4) });
  assert.equal(dest, '', '关闭后不该落盘');
  assert.equal(readCachedImage({ mid: '333', file: 'C.jpg' }), null);
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
});

await test('太小的字节不留（占位图/失败图不值得占盘）', async () => {
  const dest = archiveImage({ mid: '444', file: 'tiny.jpg', buffer: Buffer.alloc(100, 7) });
  assert.equal(dest, '');
  assert.equal(readCachedImage({ mid: '444', file: 'tiny.jpg' }), null);
});

await test('超过 15MB 的图不留（与下载路径上限一致）', async () => {
  const dest = archiveImage({ mid: '555', file: 'huge.jpg', buffer: Buffer.alloc(15 * 1024 * 1024 + 1, 9) });
  assert.equal(dest, '');
});

await test('索引有、文件被手删 → 读回 null 并自愈索引', async () => {
  archiveImage({ mid: '666', file: 'D.jpg', buffer: png(5) });
  const key = cacheKeyOf({ mid: '666', file: 'D.jpg' });
  fs.rmSync(path.join(dir, readIndex().entries[key].file), { force: true });
  assert.equal(readCachedImage({ mid: '666', file: 'D.jpg' }), null);
  assert.equal(readIndex().entries[key], undefined, '失效条目应从索引里剔除');
});

test('超限淘汰：优先删"从没被看过"的，且真的从磁盘删掉', () => {
  // 先把配额调到 1MB 并清空，从干净状态开始 —— 淘汰规则要能独立复现，
  // 不能依赖"真机缓存恰好攒了多少"（配额太大时 archiveImage 内部的 prune 根本不触发）。
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 1 } } });
  fs.rmSync(indexFile, { force: true });

  // 造三张（每张 2KB，合计 6KB > 配额）：一张被看过（hits>0），两张没被看过
  archiveImage({ mid: '701', file: 'seen.jpg', buffer: png(11) });
  archiveImage({ mid: '702', file: 'unseen-a.jpg', buffer: png(12) });
  archiveImage({ mid: '703', file: 'unseen-b.jpg', buffer: png(13) });
  const seenKey = cacheKeyOf({ mid: '701', file: 'seen.jpg' });
  assert.ok(readCachedImage({ mid: '701', file: 'seen.jpg' }), '看过的图必须读得回');
  assert.equal(readIndex().entries[seenKey].hits, 1, '命中次数应记为该条目的第 1 次');

  const index = readIndex();
  // 把未被看过的两条时间戳调老，确保淘汰顺序确定
  for (const k of Object.keys(index.entries)) {
    if (k !== seenKey) index.entries[k].ts = 1;
  }
  fs.writeFileSync(indexFile, JSON.stringify(index));

  const before = Object.keys(readIndex().entries).length;
  // 配额压到只能容下一张：淘汰规则必须"留被看过的、删没被看过的"
  const removed = prune(readIndex(), 4096);
  assert.ok(removed >= 1, `超限时必须淘汰（before=${before}）`);
  const after = Object.keys(readIndex().entries);
  assert.ok(after.length < before, '条目应减少');
  assert.ok(after.includes(seenKey), `看过的图应当留到最后（hits 优先）；after=${JSON.stringify(after)}`);
  for (const [key, entry] of Object.entries(readIndex().entries)) {
    assert.ok(fs.existsSync(path.join(dir, entry.file)), `索引里的文件必须真实存在（${key}）`);
  }
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
});

await test('孤儿清理：文件在、索引里没有的会被删掉，正常条目不动', async () => {
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
  const keep = archiveImage({ mid: '901', file: 'keep.jpg', buffer: png(31) });
  // 造两个孤儿：一个文件名像正经条目，一个完全无关（覆盖两类垃圾）
  const orphanA = path.join(dir, 'deadbeefdeadbeefdead.png');
  const orphanB = path.join(dir, 'junk.bin');
  fs.writeFileSync(orphanA, png(32));
  fs.writeFileSync(orphanB, png(33));
  assert.ok([orphanA, orphanB].every((p) => fs.existsSync(p)) && fs.existsSync(keep), '前置：三个文件都应存在');

  const removed = cleanupOrphans();
  assert.ok(removed >= 2, `至少应删掉刚造的两个孤儿，实际 ${removed}`);
  assert.equal(fs.existsSync(orphanA), false, '孤儿 A 应被删');
  assert.equal(fs.existsSync(orphanB), false, '孤儿 B 应被删');
  assert.ok(fs.existsSync(keep), '索引里有记录的文件不能被误删');
  assert.ok(fs.existsSync(indexFile), '索引文件本身不能被当孤儿删掉');
});

await test('统计信息可读（条数/体积/配额）', async () => {
  const stats = imageCacheStats();
  assert.equal(stats.enabled, true);
  assert.ok(stats.count >= 1 && stats.bytes > 0);
  assert.equal(stats.quotaMb, 512);
});

// ⚠️ 这一条会删掉索引文件，所以**必须排在"统计信息"之后**（统计要读索引）
await test('安全阀：索引丢失时不清孤儿（宁可留垃圾，也不能误删整个库存）', async () => {
  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
  archiveImage({ mid: '902', file: 'a.jpg', buffer: png(41) });
  archiveImage({ mid: '903', file: 'b.jpg', buffer: png(42) });
  const files = fs.readdirSync(dir).filter((n) => n !== 'index.json');
  assert.ok(files.length >= 2, '前置：目录里应有多张图');
  fs.rmSync(indexFile, { force: true });          // 模拟索引被删/损坏
  const removed = cleanupOrphans();
  assert.equal(removed, 0, '索引为空时不应删任何图片');
  for (const n of files) assert.ok(fs.existsSync(path.join(dir, n)), `${n} 不该被删`);
});

await test('队列入口：关闭时排队不落盘；开启时异步落盘', async () => {
  updateConfig({ media: { imageCache: { enabled: false } } });
  queueImageArchive(async () => ({ mid: '801', file: 'Q.jpg', buffer: png(21) }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(readCachedImage({ mid: '801', file: 'Q.jpg' }), null);

  updateConfig({ media: { imageCache: { enabled: true, maxMb: 512 } } });
  queueImageArchive(async () => ({ mid: '802', file: 'Q.jpg', buffer: png(22) }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(readCachedImage({ mid: '802', file: 'Q.jpg' }), '开启时应异步落盘');

  // 取字节抛错不能影响别的排队项
  queueImageArchive(async () => { throw new Error('模拟取字节失败'); });
  queueImageArchive(async () => ({ mid: '803', file: 'Q.jpg', buffer: png(23) }));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(readCachedImage({ mid: '803', file: 'Q.jpg' }), '前一个任务抛错后，后面的仍应完成');
});

// 收尾：整个临时数据目录都是本次测试建的，直接删掉（真机目录自始至终没被碰过）
try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch { /* 删不掉不影响结论 */ }

if (fail) {
  console.error(`失败 ${fail} 项，通过 ${pass} 项`);
  process.exit(1);
}
console.log(`全部 ${pass} 项通过`);
