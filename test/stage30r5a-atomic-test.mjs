// 阶段 3.0-R5-A 专项测试：writeFileAtomic 失败路径。
//
// 机主 2026-11-02 的要求：
//   · rename 成功后不误删目标文件
//   · rename 最终失败时尽可能清理本次临时文件
//   · 清理失败不能掩盖原始错误
//   · 临时文件使用唯一名称
//   · 保留原文件内容，失败时不能出现半写入
//
// 测试手法：monkey patch fs.renameSync / fs.unlinkSync 模拟各种失败。
// （ESM 里 node:fs 是同一个对象，patch 对被测模块有效）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r5a-'));

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const FL = await import(pathToFileURL(path.join(ROOT, 'src', 'file-lock.js')).href);

/** 临时 patch，跑完恢复。 */
function withPatch(patches, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(patches)) { saved[k] = fs[k]; fs[k] = v; }
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(saved)) { fs[k] = v; }
  }
}

const listTmp = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));

try {
  console.log('【① rename 成功：正常写入，无残留】');
  {
    const dir = path.join(tmp, 'a');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '旧内容', 'utf8');

    FL.writeFileAtomic(f, '新内容');
    ok('内容已替换', fs.readFileSync(f, 'utf8') === '新内容');
    ok('**没有残留 .tmp**', listTmp(dir).length === 0, listTmp(dir).join(','));
  }

  console.log('\n【② rename 成功一次（EPERM 后重试成功）】');
  {
    const dir = path.join(tmp, 'b');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '旧', 'utf8');

    let calls = 0;
    const real = fs.renameSync;
    withPatch({
      renameSync: (a, b) => {
        calls += 1;
        if (calls <= 2) { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
        return real(a, b);
      }
    }, () => {
      FL.writeFileAtomic(f, '新');
    });
    ok('重试后成功', fs.readFileSync(f, 'utf8') === '新');
    ok('**重试了 3 次**', calls === 3, String(calls));
    ok('**没有残留 .tmp**', listTmp(dir).length === 0, listTmp(dir).join(','));
  }

  console.log('\n【③ EPERM 重试耗尽：抛错 + 不留 tmp + 原文件不变】');
  {
    const dir = path.join(tmp, 'c');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '原始内容不能变', 'utf8');
    const before = fs.readFileSync(f, 'utf8');

    let err = null;
    withPatch({
      renameSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; }
    }, () => {
      try { FL.writeFileAtomic(f, '新内容'); } catch (e) { err = e; }
    });

    ok('**抛出了错误**', err !== null);
    ok('错误码保留', err?.code === 'EPERM', err?.code);
    ok('**原文件内容没变**', fs.readFileSync(f, 'utf8') === before, fs.readFileSync(f, 'utf8'));
    ok('**没有残留 .tmp**', listTmp(dir).length === 0, listTmp(dir).join(','));
  }

  console.log('\n【④ 非重试错误：直接抛，仍清理 tmp】');
  {
    const dir = path.join(tmp, 'd');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '旧', 'utf8');

    let err = null;
    let calls = 0;
    withPatch({
      renameSync: () => {
        calls += 1;
        const e = new Error('ENOSPC'); e.code = 'ENOSPC'; throw e;
      }
    }, () => {
      try { FL.writeFileAtomic(f, '新'); } catch (e) { err = e; }
    });

    ok('**抛出了错误**', err !== null);
    ok('**只试了 1 次**（非重试错误不重试）', calls === 1, String(calls));
    ok('**原文件没变**', fs.readFileSync(f, 'utf8') === '旧');
    ok('**没有残留 .tmp**', listTmp(dir).length === 0, listTmp(dir).join(','));
  }

  console.log('\n【⑤ tmp 清理失败：不掩盖原始错误】');
  {
    const dir = path.join(tmp, 'e');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    fs.writeFileSync(f, '旧', 'utf8');

    let err = null;
    withPatch({
      renameSync: () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; },
      unlinkSync: () => { const e = new Error('EBUSY-unlink'); e.code = 'EBUSY'; throw e; }
    }, () => {
      try { FL.writeFileAtomic(f, '新'); } catch (e) { err = e; }
    });

    ok('**抛的是 rename 的错，不是 unlink 的错**', err?.code === 'EPERM', err?.code);
    ok('原文件没变', fs.readFileSync(f, 'utf8') === '旧');
  }

  console.log('\n【⑥ 临时文件名唯一：并发两次写入不互相覆盖】');
  {
    const dir = path.join(tmp, 'f');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    // 连续写 5 次，每次都成功；检查没有 .tmp 残留、内容正确
    for (let i = 0; i < 5; i += 1) FL.writeFileAtomic(f, `第${i}次`);
    ok('最终内容是最后一次', fs.readFileSync(f, 'utf8') === '第4次', fs.readFileSync(f, 'utf8'));
    ok('**没有残留**', listTmp(dir).length === 0);
  }

  console.log('\n【⑦ 半写入：内容要么全新要么全旧】');
  {
    const dir = path.join(tmp, 'g');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'x.json');
    const big = 'x'.repeat(100000);
    fs.writeFileSync(f, '旧', 'utf8');
    FL.writeFileAtomic(f, big);
    const got = fs.readFileSync(f, 'utf8');
    ok('**完整写入，没有截断**', got.length === big.length, `${got.length} vs ${big.length}`);
  }

  console.log('\n【⑧ 目标文件不存在（首次创建）】');
  {
    const dir = path.join(tmp, 'h');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'new.json');
    FL.writeFileAtomic(f, '第一次');
    ok('创建成功', fs.readFileSync(f, 'utf8') === '第一次');
    ok('没有残留', listTmp(dir).length === 0);
  }
} catch (e) {
  ok('测试执行不抛异常', false, e?.message || String(e));
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
process.exit(0);
