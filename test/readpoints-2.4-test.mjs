// 2.4 五个读点切换的验收测试。
//
// 机主的测试重点：
//   · 新状态文件缺失/损坏/字段为空时，五个读点都有安全行为，**不擅自恢复旧字段**
//   · goal:null / pending:[] 时不把 undefined 当有效值
//   · done / cancelled 不被当作未完成待办
//   · 多条 pending 并存时选取逻辑明确
//   · 旧字段被改 → 不影响自主活动行为
//   · 迁移标记缺失或标识异常时，宁可不结算，也不扩大匹配范围
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(import.meta.url.replace('file:///', '').replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'readpoints-'));
const dataDir = tmp;
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' },
  skills: { autonomous: { enabled: true } }
}), 'utf8');
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
// sessions 目录（lastChatActivityAt 要扫它）
fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);
const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);

const CS_FILE = path.join(dataDir, 'companion-state.json');
const resetCs = () => { try { fs.rmSync(CS_FILE, { force: true }); } catch { /* ignore */ } };
const writeCs = (obj) => fs.writeFileSync(CS_FILE, JSON.stringify(obj), 'utf8');
const readCs = () => JSON.parse(fs.readFileSync(CS_FILE, 'utf8'));

/**
 * 造一条"老大刚回话"的记录。
 *
 * 2026-11-01 / 2.5 起，结算不再看 sessions 目录 mtime（分不清她说还是他说），
 * 改成读 messages/private_<master>.json 里 self === false 的最后一条。
 * 所以测试也得造真实的消息记录。
 */
