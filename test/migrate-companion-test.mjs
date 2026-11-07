// Companion State 迁移脚本的边界测试（4.0 · 阶段 2.3）。
//
// 机主的完成标准：
//   [ ] --dry 连续运行两次结果一致，文件哈希不变
//   [ ] 空文件、缺字段、异常字段、已有目标文件都有明确处理
//   [ ] 迁移前备份可用
//   [ ] 正式迁移后新旧数据逐项核对
//   [ ] 重复执行不会重复迁移或覆盖新状态
//   [ ] 旧字段仍保留
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'migrate-companion-state.mjs');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };

function mkdir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-cs-'));
  fs.mkdirSync(path.join(d, 'backups'), { recursive: true });
  return d;
}

/** 跑脚本（同步），返回 {code, out}。 */
function run(dir, args) {
  return new Promise((resolve) => {
    const outFile = path.join(dir, `.out-${Date.now()}-${Math.random().toString(36).slice(2, 5)}.txt`);
    const fd = fs.openSync(outFile, 'a');
    const c = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: dir },
      stdio: ['ignore', fd, fd],
      windowsHide: true
    });
    c.on('exit', (code) => {
      try { fs.closeSync(fd) } catch { /* ignore */ }
      let out = '';
      try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { fs.unlinkSync(outFile) } catch { /* ignore */ }
      resolve({ code, out });
    });
  });
}

const writeAuto = (dir, obj) => fs.writeFileSync(path.join(dir, 'autonomous.json'), JSON.stringify(obj), 'utf8');

