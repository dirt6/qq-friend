// 5.0-G1 只读生产决策运行器。
// 独立进程读取生产快照，执行 A1→A2→A3→A4；不调用模型/工具、不写业务数据、不发送。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = { dataDir: '', diaryRoot: '', auditDir: '', chatKey: '', confirm: false };
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--confirm-readonly') { opt.confirm = true; continue; }
  const map = { '--data-dir': 'dataDir', '--diary-root': 'diaryRoot', '--audit-dir': 'auditDir', '--chat-key': 'chatKey' };
  if (map[args[i]]) { opt[map[args[i]]] = args[i + 1] || ''; i += 1; }
}
if (!opt.confirm) throw new Error('需要 --confirm-readonly（G1 只读授权）');
if (!opt.dataDir || !opt.auditDir) throw new Error('需要 --data-dir 与 --audit-dir');
if (path.resolve(opt.dataDir).toLowerCase() === path.resolve(ROOT, 'data').toLowerCase() && !opt.confirm) throw new Error('production require confirm');
process.env.QQ_AGENT_DATA_DIR = path.resolve(opt.dataDir);
if (opt.diaryRoot) process.env.QQ_AGENT_DIARY_ROOT = path.resolve(opt.diaryRoot);
const { ChatStore } = await import('../src/store.js');
const { createCompanionCore } = await import('../src/companion-core/index.js');
const { buildPurposeCandidates } = await import('../src/autonomous/purpose.js');
const { assessConversationClosure } = await import('../src/autonomous/closure.js');
const { selectActivity } = await import('../src/autonomous/activity.js');
const { createDecisionReceipt } = await import('../src/autonomous/receipt.js');

const now = Date.now();
const store = new ChatStore(0);
const core = createCompanionCore({ chatStore: store });
const goals = core.goals.active ? [core.goals.active()].filter(Boolean) : [];
const pending = core.pending.active ? core.pending.active() : [];
const chatKey = opt.chatKey || 'private:1846383180';
const snap = core.readChatSnapshot({ chatKey, now, contextLimit: 20 });
const messages = (snap.context || []).map((m) => ({ role: m.self ? 'assistant' : 'user', text: String(m.text || ''), at: m.ts }));
const purposeInput = { goals, pending, now, topics: messages.slice(-5).map((m) => ({ text: m.text })) };
const purpose = buildPurposeCandidates(purposeInput);
const closure = assessConversationClosure({ now, messages });
const activity = selectActivity({ now, closure, purpose, state: { goals, pending, budget: null } });
const receipt = createDecisionReceipt({ now, purpose, closure, activity, inputRef: 'g1:readonly' });
if (!receipt.ok) throw new Error(`receipt failed: ${receipt.error}`);
const audit = {
  at: new Date(now).toISOString(), mode: 'G1_READONLY', dataDir: path.resolve(opt.dataDir), chatKey,
  counts: { goals: goals.length, pending: pending.length, messages: messages.length, purposeCandidates: purpose.candidates.length },
  purpose: { noAction: purpose.noAction, candidates: purpose.candidates.map((c) => ({ id: c.candidateId, kind: c.kind, owner: c.owner, confidence: c.confidence })) },
  closure: { decision: closure.decision, reason: closure.reason, unresolved: closure.unresolvedRequests.length },
  activity: { decision: activity.decision, type: activity.selectedActivity?.type || null, reason: activity.reason },
  receipt: { receiptId: receipt.receipt.receiptId, status: receipt.receipt.status, executionState: receipt.receipt.execution.state, authorized: receipt.receipt.execution.authorized },
  noExecutor: true, noModel: true, noBusinessWrite: true
};
fs.mkdirSync(path.resolve(opt.auditDir), { recursive: true });
fs.writeFileSync(path.join(path.resolve(opt.auditDir), 'g1-receipt.json'), JSON.stringify(receipt.receipt, null, 1), 'utf8');
fs.writeFileSync(path.join(path.resolve(opt.auditDir), 'g1-audit.json'), JSON.stringify(audit, null, 1), 'utf8');
console.log(JSON.stringify(audit, null, 1));
