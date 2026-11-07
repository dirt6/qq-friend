// 模型调用记录器的验收测试（4.0 · 1.5.8.3）。
//
// 机主要求：先只做记录器，验证并发写入、异常恢复、容量轮转、坏行处理、roundId 关联，
// **不接入任何调用入口**。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = pathToFileURL(path.join(ROOT, 'src', 'model-calls.js')).href;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-calls-'));
const FILE = path.join(tmp, 'model-calls.ndjson');
process.env.QQ_AGENT_DATA_DIR = tmp;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const mc = await import(MOD);

try {
  console.log('【① 基本写入 + 结构】');
  {
    const r = mc.recordCall({
      purpose: 'chat.reply', backend: 'dsh', status: 'success',
      durationMs: 6200, model: 'deepseek-flash',
      tokens: { prompt: 17200, completion: 166, cached: 6144 },
      file: FILE
    });
    ok('写入成功', r.ok === true, JSON.stringify(r).slice(0, 120));
    const all = mc.readCalls({ file: FILE });
    ok('读回 1 条', all.length === 1, String(all.length));
    const c = all[0];
    ok('id 是 call-xxxxxxxx', /^call-[0-9a-f]{8}$/.test(c.id), c.id);
    // 没有轮上下文时用 round-lone-* 兜底：能区分「有轮」和「孤立调用」，是有意设计
    ok('roundId 格式合法（round-* 或 round-lone-*）', /^round-(lone-)?[0-9a-f]{6,8}$/.test(c.roundId), c.roundId);
    ok('at 是 ISO 带时区', /^\d{4}-\d{2}-\d{2}T/.test(c.at), c.at);
    ok('字段齐全', ['id', 'roundId', 'at', 'purpose', 'backend', 'status', 'durationMs',
      'fallback', 'fallbackFrom', 'failureCode', 'failureDetail', 'model', 'tokens'].every((k) => k in c),
      Object.keys(c).join(','));
    ok('tokens 完整', c.tokens.prompt === 17200 && c.tokens.cached === 6144);
  }

  console.log('\n【② 失败记录：tokens 是 null 不是 0】');
  {
    const r = mc.recordCall({
      purpose: 'chat.reply', backend: 'dsh', status: 'failed',
      durationMs: 180000, failureCode: 'DSH_TIMEOUT',
      failureDetail: '180000ms 超时，进程已终止', file: FILE
    });
    const c = r.record;
    ok('失败被记下', c.status === 'failed');
    ok('failureCode 正确', c.failureCode === 'DSH_TIMEOUT');
    ok('tokens 是 null（不伪造 0）', c.tokens === null, JSON.stringify(c.tokens));
    ok('failureDetail 保留', c.failureDetail.includes('180000ms'));
  }

  console.log('\n【③ fallback：两次调用都留，同 roundId】');
  {
    let round;
    mc.withRound({ kind: 'chat', chatKey: 'private:1' }, (r) => {
      round = r;
      mc.recordCall({
        purpose: 'chat.reply', backend: 'dsh', status: 'failed',
        durationMs: 180000, failureCode: 'DSH_TIMEOUT', file: FILE, round: r
      });
      mc.recordCall({
        purpose: 'chat.reply', backend: 'api', status: 'success',
        durationMs: 3400, fallback: true, fallbackFrom: 'dsh',
        tokens: { prompt: 17100, completion: 158 }, file: FILE, round: r
      });
    });
    const all = mc.readCalls({ file: FILE });
    const mine = all.filter((c) => c.roundId === round.roundId);
    ok('同 roundId 下有 2 条', mine.length === 2, String(mine.length));
    ok('第一条是 dsh failed', mine[0].backend === 'dsh' && mine[0].status === 'failed');
    ok('第二条是 api success 且标了 fallback', mine[1].backend === 'api' && mine[1].fallback === true && mine[1].fallbackFrom === 'dsh');
    ok('**第一次失败没被覆盖**', mine[0].failureCode === 'DSH_TIMEOUT');
  }

  console.log('\n【④ roundId：ALS 自动关联】');
  {
    let captured = null;
    await mc.withRound({ kind: 'autonomous', chatKey: 'auto' }, async (r) => {
      await new Promise((res) => setTimeout(res, 10));   // 跨 await 也要能拿到
      captured = mc.currentRound();
      mc.recordCall({ purpose: 'autonomous.intent', backend: 'api', status: 'success', file: FILE });
      mc.recordCall({ purpose: 'autonomous.decision', backend: 'api', status: 'success', file: FILE });
      return r;
    });
    ok('ALS 跨 await 能拿到 round', captured && /^round-/.test(captured.roundId), JSON.stringify(captured));
    const all = mc.readCalls({ file: FILE }).filter((c) => c.roundId === captured.roundId);
    ok('两条记录同一个 roundId', all.length === 2, String(all.length));
    ok('purpose 各不相同', all[0].purpose === 'autonomous.intent' && all[1].purpose === 'autonomous.decision');
  }

  console.log('\n【⑤ 轮转：2 MB 上限，轮转失败不删旧文件】');
  {
    const f = path.join(tmp, 'rotate.ndjson');
    // 用小上限快速触发
    fs.writeFileSync(f, 'x'.repeat(500), 'utf8');
    mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: f, maxBytes: 400 });
    ok('超上限后当前文件被重写（只剩新记录）', fs.statSync(f).size < 500, String(fs.statSync(f).size));
    ok('旧数据轮转成 .1', fs.existsSync(`${f}.1`), '没有 .1');
    ok('.1 里有原来的 500 字节', fs.statSync(`${f}.1`).size === 500, String(fs.statSync(`${f}.1`).size));

    // 轮转失败：把 .1 设成目录，rename 会失败
    const f2 = path.join(tmp, 'rot-fail.ndjson');
    fs.writeFileSync(f2, 'y'.repeat(500), 'utf8');
    fs.mkdirSync(`${f2}.1`, { recursive: true });   // rename 到已存在的目录会失败
    mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: f2, maxBytes: 400 });
    ok('**轮转失败时旧文件还在**', fs.existsSync(f2) && fs.statSync(f2).size >= 500, String(fs.statSync(f2).size));
    ok('轮转失败不影响写入', fs.readFileSync(f2, 'utf8').includes('"purpose"'));
  }

  console.log('\n【⑥ 坏行处理】');
  {
    const f = path.join(tmp, 'bad.ndjson');
    fs.writeFileSync(f, '{"good":1}\n{ 这不是 json\n{"good":2}\n\n', 'utf8');
    const all = mc.readCalls({ file: f });
    ok('坏行被跳过、好行保留', all.length === 2, String(all.length));
    ok('不抛异常', true);
  }

  console.log('\n【⑦ 写失败不影响调用方】');
  {
    // 指向一个不可能写的路径
    const bad = process.platform === 'win32' ? 'Z:\\nope\\x.ndjson' : '/proc/nope/x.ndjson';
    const r = mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: bad });
    ok('返回 ok:false 而不是抛', r.ok === false, JSON.stringify(r).slice(0, 80));
    ok('有错误信息', Boolean(r.error));
  }

  console.log('\n【⑧ 非法输入被归一化】');
  {
    const r = mc.recordCall({
      purpose: '不存在的任务', backend: 'unknown-backend', status: 'weird',
      failureCode: '不存在的码', file: FILE
    });
    ok('未知 purpose → other', r.record.purpose === 'other', r.record.purpose);
    ok('未知 backend → api', r.record.backend === 'api', r.record.backend);
    ok('未知 status → failed', r.record.status === 'failed', r.record.status);
    ok('未知 failureCode → UNKNOWN 且有 detail', r.record.failureCode === 'UNKNOWN' && r.record.failureDetail, r.record.failureDetail);
  }

  console.log('\n【⑨ 跨进程并发写】');
  {
    const f = path.join(tmp, 'concurrent.ndjson');
    const body = `
const mc = await import(${JSON.stringify(MOD)});
for (let i = 0; i < 50; i += 1) {
  mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: ${JSON.stringify(f)} });
}
process.stdout.write('done');
`;
    const run = (tag) => new Promise((resolve) => {
      const out = fs.openSync(path.join(tmp, `${tag}.out`), 'a');
      const err = fs.openSync(path.join(tmp, `${tag}.err`), 'a');
      const c = spawn(process.execPath, ['--input-type=module', '-e', body], {
        cwd: ROOT, env: { ...process.env, QQ_AGENT_DATA_DIR: tmp }, stdio: ['ignore', out, err], windowsHide: true
      });
      c.on('exit', (code) => {
        try { fs.closeSync(out) } catch { /* ignore */ }
        try { fs.closeSync(err) } catch { /* ignore */ }
        resolve(code);
      });
    });
    const [a, b] = await Promise.all([run('c1'), run('c2')]);
    ok('两个子进程都正常退出', a === 0 && b === 0, `${a}/${b}`);
    const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    ok('100 条全部写进去（一条不丢）', lines.length === 100, String(lines.length));
    ok('每行都是合法 JSON', lines.every((l) => { try { JSON.parse(l); return true } catch { return false } }));
    ok('没有残留锁', !fs.existsSync(`${f}.lock`), '有 .lock 残留');
  }

  console.log('\n【⑩ 统计与分组】');
  {
    const s = mc.stats({ file: FILE });
    ok('有 total', typeof s.total === 'number' && s.total > 0, String(s.total));
    ok('按 backend 分组', s.byBackend.dsh >= 1 && s.byBackend.api >= 1, JSON.stringify(s.byBackend));
    ok('按 purpose 分组', s.byPurpose['chat.reply'] >= 1, JSON.stringify(s.byPurpose));
    ok('失败按 code 分组', s.byFailure.DSH_TIMEOUT >= 1, JSON.stringify(s.byFailure));
    ok('统计到 fallback 次数', s.fallbacks >= 1, String(s.fallbacks));

    const calls = mc.readCalls({ file: FILE });
    const groups = mc.groupByRound(calls);
    ok('按 roundId 分组能拿到', groups.size >= 2, String(groups.size));
  }

  console.log('\n【⑪ 诊断类默认排除在统计外】');
  {
    const f = path.join(tmp, 'diag.ndjson');
    mc.recordCall({ purpose: 'diagnostic.route_test', backend: 'api', status: 'success', file: f });
    mc.recordCall({ purpose: 'chat.reply', backend: 'api', status: 'success', file: f });
    const s1 = mc.stats({ file: f });
    ok('默认排除诊断', s1.total === 1, String(s1.total));
    const s2 = mc.stats({ file: f, excludeDiagnostic: false });
    ok('显式要求时包含诊断', s2.total === 2, String(s2.total));
  }

  console.log('\n【⑫ 只读性与容量】');
  {
    const sz = mc.storage();
    ok('有 current/archive/total 三个数', typeof sz.currentBytes === 'number' && typeof sz.archiveBytes === 'number');
    ok('上限是 2 MB', sz.maxBytes === 2 * 1024 * 1024, String(sz.maxBytes));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
