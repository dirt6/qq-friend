// B站视频总结：fake detail + fake chat，不联网、不调用真模型。
import assert from 'node:assert/strict';
import { summarizeVideoDetail, summaryPrompt, videoMaterial } from '../src/bili-summary.js';

const detail = {
  ok: true, bvid: 'BV1xx411c7mD', title: '猫猫为什么喜欢箱子', owner: '猫研所', tname: '动物',
  url: 'https://www.bilibili.com/video/BV1xx411c7mD', desc: '从行为学解释猫对纸箱的偏好。',
  stat: { view: 10000, like: 800, reply: 120 },
  replies: [
    { user: '甲', like: 99, text: '我家猫也是，箱子一到就钻进去' },
    { user: '乙', like: 42, text: '原来不是怕冷，是安全感' }
  ]
};
let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };
const material = videoMaterial(detail);
ok('材料包含标题/简介/热评', /猫猫为什么喜欢箱子/.test(material) && /行为学/.test(material) && /箱子一到/.test(material));
ok('提示词明确禁止编造/信息边界', /不要编造/.test(summaryPrompt(detail)) && /信息边界/.test(summaryPrompt(detail)));
let seen = null;
const r = await summarizeVideoDetail(detail, { chat: async (args) => { seen = args; return { message: { content: '一句话结论：猫喜欢箱子。\n信息边界：仅基于简介和热评。' }, model: 'fake' }; } });
ok('总结成功', r.ok === true && /猫喜欢箱子/.test(r.summary), JSON.stringify(r));
ok('传给 chat 的材料含热评', /箱子一到/.test(seen.messages[1].content));
ok('标记覆盖范围', r.coverage === 'metadata+hot_comments' && r.replyCount === 2);
const empty = await summarizeVideoDetail(detail, { chat: async () => ({ message: { content: '' } }) });
ok('空总结明确失败', empty.ok === false && empty.error === 'summary_empty');
const bad = await summarizeVideoDetail({ ok: false, error: '详情失败' }, { chat: async () => ({}) });
ok('详情失败不继续调模型', bad.ok === false && /详情失败/.test(bad.error));
console.log(`\nBili summary: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
