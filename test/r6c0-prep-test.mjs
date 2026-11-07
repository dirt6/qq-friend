// R6-C0 专项测试：实验准备（环境隔离 / 凭据 / 场景 / 清理）。
//
// ⚠️ 本测试**不启动真实 DSH、不发请求、不消耗 token**。
//    只验证「实验准备工作本身是否正确」。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6c0t-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const E = await import(pathToFileURL(path.join(ROOT, 'scripts', 'r6c0', 'env.mjs')).href);
const C = await import(pathToFileURL(path.join(ROOT, 'scripts', 'r6c0', 'credentials.mjs')).href);
const S = await import(pathToFileURL(path.join(ROOT, 'scripts', 'r6c0', 'scenarios.mjs')).href);
const D = await import(pathToFileURL(path.join(ROOT, 'scripts', 'r6c0', 'cleanup.mjs')).href);

const created = [];
const mk = (tag) => { const e = E.createExperiment({ tag }); created.push(e.dirs.root); return e; };

try {
  console.log('【① 环境隔离：生产路径识别】');
  {
    const prod = E.productionPaths();
    ok('**appRoot 正确**', prod.appRoot === 'E:\\dsh\\QQ-agent', prod.appRoot);
    // ⚠️ 测试里设了 QQ_AGENT_DATA_DIR 指向临时目录，所以这里只验证
    //    「dataDir 要么在 appRoot 下，要么是显式指定的隔离目录」
    const dataDirOk = E.isInside(prod.appRoot, prod.dataDir)
      || path.resolve(prod.dataDir) === path.resolve(tmp);
    ok('**dataDir 在 appRoot 下（或显式隔离）**', dataDirOk, prod.dataDir);
    ok('**dshHome 在 dataDir 下**', E.isInside(prod.dataDir, prod.dshHome));
    ok('sessions 在 dshHome 下', E.isInside(prod.dshHome, prod.sessions));
  }

  console.log('\n【② 环境隔离：isInside 的边界安全】');
  {
    ok('**/exp 包含 /exp/a**', E.isInside('/exp', '/exp/a') === true);
    ok('**/exp 不包含 /exp2**（关键）', E.isInside('/exp', '/exp2') === false);
    ok('**/exp 包含自己**', E.isInside('/exp', '/exp') === true);
    ok('/exp 不包含 /exp/../other', E.isInside('/exp', '/exp/../other') === false);
  }

  console.log('\n【③ 环境隔离：创建的环境在生产之外】');
  {
    const e = mk('t1');
    const prod = E.productionPaths();
    ok('根目录存在', fs.existsSync(e.dirs.root));
    ok('**根目录不在生产里**',
      !E.isInside(prod.appRoot, e.dirs.root) && !E.isInside(prod.dataDir, e.dirs.root));
    ok('**根目录在系统临时目录里**', E.isInside(os.tmpdir(), e.dirs.root));
    ok('**目录名带实验前缀**', path.basename(e.dirs.root).startsWith('qq-r6c-'));
    ok('有 experiment.json', fs.existsSync(path.join(e.dirs.root, 'experiment.json')));

    const v = E.validateExperiment(e.dirs);
    ok('**validateExperiment 通过**', v.ok === true, JSON.stringify(v));

    // 五个子目录都在
    for (const k of ['dshHome', 'cwd', 'logs', 'results', 'tmp']) {
      ok(`子目录 ${k} 存在`, fs.existsSync(e.dirs[k]));
    }
  }

  console.log('\n【④ 环境隔离：拒绝非法实验目录】');
  {
    ok('**拒绝不存在的目录**', E.validateExperiment({ root: 'Z:\\nope\\qq-r6c-x' }).ok === false);
    ok('**拒绝没有前缀的目录**',
      E.validateExperiment({ root: os.tmpdir() }).ok === false);
    ok('**拒绝生产目录**',
      E.validateExperiment({ root: E.productionPaths().dataDir }).ok === false);
  }

  console.log('\n【⑤ 写入安全：实验内允许，生产拒绝】');
  {
    const e = mk('t2');
    ok('**写实验 results 允许**',
      E.assertSafeWrite(e.dirs, path.join(e.dirs.results, 'x.json')).ok === true);
    ok('**写生产 data 拒绝**',
      E.assertSafeWrite(e.dirs, path.join(E.productionPaths().dataDir, 'x.json')).ok === false);
    ok('**.. 穿越拒绝**',
      E.assertSafeWrite(e.dirs, path.join(e.dirs.results, '..', '..', '..', '..', 'evil.txt')).ok === false);
    ok('**空路径拒绝**', E.assertSafeWrite(e.dirs, '').ok === false);
  }

  console.log('\n【⑥ 快照：前后对比能发现变化】');
  {
    const e = mk('t3');
    const before = E.snapshot(e.dirs.root);
    fs.writeFileSync(path.join(e.dirs.results, 'a.json'), '{"x":1}', 'utf8');
    const after = E.snapshot(e.dirs.root);
    ok('快照有文件数', typeof before.count === 'number');
    ok('**新增文件后 count 变大**', after.count === before.count + 1, `${before.count} → ${after.count}`);
    ok('**hash 变了**', after.hash !== before.hash);
  }

  console.log('\n【⑦ 凭据：没有凭据时拒绝，且不回退生产】');
  {
    const e = mk('t4');
    const oldA = process.env[C.EXPERIMENT_KEY_ENV];
    const oldB = process.env[C.STANDARD_KEY_ENV];
    delete process.env[C.EXPERIMENT_KEY_ENV];
    delete process.env[C.STANDARD_KEY_ENV];

    const r = C.checkCredential(e.dirs);
    ok('**ok === false**', r.ok === false);
    ok('code 是 NO_CREDENTIAL', r.code === 'NO_CREDENTIAL', r.code);
    ok('**错误信息说「不会回退到生产配置」**', /不会.*回退到生产配置/.test(r.error || ''), r.error);
    ok('**没有泄露任何值**', !r.error?.includes('sk-'), r.error);

    if (oldA !== undefined) process.env[C.EXPERIMENT_KEY_ENV] = oldA;
    if (oldB !== undefined) process.env[C.STANDARD_KEY_ENV] = oldB;
  }

  console.log('\n【⑧ 凭据：脱敏只给长度，不给任何字符】');
  {
    ok('**maskKey 不含原文**', !C.maskKey('sk-secret1234567890').includes('secret'));
    ok('**只显示长度**', C.maskKey('sk-abc') === '****（长度 6）', C.maskKey('sk-abc'));
    ok('空值有明确表示', C.maskKey('') === '(空)');
  }

  console.log('\n【⑨ 凭据：泄露扫描能检出 sk- 格式】');
  {
    ok('**干净文本 clean=true**', C.scanForLeaks('普通日志：一切正常').clean === true);
    const leaked = C.scanForLeaks('key=sk-abcdefghijklmnopqrstuvwxyz');
    ok('**含 key 的文本 clean=false**', leaked.clean === false);
    ok('**命中列表有内容**', leaked.hits.length > 0, JSON.stringify(leaked.hits));
  }

  console.log('\n【⑩ 凭据：DSH_HOME 指向生产时拒绝】');
  {
    const e = mk('t5');
    const old = process.env.DSH_HOME;
    process.env.DSH_HOME = E.productionPaths().dshHome;
    const r = C.assertNoProductionCredential(e.dirs);
    ok('**ok === false**', r.ok === false, JSON.stringify(r));
    ok('**报错提到「可能读到生产凭据」**', /可能读到生产凭据/.test(r.error || ''), r.error);

    process.env.DSH_HOME = e.dirs.dshHome;
    ok('**指向实验内时通过**', C.assertNoProductionCredential(e.dirs).ok === true);

    if (old === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = old;
  }

  console.log('\n【⑪ 场景目录：8 个场景都在，且各有三态】');
  {
    const cat = S.scenarioCatalog();
    ok('**8 个场景**', cat.length === 8, String(cat.length));
    for (const sc of cat) {
      ok(`${sc.id} 有 purpose`, typeof sc.purpose === 'string' && sc.purpose.length > 10);
      ok(`${sc.id} 有 assertions`, Array.isArray(sc.assertions) && sc.assertions.length > 0);
      ok(`${sc.id} 有 notCovered`, Array.isArray(sc.notCovered));
      ok(`${sc.id} 有 minSamples`, Number(sc.minSamples) >= 1);
    }
    const ids = cat.map((s) => s.id);
    ok('编号是 S1~S8', JSON.stringify(ids) === JSON.stringify(['S1','S2','S3','S4','S5','S6','S7','S8']), JSON.stringify(ids));
  }

  console.log('\n【⑫ 三态判定：样本不足 = INCONCLUSIVE（不是 PASS）】');
  {
    ok('**样本 0 → INCONCLUSIVE**',
      S.decideVerdict({ samples: 0, requiredSamples: 1, allAssertionsPassed: true }).verdict === 'INCONCLUSIVE');
    ok('**样本 2 / 需要 10 → INCONCLUSIVE**',
      S.decideVerdict({ samples: 2, requiredSamples: 10, allAssertionsPassed: true }).verdict === 'INCONCLUSIVE');
    ok('**样本够 + 断言全过 → PASS**',
      S.decideVerdict({ samples: 10, requiredSamples: 10, allAssertionsPassed: true }).verdict === 'PASS');
    ok('**样本够 + 断言失败 → FAIL**',
      S.decideVerdict({ samples: 10, requiredSamples: 10, allAssertionsPassed: false, failures: 2 }).verdict === 'FAIL');
    ok('三态常量都在',
      S.VERDICT.PASS === 'PASS' && S.VERDICT.FAIL === 'FAIL' && S.VERDICT.INCONCLUSIVE === 'INCONCLUSIVE');
  }

  console.log('\n【⑬ P95 计算方法】');
  {
    const r = S.percentile95([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
    ok('**n = 10**', r.n === 10);
    ok('**p95 = 1000**（第 10 个）', r.p95 === 1000, String(r.p95));
    ok('**p50 = 500**', r.p50 === 500, String(r.p50));
    ok('**说明了计算方法**', /排序后取第 ceil/.test(r.method), r.method);
    ok('空数组给 null', S.percentile95([]) === null);
    ok('过滤非数字', S.percentile95([100, NaN, 'x', 200]).n === 2);
  }

  console.log('\n【⑭ 清理：拒绝一切危险路径】');
  {
    ok('**空路径拒绝**', D.checkDeletable('').ok === false);
    ok('**null 拒绝**', D.checkDeletable(null).ok === false);
    ok('**磁盘根拒绝**', D.checkDeletable('C:\\').ok === false);
    ok('**系统目录拒绝**', D.checkDeletable('C:\\Windows').ok === false);
    ok('**生产目录拒绝**', D.checkDeletable(E.productionPaths().dataDir).ok === false);
    ok('**无前缀临时目录拒绝**', D.checkDeletable(os.tmpdir()).ok === false);
    ok('**不存在的路径拒绝**', D.checkDeletable('Z:\\nope\\qq-r6c-x').ok === false);
  }

  console.log('\n【⑮ 清理：默认演练，不真删】');
  {
    const e = mk('t6');
    const r = D.cleanupExperiment(e.dirs.root);         // 默认 dryRun
    ok('**dryRun === true**', r.dryRun === true);
    ok('**deleted === false**', r.deleted === false);
    ok('**目录还在**', fs.existsSync(e.dirs.root));
    ok('有 before 快照', typeof r.before?.count === 'number');

    const r2 = D.cleanupExperiment(e.dirs.root, { dryRun: false });   // 没 confirm
    ok('**没 confirm 时拒绝真删**', r2.ok === false && r2.reason === 'NO_CONFIRM', JSON.stringify(r2));
    ok('**目录还在**', fs.existsSync(e.dirs.root));
  }

  console.log('\n【⑯ 清理：真删后目录消失，且记录了前后】');
  {
    const e = mk('t7');
    fs.writeFileSync(path.join(e.dirs.results, 'x.json'), '{}', 'utf8');
    const r = D.cleanupExperiment(e.dirs.root, { dryRun: false, confirm: true });
    ok('ok === true', r.ok === true);
    ok('**deleted === true**', r.deleted === true);
    ok('**目录没了**', !fs.existsSync(e.dirs.root));
    ok('before 有文件数', r.before.count >= 1, String(r.before?.count));
    ok('before 有 hash', typeof r.before.hash === 'string' && r.before.hash.length > 0);
  }

  console.log('\n【⑰ 场景结果骨架】');
  {
    const r = S.emptyResult('S1');
    ok('场景编号正确', r.scenario === 'S1');
    ok('**默认判定是 INCONCLUSIVE**（不是 PASS）', r.verdict === 'INCONCLUSIVE', r.verdict);
    ok('有 samples/failures/timeouts', 'samples' in r && 'failures' in r && 'timeouts' in r);
    ok('有 raw（原始证据）', Array.isArray(r.raw));
  }

  console.log('\n【⑱ 源码级：本模块不启动真实 DSH】');
  {
    for (const f of ['env.mjs', 'credentials.mjs', 'scenarios.mjs', 'cleanup.mjs']) {
      const src = fs.readFileSync(path.join(ROOT, 'scripts', 'r6c0', f), 'utf8');
      ok(`**${f} 不 spawn**`, !/\bspawn\(/.test(src));
      // 只查真正的**执行调用**（spawn/execFile），不查注释里提到的文件名
      ok(`**${f} 不执行 dsh**`,
        !/(spawn|execFile|exec)\s*\(\s*['"]cmd['"]/.test(src)
        && !/(spawn|execFile|exec)\s*\([^)]*dsh/i.test(src));
    }
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  // 清理本测试创建的所有实验目录
  for (const root of created) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
