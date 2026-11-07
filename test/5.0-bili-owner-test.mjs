// B站主人映射：alias 解析、缺配置失败；临时文件，不联网。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { getBiliOwner, resolveBiliMention } from '../src/bili-owner.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bili-owner-'));
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const file = path.join(tmp, 'owner.json');
fs.writeFileSync(file, JSON.stringify({ uid: '507695674', nickname: '泥土如是说' }), 'utf8');
const owner = getBiliOwner({ file });
ok('读取主人映射', owner?.uid === '507695674' && owner?.nickname === '泥土如是说');
const a = resolveBiliMention('owner', owner);
ok('owner 解析成 B站昵称', a.ok === true && a.mention === '泥土如是说');
const m = resolveBiliMention('me', owner);
ok('me 同义', m.ok === true && m.mention === '泥土如是说');
const raw = resolveBiliMention('别人', owner);
ok('普通昵称原样', raw.ok === true && raw.mention === '别人');
const none = resolveBiliMention('owner', null);
ok('缺映射明确失败', none.ok === false && /未配置/.test(none.error));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nBili owner: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
