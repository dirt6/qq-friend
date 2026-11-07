// 存储容量监控的验收测试（4.0 · 1.5.7.6）。
//
// 机主的规则：
//   < 500 MB 正常 / ≥ 500 MB 预警 / ≥ 1 GB 暂停自动归档
//   **1 GB 只暂停归档，不删除、不停止机器人、不影响聊天**
//
// 做法：造几个假目录（用稀疏文件撑大小），验证分级与边界。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = pathToFileURL(path.join(ROOT, 'src', 'storage-health.js')).href;

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-health-'));

/** 造一个指定大小的文件（用稀疏写，不真占磁盘）。 */
function makeFile(p, bytes) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  try { fs.ftruncateSync(fd, bytes); } finally { fs.closeSync(fd); }
}

try {
  const { storageHealth, canArchive, WARN_BYTES, STOP_BYTES } = await import(MOD);

  console.log('【① 空目录：正常】');
  {
    const d = path.join(tmp, 'empty');
    fs.mkdirSync(d, { recursive: true });
    const h = storageHealth({ dataDir: d });
    ok('等级 ok', h.level === 'ok', h.level);
    ok('总计 0', h.totalBytes === 0, String(h.totalBytes));
    ok('没有 error 级问题', h.issues.every((i) => i.level !== 'error'));
    ok('能归档', canArchive({ dataDir: d }).ok === true);
  }

  console.log('\n【② 400 MB：仍然正常】');
  {
    const d = path.join(tmp, 'w400');
    makeFile(path.join(d, 'sessions', 'a.json'), 400 * 1024 * 1024);
    const h = storageHealth({ dataDir: d });
    ok('等级 ok', h.level === 'ok', h.level);
    ok('sessions 被统计到', h.dirs.find((x) => x.name === 'sessions').bytes === 400 * 1024 * 1024);
    ok('能归档', canArchive({ dataDir: d }).ok === true);
  }

  console.log('\n【③ 600 MB：预警，但仍能归档】');
  {
    const d = path.join(tmp, 'w600');
    makeFile(path.join(d, 'dsh-home', 'x'), 600 * 1024 * 1024);
    const h = storageHealth({ dataDir: d });
    ok('等级 warn', h.level === 'warn', h.level);
    ok('有 warn 级问题', h.issues.some((i) => i.code === 'storage-warn'));
    ok('ok 还是 true（warn 不阻断）', h.ok === true);
    ok('仍然能归档', canArchive({ dataDir: d }).ok === true, JSON.stringify(canArchive({ dataDir: d })));
  }

  console.log('\n【④ 1.2 GB：停止自动归档，但 ok=false 只影响归档】');
  {
    const d = path.join(tmp, 'w1200');
    makeFile(path.join(d, 'sessions', 'big.json'), 1200 * 1024 * 1024);
    const h = storageHealth({ dataDir: d });
    ok('等级 stop', h.level === 'stop', h.level);
    ok('有 error 级问题', h.issues.some((i) => i.level === 'error' && i.code === 'storage-stop'));
    ok('ok=false（给调用方信号）', h.ok === false);
    const g = canArchive({ dataDir: d });
    ok('canArchive 拒绝', g.ok === false, JSON.stringify(g));
    ok('拒绝理由里有人话', /1 GB/.test(g.reason) || /暂停/.test(g.reason), g.reason);
    ok('阈值常量正确', h.warnBytes === 500 * 1024 * 1024 && h.stopBytes === 1024 * 1024 * 1024);
  }

  console.log('\n【⑤ 边界：正好 500 MB 触发预警】');
  {
    const d = path.join(tmp, 'w500');
    makeFile(path.join(d, 'messages', 'x.json'), WARN_BYTES);
    const h = storageHealth({ dataDir: d });
    ok('≥ 500MB 就 warn', h.level === 'warn', h.level);
  }

  console.log('\n【⑥ 边界：正好 1 GB 触发停止】');
  {
    const d = path.join(tmp, 'w1024');
    makeFile(path.join(d, 'logs', 'x.log'), STOP_BYTES);
    const h = storageHealth({ dataDir: d });
    ok('≥ 1GB 就 stop', h.level === 'stop', h.level);
  }

  console.log('\n【⑦ 不存在的目录不报错】');
  {
    const d = path.join(tmp, 'nothing');
    fs.mkdirSync(d, { recursive: true });
    const h = storageHealth({ dataDir: d });
    ok('不抛异常', typeof h.totalBytes === 'number');
    ok('所有监控项都标了 exists=false', h.dirs.every((x) => x.exists === false));
  }

  console.log('\n【⑧ 摘要行可读】');
  {
    const { summaryLine } = await import(MOD);
    const d = path.join(tmp, 'w600');
    const line = summaryLine({ dataDir: d });
    ok('包含 MB 和最大目录', /MB/.test(line) && /dsh-home/.test(line), line);
  }

  console.log('\n【⑨ 只读：调用前后真实 data 不变】');
  {
    const real = path.join(ROOT, 'data');
    const before = fs.statSync(path.join(real, 'sessions')).mtimeMs;
    const h = storageHealth({ dataDir: real });
    const after = fs.statSync(path.join(real, 'sessions')).mtimeMs;
    ok('体检不写文件（mtime 没变）', before === after);
    ok('真实数据能算出来', h.totalBytes > 0, String(h.totalBytes));
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
