// 日记改删 worker：独立进程执行 removeLine/relevelLine。
// 用法：node worker <root每日目录> <op> <match> <arg> <outFile>
import fs from 'node:fs';
import { removeLine, relevelLine } from '../src/diary/writer.js';

const [, , dir, op, match, arg, outFile] = process.argv;
let r;
try {
  r = op === 'remove'
    ? removeLine({ match, root: dir })
    : relevelLine({ match, importance: arg, root: dir });
} catch (e) {
  r = { ok: false, reason: String(e?.message ?? e) };
}
fs.writeFileSync(outFile, JSON.stringify(r));
