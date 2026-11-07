// 5.0 听写模式：说「先别回话」后只记录不回复，直到「我说完了」。
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const tmp = path.join(os.tmpdir(), `listen-mode-test-${process.pid}.json`);
process.env.LISTEN_MODE_FILE = tmp;
const m = await import('../src/listen-mode.js');

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

ok('识别：先别回话', m.isListenStart('先别回话'));
ok('识别：等我说完', m.isListenStart('等我说完再回'));
ok('识别：先听我说', m.isListenStart('先听我说'));
ok('识别：我先说完', m.isListenStart('我还没说完'));
ok('不误判普通句', !m.isListenStart('别回我这条消息了'));
ok('不误判普通句2', !m.isListenStart('今天吃什么'));
ok('识别：我说完了', m.isListenEnd('我说完了'));
ok('识别：可以回了', m.isListenEnd('可以回了'));
ok('不误判：我说完就睡', !m.isListenEnd('我说完就睡'));
ok('空文本不触发', !m.isListenStart('') && !m.isListenEnd(''));

ok('初始不在听写模式', m.isListening('private:1') === false);
m.setListening('private:1', true);
ok('开启后为 true', m.isListening('private:1') === true);
ok('其他会话不受影响', m.isListening('private:2') === false);
m.setListening('private:1', false);
ok('关闭后为 false', m.isListening('private:1') === false);
ok('空 chatKey 拒绝', m.setListening('', true).ok === false);

console.log(`\nListen mode: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
