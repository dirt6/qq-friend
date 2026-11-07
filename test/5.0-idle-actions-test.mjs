// 空闲动作：fake sender，验证配额/静默/去重/分享文本链接；不发公开内容。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createIdleActions } from '../src/idle-actions.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-actions-'));
let sent = [];
const sender = { async sendTextBatch(chatKey, arr) { sent.push({ chatKey, text: arr[0] }); return { sent: [{ messageId: 1 }] }; } };
const fixedNow = new Date('2026-11-05T12:00:00+08:00').getTime();
const a = createIdleActions({ sender, target: '1846383180', now: () => fixedNow, journalFile: path.join(tmp, 'journal.json') });
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const s = await a.share({ title: '标题', url: 'https://example.com/x', text: '看这个', includeLink: true });
ok('分享文字+链接', s.ok === true && /标题/.test(s.text) && /https:\/\/example/.test(s.text) && sent[0]?.chatKey === 'private:1846383180');
const c = await a.chat({ text: '老大，在忙吗' });
ok('主动聊天', c.ok === true && sent[1]?.text === '老大，在忙吗');
const d = await a.chat({ text: '老大，在忙吗' });
ok('去重', d.ok === false && d.reason === 'duplicate');
const q = createIdleActions({ sender, target: '1846383180', now: () => new Date('2026-11-05T02:30:00+08:00').getTime(), journalFile: path.join(tmp, 'q.json') });
const qr = await q.share({ title: 'x' });
ok('静默时段', qr.ok === false && qr.reason === 'quiet_hours');
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nIdle actions: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
