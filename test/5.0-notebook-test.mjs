// 私人本子：固定路径、追加/读取；临时文件，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { appendNotebook, readNotebook } from '../src/notebook.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-'));
const file = path.join(tmp, '小鲸鱼的本子.md');
fs.writeFileSync(file, '# 小鲸鱼的本子\n', 'utf8');
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const a = appendNotebook({ file, title: '今天', text: '今天很开心' });
ok('追加成功', a.ok === true);
const r = readNotebook({ file });
ok('读回内容', r.ok === true && /今天很开心/.test(r.text) && /## 今天/.test(r.text));
const empty = appendNotebook({ file, text: ' ' });
ok('空内容拒绝', empty.ok === false);
const big = appendNotebook({ file, text: 'x'.repeat(3001) });
ok('超长拒绝', big.ok === false);
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nNotebook: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
