// 5.0 允许单发图/表情、不带文字（2026-11-06 机主纠正：不是强制带文字）。
import assert from 'node:assert/strict';
import { buildToolDefs } from '../src/tools.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

const defs = buildToolDefs();
const tool = defs.find((d) => d.id === 'send_sticker');
ok('找到 send_sticker 工具', Boolean(tool));

function makeCtx(sent = []) {
  return {
    chatKey: 'private:1',
    session: { id: 's1', sent: sent.slice(), triggerText: '' },
    stickers: {
      find: async () => ({ id: 's1', url: 'http://127.0.0.1:9/nope.png', desc: '测试', localNote: '' }),
      ensureSendable: async (s) => s,
      markUsed: () => {}
    },
    sender: { sendSticker: async () => ({ message_id: 1 }) },
    emit: () => {}
  };
}

// 1) 本轮没发文字 → 允许单发表情（不再被“必须先发文字”拦截）
const r1 = await tool.execute(makeCtx([]), { stickerId: 's1' });
const c1 = String(r1?.content ?? '');
ok('没发文字也能发表情（不被文字校验拦截）', !/必须先用 send_message|先发一句文字/.test(c1), c1.slice(0, 80));

// 2) 已发文字 → 同样不受影响
const r2 = await tool.execute(makeCtx([{ type: 'text', text: '呐', at: '00:00:00' }]), { stickerId: 's1' });
ok('有文字时也不被拦截', !/必须先用 send_message|先发一句文字/.test(String(r2?.content ?? '')), String(r2?.content ?? '').slice(0, 80));

// 3) 描述明确允许单发
ok('描述允许单独发表情', /可以单独发表情|不带文字/.test(String(tool.description || '')));

console.log(`\nSticker text: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
