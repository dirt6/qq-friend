// 5.0 零宽字符/纯空白不应变成聊天消息（2026-11-06：她单发表情时发了 U+200B）。
import assert from 'node:assert/strict';
import { splitForChat } from '../src/split-chat.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

ok('纯零宽空格不产生消息', splitForChat('\u200B').length === 0);
ok('零宽+BOM+空白不产生消息', splitForChat('\u200B\uFEFF \u2060').length === 0);
ok('纯普通空白不产生消息', splitForChat('   ').length === 0);
ok('零宽+文字保留文字', splitForChat('\u200B你好').join('') === '你好');
ok('普通文本正常', splitForChat('老大').length === 1);
ok('多句仍能分条', splitForChat('老大。你在吗？').length >= 1);

console.log(`\nSplit zero width: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
