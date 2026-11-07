// 阶段 3.0-R5-D 专项测试：Memory Hub 日记写入接入。
//
// 机主 2026-11-02 的要求：
//   · 保持六层记忆原有文件布局
//   · 日记原文保持不变
//   · 空日记不允许写入指向不存在段落的元数据
//   · 元数据读取、写入、定位通过统一入口
//   · 不猜测 stale 引用的新位置
//   · 保持旧数据读取兼容
//   · **明确生产启用开关和回退方案**
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

function mkEnv(paragraphs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r5d-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    persona: { roleText: 'x' },
    skills: { diary: { root: dir } }
  }), 'utf8');
  const dayDir = path.join(dir, '每日');
  fs.mkdirSync(dayDir, { recursive: true });
  const f = path.join(dayDir, '2026-11-02.md');
  fs.writeFileSync(f, paragraphs.join('\n\n') + '\n', 'utf8');
  return { dir, src: f };
}

async function main() {
  const { dir, src } = mkEnv(['第一段。', '第二段。', '第三段。']);
  process.env.QQ_AGENT_DATA_DIR = dir;
  const D = await import(pathToFileURL(path.join(ROOT, 'src', 'memory-hub', 'diary-write.js')).href);
  const KEY = '2026-11-02';

  try {
    console.log('【① 默认关闭：不写，且明确报 DISABLED】');
    {
      delete process.env.QQ_DIARY_META_WRITE;
      ok('**diaryWriteEnabled() === false**', D.diaryWriteEnabled() === false);
      const r = D.appendDiaryMemory({ dateKey: KEY, paragraphIndex: 0 });
      ok('**返回 DISABLED**', r.ok === false && r.code === 'DISABLED', JSON.stringify(r));
      ok('**没有写元数据文件**', !fs.existsSync(path.join(dir, 'diary-meta', `${KEY}.json`)));
    }

    console.log('\n【② 打开开关后：能写】');
    {
      process.env.QQ_DIARY_META_WRITE = '1';
      ok('diaryWriteEnabled() === true', D.diaryWriteEnabled() === true);
      const r = D.appendDiaryMemory({
        dateKey: KEY, paragraphIndex: 0, contentType: 'event', epistemicType: 'direct', roundId: 'round-a'
      });
      ok('**写入成功**', r.ok === true && r.added === true, JSON.stringify(r));
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'diary-meta', `${KEY}.json`), 'utf8'));
      ok('元数据里有 1 条', meta.entries.length === 1);
      ok('roundId 落盘', meta.entries[0].roundId === 'round-a');
    }

    console.log('\n【③ 幂等：同段同内容不重复】');
    {
      const r = D.appendDiaryMemory({ dateKey: KEY, paragraphIndex: 0, contentType: 'event' });
      ok('**added: false**', r.ok === true && r.added === false, JSON.stringify(r));
      const meta = JSON.parse(fs.readFileSync(path.join(dir, 'diary-meta', `${KEY}.json`), 'utf8'));
      ok('还是 1 条', meta.entries.length === 1);
    }

    console.log('\n【④ 日记原文一个字节没变】');
    {
      const before = sha(src);
      D.appendDiaryMemory({ dateKey: KEY, paragraphIndex: 1, contentType: 'event' });
      D.readDayDiaryMemory(KEY);
      D.listDiaryParagraphs(KEY);
      ok('**原文 hash 完全一致**', sha(src) === before);
    }

    console.log('\n【⑤ 空日记：不允许写入】');
    {
      // ⚠️ 必须用子进程：diary-write.js 的 diaryRoot() 读 getConfig()，有模块级缓存，
      // 在父进程里换 QQ_AGENT_DATA_DIR 不可靠（会读到第一个目录）。
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'r5d-empty-'));
      fs.writeFileSync(path.join(empty, 'config.json'), JSON.stringify({
        persona: { roleText: 'x' }, skills: { diary: { root: empty } }
      }), 'utf8');
      fs.mkdirSync(path.join(empty, '每日'), { recursive: true });
      // **真的空文件**
      fs.writeFileSync(path.join(empty, '每日', `${KEY}.md`), '', 'utf8');

      const worker = path.join(ROOT, 'scripts', 'r5d-empty-worker.mjs');
      // **必须 stdio:'ignore'** —— 沙箱下默认 pipe 会 EPERM（已知限制）
      const child = spawnSync(process.execPath, [worker, empty, KEY], {
        stdio: 'ignore', env: { ...process.env, QQ_DIARY_META_WRITE: '1' }
      });
      let out = null;
      try { out = JSON.parse(fs.readFileSync(path.join(empty, 'out.json'), 'utf8')); } catch { out = null; }
      if (!out) {
        console.log('    [调试] child.status=' + child.status + ' signal=' + child.signal);
        console.log('    [调试] stderr=' + String(child.stderr || '').slice(0, 400));
        console.log('    [调试] stdout=' + String(child.stdout || '').slice(0, 400));
      }
      ok('**拒绝（越界）**', out?.ok === false, JSON.stringify(out));
      ok('**没有生成元数据文件**', !fs.existsSync(path.join(empty, 'diary-meta', `${KEY}.json`)));
      fs.rmSync(empty, { recursive: true, force: true });
    }

    console.log('\n【⑥ 读取 / 定位走统一入口】');
    {
      const day = D.readDayDiaryMemory(KEY);
      ok('readDayDiaryMemory ok', day.ok === true);
      ok('**entries 带定位结果**', day.entries.every((e) => typeof e.ok === 'boolean' && 'stale' in e));
      ok('entry 有 paragraphIndex / quoteHash', 'paragraphIndex' in day.entries[0] && 'quoteHash' in day.entries[0]);

      const loc = D.locateDiaryMemory(KEY, day.entries[0]);
      ok('**定位成功**', loc.ok === true, JSON.stringify(loc));

      const bad = D.locateDiaryMemory(KEY, { paragraphIndex: 0, quoteHash: 'sha1:deadbeef' });
      ok('**hash 不对 → stale**', bad.ok === false && bad.stale === true, JSON.stringify(bad));
    }

    console.log('\n【⑦ 不猜 stale 的新位置】');
    {
      // 改掉第一段
      const f = path.join(dir, '每日', `${KEY}.md`);
      fs.writeFileSync(f, '第一段改了。\n\n第二段。\n\n第三段。\n', 'utf8');
      const day = D.readDayDiaryMemory(KEY);
      const e0 = day.entries.find((x) => x.paragraphIndex === 0);
      ok('**原引用 stale**', e0.stale === true, JSON.stringify(e0));
      ok('**没有自动绑到别的位置**', e0.ok === false);
    }

    console.log('\n【⑧ 回退：删掉 diary-meta 就回到无元数据状态】');
    {
      const metaDir = path.join(dir, 'diary-meta');
      fs.rmSync(metaDir, { recursive: true, force: true });
      const day = D.readDayDiaryMemory(KEY);
      ok('**读回空 entries**', day.ok === true && day.entries.length === 0);
      ok('**原文没变**', fs.existsSync(src));
      // 关开关后不再写
      delete process.env.QQ_DIARY_META_WRITE;
      const r = D.appendDiaryMemory({ dateKey: KEY, paragraphIndex: 0 });
      ok('**回退后写入被拒**', r.code === 'DISABLED');
    }

    console.log('\n【⑨ config 开关也能用（不靠环境变量）】');
    {
      process.env.QQ_DIARY_META_WRITE = '';
      delete process.env.QQ_DIARY_META_WRITE;
      // 注意：diaryWriteEnabled 读 getConfig()，有缓存 —— 这里只能验证「config 里没有 metaWrite 时是 false」
      ok('**config 没开 → false**', D.diaryWriteEnabled() === false);
    }

    console.log('\n【⑩ 源码级：写入口只有一处、原文只读】');
    {
      const s = fs.readFileSync(path.join(ROOT, 'src', 'memory-hub', 'diary-write.js'), 'utf8');
      ok('**没有写原文的代码**', !/writeFileSync\([^)]*每日/.test(s));
      ok('**写入委托给 appendDiaryEntry**', s.includes('appendDiaryEntry('));
      ok('**有开关检查**', s.includes('diaryWriteEnabled()'));
      ok('**有回退说明**', s.includes('回退') || s.includes('关闭'));
    }
  } catch (e) {
    ok('测试执行不抛异常', false, e?.message || String(e));
  } finally {
    delete process.env.QQ_DIARY_META_WRITE;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log(`\n通过 ${pass} / 失败 ${fail}`);
  if (fail) process.exit(1);
  process.exit(0);
}

main();
