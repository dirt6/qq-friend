// D1-2b-2 故障注入 worker：执行 append/remove/relevel，按 DIARY_FAULT 在节点自杀。
// 用法：node worker <dataDir> <diaryRoot> <op> <dateKey> <content> <outFile>
import fs from 'node:fs';
import path from 'node:path';

const [, , dataDir, diaryRoot, op, dateKey, content, outFile] = process.argv;
process.env.QQ_AGENT_DATA_DIR = dataDir;

const W = await import('../src/diary/writer.js');
const dayDir = path.join(diaryRoot, '每日');

let r;
try {
  if (op === 'append') {
    r = W.write({ content, day: dateKey, root: dayDir, source: 'test' });
  } else if (op === 'remove') {
    r = W.removeLine({ match: content, day: dateKey, root: dayDir });
  } else if (op === 'relevel') {
    r = W.relevelLine({ match: content, importance: '重要', day: dateKey, root: dayDir });
  } else {
    r = { ok: false, error: 'unknown op' };
  }
} catch (e) {
  r = { ok: false, error: String(e?.message ?? e) };
}
fs.writeFileSync(outFile, JSON.stringify(r));
