// 兄弟进程诊断专项测试（R8-0-A3 降级后）。
//
// 目标：确认 killStaleSiblings 已降级为 **只读诊断**：
//   · 不调用 process.kill / taskkill / Stop-Process；
//   · 返回 { found, error }，记录 PID / 命令行 / 启动时间 / 是否早于本实例；
//   · 不给 appRoot 时安全拒绝。
import fs from 'node:fs';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; }
  else { fail += 1; failures.push({ name, detail }); console.log(`✗ ${name}${detail ? ' -> ' + detail : ''}`); }
}

const src = fs.readFileSync(path.resolve('src/instance-lock.js'), 'utf8');

// ══════════════════════════════════════════════════════════════
// ① 静态检查：只诊断，不杀
// ══════════════════════════════════════════════════════════════
ok('**导出 diagnoseSiblings**', src.includes('export function diagnoseSiblings'));
ok('**没有用 process.kill 发送终止信号**', !/process\.kill\(\s*pid\s*,\s*['"]SIG/.test(src));
ok('**没有通过 kill 发 SIGTERM/SIGKILL**', !/kill\([^)]*SIG(TERM|KILL)/.test(src));
ok('**没有 taskkill / Stop-Process**', !/taskkill|Stop-Process/i.test(src));
ok('安全约束：命令行必须带 appRoot', src.includes('if (!norm(item.cmd).includes(rootNorm)) continue;'));
ok('记录是否早于本实例', src.includes('earlier'));
ok('诊断日志写明“仅记录，不终止”', src.includes('仅记录，不终止'));
ok('返回结构含 found', src.includes('found: []'));
ok('没有 appRoot 就拒绝', src.includes("if (!appRoot) return { ...out, error:"));

// ══════════════════════════════════════════════════════════════
// ② 运行时：安全拒绝与返回结构
// ══════════════════════════════════════════════════════════════
const L = await import('../src/instance-lock.js');

ok('diagnoseSiblings 已导出', typeof L.diagnoseSiblings === 'function');
ok('旧的 killStaleSiblings 不再导出', typeof L.killStaleSiblings === 'undefined');

{
  const r = L.diagnoseSiblings(null);
  ok('**不给 appRoot → 不扫描、不杀**', Array.isArray(r.found) && r.found.length === 0, JSON.stringify(r));
  ok('不给 appRoot → 带 error 说明', typeof r.error === 'string' && r.error.length > 0, r.error);
}
{
  const r = L.diagnoseSiblings('');
  ok('空字符串 appRoot → 不扫描', r.found.length === 0, JSON.stringify(r.found));
}

// ══════════════════════════════════════════════════════════════
// ③ acquireInstanceLock 只调用诊断（静态）
// ══════════════════════════════════════════════════════════════
ok('acquire 成功后会调 diagnoseSiblings', /fs\.writeFileSync\(LOCK_FILE[\s\S]{0,600}diagnoseSiblings\(appRoot/.test(src));
ok('返回值带 siblings 字段', src.includes('siblings: diag.found'));
ok('诊断失败不挡启动（try/catch 兜底）', /diagnoseSiblings\(appRoot[\s\S]{0,400}\} catch/.test(src));

// ══════════════════════════════════════════════════════════════
// ④ 生产 lock 文件在测试前后未被改动
// ══════════════════════════════════════════════════════════════
{
  const lockFile = path.resolve('data/qq-agent.lock');
  const before = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8').trim() : null;
  L.diagnoseSiblings(path.resolve('.'));
  const after = fs.existsSync(lockFile) ? fs.readFileSync(lockFile, 'utf8').trim() : null;
  ok('生产 lock 文件内容前后一致（测试不写锁）', before === after, `${before} vs ${after}`);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ' -> ' + f.detail : ''}`);
  process.exit(1);
}
process.exit(0);
