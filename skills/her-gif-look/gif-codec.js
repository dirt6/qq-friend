// GIF 拆帧 / 拼图 —— 纯 JS，零依赖。
// 供两处共用：skills/gif-look/index.js（插件工具）和 tools/gif-look.mjs（命令行）。
//
// 做的事情：解码 GIF（LZW + 帧合成 + 处置方式 + 透明 + 隔行）→ 均匀取 N 帧 →
// 缩放拼成一张 sheet.png。模型读那一张，就能看出动作过程。

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { basename, join } from 'node:path';

// ---------- GIF 解码 ----------
export function decodeGif(buf) {
  if (buf.toString('ascii', 0, 3) !== 'GIF') throw new Error('这个文件不是 GIF');
  const version = buf.toString('ascii', 3, 6);
  let p = 6;
  const width = buf.readUInt16LE(p); p += 2;
  const height = buf.readUInt16LE(p); p += 2;
  const packed = buf[p++];
  const bgIndex = buf[p++];
  p += 1;

  let globalPalette = null;
  if (packed & 0x80) {
    const n = 2 ** ((packed & 0x07) + 1);
    globalPalette = readPalette(buf, p, n);
    p += n * 3;
  }

  const frames = [];
  let gce = { disposal: 0, delay: 0, transparent: -1 };

  const readSubBlocks = () => {
    const chunks = [];
    while (true) {
      const len = buf[p++];
      if (!len) break;
      chunks.push(buf.subarray(p, p + len));
      p += len;
    }
    return Buffer.concat(chunks);
  };

  while (p < buf.length) {
    const block = buf[p++];
    if (block === 0x3b) break;

    if (block === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) {
        const size = buf[p++];
        const flags = buf[p++];
        const delay = buf.readUInt16LE(p); p += 2;
        const tIdx = buf[p++];
        p += 1;
        if (size !== 4) p += size - 4;
        gce = { disposal: (flags >> 2) & 0x07, delay, transparent: flags & 0x01 ? tIdx : -1 };
      } else {
        readSubBlocks();
      }
      continue;
    }

    if (block === 0x2c) {
      const left = buf.readUInt16LE(p); p += 2;
      const top = buf.readUInt16LE(p); p += 2;
      const w = buf.readUInt16LE(p); p += 2;
      const h = buf.readUInt16LE(p); p += 2;
      const ipacked = buf[p++];
      let palette = globalPalette;
      if (ipacked & 0x80) {
        const n = 2 ** ((ipacked & 0x07) + 1);
        palette = readPalette(buf, p, n);
        p += n * 3;
      }
      const interlaced = !!(ipacked & 0x40);
      const minCodeSize = buf[p++];
      const data = readSubBlocks();
      const indices = lzwDecode(minCodeSize, data, w * h);
      frames.push({
        left, top, w, h, interlaced, indices, palette,
        disposal: gce.disposal, delay: gce.delay, transparent: gce.transparent,
      });
      gce = { disposal: 0, delay: 0, transparent: -1 };
      continue;
    }

    break;
  }

  return { version, width, height, bgIndex, globalPalette, frames };
}

function readPalette(buf, offset, n) {
  const pal = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = offset + i * 3;
    pal[i] = [buf[o], buf[o + 1], buf[o + 2]];
  }
  return pal;
}

function lzwDecode(minCodeSize, data, expected) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = [];
  const resetDict = () => {
    dict = [];
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    dict[clearCode] = null;
    dict[endCode] = null;
    codeSize = minCodeSize + 1;
  };
  resetDict();

  const out = new Uint8Array(expected);
  let outPos = 0, bitBuf = 0, bitCount = 0, prev = null, dataPos = 0;

  const readCode = () => {
    while (bitCount < codeSize) {
      if (dataPos >= data.length) return -1;
      bitBuf |= data[dataPos++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuf & ((1 << codeSize) - 1);
    bitBuf >>= codeSize;
    bitCount -= codeSize;
    return code;
  };

  while (outPos < expected) {
    const code = readCode();
    if (code < 0) break;
    if (code === clearCode) { resetDict(); prev = null; continue; }
    if (code === endCode) break;

    let entry;
    if (code < dict.length && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat([prev[0]]);
    else break;

    for (const v of entry) { if (outPos < expected) out[outPos++] = v; }
    if (prev) dict.push(prev.concat([entry[0]]));
    prev = entry;

    if (dict.length === (1 << codeSize) && codeSize < 12) codeSize++;
  }
  return out;
}

// ---------- 帧合成 ----------
export function composeFrames(gif) {
  const { width: W, height: H, frames } = gif;
  let canvas = new Uint8ClampedArray(W * H * 4);
  let snapshot = null;
  let lastDisposal = 0;
  let lastRect = null;
  const out = [];

  for (const f of frames) {
    if (lastDisposal === 2 && lastRect) clearRect(canvas, W, lastRect);
    else if (lastDisposal === 3 && snapshot) canvas = snapshot.slice();
    if (f.disposal === 3) snapshot = canvas.slice();

    const rowOrder = f.interlaced ? interlaceRows(f.h) : null;
    for (let y = 0; y < f.h; y++) {
      const srcY = rowOrder ? rowOrder[y] : y;
      for (let x = 0; x < f.w; x++) {
        const idx = f.indices[srcY * f.w + x];
        if (idx === f.transparent) continue;
        const c = f.palette && f.palette[idx] ? f.palette[idx] : [0, 0, 0];
        const dx = f.left + x, dy = f.top + y;
        if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue;
        const o = (dy * W + dx) * 4;
        canvas[o] = c[0]; canvas[o + 1] = c[1]; canvas[o + 2] = c[2]; canvas[o + 3] = 255;
      }
    }

    out.push({ rgba: canvas.slice(), delay: f.delay });
    lastDisposal = f.disposal;
    lastRect = { left: f.left, top: f.top, w: f.w, h: f.h };
  }
  return out;
}

function clearRect(canvas, W, r) {
  for (let y = r.top; y < r.top + r.h; y++) {
    for (let x = r.left; x < r.left + r.w; x++) {
      const o = (y * W + x) * 4;
      if (o >= 0 && o < canvas.length) { canvas[o] = 0; canvas[o + 1] = 0; canvas[o + 2] = 0; canvas[o + 3] = 0; }
    }
  }
}

function interlaceRows(h) {
  const rows = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) {
    for (let y = start; y < h; y += step) rows.push(y);
  }
  return rows;
}

// ---------- PNG 编码 ----------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

export function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0;
    for (let x = 0; x < width * 4; x++) raw[o++] = rgba[y * width * 4 + x];
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 缩放 / 拼图 ----------
function scaleRGBA(src, sw, sh, dw, dh) {
  const dst = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh));
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw));
      const s = (sy * sw + sx) * 4, d = (y * dw + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
  return dst;
}

