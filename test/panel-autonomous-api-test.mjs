// 面板 /api/autonomous 的接口测试（1.6，2026-10-31）。
//
// 重点不是"页面好不好看"，而是**旧数据不能把页面搞崩**：
// 2.3 之前的记录没有 intent / actions，接口必须降级而不是报错或整轮消失。
import fs from 'node:fs';
// 4.0 / 1.5.4 修：日期必须用**本地时区**。原来用 toISOString().slice(0,10)（UTC），
// 北京 00:00~08:00 期间和代码里的本地日期对不上，测试会凭空失败（2026-11-01 02:05 实测）。
const p2 = (n) => String(n).padStart(2, '0');
const _now = new Date();
const TODAY = `${_now.getFullYear()}-${p2(_now.getMonth() + 1)}-${p2(_now.getDate())}`;
const THIS_MONTH = TODAY.slice(0, 7);

import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'scripts', 'web-panel-server.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const port = 9700 + Math.floor(Math.random() * 200);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-panel-auto-'));
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-panel-auto-log-'));

// 最小 config：面板的 readConfig 会读它（intervalHours 也从这来）
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  persona: { roleText: 'x', masterId: '' },
  snowluma: { httpUrl: 'http://127.0.0.1:9' },
  skills: { autonomous: { intervalHours: 3 } }
}), 'utf8');

// 一旧一新两条记录：旧的没有 intent/actions，新的有全套
// 4.0 / 1.5.4 修：用**固定时间锚点**，别用 Date.now()。
// 这个测试假设"1 小时前和现在同一天"，但凌晨 00:00~01:00 跑就会跨日，
// 按日期筛选会多出一轮（2026-11-01 00:05 实测）。
// 固定成当天下午 3 点，任何时刻跑都一样。
const now = (() => {
  const d = new Date();
  d.setHours(15, 0, 0, 0);
  return d.getTime();
})();
fs.writeFileSync(path.join(dataDir, 'autonomous.json'), JSON.stringify({
  status: 'IDLE',
  lastWakeAt: now - 3600_000,
  nextWakeAt: now + 7200_000,
  lastStopReason: '完成：做了 2 件（share / think）',
  selfWake: { enabled: true, wakeAt: now + 1800_000, reason: '等帖子更新', source: '自主决定' },
  pendingNextStep: { topic: '桌面AI伙伴', intent: '看看不同架构', status: 'pending' },
  history: [
    {
      startedAt: now - 86400_000, endedAt: now - 86400_000 + 5000, status: 'IDLE',
      modelCalls: 1, inputTokens: 2000, outputTokens: 100, candidates: 9,
      action: 'share', goal: '把这条递给老大', why: '看着有意思', picked: '帖子A（https://x）',
      stopReason: '完成：挑了一条并分享', sources: ['B站']
    },
    {
      startedAt: now - 3600_000, endedAt: now - 3600_000 + 8000, status: 'IDLE',
      modelCalls: 3, inputTokens: 4000, outputTokens: 300, candidates: 0,
      intent: { intent: 'reflect', goal: '想想最近的事', why: '有点闷', topic: '记忆', desiredOutcome: '理清楚' },
      wakeAfterMinutes: 30,
      actions: [
        { action: 'think', actionType: 'think', goal: '想清楚记忆怎么接', why: '一直没想明白',
          result: 'success', resultSummary: '想清楚了一件事：先把日记读起来', reflection: '原来卡在读取那步', next: '下次看看 diary 工具' },
        { action: 'share', actionType: 'share', goal: '把发现说给老大', why: '想让他知道',
          result: 'skipped', resultSummary: '没发出去（quiet）', reflection: '', next: '' }
      ],
      stopReason: '完成：做了 2 件（think / share）', error: ''
    }
  ]
}, null, 1), 'utf8');

const outFile = path.join(logDir, 'out.log');
const errFile = path.join(logDir, 'err.log');
const outFd = fs.openSync(outFile, 'a');
const errFd = fs.openSync(errFile, 'a');

let child = null;
let spawnError = '';
try {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      QQ_PANEL_PORT: String(port),
      QQ_AGENT_DATA_DIR: dataDir,
      QQ_PANEL_FAKE_ADMIN: '1',
      QQ_PANEL_NO_BROWSER: '1'
    },
    stdio: ['ignore', outFd, errFd],
    windowsHide: true
  });
} catch (e) {
  spawnError = 'spawn 失败：' + (e?.message || e);
}

const waitPort = async (p, ms = 10000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const up = await new Promise((resolve) => {
      const s = net.connect({ host: '127.0.0.1', port: p });
      s.on('connect', () => { s.destroy(); resolve(true); });
      s.on('error', () => resolve(false));
      s.setTimeout(500, () => { s.destroy(); resolve(false); });
    });
    if (up) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};

try {
  if (spawnError) {
    ok('面板进程能起来', false, spawnError);
  } else {
    const up = await waitPort(port);
    ok('面板能启动（端口 ' + port + '）', up);
    if (up) {
      const res = await fetch(`http://127.0.0.1:${port}/api/autonomous`);
      ok('/api/autonomous 返回 200', res.status === 200, String(res.status));
      const j = await res.json();

      ok('顶层结构齐全（state/rounds/stats）', j.ok && j.state && Array.isArray(j.rounds) && j.stats);
      ok('两轮都返回了（新的在前）', j.rounds.length === 2 && j.rounds[0].actions.length === 2, JSON.stringify(j.rounds.map((r) => r.actions.length)));
      ok('新记录带 intent', j.rounds[0].intent?.intent === 'reflect', JSON.stringify(j.rounds[0].intent));
      ok('旧记录降级但没消失', Boolean(j.rounds[1].legacy) && j.rounds[1].actions.length === 1, JSON.stringify(j.rounds[1].legacy));
      ok('旧记录从顶层字段拼出了 action', j.rounds[1].actions[0].action === 'share');

      ok('result 与 reflection 分开', j.rounds[0].actions[0].result === 'success'
        && j.rounds[0].actions[0].reflection === '原来卡在读取那步');
      ok('skipped 保留原样', j.rounds[0].actions[1].result === 'skipped');

      ok('selfWake 读到了', j.state.selfWake?.enabled === true && j.state.selfWake.reason === '等帖子更新');
      ok('固定周期也读到了', Number(j.state.nextWakeAt) > 0);
      ok('intervalHours 从 config 来', j.state.intervalHours === 3);

      ok('统计：意图分布', j.stats.intents.reflect === 1 && j.stats.intents.legacy === 1, JSON.stringify(j.stats.intents));
      ok('统计：think 次数', j.stats.think === 1);
      ok('统计：结果分布', j.stats.results.success === 1 && j.stats.results.skipped === 1, JSON.stringify(j.stats.results));
      ok('统计：自主预约次数', j.stats.selfWake === 1);
      ok('统计：自然结束', j.stats.natural === 2, String(j.stats.natural));

      // 按日期筛选
      const today = new Date(now - 3600_000);
      const pad = (x) => String(x).padStart(2, '0');
      const dayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
      const onlyToday = await (await fetch(`http://127.0.0.1:${port}/api/autonomous?date=${dayKey}`)).json();
      ok('按日期筛选生效', onlyToday.rounds.length === 1, String(onlyToday.rounds.length));
    }
  }
} finally {
  if (child) { try { child.kill() } catch { /* 已退 */ } }
  try { fs.closeSync(outFd); } catch { /* ignore */ }
  try { fs.closeSync(errFd); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
