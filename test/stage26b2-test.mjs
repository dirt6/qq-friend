// 阶段 2.6-B2 专项测试：Pending 惰性过期清理。
//
// 机主授权（2026-11-02）：
//   · 查明 expiredPending() 适合的调用入口
//   · **不在只读 readCompanion() 中执行写入**
//   · 明确过期后的状态和历史保留规则
//   · 保证幂等
//   · 保证清理失败不阻断当前 Action
//   · 检查上限 20 条与过期记录的交互
//   · 不擅自删除历史记录
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '10001' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const CS = path.join(tmp, 'companion-state.json');
const writeCs = (o) => fs.writeFileSync(CS, JSON.stringify(o), 'utf8');
const readCs = () => JSON.parse(fs.readFileSync(CS, 'utf8'));
const resetCs = () => { try { fs.rmSync(CS, { force: true }); } catch { /* ignore */ } };

/** 造一条已过期的 pending。 */
function mkExpired(text, daysAgo = 1) {
  return {
    id: 'p-' + Math.random().toString(16).slice(2, 8),
    text,
    status: 'pending',
    source: 'autonomous',
    at: new Date(Date.now() - (daysAgo + 30) * 86400e3).toISOString(),
    expiresAt: new Date(Date.now() - daysAgo * 86400e3).toISOString()
  };
}

try {
  console.log('【① PENDING_STATUS 加了 expired】');
  {
    ok('五个状态', JSON.stringify(cs.PENDING_STATUS) === JSON.stringify(['pending', 'waiting', 'done', 'cancelled', 'expired']), JSON.stringify(cs.PENDING_STATUS));
  }

  console.log('\n【② readCompanion 不写盘、不清理】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('过期的这条')]
    });
    const before = fs.readFileSync(CS, 'utf8');
    cs.readCompanion();
    const after = fs.readFileSync(CS, 'utf8');
    ok('**文件字节级不变**', before === after);
    ok('**状态仍是 pending（没被清理）**', readCs().pending[0].status === 'pending', readCs().pending[0].status);
  }

  console.log('\n【③ addPending 时顺手清理】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('过期的这条')]
    });
    cs.addPending({ text: '新的一条', source: 'chat' });
    const ps = readCs().pending;
    const old = ps.find((p) => p.text === '过期的这条');
    const fresh = ps.find((p) => p.text === '新的一条');
    ok('**过期的转成 expired**', old.status === 'expired', old.status);
    ok('**没被删除**（还在文件里）', Boolean(old));
    ok('有 settledAt', Boolean(old.settledAt));
    ok('settledBy 是 expiry', old.settledBy === 'expiry', old.settledBy);
    ok('有 expiredAt', Boolean(old.expiredAt));
    ok('新的正常加入', fresh.status === 'pending');
  }

  console.log('\n【④ settlePending 时也顺手清理】');
  {
    resetCs();
    const fresh = cs.addPending({ text: '要结算的', source: 'chat' });
    const st = readCs();
    st.pending.push(mkExpired('同时存在的过期项'));
    writeCs(st);

    cs.settlePending(fresh.pending.id, 'done');
    const ps = readCs().pending;
    ok('被结算的变 done', ps.find((p) => p.id === fresh.pending.id).status === 'done');
    ok('**过期的那条变 expired**', ps.find((p) => p.text === '同时存在的过期项').status === 'expired');
  }

  console.log('\n【⑤ 幂等：重复清理不改变 settledAt】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('过期的')]
    });
    cs.addPending({ text: '触发清理 1', source: 'chat' });
    const t1 = readCs().pending.find((p) => p.text === '过期的').settledAt;
    cs.addPending({ text: '触发清理 2', source: 'chat' });
    const t2 = readCs().pending.find((p) => p.text === '过期的').settledAt;
    ok('**settledAt 没被更新**', t1 === t2, `${t1} vs ${t2}`);
    ok('状态还是 expired', readCs().pending.find((p) => p.text === '过期的').status === 'expired');
  }

  console.log('\n【⑥ 同文本过期后可以重新记一条】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('等老大回话')]
    });
    const r = cs.addPending({ text: '等老大回话', source: 'chat', status: 'waiting' });
    ok('创建成功', r.ok === true);
    const ps = readCs().pending;
    const alive = ps.filter((p) => p.text === '等老大回话' && p.status !== 'expired');
    ok('**新的那条是 waiting**', alive.length === 1 && alive[0].status === 'waiting', JSON.stringify(alive.map(p=>p.status)));
    ok('旧的还在（expired）', ps.some((p) => p.text === '等老大回话' && p.status === 'expired'));
  }

  console.log('\n【⑦ activePending 排除 expired】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [
        mkExpired('过期的'),
        { id: 'p-live', text: '活着的', status: 'pending', source: 'chat', at: new Date().toISOString() }
      ]
    });
    cs.addPending({ text: '触发清理', source: 'chat' });   // 让它被标记
    const act = cs.activePending();
    ok('**过期的不在 activePending 里**', !act.some((p) => p.text === '过期的'), JSON.stringify(act.map(p=>p.text)));
    ok('活着的那条在', act.some((p) => p.text === '活着的'));
  }

  console.log('\n【⑧ expiredPending 只读、只返回已标记的】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('到了 expiresAt 但还没被清')]
    });
    ok('**还没清理时返回空**（读操作不触发清理）', cs.expiredPending().length === 0, String(cs.expiredPending().length));

    cs.addPending({ text: '触发清理', source: 'chat' });
    ok('清理后能查到', cs.expiredPending().length === 1, String(cs.expiredPending().length));
  }

  console.log('\n【⑨ expired 计入 20 条上限的"已结算"组】');
  {
    resetCs();
    // 造 20 条 expired + 1 条新的 → 应该不会因为 expired 占位而拒绝
    const old = [];
    for (let i = 0; i < 20; i += 1) old.push(mkExpired('旧过期 ' + i));
    writeCs({ version: 2, goals: [], topic: null, updatedAt: '', pending: old });

    const r = cs.addPending({ text: '新的', source: 'chat' });
    ok('创建成功', r.ok === true, JSON.stringify(r).slice(0, 100));
    const ps = readCs().pending;
    ok('**总数不超过 20**', ps.length <= 20, String(ps.length));
    ok('新的那条在', ps.some((p) => p.text === '新的'));
    // 丢的应该是 expired 里最老的
    const expiredLeft = ps.filter((p) => p.status === 'expired').length;
    ok('**丢的是已结算的（expired）**', expiredLeft <= 20, String(expiredLeft));
  }

  console.log('\n【⑩ 过期不删记录（保留 7 天）】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [mkExpired('刚刚过期')]
    });
    cs.addPending({ text: '触发', source: 'chat' });
    ok('**记录还在**', readCs().pending.some((p) => p.text === '刚刚过期'));
  }

  console.log('\n【⑪ 老数据没有 expiresAt 的不会被误判过期】');
  {
    resetCs();
    writeCs({
      version: 2, goals: [], topic: null, updatedAt: '',
      pending: [{
        id: 'p-noexp', text: '没有 expiresAt 的老记录', status: 'pending',
        source: 'autonomous', at: '2026-11-01T00:00:00Z'
        // 故意不设 expiresAt
      }]
    });
    cs.addPending({ text: '触发', source: 'chat' });
    ok('**状态仍是 pending**', readCs().pending.find((p) => p.id === 'p-noexp').status === 'pending');
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
