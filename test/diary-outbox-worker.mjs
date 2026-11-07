// 操作日志 worker：登记一条后（可选）SIGKILL。
// 用法：node worker <dataDir> <op> <dateKey> <match> <suicide> <outFile>
import fs from 'node:fs';
import path from 'node:path';

const [, , dataDir, op, dateKey, match, suicideRaw, outFile] = process.argv;
process.env.QQ_AGENT_DATA_DIR = dataDir;
const { prepareDiaryOp } = await import('../src/diary/outbox.js');

const r = prepareDiaryOp({ op, dateKey, match, expectedSourceHash: 'sha1:x' });
if (suicideRaw === 'suicide') {
  fs.writeFileSync(outFile, JSON.stringify(r));
  process.kill(process.pid, 'SIGKILL');
  await new Promise(() => {});
}
fs.writeFileSync(outFile, JSON.stringify(r));
