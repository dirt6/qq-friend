// 小鲸鱼写的小程序草稿：只保存，不执行、不加载。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const HER_PROGRAMS_DIR = process.env.HER_PROGRAMS_DIR || path.join(ROOT, 'skills', 'her-test', 'programs');
const NAME_RE = /^[a-zA-Z0-9_\-\u4e00-\u9fa5]{1,40}$/;

export function ensureHerPrograms(dir = HER_PROGRAMS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const readme = path.join(dir, 'README.md');
  if (!fs.existsSync(readme)) {
    fs.writeFileSync(readme, '# 小鲸鱼的小程序草稿\n\n> 只保存，不自动执行。由老大审阅后再决定是否接入。\n', 'utf8');
  }
}

export function saveHerProgram({ name, code, note = '', dir = HER_PROGRAMS_DIR } = {}) {
  const base = String(name || '').trim();
  if (!NAME_RE.test(base)) return { ok: false, error: '名字只能是字母/数字/下划线/短横/中文，1-40 字' };
  if (base.toLowerCase() === 'index') return { ok: false, error: '不能叫 index，避免覆盖已加载工具' };
  const body = String(code ?? '');
  if (!body.trim()) return { ok: false, error: '代码不能为空' };
  if (body.length > 30000) return { ok: false, error: '代码最多 30000 字' };
  ensureHerPrograms(dir);
  const file = path.join(dir, `draft-${base}.js`);
  try {
    fs.writeFileSync(file, `// ${String(note || '').slice(0, 200)}\n${body}\n`, 'utf8');
    return { ok: true, file, name: base };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
}

export function listHerPrograms({ dir = HER_PROGRAMS_DIR } = {}) {
  try {
    ensureHerPrograms(dir);
    return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ({ file: f, bytes: fs.statSync(path.join(dir, f)).size }));
  } catch { return []; }
}
