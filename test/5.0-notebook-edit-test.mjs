// 本子：写/改/删（唯一匹配 + 删除备份 + 不删标题）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendNotebook, readNotebook, editNotebook, deleteNotebook } from '../src/notebook.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-'));
const file = path.join(tmp, 'book.md');
const trash = path.join(tmp, 'trash');
fs.writeFileSync(file, '# 小鲸鱼的本子\n\n## 第一条 · 2026-11-05T00:00:00.000Z\n\n今天想去看雨。\n\n## 第二条 · 2026-11-05T01:00:00.000Z\n\n猫在我脚边睡着了。\n', 'utf8');

const a = appendNotebook({ file, title: '第三条', text: '随手记一笔。' });
ok('追加', a.ok === true && fs.readFileSync(file, 'utf8').includes('随手记一笔。'));

const e1 = editNotebook({ file, match: '今天想去看雨。', text: '今天想去窗边坐一会儿。' });
ok('唯一匹配可改', e1.ok === true && fs.readFileSync(file, 'utf8').includes('今天想去窗边坐一会儿。'));
ok('原文已不存在', !fs.readFileSync(file, 'utf8').includes('今天想去看雨。'));

const e2 = editNotebook({ file, match: '不存在的句子', text: 'x' });
ok('找不到就拒绝', e2.ok === false);

const e3 = editNotebook({ file, match: '##', text: 'x' });
ok('多匹配就拒绝', e3.ok === false && /匹配到/.test(String(e3.error)), JSON.stringify(e3));

const before = fs.readFileSync(file, 'utf8');
const d1 = deleteNotebook({ file, match: '猫在我脚边睡着了。' });
ok('按条目删除', d1.ok === true && !fs.readFileSync(file, 'utf8').includes('猫在我脚边睡着了。'));
ok('默认不备份', d1.ok === true && !d1.backup);

const backupFile = path.join(tmp, 'book2.md');
fs.writeFileSync(backupFile, '# 小鲸鱼的本子\n\n## 备份测试 · x\n\n要删掉的条目\n', 'utf8');
const db = deleteNotebook({ file: backupFile, match: '要删掉的条目', backupDir: trash });
ok('显式传 backupDir 才备份', db.ok === true && Boolean(db.backup) && fs.existsSync(db.backup));

const d2 = deleteNotebook({ file, match: '小鲸鱼的本子' });
ok('不能删标题', d2.ok === false);

const d3 = deleteNotebook({ file, match: '不存在' });
ok('删不到就拒绝', d3.ok === false);

const d4 = deleteNotebook({ file, match: '随手记一笔。' });
ok('删第三条后只剩一条', d4.ok === true && (fs.readFileSync(file, 'utf8').match(/^## /gm) || []).length === 1);

const r = readNotebook({ file, chars: 3000 });
ok('删除后仍可读', r.ok === true && r.text.includes('第一条'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nNotebook edit: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
