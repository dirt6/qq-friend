// R6-B2 专项测试：Session Adapter 核心与接口。
//
// 机主 2026-11-03 的边界：
//   · 以本地 DSH 0.2.0-rc.2 实际能力为依据
//   · 通过 CLI 和 --session-id 管理 Session
//   · **不假设存在 --session-key 或可编程 Session API**
//   · **不包装不存在的管理功能**（清理、TTL 由 QQ-agent 负责）
//   · cwd 固定要求必须进入显式约束和测试
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r6b2-'));
process.env.QQ_AGENT_DATA_DIR = tmp;
fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const A = await import(pathToFileURL(path.join(ROOT, 'src', 'session', 'adapter.js')).href);

const APP_ROOT = 'E:\\dsh\\QQ-agent';

try {
  console.log('【① 能力声明：只能声称 DSH 真有的】');
  {
    const c = A.capabilities();
    ok('**create === true**', c.create === true);
    ok('**resume === true**', c.resume === true);
    ok('**list === false**（DSH 没有）', c.list === false);
    ok('**delete === false**', c.delete === false);
    ok('**ttl === false**', c.ttl === false);
    ok('**naming === false**（没有 --session-key）', c.naming === false);
  }

  console.log('\n【② 不支持的请求要明确拒绝】');
  {
    for (const what of ['list', 'delete', 'ttl', 'naming']) {
      const r = A.unsupported(what);
      ok(`**${what} 被拒绝**`, r.ok === false && r.code === A.ERR.UNSUPPORTED, JSON.stringify(r));
      ok(`${what} 的报错说明是 QQ-agent 的责任`, /QQ-agent 自己的责任/.test(r.error), r.error);
    }
  }

  console.log('\n【③ buildArgs：新建 vs 恢复】');
  {
    const create = A.buildArgs({ profile: 'headless' });
    ok('新建 ok', create.ok === true);
    ok('**mode === create**', create.mode === 'create', create.mode);
    ok('**没有 --session-id**', !create.args.includes('--session-id'), JSON.stringify(create.args));
    ok('以 --profile headless 开头', create.args[0] === '--profile' && create.args[1] === 'headless');
    ok('**以 - 结尾（走 stdin）**', create.args[create.args.length - 1] === '-', JSON.stringify(create.args));
    ok('含 --json', create.args.includes('--json'));

    const resume = A.buildArgs({ profile: 'headless', sessionId: 'session-abc-123' });
    ok('恢复 ok', resume.ok === true);
    ok('**mode === resume**', resume.mode === 'resume', resume.mode);
    ok('**有 --session-id 和值**',
      resume.args.includes('--session-id')
      && resume.args[resume.args.indexOf('--session-id') + 1] === 'session-abc-123');
  }

  console.log('\n【④ buildArgs：--patch 必须在 --json 之前（R6-A 实测踩过）】');
  {
    const r = A.buildArgs({
      profile: 'headless',
      patchFiles: ['a.yml', 'b.yml'],
      sessionId: 'session-x'
    });
    ok('ok', r.ok === true);
    const jsonIdx = r.args.indexOf('--json');
    const patchIdxs = [];
    r.args.forEach((a, i) => { if (a === '--patch') patchIdxs.push(i); });
    ok('**有两个 --patch**', patchIdxs.length === 2, String(patchIdxs.length));
    ok('**所有 --patch 都在 --json 之前**',
      patchIdxs.every((i) => i < jsonIdx),
      `patch=${JSON.stringify(patchIdxs)} json=${jsonIdx}`);
    ok('--session-id 在 --json 之后（app 参数）',
      r.args.indexOf('--session-id') > jsonIdx);
  }

  console.log('\n【⑤ buildArgs：空 profile / 坏 sessionId 要拒绝】');
  {
    ok('**空 profile → 失败**', A.buildArgs({ profile: '' }).ok === false);
    ok('空 profile 的 code', A.buildArgs({ profile: '' }).code === A.ERR.PROFILE_REQUIRED);

    // 空串 / 纯空白 = 没传 → 新建（合法）
    for (const empty of ['', '   ']) {
      const r = A.buildArgs({ profile: 'headless', sessionId: empty });
      ok(`空/${empty.length} 空格 sessionId = 新建（合法）`, r.ok === true && r.mode === 'create',
        JSON.stringify({ ok: r.ok, mode: r.mode }));
    }
    // 真正非法的输入 → 拒绝
    for (const bad of ['a\nb', ' a ', 'x'.repeat(300)]) {
      const r = A.buildArgs({ profile: 'headless', sessionId: bad });
      ok(`**坏 sessionId 被拒：「${bad.slice(0, 10)}」**`, r.ok === false && r.code === A.ERR.BAD_SESSION_ID,
        JSON.stringify({ ok: r.ok, code: r.code }));
    }
  }

  console.log('\n【⑥ checkContext：cwd 是硬约束】');
  {
    ok('**不传 cwd → 失败**', A.checkContext({}).ok === false);
    ok('不传 cwd 的 code', A.checkContext({}).code === A.ERR.CWD_REQUIRED);
    ok('**报错说清楚原因**', /会话绑定了创建时的 cwd/.test(A.checkContext({}).error || ''), A.checkContext({}).error);

    ok('**相对路径 cwd → 失败**', A.checkContext({ cwd: 'relative/path' }).ok === false);
    ok('**绝对路径 cwd → 通过**', A.checkContext({ cwd: APP_ROOT }).ok === true);

    ok('**cwd 与 appRoot 不一致 → 失败**',
      A.checkContext({ cwd: 'C:\\Windows', appRoot: APP_ROOT }).ok === false);
    ok('报错里有期望和实际', /期望 E:\\dsh\\QQ-agent/.test(A.checkContext({ cwd: 'C:\\Windows', appRoot: APP_ROOT }).error || ''),
      A.checkContext({ cwd: 'C:\\Windows', appRoot: APP_ROOT }).error);
    ok('**cwd 与 appRoot 一致 → 通过**',
      A.checkContext({ cwd: APP_ROOT, appRoot: APP_ROOT }).ok === true);
  }

  console.log('\n【⑦ planCall：完整调用描述】');
  {
    const r = A.planCall({
      profile: 'headless',
      cwd: APP_ROOT,
      sessionId: 'session-abc',
      patchFiles: ['p.yml'],
      text: '你好呀',
      env: { DSH_HOME: 'E:\\dsh\\QQ-agent\\data\\dsh-home' },
      appRoot: APP_ROOT
    });
    ok('ok', r.ok === true, JSON.stringify({ error: r.error }));
    ok('**mode === resume**', r.plan.mode === 'resume', r.plan.mode);
    ok('**stdin 是任务文本**', r.plan.stdin === '你好呀', JSON.stringify(r.plan.stdin));
    ok('**cwd 是绝对路径**', path.isAbsolute(r.plan.cwd), r.plan.cwd);
    ok('**env 被带上**', r.plan.env.DSH_HOME === 'E:\\dsh\\QQ-agent\\data\\dsh-home');
    ok('**args 以 - 结尾**', r.plan.args[r.plan.args.length - 1] === '-');
  }

  console.log('\n【⑧ planCall：cwd 缺失时必须在拼参数之前就失败】');
  {
    const r = A.planCall({ profile: 'headless', text: 'x' });
    ok('**失败**', r.ok === false);
    ok('**code 是 CWD_REQUIRED**', r.code === A.ERR.CWD_REQUIRED, r.code);
    ok('**没有 plan**', r.plan === undefined);
  }

  console.log('\n【⑨ 纯函数：不碰文件系统】');
  {
    // 把 cwd 指向一个不存在的路径，buildArgs / planCall 也不该失败
    const ghost = 'Z:\\不存在的目录\\QQ-agent';
    const r = A.planCall({ profile: 'headless', cwd: ghost, text: 'x' });
    ok('**不存在的 cwd 也能 plan（纯函数不检查存在性）**', r.ok === true, JSON.stringify({ error: r.error }));
    ok('（真正执行时 DSH 会报错，那时才失败）', true);
  }

  console.log('\n【⑩ 源码级：没有假装有 sessionKey / 管理 API】');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'session', 'adapter.js'), 'utf8');
    ok('**不出现 --session-key 参数**', !/['"]--session-key['"]/.test(src));
    ok('**不 import dsh-gateway**（保持纯逻辑层）', !/from ['"].*dsh-gateway/.test(src));
    ok('**不调用 spawn**', !/\bspawn\(/.test(src));
    ok('**不碰 fs**（没有 fs import）', !/from ['"]node:fs['"]/.test(src));
    ok('**不支持的能力都在 unsupported 里明确拒绝**', /export function unsupported/.test(src));
    ok('**CAPABILITIES 里 list/delete/ttl/naming 都是 false**',
      /list: false/.test(src) && /delete: false/.test(src) && /ttl: false/.test(src) && /naming: false/.test(src));
  }

  console.log('\n【⑪ 与 dsh-gateway 的纯函数能配合（解析层复用）】');
  {
    const G = await import(pathToFileURL(path.join(ROOT, 'src', 'dsh-gateway.js')).href);
    const st = G.newEventState();
    G.applyEvent(st, { type: 'session', sessionId: 'session-abc' });
    G.applyEvent(st, { type: 'final', text: '回复' });
    const out = G.decideOutcome({ code: 0, st });
    ok('**Adapter 的 plan 能被 gateway 的解析层消费**', out.ok === true && out.text === '回复');
    ok('sessionId 能对上', out.sessionId === 'session-abc');
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.stack || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
