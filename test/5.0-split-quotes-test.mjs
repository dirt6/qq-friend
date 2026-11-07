// 聊天分条：成对引号/括号不拆开；密度规则保持不变。
import { splitForChat } from '../src/split-chat.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

const quoted = splitForChat('他说“你好，世界，今天天气不错”就走了。');
ok('引号内两个逗号不拆', quoted.length === 1 && quoted[0] === '他说“你好，世界，今天天气不错”就走了。', JSON.stringify(quoted));

const quotedSentence = splitForChat('第一句。“引号里有句号。也不该拆开。”第三句。');
ok('引号内句号不拆', quotedSentence.length === 2 && quotedSentence[1].includes('“引号里有句号。也不该拆开。”'), JSON.stringify(quotedSentence));

const brackets = splitForChat('（括号里，有逗号，也有句号。）后面正常');
ok('括号内不拆', brackets.length === 1 && brackets[0].includes('（括号里，有逗号，也有句号。）'), JSON.stringify(brackets));

const englishQuotes = splitForChat('他说 "hello, world, again" 就走了');
ok('英文引号内逗号不拆', englishQuotes.length === 1 && englishQuotes[0].includes('"hello, world, again"'), JSON.stringify(englishQuotes));

const normal = splitForChat('我觉得吧，这个事吧，其实还行');
ok('普通短句仍按逗号密度拆', normal.length === 2, JSON.stringify(normal));

const list = splitForChat('一，二，三，四');
ok('列举不拆', list.length === 1 && list[0] === '一，二，三，四', JSON.stringify(list));

const unpaired = splitForChat('他说“没有右引号，然后，继续说话');
ok('不配对引号保持原行为', Array.isArray(unpaired) && unpaired.join('') === '他说“没有右引号，然后，继续说话', JSON.stringify(unpaired));

const shortAnswer = splitForChat('嗯。');
ok('短应答去掉句末标点', shortAnswer.length === 1 && shortAnswer[0] === '嗯', JSON.stringify(shortAnswer));

console.log(`\nSplit chat: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
