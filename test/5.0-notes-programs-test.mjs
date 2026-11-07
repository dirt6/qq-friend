// 本子/小程序草稿：临时目录，不执行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appendNotebook, readNotebook } from '../src/notebook.js';
import { saveHerProgram, listHerPrograms } from '../src/her-programs.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'her-notes-'));
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const file = path.join(tmp, '小鲸鱼的本子.md');
fs.writeFileSync(file, '# 本子\n', 'utf8');
ok('本子追加', appendNotebook({ file, title: '今天', text: '记一笔' }).ok === true);
ok('本子读回', /记一笔/.test(readNotebook({ file }).text));
process.env.HER_PROGRAMS_DIR = path.join(tmp, 'programs');
const mod = await import('../src/her-programs.js');
const s = mod.saveHerProgram({ name: '小工具', code: 'export const x = 1;', note: '测试', dir: path.join(tmp, 'programs') });
ok('保存小程序草稿', s.ok === true && fs.existsSync(s.file));
ok('列出草稿', mod.listHerPrograms({ dir: path.join(tmp, 'programs') }).some((x) => x.file === 'draft-小工具.js'));
ok('拒绝路径名', mod.saveHerProgram({ name: '../evil', code: 'x' }).ok === false);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nNotes/Programs: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
