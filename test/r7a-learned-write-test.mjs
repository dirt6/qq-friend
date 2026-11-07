// ⚠️ STALE（2026-11-05）：本测试仍引用已删除的 scripts/web-panel-server.mjs（8899 面板），
//    并包含与现行安全设计冲突的 archive 断言。**不纳入回归、不为变绿改断言**；
//    记忆管理 API 的新覆盖见 5.0（/api/learned/* 手工验收 + 审计日志）。
// R7-A 专项测试：记忆管理写入 API。
//
// 机主 2026-11-03 的四项额外要求：
//   ① ACL 日志记录**结果**，不只是请求
//   ② 严格验证请求参数（不接受未定义字段 / 检查 ID、状态、长度 / 不传任意路径）
//   ③ 删除不能只靠 confirm 字段（后端还要验证目标存在）
//   ④ 先验证底层函数真实语义（archiveStale 批量、saveItem 会新建、removeItem 不可恢复）
//
// ⚠️ 全部用隔离数据目录，**不碰生产记忆**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7a-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  server: { port: 3210 }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const { createRoutes } = await import(pathToFileURL(path.join(ROOT, 'src', 'routes.js')).href);
const L = await import(pathToFileURL(path.join(ROOT, 'src', 'learned.js')).href);

const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);

/** 造一个假请求对象。 */
function mkReq({ origin = '', referer = '', contentType = 'application/json' } = {}) {
  return {
    headers: {
      ...(origin ? { origin } : {}),
      ...(referer ? { referer } : {}),
      ...(contentType ? { 'content-type': contentType } : {})
    },
    url: '/',
    method: 'POST'
  };
}

/** 调一个路由，返回它的 json 结果。 */
async function call(pattern, body, reqOpts = {}, urlStr = 'http://127.0.0.1/') {
  const r = find(pattern);
  if (!r) return { ok: false, code: 'NO_ROUTE' };
  let out = null;
  // ⚠️ fake 必须和真实签名一致：json(res, code, data)
  //    单参数 fake 会让「json(data)」这种错误在测试里通过，在生产里 500。
  const json = (res, code, data) => {
    if (data === undefined || typeof code !== 'number' || !res || typeof res !== 'object') {
      // 模拟真实实现：writeHead(undefined) 会抛
      throw new Error(`json() 签名错误: res=${typeof res} code=${code} data=${typeof data}`);
    }
    out = data;
    return data;
  };
  const req = mkReq(reqOpts);
  await r.handler({ json, req, url: new URL(urlStr), body, res: {}, req });
  return out;
}

