// 1.5.6 面板权限收回的验收测试。
//
// 机主的验收要求：
//   · 旧记忆写接口无法绕过后端权限
//   · 面板记忆管理功能保留（读取），后续接入 Memory Hub
//   · 不新增不必要的文件副本
//   · 删除行为有明确提示
//   · 不影响现有记忆读取和自主活动
//
// 做法：起一个真实的 8899 面板服务（临时 DATA_DIR + 随机端口），
// 直接 POST 旧接口 —— 模拟"旧页面/书签/curl 绕前端"的场景。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'web-panel-server.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const port = 9600 + Math.floor(Math.random() * 300);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-acl-'));
const logDir = path.join(dataDir, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const DRAW_DIR = path.join(dataDir, 'drawings');
fs.mkdirSync(DRAW_DIR, { recursive: true });
fs.writeFileSync(path.join(DRAW_DIR, 'test.png'), 'fake', 'utf8');

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '' },
  snowluma: { httpUrl: 'http://127.0.0.1:9' },
  skills: { autonomous: { intervalHours: 3 } }
}), 'utf8');
fs.writeFileSync(path.join(dataDir, 'learned.json'), JSON.stringify({
  version: 1,
  items: [{ id: 'l-acl-1', text: '这条经验用来测面板权限，长度足够入库', status: 'stable', tags: [], hits: 3, corrections: 0 }]
}), 'utf8');

function waitPort(p, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const s = net.connect(p, '127.0.0.1');
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => {
        s.destroy();
        if (Date.now() - t0 > timeoutMs) resolve(false);
        else setTimeout(tick, 250);
      });
    };
    tick();
  });
}

async function post(name, body) {
  const r = await fetch(`http://127.0.0.1:${port}/api/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {})
  });
  let j = null;
  try { j = await r.json(); } catch { /* 可能不是 JSON */ }
  return { status: r.status, body: j };
}
async function get(name) {
  const r = await fetch(`http://127.0.0.1:${port}/api/${name}`);
  let j = null;
  try { j = await r.json(); } catch { /* ignore */ }
  return { status: r.status, body: j };
}

const child = spawn(process.execPath, [SERVER], {
      // 4.0：测试里不许真弹浏览器（否则会以管理员权限拉起 Edge，
      // 之后机主自己开 Edge 就会撞"现有实例正在以提升的权限运行"）
      env: { ...process.env, QQ_PANEL_NO_BROWSER: '1' },
  cwd: ROOT,
  env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_PANEL_PORT: String(port), QQ_PANEL_LOG_DIR: logDir },
  stdio: 'ignore',
  windowsHide: true
});

try {
  const up = await waitPort(port);
  ok('面板服务起来了', up === true, `端口 ${port}`);

  if (up) {
    console.log('\n【① 四个记忆写接口：必须 403】');
    for (const [name, body] of [
      ['learned.status', { id: 'l-acl-1', status: 'stable' }],
      ['learned.archive', {}],
      ['learned.save', { id: 'l-acl-1', text: '被面板改过的内容，长度够' }],
      ['learned.delete', { id: 'l-acl-1' }]
    ]) {
      const r = await post(name, body);
      ok(`${name} → 403`, r.status === 403, `实际 ${r.status}`);
      ok(`${name} 带 MEMORY_WRITE_RETIRED`, r.body?.code === 'MEMORY_WRITE_RETIRED', JSON.stringify(r.body));
    }

    console.log('\n【② 记忆文件没被改动（后端真拒绝，不是假装）】');
    const learned = JSON.parse(fs.readFileSync(path.join(dataDir, 'learned.json'), 'utf8'));
    ok('条目还在', learned.items.length === 1, String(learned.items.length));
    ok('文本没被改', learned.items[0].text.includes('用来测面板权限'), learned.items[0].text);
    ok('状态没被改', learned.items[0].status === 'stable', learned.items[0].status);

    console.log('\n【③ 读取仍然正常】');
    const rd = await get('learned');
    ok('GET /api/learned 正常', rd.status === 200 && Array.isArray(rd.body?.items), `实际 ${rd.status}`);
    const diary = await get('diary');
    ok('GET /api/diary 正常', diary.status === 200, `实际 ${diary.status}`);
    const auto = await get('autonomous');
    ok('GET /api/autonomous 正常', auto.status === 200, `实际 ${auto.status}`);

    console.log('\n【④ 运维操作没被误伤】');
    const st = await post('stickers.sync', {});
    ok('stickers.sync 不是 403', st.status !== 403, `实际 ${st.status}`);
    const dr = await post('drawings.open', {});
    ok('drawings.open 不是 403', dr.status !== 403, `实际 ${dr.status}`);
    const bs = await post('bot.start', {});
    ok('bot.start 不是 403（运维保留）', bs.status !== 403, `实际 ${bs.status}`);

    console.log('\n【⑤ 画作删除仍可用（保留 + 前端二次确认）】');
    const dd = await post('drawings.delete', { file: 'test.png' });
    ok('drawings.delete 成功', dd.status === 200 && dd.body?.ok === true, JSON.stringify(dd.body).slice(0, 100));
    ok('文件真的删了（按机主要求：不留备份）', !fs.existsSync(path.join(DRAW_DIR, 'test.png')));

    console.log('\n【⑥ 拒绝日志写下来了】');
    const aclFile = path.join(logDir, 'acl.jsonl');
    ok('acl.jsonl 存在', fs.existsSync(aclFile));
    if (fs.existsSync(aclFile)) {
      const lines = fs.readFileSync(aclFile, 'utf8').trim().split('\n').filter(Boolean);
      ok('记录了 4 条拒绝', lines.length >= 4, String(lines.length));
      const first = JSON.parse(lines[0]);
      ok('字段完整（at/route/action）', Boolean(first.at && first.route && first.action === 'deny'), JSON.stringify(first));
      ok('日志体积很小', fs.statSync(aclFile).size < 64 * 1024, `${fs.statSync(aclFile).size} B`);
    }
  }

  console.log('\n【⑦ 3210 的群友印象接口也收回了】');
  {
    const routesSrc = fs.readFileSync(path.join(ROOT, 'src', 'routes.js'), 'utf8');
    ok('consolidate 里有 MEMORY_WRITE_RETIRED', routesSrc.includes('MEMORY_WRITE_RETIRED'));
    // 确认拒绝在真正的处理之前（handler 开头）
    const at = routesSrc.indexOf("pattern: '/api/memory-files/consolidate'");
    const seg = routesSrc.slice(at, at + 900);
    ok('403 出现在原实现之前', seg.indexOf('MEMORY_WRITE_RETIRED') < seg.indexOf('bodyOf(req)'), '顺序不对');
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { child.kill() } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