function markChatActivity(ts) {
  const f = path.join(dataDir, 'messages', 'private_10001.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(f, 'utf8')).messages || []; } catch { /* 新文件 */ }
  list.push({ id: list.length + 1, mid: 2000 + list.length, ts, text: '在吗', self: false, senderId: '10001' });
  fs.writeFileSync(f, JSON.stringify({ messages: list }), 'utf8');
}

try {
  console.log('【① 文件缺失：读点安全，不擅自恢复旧字段】');
  {
    resetCs();
    ok('activePending 返回空数组', Array.isArray(cs.activePending()) && cs.activePending().length === 0);
    ok('promptSection 返回空串', cs.promptSection() === '');
    ok('settleChatPending 返回 false', auto.settleChatPending() === false);
  }

  console.log('\n【② 文件损坏：同样安全】');
  {
    fs.writeFileSync(CS_FILE, '{ 这不是 json', 'utf8');
    ok('activePending 空', cs.activePending().length === 0);
    ok('settleChatPending false', auto.settleChatPending() === false);
  }

  console.log('\n【③ goal:null / pending:[] 不把 undefined 当有效值】');
  {
    writeCs({ version: 1, goal: null, topic: null, pending: [], updatedAt: '' });
    ok('promptSection 空', cs.promptSection() === '');
    ok('activePending 空', cs.activePending().length === 0);
    ok('settleChatPending false', auto.settleChatPending() === false);
  }

  console.log('\n【④ 迁移标记：只有带 migrationTag 的才结算】');
  {
    // 没有 migrationTag 的 pending —— 不该被结算
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-aaaaaa', text: '明天再查查资料', status: 'pending',
        source: 'autonomous', at: new Date(Date.now() - 600e3).toISOString()
      }]
    });
    markChatActivity(Date.now());
    ok('**无 tag 的新待办不被误结算**', auto.settleChatPending() === false, '被误结算了');
    ok('状态仍是 pending', readCs().pending[0].status === 'pending');

    // 有 migrationTag 的 —— 应该结算
    const at = Date.now() - 600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-bbbbbb', text: '等老大回应，看他怎么说', status: 'pending',
        source: 'autonomous', at: new Date(at).toISOString(),
        migrationTag: 'chat-wait-reply'
      }]
    });
    markChatActivity(Date.now());
    ok('带 tag 的能结算', auto.settleChatPending() === true, '没结算');
    ok('状态变成 done', readCs().pending[0].status === 'done');
    ok('**没删**（保留 7 天）', readCs().pending.length === 1);
  }

  console.log('\n【⑤ 标识异常：宁可不结算】');
  {
    const at = Date.now() - 600e3;
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-cccccc', text: '等老大回应', status: 'pending',
        source: 'autonomous', at: new Date(at).toISOString(),
        migrationTag: 'something-else'   // 标识不对
      }]
    });
    markChatActivity(Date.now());
    ok('标识不匹配 → 不结算', auto.settleChatPending() === false);
    ok('状态没变', readCs().pending[0].status === 'pending');
  }

  console.log('\n【⑥ 老大还没回话 → 不结算】');
  {
    const at = Date.now() - 60e3;   // 1 分钟前
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-dddddd', text: '等老大回应', status: 'pending',
        source: 'autonomous', at: new Date(at).toISOString(),
        migrationTag: 'chat-wait-reply'
      }]
    });
    // 聊天活动比 at 只晚 30 秒（< 90 秒保护期）
    markChatActivity(at + 30e3);
    ok('没超过 90 秒保护期 → 不结算', auto.settleChatPending() === false);
  }

  console.log('\n【⑦ done / cancelled 不被当成未完成】');
  {
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [
        { id: 'p-1', text: '已完成的事', status: 'done', source: 'autonomous', at: new Date(Date.now() - 600e3).toISOString(), migrationTag: 'chat-wait-reply', settledAt: new Date().toISOString() },
        { id: 'p-2', text: '取消了的事', status: 'cancelled', source: 'autonomous', at: new Date(Date.now() - 600e3).toISOString() },
        { id: 'p-3', text: '还没开始做的事', status: 'pending', source: 'autonomous', at: new Date(Date.now() - 600e3).toISOString() }
      ]
    });
    const act = cs.activePending();
    ok('activePending 只含未结算的（这里剩 p-3，状态 pending）', act.length === 1 && act[0].id === 'p-3', JSON.stringify(act.map((x) => x.status)));
    ok('done 已结算过 → settleChatPending 不再动它', (() => {
      // 只有 p-3 是未结算的，但它没有 migrationTag → 不该被结算
      markChatActivity(Date.now());
      return auto.settleChatPending() === false;
    })());
  }

  console.log('\n【⑧ 多条 pending：planner 能看到全部未结算项】');
  {
    writeCs({
      version: 1,
      goal: { text: '继续完善小镇游戏', source: 'chat', since: '' },
      topic: null,
      updatedAt: '',
      pending: [
        { id: 'p-1', text: '继续讨论警察助手的人设', status: 'pending', source: 'chat', at: new Date(Date.now() - 3000e3).toISOString() },
        { id: 'p-2', text: '等老大回话', status: 'waiting', source: 'autonomous', at: new Date(Date.now() - 2000e3).toISOString() },
        { id: 'p-3', text: '已经做完的', status: 'done', source: 'chat', at: new Date(Date.now() - 1000e3).toISOString(), settledAt: new Date().toISOString() }
      ]
    });
    const s = cs.promptSection();
    ok('包含 goal', /继续完善小镇游戏/.test(s), s);
    ok('包含两条未结算', /警察助手/.test(s) && /等老大回话/.test(s), s);
    ok('**不含已完成的**', !/已经做完的/.test(s), s);
    ok('标了"在等"', /在等/.test(s), s);
  }

  console.log('\n【⑨ 过期项传了但标出来，不当完成】');
  {
    const past = new Date(Date.now() - 86400e3).toISOString();
    writeCs({
      version: 1, goal: null, topic: null, updatedAt: '',
      pending: [{
        id: 'p-1', text: '一件过期的待办', status: 'pending', source: 'chat',
        at: new Date(Date.now() - 3000e3).toISOString(), expiresAt: past
      }]
    });
    const act = cs.activePending();
    ok('过期项仍在 activePending 里（没被当完成）', act.length === 1, String(act.length));
    ok('状态仍是 pending', act[0].status === 'pending');
    // 4.0 / 2.6-B2：expiredPending 只返回**已经被标记成 expired** 的记录。
    // 读操作不再触发清理（那样会一读就写盘），要先经过一次写入才会被标记。
    ok('清理前 expiredPending 是空（读不触发清理）', cs.expiredPending().length === 0);
    cs.addPending({ text: '触发清理', source: 'chat' });
    const exp = cs.expiredPending();
    ok('**清理后能查出来**', exp.length === 1 && exp[0].id === 'p-1', JSON.stringify(exp.map(x => x.id)));
  }

  console.log('\n【⑩ 旧字段被改 → 不影响运行时读取】');
  {
    // 旧字段有一堆垃圾，新文件才是真源
    fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
      version: 1,
      currentGoal: '这是旧字段里的垃圾目标，不该被读到',
      pendingNextStep: { topic: '这是旧字段里的垃圾待办', status: 'pending', at: 1 },
      history: []
    }), 'utf8');
    writeCs({
      version: 1, goal: { text: '新文件里的真目标', source: 'autonomous', since: '' },
      topic: null, updatedAt: '',
      pending: [{ id: 'p-1', text: '新文件里的真待办', status: 'pending', source: 'autonomous', at: new Date().toISOString() }]
    });

    const s = cs.promptSection();
    ok('promptSection 只含新文件的', /新文件里的真目标/.test(s) && !/垃圾/.test(s), s);
    ok('activePending 只含新文件的', cs.activePending().length === 1 && cs.activePending()[0].text === '新文件里的真待办');

    // settleChatPending 也不该读旧字段
    markChatActivity(Date.now());
    ok('settleChatPending 不读旧字段', auto.settleChatPending() === false);
    ok('旧字段被改也不影响结算判断', readCs().pending[0].status === 'pending');
  }

  console.log('\n【⑪ 源码里运行时不再读写旧字段】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    const hits = src.split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter((x) => /st\.pendingNextStep|st\.currentGoal/.test(x.line));
    ok('index.js 里没有 st.pendingNextStep / st.currentGoal 的运行时使用', hits.length === 0,
      JSON.stringify(hits.map((x) => `${x.n}: ${x.line.trim()}`)));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