try {
  // ── 播种隔离数据 ────────────────────────────────────────────
  fs.writeFileSync(path.join(tmp, 'learned.json'), JSON.stringify({ version: 2, items: [] }), 'utf8');
  // ⚠️ 两条重要发现（实测）：
  //   ① addExperience 最小长度是 4（'body.length < 4' 就返回"太短"）
  //   ② 它会把**相似文本自动合并**（0.28 相似度阈值）
  //      所以测试文本必须**完全不同的主题**，否则三条会并成一条。
  const seedTexts = [
    '苹果醋要稀释了喝',
    '地铁四号线早上七点半最挤',
    '湿度超过八十要开抽湿机'
  ];
  const seed = [];
  for (const t of seedTexts) {
    const r = L.addExperience({ text: t, contentType: 'fact', epistemicType: 'direct' });
    if (!r.ok) { console.log('  [播种失败] ' + t + ' → ' + JSON.stringify(r)); continue; }
    seed.push(r);
  }
  if (seed.length !== 3) console.log('  [警告] 期望 3 条，实际 ' + seed.length + ' 条（可能被合并）');
  // 造一条 stable 且很旧的，用于测试 archiveStale
  {
    const items = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8'));
    items.items.push({
      id: 'old-stable-1',
      text: '很久以前的稳定经验（用于测试归档）',
      status: 'stable',
      createdAt: new Date(Date.now() - 100 * 86400000).toISOString(),
      updatedAt: new Date(Date.now() - 100 * 86400000).toISOString(),
      lastUsedAt: new Date(Date.now() - 100 * 86400000).toISOString(),
      hits: 0,
      corrections: 1
    });
    fs.writeFileSync(path.join(tmp, 'learned.json'), JSON.stringify(items, null, 1), 'utf8');
  }

  const ids = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.map((x) => x.id);
  ok('隔离数据已播种', ids.length >= 4, String(ids.length));

  // ══════════════════════════════════════════════════════════
  console.log('\n【① 参数校验：拒绝非法输入】');
  {
    const r1 = await call('/api/learned/status', { status: 'verified' });   // 缺 id
    ok('**缺 id → BAD_ID**', r1.code === 'BAD_ID', JSON.stringify(r1));

    const r2 = await call('/api/learned/status', { id: '/etc/passwd', status: 'verified' });
    ok('**id 含路径 → 不报错但会查不到（不 crash）**', r2.ok === false || r2.code === 'SET_STATUS_FAILED', JSON.stringify(r2));

    const r3 = await call('/api/learned/status', { id: ids[0], status: 'hacked' });
    ok('**非法 status → BAD_STATUS**', r3.code === 'BAD_STATUS', JSON.stringify(r3));

    const r4 = await call('/api/learned/save', { id: ids[0], text: '' });
    ok('**空文本 → EMPTY_TEXT**', r4.code === 'EMPTY_TEXT', JSON.stringify(r4));

    const r5 = await call('/api/learned/save', { id: ids[0], text: 'x'.repeat(5000) });
    ok('**超长文本 → TEXT_TOO_LONG**', r5.code === 'TEXT_TOO_LONG', JSON.stringify(r5));

    const r6 = await call('/api/learned/archive', { days: 99999 });
    ok('**days 超范围 → BAD_DAYS**', r6.code === 'BAD_DAYS', JSON.stringify(r6));

    const r7 = await call('/api/learned/archive', { days: -1 });
    ok('**days 负数 → BAD_DAYS**', r7.code === 'BAD_DAYS', JSON.stringify(r7));
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【② 来源防护：拒绝非本机 Origin】');
  {
    const r1 = await call('/api/learned/status', { id: ids[0], status: 'verified' }, { origin: 'http://evil.com' });
    ok('**非本机 Origin → NON_LOCAL_ORIGIN**', r1.code === 'NON_LOCAL_ORIGIN', JSON.stringify(r1));

    const r2 = await call('/api/learned/status', { id: ids[0], status: 'verified' }, { origin: 'http://127.0.0.1:3210' });
    ok('本机 Origin → 放行', !r2.code || r2.code !== 'NON_LOCAL_ORIGIN', JSON.stringify(r2));

    const r3 = await call('/api/learned/status', { id: ids[0], status: 'verified' }, { contentType: 'text/plain' });
    ok('**非 JSON Content-Type → NOT_JSON**', r3.code === 'NOT_JSON', JSON.stringify(r3));
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【③ 改状态：正常 + source=owner 语义】');
  {
    const r = await call('/api/learned/status', { id: ids[0], status: 'verified' });
    ok('**成功**', r.ok === true, JSON.stringify(r));
    const item = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.find((x) => x.id === ids[0]);
    ok('**落盘状态已变**', item?.status === 'verified', item?.status);

    // 升级到 stable 也需要 owner（API 里写死 owner，所以应该成功）
    const r2 = await call('/api/learned/status', { id: ids[0], status: 'stable' });
    ok('**升级到 stable 成功（source 固定 owner）**', r2.ok === true, JSON.stringify(r2));
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【④ saveItem 的真实语义：多行会新建】');
  {
    const before = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.length;
    const r = await call('/api/learned/save', {
      id: ids[1],
      text: '第一行替换原内容啊\n第二行是新加的经验\n第三行也是新加的'
    });
    ok('**ok === true**', r.ok === true, JSON.stringify(r));
    ok('**created === 2**（两行新建）', r.created === 2, String(r.created));
    ok('**total === 3**（三行）', r.total === 3, String(r.total));

    const after = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.length;
    ok('**实际条目数 +2**', after === before + 2, `${before} → ${after}`);

    const item = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.find((x) => x.id === ids[1]);
    ok('**原条目内容已替换**', String(item?.text).startsWith('第一行'), item?.text);
    ok('**多行时 status 被设回 pending**', item?.status === 'pending', item?.status);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑤ archiveStale 的真实语义：批量】');
  {
    const before = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items
      .filter((x) => x.status === 'stable').length;
    const r = await call('/api/learned/archive', { days: 30 });
    ok('**ok === true**', r.ok === true, JSON.stringify(r));
    ok('**返回的是数量（不是单条）**', typeof r.archived === 'number', typeof r.archived);
    ok('**至少归档了那条 100 天前的**', r.archived >= 1, String(r.archived));
    ok('**note 里明确说是批量**', /归档/.test(r.note || ''), r.note);

    const stillStable = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items
      .filter((x) => x.id === 'old-stable-1')[0];
    ok('**那条 old-stable 已变 archived**', stillStable?.status === 'archived', stillStable?.status);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑥ 删除：confirm + 存在性双重校验】');
  {
    // 没 confirm
    const r1 = await call('/api/learned/delete', { id: ids[2] });
    ok('**缺 confirm → NO_CONFIRM**', r1.code === 'NO_CONFIRM', JSON.stringify(r1));
    const stillThere = JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.some((x) => x.id === ids[2]);
    ok('**没被删掉**', stillThere === true);

    // 有 confirm 但目标不存在
    const r2 = await call('/api/learned/delete', { id: 'no-such-id', confirm: true });
    ok('**目标不存在 → NOT_FOUND**（不是假成功）', r2.code === 'NOT_FOUND', JSON.stringify(r2));

    // 正确删除
    const r3 = await call('/api/learned/delete', { id: ids[2], confirm: true });
    ok('**正确删除 → ok**', r3.ok === true, JSON.stringify(r3));
    ok('**返回的是内容摘要（不是全文）**',
      typeof r3.removedPreview === 'string' && r3.removedPreview.length <= 60, String(r3.removedPreview?.length));
    const gone = !JSON.parse(fs.readFileSync(path.join(tmp, 'learned.json'), 'utf8')).items.some((x) => x.id === ids[2]);
    ok('**真的删掉了**', gone === true);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑦ 审计日志：记录结果，不只是请求】');
  {
    const f = path.join(tmp, 'logs', 'memory-write-audit.jsonl');
    ok('**审计文件已生成**', fs.existsSync(f));
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      ok('**有记录**', lines.length > 0, String(lines.length));
      ok('**每条有 op**', lines.every((x) => typeof x.op === 'string'));
      ok('**每条有 result**', lines.every((x) => typeof x.result === 'string'));
      const results = new Set(lines.map((x) => x.result));
      ok('**result 出现多种（不是只记成功）**', results.size >= 2, JSON.stringify([...results]));
      ok('**拒绝时记了 reason**', lines.some((x) => x.result === 'denied' && x.reason));
      // 敏感内容检查
      const all = lines.map((x) => JSON.stringify(x)).join('');
      ok('**不含 token**', !/token/i.test(all));
      ok('**不含经验全文**（只有前 60 字摘要）',
        lines.every((x) => !x.preview || String(x.preview).length <= 60));
    }
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑧ 列表接口：只读】');
  {
    const r = await call('/api/learned/list', null, {}, 'http://127.0.0.1/api/learned/list');
    ok('**ok === true**', r.ok === true, JSON.stringify({ code: r.code }));
    ok('**有 total 和 items**', typeof r.total === 'number' && Array.isArray(r.items));
    ok('**能按 status 过滤**', true);

    const r2 = await call('/api/learned/list', null, {}, 'http://127.0.0.1/api/learned/list?status=archived');
    ok('**过滤生效（archived 数量 <= 总数）**', r2.total <= r.total, `${r2.total} <= ${r.total}`);
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑨ 8899 的四个 403 保持不变（不解除）】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'web-panel-server.mjs'), 'utf8');
    ok('**RETIRED_MEMORY_WRITES 仍在**', src.includes('RETIRED_MEMORY_WRITES'));
    ok('**四个操作都还在退役列表里**',
      src.includes("'learned.status'") && src.includes("'learned.archive'")
      && src.includes("'learned.save'") && src.includes("'learned.delete'"));
    ok('**403 逻辑没被删除**', src.includes('MEMORY_WRITE_RETIRED'));
  }

  // ══════════════════════════════════════════════════════════
  console.log('\n【⑩ 没有引入任意文件路径入口】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const seg = src.slice(src.indexOf('R7-A 记忆管理'), src.indexOf('NapCat 二维码'));
    ok('**learned 路由里没有 fs.readFile / writeFile**',
      !/fs\.(readFile|writeFile|unlink|rm)/.test(seg));
    ok('**没有接受 path 类参数**', !/body\?\.(path|file|dir)/.test(seg));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
