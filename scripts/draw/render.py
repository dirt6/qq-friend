#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把一份 JSON 场景画成 PNG —— 她的画笔。

为什么要有它：她没有出图模型（整台机器只有一个 DeepSeek 文本 key，也没有
ComfyUI / SD），所以「画画」不能靠文生图，只能靠**图元拼 + 风格化**。模型
给出「圆、椭圆、三角、文字」这些几何指令，这里先画出来，再按 style 上一层
手绘感——不然出来的就是干净的 CAD 图，不像她画的。

设计取舍：
  · 坐标一律用**逻辑像素**（场景里写的 900x600 就是 900x600），内部按
    SUPERSAMPLE 倍放大绘制再缩小 —— 否则圆和斜线全是锯齿。
  · 输入走 **stdin（UTF-8）**，不走命令行参数：Windows 的 cmd 用 GBK 解析参数，
    中文和 emoji 会整段丢（QQ Agent 的网关就踩过这个坑，见 dsh-gateway.js 注释）。
  · 半透明/旋转的图形画在独立图层再合成，否则 ImageDraw 会**直接替换**像素，
    半透明色变成实色、下面的东西被盖掉。
  · **文字永远不参与风格化**：抖动和纸纹会让字变糊。图形先画、文字最后盖。
  · 字体只认这台机器上确实存在的几个（微软雅黑 / 黑体 / 宋体），找不到就退回
    Pillow 默认字体 —— 宁可字丑，也不要整张图画不出来。

用法：
    python render.py --out E:\\dsh\\QQ-agent\\data\\drawings\\x.png  < scene.json

