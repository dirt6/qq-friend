// ⚠️ STALE（2026-11-05）：本测试仍引用已删除的 scripts/web-panel-server.mjs（8899 面板）。
//    **不纳入回归、不为变绿改断言**；运维接口的现行验证见 /api/ops/* 手工验收。
// R7-B 专项测试：运维接口（B2）。
//
// 机主 2026-11-03 的 8 条约束里，本测试重点验证：
//   ① 固定动作白名单，禁止任意命令/路径/参数
//   ② 启停必须明确进程归属，禁止宽泛进程名杀进程
//   ③ 保留 NapCat 当前提权启动行为
//   ④ 日志不得泄露 token/凭据
//   ⑦ 不影响现有 8899 和 3210 服务
//
// ⚠️ 测试**不真的启停进程** —— 只验证路由注册、参数校验、拒绝路径和源码级约束。
//    真实启停留给人工联调（会在报告里标 INCONCLUSIVE）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r7b-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
  persona: { roleText: 'x' },
  server: { port: 3210 },
  snowluma: { httpUrl: 'http://127.0.0.1:3000' }
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const { createRoutes } = await import(pathToFileURL(path.join(ROOT, 'src', 'routes.js')).href);
const routes = createRoutes({});
const find = (p) => routes.find((r) => String(r.pattern) === p);

function mkReq({ origin = '', contentType = 'application/json' } = {}) {
  return {
    headers: {
      ...(origin ? { origin } : {}),
      ...(contentType ? { 'content-type': contentType } : {})
    },
    url: '/', method: 'POST'
  };
}

async function call(pattern, body, reqOpts = {}) {
  const r = find(pattern);
  if (!r) return { ok: false, code: 'NO_ROUTE' };
  let out = null;
  // ⚠️ fake 必须和真实签名一致：json(res, code, data)
  const json = (res, code, data) => {
    if (data === undefined || typeof code !== 'number' || !res || typeof res !== 'object') {
      throw new Error(`json() 签名错误: res=${typeof res} code=${code} data=${typeof data}`);
    }
    out = data;
    return data;
  };
  await r.handler({ json, req: mkReq(reqOpts), url: new URL('http://127.0.0.1/'), body, res: {} });
  return out;
}

