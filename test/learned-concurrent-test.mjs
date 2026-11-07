// 经验库单写者的并发测试（4.0 · 1.5.4）。
//
// 机主点名要求：**不能丢 hits / corrections / history**。
// 这几个字段是累加值，最怕「两进程各读旧值再各加 1，后写的覆盖先写的」。
//
// 用真实公开接口：selectForContext 每次选中会给 hits +1 并落盘。
// 隔离：临时 DATA_DIR，不碰生产 learned.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'learned-conc-'));
const dataDir = tmp;
const FILE = path.join(dataDir, 'learned.json');

fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ persona: { roleText: 'x' } }), 'utf8');
fs.writeFileSync(FILE, JSON.stringify({
  version: 1,
  items: [{
    id: 'l-test-1',
    text: '测试并发的时候要小心一点，别把计数弄丢了',
    status: 'stable', tags: [], sourceDay: '2026-10-01',
    createdAt: 1, updatedAt: 1, lastUsedAt: 1,
    hits: 100, corrections: 3
  }]
}), 'utf8');

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};
const read = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const find = (id) => read().items.find((x) => x.id === id);

const MOD = pathToFileURL(path.join(ROOT, 'src', 'learned.js')).href;

function runChild(tag, body) {
  return new Promise((resolve) => {
    const outFile = path.join(tmp, `${tag}.out`);
    const errFile = path.join(tmp, `${tag}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const script = `const L = await import(${JSON.stringify(MOD)});\n${body}\nprocess.exit(0);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: ROOT,
      env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
      stdio: ['ignore', out, err],
      windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill() } catch { /* ignore */ } }, 120000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out) } catch { /* ignore */ }
      try { fs.closeSync(err) } catch { /* ignore */ }
      let stdout = ''; let stderr = '';
      try { stdout = fs.readFileSync(outFile, 'utf8'); } catch { /* ignore */ }
      try { stderr = fs.readFileSync(errFile, 'utf8').slice(0, 400); } catch { /* ignore */ }
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  console.log('【① 两进程各选 10 次：hits 必须 +20，不能只 +10】');
  {
    const before = find('l-test-1').hits;
    // 每次 selectForContext 命中 → hits+1 → writeStore
    const body = `
for (let i = 0; i < 10; i += 1) {
  L.selectForContext({ contextText: '测试并发的时候要小心一点', limit: 1 });
}
process.stdout.write('done');
`;
    const [a, b] = await Promise.all([runChild('a', body), runChild('b', body)]);
    ok('两个子进程都跑完', a.code === 0 && b.code === 0 && a.stdout === 'done' && b.stdout === 'done',
      `${a.code}/${b.code} ${a.stderr}${b.stderr}`);
    const after = find('l-test-1').hits;
    ok(`hits ${before} → ${before + 20}`, after === before + 20, `实际 ${after}（丢了 ${before + 20 - after} 次）`);
  }

  console.log('\n【② 并发写不同字段：互不覆盖】');
  {
    // A 改 status，B 改 text，两边都基于同一份旧快照
    const bodyA = `
const s = L.listAll();
L.setStatus('l-test-1', 'archived', { source: 'owner' });
process.stdout.write('a');
`;
    const bodyB = `
const s = L.listAll();
L.saveItem('l-test-1', '被 B 改过的文本，长度也够长不影响判断');
process.stdout.write('b');
`;
    const [a, b] = await Promise.all([runChild('fa', bodyA), runChild('fb', bodyB)]);
    ok('两个子进程都跑完', a.code === 0 && b.code === 0 && a.stdout === 'a' && b.stdout === 'b',
      `${a.code}/${b.code} ${a.stderr}${b.stderr}`);
    const it = find('l-test-1');
    ok('B 改的 text 生效', String(it.text).includes('被 B 改过'), it.text);
    // 这一条如果挂了，说明"没改的字段保留锁内值"没生效
    ok('A 改的 status 没被 B 的旧值覆盖', it.status === 'archived', it.status);
    ok('hits 还在（没被重置）', Number(it.hits) >= 120, String(it.hits));
  }

  console.log('\n【③ 删除仍然是删除（不被合并逻辑复活）】');
  {
    const r = await runChild('del', `
L.removeItem('l-test-1');
process.stdout.write('gone');
`);
    ok('删除执行完', r.code === 0 && r.stdout === 'gone', r.stderr);
    ok('条目真的没了', find('l-test-1') === undefined, JSON.stringify(find('l-test-1')));
  }

  console.log('\n【④ 并发新增：两条都进库】');
  {
    const before = read().items.length;
    const body = `
// 故意用两条**不相似**的文本：太像的会被 addExperience 的同义合并逻辑合掉（那是设计行为）
L.addExperience({ text: '老大说想吃火锅，先记下来备用', sourceDay: '2026-10-31' });
process.stdout.write('1');
`;
    const body2 = `
L.addExperience({ text: '桌宠部署拖了很久，下次见面提醒一句', sourceDay: '2026-10-31' });
process.stdout.write('2');
`;
    const [a, b] = await Promise.all([runChild('na', body), runChild('nb', body2)]);
    ok('两个子进程都跑完', a.code === 0 && b.code === 0, `${a.code}/${b.code} ${a.stderr}${b.stderr}`);
    const after = read().items;
    ok(`条目数 ${before} → ${before + 2}`, after.length === before + 2, `实际 ${after.length}`);
    const texts = after.map((x) => x.text).join('|');
    ok('甲在库里', texts.includes('火锅'));
    ok('乙在库里', texts.includes('桌宠部署'));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
