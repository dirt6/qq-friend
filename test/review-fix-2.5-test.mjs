// 2.5 审查修复的针对性测试（4 项）。
//
// 机主指定的四项：
//   ① 时间条件不满足时，pending 未结算，goal 不得清除
//   ② pending 成功结算且文本匹配时，goal 正常清除
//   ③ 消息数组乱序时，返回最大有效时间戳
//   ④ 无效时间戳不会污染最大值
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-'));
const dataDir = tmp;
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' },
  skills: { autonomous: { enabled: true } }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const auto = await import(pathToFileURL(path.join(ROOT, 'plugins', 'autonomous', 'index.js')).href);

const CS = path.join(dataDir, 'companion-state.json');
const MSG = path.join(dataDir, 'messages', 'private_10001.json');

const writeCs = (o) => fs.writeFileSync(CS, JSON.stringify(o), 'utf8');
const readCs = () => JSON.parse(fs.readFileSync(CS, 'utf8'));
// 2.6.1 起文件里是 goals 数组
const activeG = (st) => {
  const s = st || readCs();
  // 2.6.1：文件可能是旧格式（只有 goal），也可能是新格式（goals 数组）
  if (Array.isArray(s.goals)) return s.goals.find((g) => g.status === 'active') || null;
  return s.goal && s.goal.text ? s.goal : null;
};
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };
const writeMsgs = (arr) => fs.writeFileSync(MSG, JSON.stringify({ messages: arr }), 'utf8');
const resetMsgs = () => { try { fs.rmSync(MSG, { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 时间条件不满足 → 不结算，goal 不清】');
  {
    resetCs(); resetMsgs();
    const future = Date.now() + 3600e3;          // 待办在未来
    writeCs({
      version: 1,
      goal: { text: '等老大回话', source: 'autonomous', since: new Date().toISOString() },
      topic: null, updatedAt: '',
      pending: [{
        id: 'p-future', text: '等老大回话', status: 'waiting',
        source: 'autonomous', at: new Date(future).toISOString()
      }]
    });
    // 用户消息早于待办创建时间
    writeMsgs([{ id: 1, mid: 1, ts: Date.now(), text: '在吗', self: false }]);

    const r = auto.settleChatPending();
    ok('返回 false（没结算）', r === false, String(r));
    const after = readCs();
    ok('pending 仍是 waiting', after.pending[0].status === 'waiting', after.pending[0].status);
    ok('**goal 没被清**', activeG(after)?.text === '等老大回话', JSON.stringify(activeG(after)));
  }

  console.log('\n【② 成功结算且文本匹配 → goal 正常清除】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1,
      goal: { text: '等老大回话', source: 'autonomous', since: new Date(past).toISOString() },
      topic: null, updatedAt: '',
      pending: [{
        id: 'p-ok', text: '等老大回话', status: 'waiting',
        source: 'autonomous', at: new Date(past).toISOString()
      }]
    });
    writeMsgs([{ id: 1, mid: 1, ts: Date.now(), text: '嗯我回来了', self: false }]);

    const r = auto.settleChatPending();
    ok('返回 true', r === true, String(r));
    const after = readCs();
    ok('pending 变 done', after.pending[0].status === 'done');
    ok('**goal 被清（文本匹配）**', activeG(after) === null, JSON.stringify(activeG(after)));
  }

  console.log('\n【③ 消息数组乱序 → 返回最大有效时间戳】');
  {
    resetCs(); resetMsgs();
    const t1 = 1793000000000;
    const t2 = 1793000600000;   // 最大
    const t3 = 1793000300000;
    // 故意乱序：t2 在中间，t1 在最后
    writeMsgs([
      { id: 1, mid: 1, ts: t1, text: '第一条', self: false },
      { id: 2, mid: 2, ts: t2, text: '第二条（时间最大）', self: false },
      { id: 3, mid: 3, ts: t3, text: '第三条', self: false },
      { id: 4, mid: 4, ts: t1 - 1000, text: '末尾但时间最早', self: false }
    ]);
    const got = auto.lastUserMessageAt();
    ok('返回最大时间戳', got === t2, `${got} vs ${t2}`);
    ok('**不是数组末尾那条**', got !== (t1 - 1000), String(got));
  }

  console.log('\n【④ 无效时间戳不污染最大值】');
  {
    resetCs(); resetMsgs();
    const good = 1793000000000;
    writeMsgs([
      { id: 1, mid: 1, ts: good, text: '有效的', self: false },
      { id: 2, mid: 2, ts: NaN, text: 'NaN', self: false },
      { id: 3, mid: 3, ts: 'NotADate', text: '字符串', self: false },
      { id: 4, mid: 4, ts: 0, text: '零', self: false },
      { id: 5, mid: 5, ts: -1, text: '负数', self: false },
      { id: 6, mid: 6, ts: null, text: 'null', self: false },
      { id: 7, mid: 7, ts: undefined, text: 'undefined', self: false }
    ]);
    const got = auto.lastUserMessageAt();
    ok('返回有效值', got === good, `${got} vs ${good}`);
    ok('**没被 NaN / 字符串 / 0 / 负数污染**', Number.isFinite(got) && got === good);

    // 全是无效值 → 返回 0
    resetMsgs();
    writeMsgs([
      { id: 1, mid: 1, ts: NaN, text: 'x', self: false },
      { id: 2, mid: 2, ts: 'bad', text: 'y', self: false }
    ]);
    ok('全无效时返回 0', auto.lastUserMessageAt() === 0, String(auto.lastUserMessageAt()));
  }

  console.log('\n【⑤ 机器人的消息不参与最大值】');
  {
    resetCs(); resetMsgs();
    const userTs = 1793000000000;
    writeMsgs([
      { id: 1, mid: 1, ts: userTs, text: '老大说的', self: false },
      { id: 2, mid: 2, ts: userTs + 999999, text: '她自己说的（更晚）', self: true }
    ]);
    ok('只返回老大的时间', auto.lastUserMessageAt() === userTs, String(auto.lastUserMessageAt()));
  }

  console.log('\n【⑥ 混合场景：一条结算一条不结算，goal 只跟结算的那条匹配】');
  {
    resetCs(); resetMsgs();
    const past = Date.now() - 3600e3;
    writeCs({
      version: 1,
      goal: { text: '未来那条等待', source: 'autonomous', since: new Date().toISOString() },
      topic: null, updatedAt: '',
      pending: [
        { id: 'p-now', text: '现在这条等待', status: 'waiting', source: 'autonomous', at: new Date(past).toISOString() },
        { id: 'p-later', text: '未来那条等待', status: 'waiting', source: 'autonomous', at: new Date(Date.now() + 3600e3).toISOString() }
      ]
    });
    writeMsgs([{ id: 1, mid: 1, ts: Date.now(), text: '在吗', self: false }]);

    auto.settleChatPending();
    const after = readCs();
    ok('早的那条结算了', after.pending.find((p) => p.id === 'p-now').status === 'done');
    ok('未来那条没结算', after.pending.find((p) => p.id === 'p-later').status === 'waiting');
    ok('**goal 没被清**（它匹配的是没结算的那条）',
      activeG(after)?.text === '未来那条等待', JSON.stringify(activeG(after)));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