export function makeSheet(frames, fw, fh, cell, cols) {
  const rows = Math.ceil(frames.length / cols);
  const gap = 6;
  const W = cols * cell + (cols + 1) * gap;
  const H = rows * cell + (rows + 1) * gap;
  const sheet = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < sheet.length; i += 4) { sheet[i] = 32; sheet[i + 1] = 32; sheet[i + 2] = 36; sheet[i + 3] = 255; }

  const scale = Math.min(cell / fw, cell / fh);
  const dw = Math.max(1, Math.round(fw * scale));
  const dh = Math.max(1, Math.round(fh * scale));

  frames.forEach((f, i) => {
    const cx = gap + (i % cols) * (cell + gap);
    const cy = gap + Math.floor(i / cols) * (cell + gap);
    const ox = cx + Math.floor((cell - dw) / 2);
    const oy = cy + Math.floor((cell - dh) / 2);
    const scaled = scaleRGBA(f.rgba, fw, fh, dw, dh);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        const s = (y * dw + x) * 4;
        if (!scaled[s + 3]) continue;
        const d = ((oy + y) * W + (ox + x)) * 4;
        sheet[d] = scaled[s]; sheet[d + 1] = scaled[s + 1]; sheet[d + 2] = scaled[s + 2]; sheet[d + 3] = 255;
      }
    }
  });
  return { W, H, rgba: sheet };
}

// ---------- 一站式：文件 → 拼图 ----------
/**
 * @param {string} file      gif 路径
 * @param {string} outDir    输出目录
 * @param {object} opt       { frames=6, cell=320, cols=3, saveFrames=false }
 * @returns {{sheet:string, frames:number, size:string, durationMs:number, meta:object}}
 */
export function buildSheet(file, outDir, opt = {}) {
  const frames = Math.max(2, Math.min(24, opt.frames ?? 6));
  const cell = Math.max(64, Math.min(640, opt.cell ?? 320));
  const cols = Math.max(1, Math.min(6, opt.cols ?? 3));

  const buf = readFileSync(file);
  const gif = decodeGif(buf);
  if (!gif.frames.length) throw new Error('一帧都没解出来（可能不是标准 GIF）');
  const composed = composeFrames(gif);

  const total = composed.length;
  const count = Math.min(frames, total);
  const picked = [];
  for (let i = 0; i < count; i++) {
    const idx = count === 1 ? 0 : Math.round((i * (total - 1)) / (count - 1));
    picked.push({ index: idx, ...composed[idx] });
  }

  mkdirSync(outDir, { recursive: true });
  if (opt.saveFrames) {
    picked.forEach((f, i) => {
      writeFileSync(join(outDir, `frame-${String(i + 1).padStart(2, '0')}.png`), encodePNG(gif.width, gif.height, f.rgba));
    });
  }

  const sheet = makeSheet(picked, gif.width, gif.height, cell, cols);
  const sheetPath = join(outDir, 'sheet.png');
  writeFileSync(sheetPath, encodePNG(sheet.W, sheet.H, sheet.rgba));

  const totalDelay = composed.reduce((a, f) => a + f.delay, 0);
  const meta = {
    file: basename(file),
    version: gif.version,
    size: `${gif.width}x${gif.height}`,
    frameCount: total,
    totalDurationMs: totalDelay * 10,
    taken: picked.map((f, i) => ({ n: i + 1, frameIndex: f.index, delayCs: f.delay })),
    sheet: { width: sheet.W, height: sheet.H, cols, cell },
  };
  writeFileSync(join(outDir, 'meta.json'), JSON.stringify(meta, null, 2));

  return { sheet: sheetPath, frames: picked.length, size: meta.size, durationMs: meta.totalDurationMs, meta };
}
