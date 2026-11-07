// 动图识别（GIF）：把一张动图拆成几帧、拼成一张分格图，
// 这样「一次只能看一张静态图」的模型也能看出动作过程。
//
// 设计取舍：
//  - 只读文件、只写 data/gif-frames/ 下的产物，不碰原图、不联网。
//  - 不指定路径时自动取 data/image-cache 里最新的 .gif —— 刚收到的动图就是它。
//  - 只支持 GIF。WebP / APNG / 视频需要别的解码器，遇到时如实报错，不硬编。

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildSheet } from './gif-codec.js';

export function setup(api) {
  const log = api.log ?? (() => {});
  const root = process.cwd();
  const cacheDir = join(root, 'data', 'image-cache');
  const outRoot = join(root, 'data', 'gif-frames');

  function pickLatestGif() {
    if (!existsSync(cacheDir)) return null;
    const cands = readdirSync(cacheDir)
      .filter((f) => /\.gif$/i.test(f))
      .map((f) => ({ f, t: statSync(join(cacheDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    return cands.length ? join(cacheDir, cands[0].f) : null;
  }

  api.registerTool({
    id: 'look_gif',
    name: '看动图',
    description: '把一张 GIF 动图拆成几帧、拼成一张分格图，返回这张图的路径。'
      + '拿到路径后再用 read_image 打开它，就能看出这张动图是怎么动的（谁先动、往哪边、做了什么）。'
      + '什么时候用：对方发来的是动图（.gif），而 read_image 只让你看到一张定格的画面时；'
      + '或者你想知道一张动图的后半段发生了什么。'
      + '不传 path 就是「看刚收到的那张」——会自动取最近一张动图。',
    category: 'utility',
    icon: '🎞️',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'GIF 文件路径。不填 = 自动找 data/image-cache 里最新的 .gif。' },
        frames: { type: 'integer', description: '取几帧，默认 6，范围 2~24。动图很短时可以少取。' },
        cell: { type: 'integer', description: '拼图里每格边长（像素），默认 320。' },
        cols: { type: 'integer', description: '拼图每行几格，默认 3。' },
      },
    },
    async execute(ctx, args) {
      const file = args?.path ? resolve(root, String(args.path)) : pickLatestGif();
      if (!file) return { content: '没找到动图：data/image-cache 里没有任何 .gif。', isError: true };
      if (!existsSync(file)) return { content: `这个文件不存在：${file}`, isError: true };
      if (!/\.gif$/i.test(file)) return { content: '只支持 GIF。WebP/APNG/视频我现在解不了，别硬看。', isError: true };

      try {
        const tag = file.split(/[\\/]/).pop().replace(/\.gif$/i, '').slice(0, 24);
        const outDir = join(outRoot, `${tag}-${Date.now()}`);
        const r = buildSheet(file, outDir, {
          frames: args?.frames ? Number(args.frames) : undefined,
          cell: args?.cell ? Number(args.cell) : undefined,
          cols: args?.cols ? Number(args.cols) : undefined,
        });
        log(`[gif-look] ${file} -> ${r.sheet} (${r.frames} frames, ${r.size})`);
        return {
          content: `拆好了：${r.frames} 帧，原图 ${r.size}，总时长约 ${r.durationMs} 毫秒\n`
            + `拼图路径：${r.sheet}\n`
            + `下一步：用 read_image 打开这个路径，就能看出动作过程。`,
        };
      } catch (e) {
        return { content: `拆帧失败：${String(e?.message ?? e)}`, isError: true };
      }
    },
  });
}