stdout 输出一行 JSON：{"ok":true,"path":"...","width":900,"height":600,"shapes":12,"style":"crayon"}
"""

import argparse
import hashlib
import json
import math
import os
import random
import sys
import traceback

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

# 放大倍数。3 倍足够把 900x600 画到 2700x1800，再 LANCZOS 缩回来，边缘干净。
SUPERSAMPLE = 3

MAX_SIDE = 2000          # 逻辑边长上限，防止模型传个 99999 把内存打爆
MAX_SHAPES = 400         # 图形数量上限
DEFAULT_W, DEFAULT_H = 900, 600

# 画风。flat 是干净扁平；其余三种都带手绘感，只是脏的程度和方向不同。
STYLES = {
    'flat':        '干净扁平，大色块，适合示意图',
    'crayon':      '蜡笔/手绘：线条抖、纸张颗粒、整体轻微歪',
    'picturebook': '绘本：柔和边缘、颜色更暖更饱和、纸纹',
    'pixel':       '像素画：缩成小块再放大',
}
DEFAULT_STYLE = 'crayon'

# 只列这台机器上真实存在的字体，不猜。
FONT_DIR = os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts')
FONTS = {
    ('sans', False): os.path.join(FONT_DIR, 'msyh.ttc'),      # 微软雅黑
    ('sans', True): os.path.join(FONT_DIR, 'msyhbd.ttc'),     # 微软雅黑 Bold
    ('hei', False): os.path.join(FONT_DIR, 'simhei.ttf'),     # 黑体
    ('hei', True): os.path.join(FONT_DIR, 'simhei.ttf'),
    ('song', False): os.path.join(FONT_DIR, 'simsun.ttc'),    # 宋体
    ('song', True): os.path.join(FONT_DIR, 'simsun.ttc'),
    ('mono', False): os.path.join(FONT_DIR, 'consola.ttf'),   # Consolas（无中文）
    ('mono', True): os.path.join(FONT_DIR, 'consola.ttf'),
}

NAMED = {'transparent': (0, 0, 0, 0), 'none': (0, 0, 0, 0)}


def parse_color(value, default=(0, 0, 0, 255)):
    """把 '#rgb' / '#rrggbb' / '#rrggbbaa' / [r,g,b(,a)] / 'red' 统一成 RGBA 四元组。"""
    if value is None:
        return default
    if isinstance(value, (list, tuple)):
        nums = []
        for v in value[:4]:
            try:
                nums.append(max(0, min(255, int(round(float(v))))))
            except (TypeError, ValueError):
                nums.append(0)
        while len(nums) < 3:
            nums.append(0)
        if len(nums) == 3:
            nums.append(255)
        return tuple(nums)
    text = str(value).strip().lower()
    if not text:
        return default
    if text in NAMED:
        return NAMED[text]
    if text.startswith('#'):
        h = text[1:].strip()
        if len(h) == 3:
            h = ''.join(c * 2 for c in h)
        try:
            if len(h) == 6:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255)
            if len(h) == 8:
                return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16))
        except ValueError:
            return default
        return default
    try:
        from PIL import ImageColor
        r, g, b = ImageColor.getrgb(text)
        return (r, g, b, 255)
    except Exception:
        return default


def num(value, default=0.0):
    try:
        f = float(value)
    except (TypeError, ValueError):
        return default
    if math.isnan(f) or math.isinf(f):
        return default
    return f


def normalize_style(value):
    s = str(value or '').strip().lower()
    if s in ('', 'auto', 'default', 'her', 'hers'):
        return DEFAULT_STYLE
    if s in STYLES:
        return s
    # 常见别名，模型容易写别的词
    alias = {
        'hand': 'crayon', 'handdrawn': 'crayon', 'sketch': 'crayon', 'crayon': 'crayon',
        'chalk': 'crayon', 'crayons': 'crayon', 'oil': 'crayon',
        'book': 'picturebook', 'watercolor': 'picturebook', 'story': 'picturebook',
        'warm': 'picturebook', 'gouache': 'picturebook',
        'bit': 'pixel', '8bit': 'pixel', 'pixelart': 'pixel',
        'clean': 'flat', 'simple': 'flat', 'vector': 'flat', 'minimal': 'flat',
    }
    return alias.get(s, DEFAULT_STYLE)


def load_font(size, family='sans', bold=False):
    """按 (字族, 粗细) 找字体；找不到逐级降级，最后退 Pillow 内置字体。"""
    family = str(family or 'sans').strip().lower()
    if family in ('微软雅黑', 'yahei', 'microsoftyahei', 'sans-serif', 'default'):
        family = 'sans'
    candidates = [(family, bool(bold)), (family, False), ('sans', bool(bold)), ('sans', False)]
    seen = set()
    for key in candidates:
        if key in seen:
            continue
        seen.add(key)
        path = FONTS.get(key)
        if not path or not os.path.exists(path):
            continue
        try:
            return ImageFont.truetype(path, max(1, int(size)))
        except Exception:
            continue
    try:
        return ImageFont.load_default(size=max(1, int(size)))
    except TypeError:      # 老版本 Pillow 的 load_default 不收 size
        return ImageFont.load_default()


def background_layer(width, height, spec):
    """背景：纯色或线性渐变。渐变用 1xN 的条带拉伸，比逐像素快两个数量级。"""
    if isinstance(spec, dict) and str(spec.get('type', '')).lower() in ('linear', 'gradient'):
        c1 = parse_color(spec.get('from', spec.get('start')), (255, 255, 255, 255))
        c2 = parse_color(spec.get('to', spec.get('end')), c1)
        angle = num(spec.get('angle'), 90)
        if abs(angle % 180) < 45:      # 横向
            strip = Image.new('RGBA', (256, 1))
            for x in range(256):
                t = x / 255.0
                strip.putpixel((x, 0), tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4)))
            return strip.resize((width, height), Image.BILINEAR)
        strip = Image.new('RGBA', (1, 256))
        for y in range(256):
            t = y / 255.0
            strip.putpixel((0, y), tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(4)))
        return strip.resize((width, height), Image.BILINEAR)
    if isinstance(spec, str) and spec.strip().startswith('gradient:'):
        parts = spec.split(':')
        if len(parts) >= 3:
            return background_layer(width, height, {
                'type': 'linear', 'from': parts[1], 'to': parts[2], 'angle': 90
            })
    return Image.new('RGBA', (width, height), parse_color(spec, (255, 255, 255, 255)))


def points_of(shape, scale):
    raw = shape.get('points')
    if not isinstance(raw, list):
        return []
    out = []
    for p in raw:
        if isinstance(p, (list, tuple)) and len(p) >= 2:
            out.append((num(p[0]) * scale, num(p[1]) * scale))
        elif isinstance(p, dict):
            out.append((num(p.get('x')) * scale, num(p.get('y')) * scale))
    return out


def bbox_of(shape, scale, pad):
    """估算图形占用的矩形，用来给半透明/旋转图层开画布。估大一点总没错。"""
    kind = str(shape.get('type', '')).lower()
    xs, ys = [], []
    if kind in ('line', 'polyline', 'polygon', 'triangle', 'path'):
        for x, y in points_of(shape, scale):
            xs.append(x)
            ys.append(y)
    elif kind in ('circle', 'ellipse'):
        cx, cy = num(shape.get('cx')) * scale, num(shape.get('cy')) * scale
        if kind == 'circle':
            rx = ry = num(shape.get('r')) * scale
        else:
            rx, ry = num(shape.get('rx')) * scale, num(shape.get('ry')) * scale
        xs += [cx - rx, cx + rx]
        ys += [cy - ry, cy + ry]
    elif kind == 'arc':
        cx, cy = num(shape.get('cx')) * scale, num(shape.get('cy')) * scale
        rx = num(shape.get('rx'), num(shape.get('r'))) * scale
        ry = num(shape.get('ry'), num(shape.get('r'))) * scale
        xs += [cx - rx, cx + rx]
        ys += [cy - ry, cy + ry]
    elif kind == 'text':
        x, y = num(shape.get('x')) * scale, num(shape.get('y')) * scale
        size = num(shape.get('size'), 24) * scale
        lines = str(shape.get('text', '')).split('\n')
        w = max(1, int(size * 0.62 * max((len(ln) for ln in lines), default=1)))
        h = max(1, int(size * 1.5 * max(1, len(lines))))
        xs += [x - pad, x + w + pad]
        ys += [y - pad, y + h + pad]
    else:   # rect / roundrect
        x, y = num(shape.get('x')) * scale, num(shape.get('y')) * scale
        w, h = num(shape.get('w')) * scale, num(shape.get('h')) * scale
        xs += [x, x + w]
        ys += [y, y + h]
    if not xs or not ys:
        return None
    return (min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad)


def paint(draw, shape, scale):
    """把单个图形画到 draw 上。返回 False 表示这个图形看不懂、跳过。"""
    kind = str(shape.get('type', '')).lower().strip()
    fill = parse_color(shape.get('fill'), (0, 0, 0, 0))
    stroke = parse_color(shape.get('stroke', shape.get('outline')), (0, 0, 0, 0))
    width = max(0, int(round(num(shape.get('strokeWidth', shape.get('lineWidth')), 0) * scale)))
    has_fill = bool(shape.get('fill')) and fill[3] > 0
    has_stroke = width > 0 and stroke[3] > 0

    def f():
        return fill if has_fill else None

    def s():
        return stroke if has_stroke else None

    if kind in ('rect', 'rectangle', 'roundrect', 'rounded_rect'):
        x, y = num(shape.get('x')) * scale, num(shape.get('y')) * scale
        w, h = num(shape.get('w')) * scale, num(shape.get('h')) * scale
        radius = num(shape.get('radius', shape.get('r')), 0) * scale
        box = [x, y, x + w, y + h]
        if radius > 0:
            draw.rounded_rectangle(box, radius=radius, fill=f(), outline=s(), width=width or 1)
        else:
            draw.rectangle(box, fill=f(), outline=s(), width=width or 1)
        return True

    if kind in ('circle', 'ellipse'):
        cx, cy = num(shape.get('cx')) * scale, num(shape.get('cy')) * scale
        if kind == 'circle':
            rx = ry = num(shape.get('r')) * scale
        else:
            rx, ry = num(shape.get('rx')) * scale, num(shape.get('ry')) * scale
        draw.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=f(), outline=s(), width=width or 1)
        return True

    if kind in ('polygon', 'triangle'):
        pts = points_of(shape, scale)
        if len(pts) < 3:
            return False
        draw.polygon(pts, fill=f())
        if has_stroke:
            draw.line(pts + [pts[0]], fill=stroke, width=width, joint='curve')
        return True

    if kind in ('line', 'polyline', 'path'):
        pts = points_of(shape, scale)
        if len(pts) < 2:
            return False
        if not has_stroke:
            stroke, width = fill, max(1, width)
        draw.line(pts, fill=stroke, width=width, joint='curve')
        r = max(1, width // 2)          # 圆头端点，方头在小尺寸下很生硬
        for x, y in (pts[0], pts[-1]):
            draw.ellipse([x - r, y - r, x + r, y + r], fill=stroke)
        return True

    if kind == 'arc':
        cx, cy = num(shape.get('cx')) * scale, num(shape.get('cy')) * scale
        rx = num(shape.get('rx'), num(shape.get('r'))) * scale
        ry = num(shape.get('ry'), num(shape.get('r'))) * scale
        draw.arc([cx - rx, cy - ry, cx + rx, cy + ry],
                 num(shape.get('start'), 0), num(shape.get('end'), 180),
                 fill=stroke if has_stroke else fill, width=max(1, width))
        return True

    if kind == 'text':
        raw = shape.get('text')
        text = '' if raw is None else str(raw)
        if not text.strip():
            return False
        x, y = num(shape.get('x')) * scale, num(shape.get('y')) * scale
        size = num(shape.get('size'), 24) * scale
        font = load_font(size, shape.get('font', 'sans'), bool(shape.get('bold')))
        color = fill if has_fill else (255, 255, 255, 255)
        anchor = str(shape.get('anchor', 'lt')).lower()
        spacing = int(num(shape.get('lineSpacing', shape.get('spacing')), size * 0.32))
        align = str(shape.get('align', 'left')).lower()
        if align not in ('left', 'center', 'right'):
            align = 'left'
        try:
            draw.multiline_text((x, y), text, font=font, fill=color,
                                anchor=anchor, spacing=spacing, align=align)
        except Exception:
            # 某些 anchor + 多行组合 Pillow 会拒绝，退回左上角最保守的画法
            draw.multiline_text((x, y), text, font=font, fill=color, spacing=spacing, align=align)
        return True

    return False


# ── 手绘化 ────────────────────────────────────────────────────────────────

def jitter_shape(shape, rng, scale, amount):
    """给几何一点点手抖。这是「看起来像人画的」最有效的一步。

    只抖图形，不抖文字；抖动量按逻辑像素给，乘 scale 之后在放大图上一致。
    """
    out = dict(shape)
    kind = str(out.get('type', '')).lower()
    amp = amount * scale
    if amp <= 0:
        return out
    if kind in ('line', 'polyline', 'path', 'polygon', 'triangle'):
        pts = []
        for p in out.get('points') or []:
            if isinstance(p, (list, tuple)) and len(p) >= 2:
                pts.append([num(p[0]) + rng.uniform(-amp, amp), num(p[1]) + rng.uniform(-amp, amp)])
            elif isinstance(p, dict):
                pts.append({'x': num(p.get('x')) + rng.uniform(-amp, amp),
                            'y': num(p.get('y')) + rng.uniform(-amp, amp)})
        if pts:
            out['points'] = pts
    elif kind in ('circle', 'ellipse', 'arc'):
        out['cx'] = num(out.get('cx')) + rng.uniform(-amp, amp)
        out['cy'] = num(out.get('cy')) + rng.uniform(-amp, amp)
        if 'r' in out:
            out['r'] = max(1.0, num(out.get('r')) + rng.uniform(-amp, amp) * 0.6)
        if 'rx' in out:
            out['rx'] = max(1.0, num(out.get('rx')) + rng.uniform(-amp, amp) * 0.6)
        if 'ry' in out:
            out['ry'] = max(1.0, num(out.get('ry')) + rng.uniform(-amp, amp) * 0.6)
    elif kind in ('rect', 'rectangle', 'roundrect', 'rounded_rect'):
        out['x'] = num(out.get('x')) + rng.uniform(-amp, amp) * 0.7
        out['y'] = num(out.get('y')) + rng.uniform(-amp, amp) * 0.7
        out['w'] = max(1.0, num(out.get('w')) + rng.uniform(-amp, amp) * 0.5)
        out['h'] = max(1.0, num(out.get('h')) + rng.uniform(-amp, amp) * 0.5)
    return out


def paper_texture(img, strength, seed):
    """叠一层纸张颗粒。strength 是 ±RGB 幅度，8~18 比较自然，超过 30 就脏了。

    噪声先生成四分之一大小再放大（低频）：逐像素的高频噪声会让 PNG 压不下去
    （实测 40KB 涨到 460KB），低频纹理看着也更像纸，不是电视雪花。
    """
    if strength <= 0:
        return img
    w, h = img.size
    noise = Image.effect_noise((max(2, w // 4), max(2, h // 4)), 22).convert('L')
    noise = noise.resize((w, h), Image.BICUBIC)
    lut = [max(0, min(255, 128 + int((v - 128) * strength / 64))) for v in range(256)]
    shift = noise.point(lut)
    grey = Image.merge('RGB', (shift, shift, shift))
    return ImageChops.add(img.convert('RGB'), grey, scale=1.0, offset=-128)


def wobble_rotate(img, angle, bg):
    """整张图轻微歪一点。先放大 3% 再旋转，免得四角露出底色。"""
    if abs(angle) < 0.05:
        return img
    w, h = img.size
    bw, bh = int(w * 1.03), int(h * 1.03)
    big = img.resize((bw, bh), Image.LANCZOS)
    big = big.rotate(angle, resample=Image.BICUBIC, expand=False, fillcolor=bg)
    left, top = (bw - w) // 2, (bh - h) // 2
    return big.crop((left, top, left + w, top + h))


def stylize_rgb(img, style):
    """在**已经合成到背景上、且已缩到最终尺寸**的 RGB 图做画风处理。

    为什么必须合成之后再风格化：图形层是带 alpha 的，直接模糊 alpha 会让
    「用背景色挖出来的形状」（比如拿背景色圆盖月牙）露出一圈半透明的幽灵边 ——
    2026-10-25 实测，绘本风的月牙旁边浮着一个清楚的圆环。
    合成到不透明背景上，边缘只会和背景融，不会留环。

    为什么必须在最终尺寸做：在 3 倍画布上模糊 0.7px，缩回来看等于没模糊；
    像素块更明显 —— 2700 宽上的 6px 块缩到 900 只剩 2px，完全看不出像素感。
    """
    if style == 'flat':
        return img
    if style == 'crayon':
        # 蜡笔没有锐边：整体柔一点点。太糊会像盗版，0.7 刚好。
        return img.filter(ImageFilter.GaussianBlur(0.7))
    if style == 'picturebook':
        img = img.filter(ImageFilter.GaussianBlur(1.0))
        return warm_up(img, 1.0)
    if style == 'pixel':
        return pixelize(img, 6)
    return img


def warm_up(img, amount):
    """整体偏暖一点点，绘本感。amount 0~1。"""
    if amount <= 0:
        return img
    r, g, b = img.split()
    r = r.point(lambda v: min(255, int(v + 10 * amount)))
    b = b.point(lambda v: max(0, int(v - 8 * amount)))
    return Image.merge('RGB', (r, g, b))


def pixelize(img, block):
    w, h = img.size
    small = img.resize((max(1, w // block), max(1, h // block)), Image.LANCZOS)
    return small.resize((w, h), Image.NEAREST)


def render(scene):
    if not isinstance(scene, dict):
        raise ValueError('场景必须是一个 JSON 对象')
    width = int(num(scene.get('width'), DEFAULT_W))
    height = int(num(scene.get('height'), DEFAULT_H))
    width = max(64, min(MAX_SIDE, width))
    height = max(64, min(MAX_SIDE, height))

    shapes = scene.get('shapes', scene.get('layers', []))
    if not isinstance(shapes, list):
        raise ValueError('shapes 必须是数组')
    if not shapes:
        raise ValueError('shapes 是空的，至少画一个图形')
    if len(shapes) > MAX_SHAPES:
        raise ValueError(f'图形太多（{len(shapes)} > {MAX_SHAPES}），精简一下场景')

    style = normalize_style(scene.get('style'))
    # 固定种子：同一个场景重复画出来要一样，不然她会以为「画错了」。
    seed = int(hashlib.md5(json.dumps(scene, sort_keys=True, ensure_ascii=False)
                           .encode('utf-8', 'replace')).hexdigest()[:8], 16)
    rng = random.Random(seed)

    scale = SUPERSAMPLE
    bg = background_layer(width * scale, height * scale, scene.get('background', '#ffffff'))
    art = Image.new('RGBA', (width * scale, height * scale), (0, 0, 0, 0))

    # 文字先抽出来，最后画：抖动/模糊只作用于图形
    texts = [s for s in shapes if isinstance(s, dict)
             and str(s.get('type', '')).lower() == 'text']
    others = [s for s in shapes if isinstance(s, dict)
              and str(s.get('type', '')).lower() != 'text']

    jitter = 0.0 if style in ('flat', 'pixel') else (1.6 if style == 'crayon' else 1.1)
    drawn = 0
    for shape in others:
        s = jitter_shape(shape, rng, scale, jitter) if jitter else shape
        opacity = max(0.0, min(1.0, num(s.get('opacity'), 1.0)))
        rotate = num(s.get('rotate'), 0.0)

        if opacity >= 0.999 and not rotate:
            if paint(ImageDraw.Draw(art), s, scale):
                drawn += 1
            continue

        # 半透明 / 旋转：单独一层画好再合成，否则 RGB 直接覆盖，透明度失效。
        pad = int(max(8, num(s.get('strokeWidth', 2), 2) * scale * 2))
        box = bbox_of(s, scale, pad)
        if not box:
            continue
        left, top, right, bottom = [int(round(v)) for v in box]
        try:
            layer = Image.new('RGBA', art.size, (0, 0, 0, 0))
            paint(ImageDraw.Draw(layer), s, scale)
            if opacity < 0.999:
                layer.putalpha(layer.split()[3].point(lambda v: int(v * opacity)))
            if rotate:
                layer = layer.rotate(-rotate, resample=Image.BICUBIC,
                                     center=((left + right) / 2, (top + bottom) / 2))
            art.alpha_composite(layer)
            drawn += 1
        except Exception:
            continue

    # 先合成到**不透明背景**，再缩到最终尺寸：带 alpha 的图形层直接模糊会在边缘
    # 留一圈半透明的幽灵环（绘本风的月牙实测浮着一个圆）。
    canvas = bg.copy()
    canvas.alpha_composite(art)
    out = canvas.convert('RGB').resize((width, height), Image.LANCZOS)

    # 风格化在**最终尺寸**上做：在 3 倍画布上模糊 0.7px，缩回来看等于没模糊；
    # 像素块同理，2700 宽上的 6px 块缩到 900 就只剩 2px，完全看不出像素感。
    out = stylize_rgb(out, style)

    # 文字最后画：像素化、模糊、纸纹都不该把字糊掉。
    text_layer = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer)
    for shape in texts:
        if paint(text_draw, shape, 1.0):     # scale=1：直接按最终像素写字
            drawn += 1
    out = out.convert('RGBA')
    out.alpha_composite(text_layer)
    out = out.convert('RGB')

    bg_rgb = tuple(parse_color(scene.get('background'), (255, 255, 255, 255))[:3])
    if style in ('crayon', 'picturebook'):
        # 整张歪零点几度，是「人画的」最省力的破绽修法
        out = wobble_rotate(out, rng.uniform(-0.5, 0.5), bg_rgb)
        out = paper_texture(out, 10 if style == 'crayon' else 7, seed)

    return out, drawn, width, height, style


def main():
    # Windows 的 Python 默认按 GBK 往管道/重定向输出，而调用方（Node）按 UTF-8 读，
    # 中文错误信息会变成一串问号（测试里实测：'图形太多' → 'ͼ��̫��'）。
    # 强制两个流都走 UTF-8，和父进程对齐。
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass

    ap = argparse.ArgumentParser(description='把 JSON 场景画成 PNG')
    ap.add_argument('--out', required=True, help='输出 PNG 路径')
    ap.add_argument('--scene', help='场景 JSON 文件；不给就从 stdin 读')
    ap.add_argument('--style', help='覆盖场景里的画风（flat/crayon/picturebook/pixel）')
    args = ap.parse_args()

    try:
        if args.scene:
            with open(args.scene, 'r', encoding='utf-8') as fh:
                raw = fh.read()
        else:
            raw = sys.stdin.buffer.read().decode('utf-8', 'replace')
        if not raw.strip():
            raise ValueError('没有收到场景内容（stdin 为空）')
        scene = json.loads(raw)
        if args.style:
            scene = {**scene, 'style': args.style}
        img, drawn, width, height, style = render(scene)
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or '.', exist_ok=True)
        img.save(args.out, 'PNG', optimize=True)
        print(json.dumps({
            'ok': True,
            'path': os.path.abspath(args.out),
            'width': width,
            'height': height,
            'shapes': drawn,
            'style': style,
            'bytes': os.path.getsize(args.out),
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}, ensure_ascii=False))
        traceback.print_exc(file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
