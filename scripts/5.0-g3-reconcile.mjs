// 5.0 G3 对账（只读）：列出 sent/unknown/sending，不自动重发、不修改 journal。
// 用法：node scripts/5.0-g3-reconcile.mjs [--json]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const data = path.join(root, 'data');
const jf = path.join(data, '5.0-runtime/g3-send-journal.json');
const ef = path.join(data, '5.0-runtime/execution.json');
const journal = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : { intents: {} };
const exec = fs.existsSync(ef) ? JSON.parse(fs.readFileSync(ef, 'utf8')) : { records: {} };
const rows = Object.entries(journal.intents || {}).map(([fp, x]) => ({
  fingerprint: fp, state: x.state, target: x.target, at: x.at, messageId: x.messageId || '', reason: x.reason || '', textHash: x.textHash || ''
}));
const unknownExec = Object.values(exec.records || {}).filter((r) => r.state === 'unknown').map((r) => ({ receiptId: r.receiptId, createdAt: r.createdAt, activity: r.receipt?.activity?.selectedActivity?.type || '', reason: r.history?.at?.(-1)?.reason || '' }));
const out = { ok: true, journal: { sent: rows.filter((x) => x.state === 'sent').length, unknown: rows.filter((x) => x.state === 'unknown').length, sending: rows.filter((x) => x.state === 'sending').length, rows }, unknownExec };
if (jsonOut) console.log(JSON.stringify(out, null, 1));
else {
  console.log(`G3 journal: sent=${out.journal.sent} unknown=${out.journal.unknown} sending=${out.journal.sending}`);
  for (const r of rows) console.log(`${r.state.padEnd(8)} ${r.target} ${r.at} ${r.messageId || r.reason || r.fingerprint}`);
  if (unknownExec.length) { console.log('Unknown executions:'); for (const r of unknownExec) console.log(`  ${r.receiptId} ${r.activity} ${r.reason}`); }
  console.log('只读：不会自动重发或修改 journal。');
}
