// R8 批次 A 专项：Companion Core 门面契约、依赖注入、初始化失败、只读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-core-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const c = createChecker('R8-A Companion Core');
const { createCompanionCore, CompanionCoreInitError, COMPANION_CORE_VERSION } = await import('../src/companion-core/index.js');

try {
  c.section('1. 契约：真实模块组装');
  {
    const core = createCompanionCore();
    await c.check('版本号存在', () => {
      if (typeof COMPANION_CORE_VERSION !== 'number') throw new Error('无版本');
      if (core.version !== COMPANION_CORE_VERSION) throw new Error(String(core.version));
    });
    await c.check('memory.search/get/stats 是函数', () => {
      for (const m of ['search', 'get', 'stats']) if (typeof core.memory[m] !== 'function') throw new Error(m);
    });
    await c.check('state.get/update/prompt 是函数', () => {
      if (typeof core.state.get !== 'function' || typeof core.state.update !== 'function') throw new Error('缺');
      if (typeof core.state.prompt !== 'function') throw new Error('缺 prompt');
    });
    await c.check('goals/pending/diary/activity 是函数', () => {
      for (const m of ['active', 'paused', 'create', 'update', 'pause', 'resume', 'complete', 'cancel']) {
        if (typeof core.goals[m] !== 'function') throw new Error('goals.' + m);
      }
      for (const m of ['active', 'add', 'settle']) if (typeof core.pending[m] !== 'function') throw new Error('pending.' + m);
      for (const m of ['root', 'readDay', 'readLines', 'write']) if (typeof core.diary[m] !== 'function') throw new Error('diary.' + m);
      if (typeof core.activity.recent !== 'function') throw new Error('activity.recent');
    });
    await c.check('memory.stats 返回形状', () => {
      const r = core.memory.stats();
      if (!r || typeof r.ok !== 'boolean' || typeof r.counts !== 'object') throw new Error(JSON.stringify(r));
    });
    await c.check('state.get 返回对象', () => {
      const s = core.state.get();
      if (!s || typeof s !== 'object') throw new Error(JSON.stringify(s));
    });
  }

  c.section('2. 依赖注入：调用被转发');
  {
    const calls = [];
    const memoryHub = {
      search: (o) => { calls.push(['search', o]); return { ok: true, items: [], errors: [] }; },
      get: (t, i) => { calls.push(['get', t, i]); return { ok: true, item: { id: i } }; },
      stats: () => { calls.push(['stats']); return { ok: true, counts: {}, errors: [] }; }
    };
    const companion = {
      readCompanion: () => ({ goals: [] }),
      updateCompanion: (fn) => { calls.push(['updateCompanion']); return fn({}); },
      promptSection: () => '【状态】',
      activeGoal: () => null, pausedGoals: () => [],
      createGoal: () => ({ ok: true }), createUserGoal: () => ({ ok: true }),
      updateGoal: () => ({ ok: true }), pauseGoal: () => ({ ok: true }), resumeGoal: () => ({ ok: true }),
      completeGoal: () => ({ ok: true }), cancelGoal: () => ({ ok: true }), supersedeGoal: () => ({ ok: true }),
      addPending: () => ({ ok: true }), settlePending: () => ({ ok: true }), activePending: () => []
    };
    const diary = { write: () => ({ ok: true }), readDay: () => ({ ok: true }), readLines: () => [], diaryRoot: () => '/tmp/diary' };
    const chatStore = { recent: () => [{ text: 'x' }], getChatMeta: () => ({ total: 1 }) };
    const core = createCompanionCore({ memoryHub, companion, diary, chatStore, readActivities: () => ({ ok: true, items: [] }) });
    await c.check('memory.search 参数被转发', () => {
      core.memory.search({ query: 'abc', layers: ['learned'] });
      if (calls[0][0] !== 'search' || calls[0][1].query !== 'abc') throw new Error(JSON.stringify(calls));
    });
    await c.check('state.update 转发', () => {
      core.state.update(() => ({}));
      if (!calls.some((x) => x[0] === 'updateCompanion')) throw new Error(JSON.stringify(calls));
    });
    await c.check('context.recent 用注入的 chatStore', () => {
      const r = core.context.recent('group:1', { limit: 5 });
      if (r[0].text !== 'x') throw new Error(JSON.stringify(r));
    });
    await c.check('context.meta 用注入的 chatStore', () => {
      if (core.context.meta('group:1').total !== 1) throw new Error('meta 不对');
    });
  }

  c.section('3. 初始化失败：明确报错，不静默退化');
  {
    await c.check('memoryHub 缺 search → ECOMPANION_CORE_INIT', () => {
      let code = '';
      try { createCompanionCore({ memoryHub: { get() {}, stats() {} } }); } catch (e) { code = e.code; }
      if (code !== 'ECOMPANION_CORE_INIT') throw new Error(`code=${code}`);
    });
    await c.check('companion 缺方法 → ECOMPANION_CORE_INIT', () => {
      let code = '';
      try { createCompanionCore({ companion: { readCompanion() {} } }); } catch (e) { code = e.code; }
      if (code !== 'ECOMPANION_CORE_INIT') throw new Error(`code=${code}`);
    });
    await c.check('readActivities 不是函数 → ECOMPANION_CORE_INIT', () => {
      let code = '';
      try { createCompanionCore({ readActivities: 123 }); } catch (e) { code = e.code; }
      if (code !== 'ECOMPANION_CORE_INIT') throw new Error(`code=${code}`);
    });
    await c.check('未注入 chatStore 时 context 明确报错', () => {
      const core = createCompanionCore();
      let code = '';
      try { core.context.recent('group:1'); } catch (e) { code = e.code; }
      if (code !== 'ECOMPANION_CORE_INIT') throw new Error(`code=${code}`);
    });
    await c.check('CompanionCoreInitError 是 Error 子类', () => {
      if (!(new CompanionCoreInitError('x') instanceof Error)) throw new Error('不是 Error');
    });
  }

  c.section('4. 旧接口兼容：门面结果与底层一致');
  {
    const hub = await import('../src/memory-hub/index.js');
    const core = createCompanionCore();
    const q = { query: '猫', layers: ['learned'], limit: 5 };
    const a = JSON.stringify(core.memory.search(q));
    const b = JSON.stringify(hub.search(q));
    await c.check('memory.search 与 Memory Hub 结果一致', () => {
      if (a !== b) throw new Error(`${a} vs ${b}`);
    });
  }

  c.section('5. 默认 PROFILE 数据目录');
  {
    const run = () => new Promise((resolve) => {
      const out = path.join(tmp, 'profile.out');
      const fd = fs.openSync(out, 'w');
      const code = `const c = await import(${JSON.stringify(new URL('../src/config.js', import.meta.url).href)}); process.stdout.write(JSON.stringify({ dataDir: c.DATA_DIR }));`;
      const env = { ...process.env };
      delete env.QQ_AGENT_DATA_DIR;
      delete env.QQ_AGENT_PROFILE;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], {
        cwd: ROOT, env, stdio: ['ignore', fd, 'ignore'], windowsHide: true
      });
      child.on('exit', () => {
        try { fs.closeSync(fd); } catch { /* ignore */ }
        resolve(JSON.parse(fs.readFileSync(out, 'utf8')));
      });
    });
    const r = await run();
    await c.check('默认 PROFILE 落在 data/（不是 data-2）', () => {
      if (path.basename(r.dataDir) !== 'data') throw new Error(r.dataDir);
    });
  }

  c.section('6. 只读：不产生数据变化');
  {
    const learned = path.join(tmp, 'learned.json');
    fs.writeFileSync(learned, JSON.stringify({ version: 1, items: [] }), 'utf8');
    const before = fs.readFileSync(learned, 'utf8');
    const core = createCompanionCore();
    core.memory.stats();
    core.state.get();
    const after = fs.readFileSync(learned, 'utf8');
    await c.check('只读调用前后 learned.json 字节一致', () => {
      if (before !== after) throw new Error('被改了');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
