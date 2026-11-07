// P0 专项测试：Chat Pending 去重与询问生命周期。
//
// 机主 2026-11-02 的要求：
//   ① 语义去重（0.7 + 长度比 + 冲突检查），**宁可保留两条也不错误合并**
//   ② askCount / lastAskedAt / waitingSince / lastAskRoundId
//   ③ 达到 3 次后静默，不再主动询问
//   ④ 静默后 prompt 只作状态背景，不诱导提问
//   ⑤ 普通 Pending 和等待回复分开筛选；普通 Pending **最新优先**
//   ⑥ 旧数据缺字段时兼容
//
// **三个硬条件**：
//   1. askCount 只在 out.mode === 'live' 后增加（不是 out.result === 'success'）
//   2. lastAskRoundId 参与幂等（同 Round 不重复计数）
//   3. bumpAskCount 失败不能让已发消息重发
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p0t-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const S = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);
const reset = () => { try { fs.rmSync(path.join(tmp, 'companion-state.json'), { force: true }); } catch { /* ignore */ } };

try {
  console.log('【① 常量集中配置】');
  {
    ok('**ASK_LIMIT === 3**', S.ASK_LIMIT === 3, String(S.ASK_LIMIT));
  }

  console.log('\n【② 归一化与相似度】');
  {
    ok('去标点', S.normalizeForDedup('等老大回话，好吗？') === '等对方回复好吗', S.normalizeForDedup('等老大回话，好吗？'));
    ok('同义词替换（老大→对方）', S.normalizeForDedup('等老大').includes('对方'));
    ok('同义词替换（回话→回复）', S.normalizeForDedup('回话').includes('回复'));
    ok('**完全相同的相似度是 1**', S.similarityOf('等老大回话', '等老大回话') === 1);
    ok('**完全不同的相似度低**', S.similarityOf('明天做题', '后天买菜') < 0.3, String(S.similarityOf('明天做题', '后天买菜')));
  }

  console.log('\n【③ 语义去重：不同事项不合并】');
  {
    ok('**共享等待对象但后续不同 → 不合并**',
      S.isSamePendingItem('等老大回复后翻评论', '等老大回复后决定是否修改架构') === false);
    ok('**完全不同的两件事 → 不合并**',
      S.isSamePendingItem('明天把算法题做完', '后天给老大买生日礼物') === false);
    ok('完全相同 → 合并', S.isSamePendingItem('等老大回话', '等老大回话') === true);
  }

  console.log('\n【④ addPending 语义去重】');
  {
    reset();
    const a = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    ok('第一条创建', a.ok === true);
    const b = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    ok('**完全相同 → 复用**', b.pending.id === a.pending.id, `${a.pending.id} vs ${b.pending.id}`);
    ok('总数还是 1', S.activePending().length === 1);

    const c = S.addPending({ text: '明天把算法题做完', source: 'autonomous' });
    ok('**不同事项 → 新建**', c.pending.id !== a.pending.id);
    ok('总数 2', S.activePending().length === 2);
  }

  console.log('\n【⑤ 新字段：askCount 等】');
  {
    reset();
    const r = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting', roundId: 'round-A' });
    const p = S.readCompanion().pending[0];
    ok('**askCount 初始 0**', p.askCount === 0, String(p.askCount));
    ok('lastAskedAt 空', p.lastAskedAt === '', p.lastAskedAt);
    ok('waitingSince 有值（waiting 状态）', Boolean(p.waitingSince));
    ok('silent 初始 false', p.silent === false);
    ok('**createdByRoundId 记了**', p.createdByRoundId === 'round-A', p.createdByRoundId);
  }

  console.log('\n【⑥ bumpAskCount：同一 Round 幂等】');
  {
    reset();
    const r = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    const id = r.pending.id;

    const b1 = S.bumpAskCount(id, { roundId: 'round-A' });
    ok('第一次 counted: true', b1.ok === true && b1.counted === true);
    ok('askCount = 1', S.readCompanion().pending[0].askCount === 1);

    const b2 = S.bumpAskCount(id, { roundId: 'round-A' });
    ok('**同一 Round 不重复计数**', b2.ok === true && b2.counted === false, JSON.stringify({ counted: b2.counted }));
    ok('askCount 还是 1', S.readCompanion().pending[0].askCount === 1);

    const b3 = S.bumpAskCount(id, { roundId: 'round-B' });
    ok('新 Round 才 +1', b3.counted === true && S.readCompanion().pending[0].askCount === 2);
  }

  console.log('\n【⑦ 达到 3 次 → silent】');
  {
    reset();
    const r = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    const id = r.pending.id;
    S.bumpAskCount(id, { roundId: 'r1' });
    S.bumpAskCount(id, { roundId: 'r2' });
    ok('2 次时还没静默', S.readCompanion().pending[0].silent === false);
    S.bumpAskCount(id, { roundId: 'r3' });
    const p = S.readCompanion().pending[0];
    ok('**3 次后 silent = true**', p.silent === true, String(p.silent));
    ok('**isSilentWaiting 也认**', S.isSilentWaiting(p) === true);
    ok('**不是终态**（status 还是 waiting，用户回复仍能结算）', p.status === 'waiting', p.status);
  }

  console.log('\n【⑧ 已结算的不再计数】');
  {
    reset();
    const r = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    S.settlePending(r.pending.id, 'done');
    const before = S.readCompanion().pending[0].askCount;
    const b = S.bumpAskCount(r.pending.id, { roundId: 'rx' });
    ok('**结算后 bump 不计数**', b.counted !== true);
    ok('askCount 没变', S.readCompanion().pending[0].askCount === before);
  }

  console.log('\n【⑨ promptSection：普通和等待分开】');
  {
    reset();
    S.addPending({ text: '明天把算法题做完', source: 'autonomous' });
    S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    const sec = S.promptSection();
    ok('**普通待办在「还没做完的」**', /还没做完的：.*算法题/.test(sec), sec);
    ok('**等回话在「在等他回的」**', /在等他回的：/.test(sec), sec);
    ok('**两段分开，不混在一起**', !/还没做完的：.*等老大回话/.test(sec), sec);
  }

  console.log('\n【⑩ promptSection：静默后明确「别再问了」】');
  {
    reset();
    const r = S.addPending({ text: '等老大回话', source: 'autonomous', status: 'waiting' });
    S.bumpAskCount(r.pending.id, { roundId: 'r1' });
    S.bumpAskCount(r.pending.id, { roundId: 'r2' });
    S.bumpAskCount(r.pending.id, { roundId: 'r3' });
    const sec = S.promptSection();
    ok('**有「已经问过，等他自己说，别再问了」**', /已经问过，等他自己说，别再问了/.test(sec), sec);
    ok('**不再出现在「在等他回的」段**', !/在等他回的：.*等老大回话/.test(sec), sec);
  }

  console.log('\n【⑪ promptSection：等待回复最多列 1 条】');
  {
    reset();
    for (let i = 0; i < 5; i += 1) {
      S.addPending({ text: `等老大回话第${i}件事`, source: 'autonomous', status: 'waiting' });
    }
    const sec = S.promptSection();
    const waitPart = (sec.match(/在等他回的：[^\n]*/) || [''])[0];
    ok('**只列 1 条 + 数量提示**', /另有 \d+ 件类似的/.test(waitPart), waitPart);
    const count = (waitPart.match(/；/g) || []).length;
    ok('段内没有用分号列多条', count === 0, waitPart);
  }

  console.log('\n【⑫ promptSection：普通待办最新优先】');
  {
    reset();
    S.addPending({ text: '最老的事', source: 'autonomous' });
    await new Promise((r) => setTimeout(r, 5));
    S.addPending({ text: '中间的事', source: 'autonomous' });
    await new Promise((r) => setTimeout(r, 5));
    S.addPending({ text: '最新的事', source: 'autonomous' });
    const sec = S.promptSection();
    const first = (sec.match(/还没做完的：([^；\n]+)/) || [])[1] || '';
    ok('**第一条是最新的**', first === '最新的事', first);
  }

  console.log('\n【⑬ 旧数据兼容：没有新字段也能读】');
  {
    reset();
    fs.writeFileSync(path.join(tmp, 'companion-state.json'), JSON.stringify({
      version: 2,
      goals: [], topic: null, updatedAt: '',
      pending: [{ id: 'old-1', text: '等老大回话', status: 'waiting', source: 'autonomous', at: '2026-11-01T00:00:00Z' }]
    }));
    const st = S.readCompanion();
    ok('能读', st.pending.length === 1);
    const m = S.askMetaOf(st.pending[0]);
    ok('**askCount 默认 0**', m.askCount === 0, String(m.askCount));
    ok('**silent 默认 false**', m.silent === false);
    ok('isSilentWaiting 判 false', S.isSilentWaiting(st.pending[0]) === false);
    // 旧数据也能 bump
    const b = S.bumpAskCount('old-1', { roundId: 'r1' });
    ok('**旧数据也能 bump**', b.ok === true && b.counted === true);
    ok('bump 后写入了新字段', S.readCompanion().pending[0].askCount === 1);
  }

  console.log('\n【⑭ 其他普通 Pending 行为不受影响】');
  {
    reset();
    const r = S.addPending({ text: '明天查资料', source: 'chat' });
    ok('普通 pending 创建正常', r.ok === true && r.pending.status === 'pending');
    const s = S.settlePending(r.pending.id, 'done');
    ok('结算正常', s.ok === true);
    ok('**普通 pending 不参与 askCount 逻辑**（初始就是 0）', S.readCompanion().pending[0].askCount === 0);
  }

  console.log('\n【⑭b P3：等待回复文本识别（含用户点名的用例）】');
  {
    const shouldWait = [
      ['看你怎么答', '用户点名'],
      ['看老大怎么答', '用户点名'],
      ['等他回复', '用户点名'],
      ['他回话后再一起看', '用户点名'],
      ['回了就一起翻评论，没回就下次再问', '用户点名'],
      ['看老大怎么答，再顺着他的说法掰扯两句', '生产 p-8dc134'],
      ['等老大回一句，再翻翻评论里有没有人吐槽这架构', '生产'],
      ['他回话就一起看 dsh-honcho 评论', '生产']
    ];
    for (const [t, why] of shouldWait) {
      ok(`**应识别为等待**（${why}）：${t}`, S.looksLikeWaitingText(t) === true);
    }

    const shouldNot = [
      ['查看回复情况', '**普通查看**'],
      ['查看一下昨天的记录', '不是等待'],
      ['明天把算法题做完', '无关'],
      ['看看有没有人吐槽架构', '不是等他'],
      ['翻翻评论看看别人怎么说', '不是等他'],
      ['他昨天回了，但我没回他', '**陈述句，不是等他**'],
      ['老大说了明天的计划', '不是等待']
    ];
    for (const [t, why] of shouldNot) {
      ok(`**不应识别**（${why}）：${t}`, S.looksLikeWaitingText(t) === false);
    }
  }

  console.log('\n【⑮ 源码级：bump 只在 live 后调】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'plugins', 'autonomous', 'index.js'), 'utf8');
    ok('**有 out.mode === live 判断**', /outcome\.mode === 'live'/.test(src), '');
    // 注释是跨行的，用 [\s\S] 匹配
    ok('**注释说明了为什么不用 result**', /out\.result === 'success'[\s\S]{0,120}不算真问过/.test(src), '');
    ok('**bump 失败只 warn，不回滚**', /询问计数失败（消息已发出，不影响本轮）/.test(src));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