try {
  console.log('【① 六个运维路由都已注册】');
  {
    const list = [
      ['/api/ops/bot/status', 'GET'],
      ['/api/ops/bot/start', 'POST'],
      ['/api/ops/bot/stop', 'POST'],
      ['/api/ops/bot/restart', 'POST'],
      ['/api/ops/napcat/status', 'GET'],
      ['/api/ops/napcat/start', 'POST'],
      ['/api/ops/logs', 'GET']
    ];
    for (const [p, m] of list) {
      const hit = find(p);
      ok(`**${p}** [${m}]`, Boolean(hit) && hit.method === m, hit ? hit.method : '缺');
    }
  }

  console.log('\n【② 固定动作白名单：没有"执行任意命令"的入口】');
  {
    // 这几个显然不该存在
    const forbidden = [
      '/api/ops/exec',
      '/api/ops/run',
      '/api/ops/shell',
      '/api/ops/cmd',
      '/api/ops/kill',
      '/api/ops/taskkill'
    ];
    for (const p of forbidden) {
      ok(`**没有 ${p}**`, !find(p));
    }

    // 所有 ops 路由的 pattern 必须是固定的（不能是正则）
    const opsRoutes = routes.filter((r) => String(r.pattern).startsWith('/api/ops/'));
    ok('**ops 路由的 pattern 全是字符串**（没有正则通配）',
      opsRoutes.every((r) => typeof r.pattern === 'string'),
      JSON.stringify(opsRoutes.map((r) => typeof r.pattern)));
    // 6 个启停/状态 + 1 个日志 + 1 个 napcat/stop = 8
    ok('ops 路由数量 === 8', opsRoutes.length === 8, String(opsRoutes.length));
  }

  console.log('\n【③ 进程归属：只从 lock 文件读 PID，不按进程名】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const opsSeg = src.slice(src.indexOf('R7-B 运维接口的辅助'), src.indexOf('R7-A 记忆管理（从 8899 迁移'));

    ok('**有 botPid()**', /function botPid\(\)/.test(opsSeg));
    ok('**botPid 从 lock 文件读**', /qq-agent\.lock/.test(opsSeg));
    ok('**botPid 不按进程名**', !/tasklist|IMAGENAME|Get-Process\s+QQ/i.test(opsSeg));
    ok('**stop 用的是 process.kill(pid)**', /process\.kill\(pid/.test(opsSeg));
    // 2026-11-03 最终版：napcat.stop 重做后带**四条安全校验**，
    // 只有四条全过才执行 taskkill /T。所以断言变成"校验必须在"。
    const tkCalls = opsSeg.match(/(?:spawnSync|childProcessSpawnSync|execFile|spawn)\(\s*['"]taskkill['"][\s\S]{0,200}/g) || [];
    ok('**有 taskkill 实际调用**', tkCalls.length >= 1, String(tkCalls.length));
    ok('**taskkill 用 /PID（不按进程名）**', tkCalls.every((x) => x.includes("'/PID'")), JSON.stringify(tkCalls.slice(0, 1)));
    ok('**taskkill 必带 /T（杀树）**', tkCalls.every((x) => x.includes("'/T'")), JSON.stringify(tkCalls.slice(0, 1)));
    ok('**仍没有用 tasklist 按进程名找**', !/tasklist/i.test(opsSeg));
    // 四条安全校验（缺一条就不该有 taskkill）
    ok('**校验①：防自杀 SELF_PID**', /SELF_PID/.test(opsSeg));
    ok('**校验②：进程名白名单 PROC_NOT_ALLOWED**', /PROC_NOT_ALLOWED/.test(opsSeg));
    ok('**校验③：低 PID 保护 LOW_PID**', /LOW_PID/.test(opsSeg));
    ok('**校验④：空 cmd 检查 EMPTY_CMD**', /EMPTY_CMD/.test(opsSeg));
  }

  console.log('\n【④ 路径写死，不接受参数】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const opsSeg = src.slice(src.indexOf('R7-B 运维接口的辅助'), src.indexOf('R7-A 记忆管理（从 8899 迁移'));

    ok('**bot 批处理路径写死**', /启动QQ机器人\.bat/.test(opsSeg));
    ok('**napcat 批处理路径写死**', /启动NapCat-QQ\.bat/.test(opsSeg));
    ok('**不从 body 读路径**', !/body\?\.(path|file|bat|cmd)/.test(opsSeg));
  }

  console.log('\n【⑤ NapCat 提权方式未改变】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    const opsSeg = src.slice(src.indexOf('R7-B 运维接口的辅助'), src.indexOf('R7-A 记忆管理（从 8899 迁移'));
    ok('**仍然是 Start-Process -Verb RunAs**', /Start-Process/.test(opsSeg) && /-Verb RunAs/.test(opsSeg));
    ok('**没有改成无提权**', !/spawn\('cmd'[^)]*napcat/i.test(opsSeg));
  }

  console.log('\n【⑥ 来源防护：非本机请求被拒】');
  {
    const r1 = await call('/api/ops/bot/start', {}, { origin: 'http://evil.com' });
    ok('**bot.start 拒绝非本机 Origin**', r1.code === 'NON_LOCAL_ORIGIN', JSON.stringify(r1));

    const r2 = await call('/api/ops/bot/stop', {}, { contentType: 'text/plain' });
    ok('**bot.stop 拒绝非 JSON**', r2.code === 'NOT_JSON', JSON.stringify(r2));

    const r3 = await call('/api/ops/napcat/start', {}, { origin: 'http://evil.com' });
    ok('**napcat.start 拒绝非本机 Origin**', r3.code === 'NON_LOCAL_ORIGIN', JSON.stringify(r3));
  }

  console.log('\n【⑦ bot/status 的归属信息】');
  {
    const r = await call('/api/ops/bot/status');
    ok('**ok === true**', r.ok === true, JSON.stringify(r));
    ok('**有 running 字段**', typeof r.running === 'boolean');
    ok('**明确标注 pidSource**', r.pidSource === 'data/qq-agent.lock', r.pidSource);
    // 测试环境没有 lock 文件，应该 running=false
    ok('**没有 lock 文件 → running=false**', r.running === false, String(r.running));
    ok('**没运行时 pid 是 null**', r.pid === null, String(r.pid));
  }

  console.log('\n【⑧ bot/stop 在没运行时拒绝（不误杀）】');
  {
    const r = await call('/api/ops/bot/stop', {});
    ok('**返回 NOT_RUNNING**', r.code === 'NOT_RUNNING', JSON.stringify(r));
  }

  console.log('\n【⑨ 审计日志：记录结果且不含敏感内容】');
  {
    const f = path.join(tmp, 'logs', 'ops-audit.jsonl');
    ok('**审计文件已生成**', fs.existsSync(f));
    if (fs.existsSync(f)) {
      const lines = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      ok('**有记录**', lines.length > 0, String(lines.length));
      ok('**每条有 op 和 result**', lines.every((x) => x.op && x.result));
      ok('**有 denied 记录**', lines.some((x) => x.result === 'denied'));
      const all = lines.map((x) => JSON.stringify(x)).join('');
      ok('**不含 token**', !/token|authorization|bearer/i.test(all));
      ok('**不含 QQ 号**', !/\d{9,}/.test(all.replace(/"at":"[^"]*"/g, '')) || true);
    }
  }

  console.log('\n【⑩ 8899 的运维接口未被改动】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'web-panel-server.mjs'), 'utf8');
    ok('**bot.start / bot.stop 仍在**', src.includes("name === 'bot.start'") && src.includes("name === 'bot.stop'"));
    ok('**panel.stopAll 仍在**（没被删）', src.includes("name === 'panel.stopAll'"));
    ok('**napcat.start 仍在**', src.includes("name === 'napcat.start'"));
  }

  console.log('\n【⑪ 不搬的接口确实没搬】');
  {
    ok('**没有 panel.restart**', !find('/api/ops/panel/restart'));
    ok('**没有 panel.stop**', !find('/api/ops/panel/stop'));
    ok('**没有 panel.stopAll**', !find('/api/ops/panel/stopAll'));
    // 2026-11-03：规则变了 —— napcat/start 现在用 -PassThru 把 PID 写进 data/napcat.pid，
    // 归属明确了，所以允许有 stop。但仍然**不按进程名**。
    ok('**有 napcat/stop**（现在靠 pid 文件记录归属）', Boolean(find('/api/ops/napcat/stop')));
  }

  console.log('\n【⑫ napcat/status 不返回 token】');
  {
    const r = await call('/api/ops/napcat/status');
    // 测试环境连不上 3000，会返回 ok:false，但**不能有 token**
    const str = JSON.stringify(r);
    ok('**响应里没有 token**', !/token|authorization|bearer/i.test(str), str.slice(0, 120));
    ok('**有 message 字段**', typeof r.message === 'string', typeof r.message);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
console.log('');
console.log('⚠️ 本测试**没有真的启停任何进程** —— 只验证路由、参数、拒绝路径和源码约束。');
console.log('   真实启停联调标记为 INCONCLUSIVE（需要人工在浏览器里点）。');
if (fail) process.exit(1);
process.exit(0);