try {
  console.log('【① 正常数据：dry 输出正确、真只读】');
  {
    const d = mkdir();
    writeAuto(d, {
      currentGoal: '继续完善小镇游戏的故事',
      pendingNextStep: { topic: '等老大有空继续聊', status: 'pending', at: 1793512787000 }
    });
    const h1 = sha(path.join(d, 'autonomous.json'));

    const r1 = await run(d, ['--dry']);
    ok('dry 退出码 0', r1.code === 0, String(r1.code));
    ok('输出 goal 1 / pending 1', /currentGoal found: 1/.test(r1.out) && /pendingNextStep found: 1/.test(r1.out), r1.out.slice(0, 200));
    ok('topic → null', /Topic:\s*\n\s*-> null/.test(r1.out));
    ok('没创建目标文件', !fs.existsSync(path.join(d, 'companion-state.json')));
    ok('没创建标记', !fs.existsSync(path.join(d, 'companion-state-migration.json')));
    ok('源文件哈希不变', sha(path.join(d, 'autonomous.json')) === h1);

    const r2 = await run(d, ['--dry']);
    ok('两次 dry 输出一致', r1.out === r2.out);

    const hashLine = (r1.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';
    ok('输出了源文件指纹', hashLine.length === 64, hashLine.slice(0, 20));
    fs.writeFileSync(path.join(d, '.hash'), hashLine, 'utf8');
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【② 空文件 / 缺字段 / 异常字段 → 进 skipped 且不崩】');
  {
    const d = mkdir();
    writeAuto(d, {});
    const r = await run(d, ['--dry']);
    ok('空对象不崩', r.code === 0, String(r.code));
    ok('两个字段都进 skipped', /currentGoal：字段不存在/.test(r.out) && /pendingNextStep：字段不存在/.test(r.out), r.out);
    ok('goal 0 / pending 0', /currentGoal found: 0/.test(r.out) && /pendingNextStep found: 0/.test(r.out));
    fs.rmSync(d, { recursive: true, force: true });
  }
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: '', pendingNextStep: null });
    const r = await run(d, ['--dry']);
    ok('空字符串 / null 都进 skipped', /currentGoal：空值/.test(r.out) && /pendingNextStep：空值/.test(r.out), r.out);
    fs.rmSync(d, { recursive: true, force: true });
  }
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: 12345, pendingNextStep: ['a', 'b'] });
    const r = await run(d, ['--dry']);
    ok('异常类型进 skipped 并说明类型', /无法解析成文本（类型 number）/.test(r.out), r.out);
    ok('不崩', r.code === 0);
    fs.rmSync(d, { recursive: true, force: true });
  }
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: 'x'.repeat(300) });
    const r = await run(d, ['--dry']);
    ok('超长 goal 进 skipped（不截断）', /太长（300 字）/.test(r.out), r.out);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【③ 源文件不是 JSON → 明确报错退出】');
  {
    const d = mkdir();
    fs.writeFileSync(path.join(d, 'autonomous.json'), '{ 坏的', 'utf8');
    const r = await run(d, ['--dry']);
    ok('退出码非 0', r.code !== 0, String(r.code));
    ok('报错信息清楚', /读不了源文件/.test(r.out), r.out.slice(0, 120));
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【④ 正式迁移：备份 + 写入 + 标记 + 旧字段保留】');
  {
    const d = mkdir();
    const srcObj = {
      currentGoal: '继续完善小镇游戏的故事',
      pendingNextStep: { topic: '等老大有空继续聊', status: 'pending', at: 1793512787000 }
    };
    writeAuto(d, srcObj);
    const autoHashBefore = sha(path.join(d, 'autonomous.json'));

    const dry = await run(d, ['--dry']);
    const hash = (dry.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';

    const ap = await run(d, ['--apply', '--expect-hash', hash]);
    ok('apply 退出码 0', ap.code === 0, String(ap.code) + ' ' + ap.out.slice(-200));
    ok('目标文件生成了', fs.existsSync(path.join(d, 'companion-state.json')));
    ok('标记生成了', fs.existsSync(path.join(d, 'companion-state-migration.json')));
    ok('备份生成了', fs.readdirSync(path.join(d, 'backups')).some((f) => f.startsWith('autonomous-before-companion-')));

    const st = JSON.parse(fs.readFileSync(path.join(d, 'companion-state.json'), 'utf8'));
    ok('goal 迁过来了', st.goal?.text === '继续完善小镇游戏的故事', JSON.stringify(st.goal));
    ok('goal 标记 source=autonomous', st.goal?.source === 'autonomous');
    ok('pending 迁过来了', st.pending.length === 1 && st.pending[0].text === '等老大有空继续聊', JSON.stringify(st.pending));
    ok('pending 状态是 pending（没擅自推断）', st.pending[0].status === 'pending');
    ok('**用了旧时间戳而不是迁移时间**', st.pending[0].atSource === 'legacy', st.pending[0].atSource);
    ok('topic 仍是 null', st.topic === null);
    ok('有 id', /^p-[0-9a-f]{6}$/.test(st.pending[0].id), st.pending[0].id);

    ok('**旧字段仍保留**（没删）', (() => {
      const a = JSON.parse(fs.readFileSync(path.join(d, 'autonomous.json'), 'utf8'));
      return a.currentGoal === '继续完善小镇游戏的故事' && Boolean(a.pendingNextStep);
    })());
    ok('源文件字节级未改', sha(path.join(d, 'autonomous.json')) === autoHashBefore);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑤ 重复执行：识别已迁移，不重复加】');
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: '目标 A', pendingNextStep: { topic: '待办 A' } });
    const dry = await run(d, ['--dry']);
    const hash = (dry.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';
    await run(d, ['--apply', '--expect-hash', hash]);
    const st1 = JSON.parse(fs.readFileSync(path.join(d, 'companion-state.json'), 'utf8'));
    const n1 = st1.pending.length;

    // 再跑一次（哈希已变？源文件没变，哈希应该一样）
    const ap2 = await run(d, ['--apply', '--expect-hash', hash]);
    ok('第二次跑不报错', ap2.code === 0, String(ap2.code));
    ok('提示已迁移过', /已迁移过/.test(ap2.out), ap2.out.slice(0, 150));
    const st2 = JSON.parse(fs.readFileSync(path.join(d, 'companion-state.json'), 'utf8'));
    ok('pending 数量没变（没重复加）', st2.pending.length === n1, `${n1} → ${st2.pending.length}`);
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑥ 已有目标文件（有内容）→ 拒绝覆盖】');
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: '新的目标' });
    fs.writeFileSync(path.join(d, 'companion-state.json'), JSON.stringify({
      version: 1,
      goal: { text: '已有的目标', source: 'chat', since: '2026-11-01T00:00:00Z' },
      topic: null,
      pending: [{ id: 'p-aaaaaa', text: '已有待办', status: 'pending', source: 'chat', at: '2026-11-01T00:00:00Z' }]
    }), 'utf8');

    const dry = await run(d, ['--dry']);
    ok('dry 报出冲突', /已存在且\*\*有内容\*\*/.test(dry.out) || /有内容/.test(dry.out), dry.out.slice(-300));
    const hash = (dry.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';
    const ap = await run(d, ['--apply', '--expect-hash', hash]);
    ok('apply 拒绝（退出码非 0）', ap.code !== 0, String(ap.code));
    ok('报错说清"拒绝覆盖"', /拒绝覆盖/.test(ap.out), ap.out.slice(-200));
    const st = JSON.parse(fs.readFileSync(path.join(d, 'companion-state.json'), 'utf8'));
    ok('原状态没被动', st.goal.text === '已有的目标');
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑦ 哈希不匹配 → 中止（防止预览后源文件被改）】');
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: '目标 X' });
    const dry = await run(d, ['--dry']);
    const hash = (dry.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';
    // 模拟：预览之后自主活动又改了 autonomous.json
    writeAuto(d, { currentGoal: '目标 X（被改过）' });
    const ap = await run(d, ['--apply', '--expect-hash', hash]);
    ok('中止（退出码非 0）', ap.code !== 0, String(ap.code));
    ok('说明哈希不一致', /哈希与预期不一致/.test(ap.out), ap.out.slice(-200));
    ok('没创建目标文件', !fs.existsSync(path.join(d, 'companion-state.json')));
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑧ 没带 --expect-hash → 拒绝执行】');
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: 'x' });
    const ap = await run(d, ['--apply']);
    ok('拒绝（退出码非 0）', ap.code !== 0, String(ap.code));
    ok('提示必须带 --expect-hash', /必须带 --expect-hash/.test(ap.out), ap.out.slice(0, 150));
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑨ 旧状态是字符串形式（更老的格式）】');
  {
    const d = mkdir();
    writeAuto(d, { currentGoal: '', pendingNextStep: '等老大有空' });
    const r = await run(d, ['--dry']);
    ok('字符串形式能识别', /pendingNextStep found: 1/.test(r.out), r.out);
    ok('goal 空 → skipped', /currentGoal：空值/.test(r.out));
    fs.rmSync(d, { recursive: true, force: true });
  }

  console.log('\n【⑩ 旧数据明确写 done → 不擅自改成 pending】');
  {
    const d = mkdir();
    writeAuto(d, { pendingNextStep: { topic: '已经做完的事', status: 'done' } });
    const dry = await run(d, ['--dry']);
    const hash = (dry.out.match(/sha256:\s*([0-9a-f]{64})/) || [])[1] || '';
    await run(d, ['--apply', '--expect-hash', hash]);
    const st = JSON.parse(fs.readFileSync(path.join(d, 'companion-state.json'), 'utf8'));
    ok('保留 done', st.pending[0]?.status === 'done', st.pending[0]?.status);
    fs.rmSync(d, { recursive: true, force: true });
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
