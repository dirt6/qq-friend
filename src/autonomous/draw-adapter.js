// 5.0 空闲画画：本地创作 adapter。
// 复用 src/draw.js 渲染/索引；只写 data/drawings，不发消息、不调模型。
import path from 'node:path';
import {
  renderScene as defaultRender,
  recordDrawing as defaultRecord,
  sceneFromPreset as defaultScene,
  PRESETS,
  DRAW_DIR
} from '../draw.js';

const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

export function createDrawAdapter({
  render = defaultRender,
  record = defaultRecord,
  scene = defaultScene,
  now = () => Date.now()
} = {}) {
  if (typeof render !== 'function' || typeof record !== 'function' || typeof scene !== 'function') {
    throw new Error('draw adapter 需要 render/record/scene');
  }
  async function draw({ preset = 'night', title = '', note = '' } = {}) {
    const name = String(preset || 'night').toLowerCase();
    if (!PRESET_NAMES.includes(name)) return { ok: false, sideEffect: 'none', error: 'preset_not_allowed', allowed: PRESET_NAMES };
    let sceneObj;
    try { sceneObj = scene(name, { title: String(title || '').slice(0, 60) }); } catch (e) { return { ok: false, sideEffect: 'none', error: String(e?.message || e) }; }
    let rendered;
    try { rendered = await render(sceneObj); } catch (e) { return { ok: false, sideEffect: 'none', error: String(e?.message || e) }; }
    if (!rendered?.ok || !rendered.path) return { ok: false, sideEffect: 'none', error: String(rendered?.error || 'render_failed') };
    const file = path.basename(String(rendered.path));
    try {
      const entry = record({
        file, title, note, style: rendered.style || '', source: 'autonomous',
        width: rendered.width, height: rendered.height, bytes: rendered.bytes,
        createdAt: new Date(now()).toISOString()
      });
      return { ok: true, file, path: String(rendered.path), entry, dir: DRAW_DIR };
    } catch (e) {
      // 图可能已渲染成功；索引失败不能证明没有文件 → unknown，不重画。
      return { ok: false, sideEffect: 'unknown', error: `draw_index_failed:${String(e?.message || e)}`, file };
    }
  }
  return { draw, presets: PRESET_NAMES, dir: DRAW_DIR };
}

export default createDrawAdapter;
