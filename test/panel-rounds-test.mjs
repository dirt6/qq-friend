// 面板「活动观察」接口的验收测试（4.0 · 1.5.8.9）。
//
// 起一个真实的 8899 面板服务（临时 DATA_DIR + 随机端口），请求 /api/autonomous，
// 验证 roundId / calls / callSummary / today 都出来了。
//
// 只读：不修改 autonomous.json，不创建新账本。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'web-panel-server.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const port = 9300 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-rounds-'));
fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '' },
  snowluma: { httpUrl: 'http://127.0.0.1:9' },
  skills: { autonomous: { intervalHours: 3 } }
}), 'utf8');

const DAY = 86400e3;
const now = Date.now();

// 造一轮带 roundId 的 + 一轮旧格式（没有 roundId）
fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
  version: 1,
  status: 'IDLE',
  history: [
    {
      roundId: 'round-abc12345',
      startedAt: now - 3600e3, endedAt: now - 3590e3, status: 'IDLE',
      modelCalls: 2, inputTokens: 200, outputTokens: 40,
      intent: { intent: 'explore', goal: '看看最近有什么', why: '好奇', topic: 'x', desiredOutcome: 'y' },
      actions: [{ at: now - 3595e3, action: 'explore', result: 'success', goal: '看看', why: '好奇', roundId: 'round-abc12345' }],
      stopReason: '完成：没有别的想做的了'
    },
    {
      // 旧格式：没有 roundId，actions 也没有
      startedAt: now - DAY - 3600e3, endedAt: now - DAY - 3590e3, status: 'IDLE',
      modelCalls: 1,
      actions: [{ action: 'chat', result: 'success', goal: '旧', why: '旧' }],
      stopReason: '完成'
    }
  ]
}), 'utf8');

// 模型调用记录：两条挂在 round-abc12345 上（一条 dsh 失败 + 一条 api 回退成功）
const calls = [
  { id: 'call-1', roundId: 'round-abc12345', at: new Date(now - 3600e3).toISOString(), purpose: 'autonomous.intent', backend: 'dsh', status: 'failed', durationMs: 180000, fallback: false, fallbackFrom: null, failureCode: 'DSH_TIMEOUT', failureDetail: '超时', model: 'm', tokens: null },
  { id: 'call-2', roundId: 'round-abc12345', at: new Date(now - 3595e3).toISOString(), purpose: 'autonomous.decision', backend: 'api', status: 'success', durationMs: 3400, fallback: true, fallbackFrom: 'dsh', failureCode: null, failureDetail: null, model: 'm', tokens: { prompt: 100, completion: 20, cached: 10 } }
];
fs.writeFileSync(path.join(dataDir, 'model-calls.ndjson'), calls.map((c) => JSON.stringify(c)).join('\n') + '\n', 'utf8');

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

const child = spawn(process.execPath, [SERVER], {
      // 4.0：测试里不许真弹浏览器（否则会以管理员权限拉起 Edge，
      // 之后机主自己开 Edge 就会撞"现有实例正在以提升的权限运行"）
      env: { ...process.env, QQ_PANEL_NO_BROWSER: '1' },
  cwd: ROOT,
  env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir, QQ_PANEL_PORT: String(port) },
  stdio: 'ignore',
  windowsHide: true
});

try {
  const up = await waitPort(port);
  ok('面板起起来了', up, `端口 ${port}`);

  if (up) {
    const before = fs.readFileSync(path.join(dataDir, 'autonomous.json'), 'utf8');
    const r = await fetch(`http://127.0.0.1:${port}/api/autonomous`);
    const j = await r.json();
    const after = fs.readFileSync(path.join(dataDir, 'autonomous.json'), 'utf8');

    console.log('\n【① 基本结构】');
    ok('ok=true', j.ok === true);
    ok('有 rounds', Array.isArray(j.rounds) && j.rounds.length === 2, String(j.rounds?.length));
    ok('有 today 统计', Boolean(j.today), JSON.stringify(j.today));

    console.log('\n【② roundId 与 calls 关联】');
    const withRound = j.rounds.find((x) => x.roundId === 'round-abc12345');
    ok('第一轮带 roundId', Boolean(withRound), JSON.stringify(j.rounds.map((x) => x.roundId)));
    ok('关联到 2 条调用', withRound?.calls?.length === 2, String(withRound?.calls?.length));
    ok('第一条是 dsh failed', withRound?.calls?.[0]?.backend === 'dsh' && withRound?.calls?.[0]?.status === 'failed');
    ok('第二条是 api fallback', withRound?.calls?.[1]?.backend === 'api' && withRound?.calls?.[1]?.fallback === true);
    ok('callSummary 汇总正确', withRound?.callSummary?.dsh === 1 && withRound?.callSummary?.api === 1
      && withRound?.callSummary?.fallback === 1 && withRound?.callSummary?.failed === 1,
      JSON.stringify(withRound?.callSummary));

    console.log('\n【③ 旧记录（无 roundId）正常展示，不报错】');
    const oldRound = j.rounds.find((x) => !x.roundId);
    ok('旧轮次在列表里', Boolean(oldRound), JSON.stringify(j.rounds.map((x) => x.roundId || '(无)')));
    ok('旧轮次 calls 是空数组', Array.isArray(oldRound?.calls) && oldRound.calls.length === 0);
    ok('旧轮次的 callSummary 全 0', oldRound?.callSummary?.total === 0, JSON.stringify(oldRound?.callSummary));
    ok('旧轮次的 actions 还在', Array.isArray(oldRound?.actions) && oldRound.actions.length === 1);

    console.log('\n【④ today 统计】');
    ok('今日唤醒数 ≥ 1', j.today.wakes >= 1, String(j.today.wakes));
    ok('今日调用数 ≥ 2', j.today.calls >= 2, String(j.today.calls));
    ok('今日 dsh/api 分开算', j.today.dsh >= 1 && j.today.api >= 1, JSON.stringify({ dsh: j.today.dsh, api: j.today.api }));
    ok('今日 fallback 数 ≥ 1', j.today.fallback >= 1, String(j.today.fallback));

    console.log('\n【⑤ 只读：请求前后 autonomous.json 不变】');
    ok('文件字节级一致', before === after);

    console.log('\n【⑥ 不新增账本文件】');
    const files = fs.readdirSync(dataDir);
    ok('没有新建统计文件', !files.some((f) => /stat|summary|dashboard/i.test(f)), JSON.stringify(files));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { child.kill(); } catch { /* ignore */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
