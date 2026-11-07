// W3 专项：silence-ping 的 appendSelfToFile 走统一锁 + 面板 test-send 带 mid（2026-11-03）。
//
// 背景：silence-ping 是第二个写 data/messages 的入口（虽然当前 enabled:false）。
// 它旧实现自己读快照再整文件写回，和主进程并发时是同一个丢消息 bug。
// 本测试验证它现在与 ChatStore 共用 `${file}.lock`，并且互相不覆盖。
//
// 只碰临时 DATA_DIR。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createChecker } from './_harness.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'silence-ping-store-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const MESSAGES = path.join(dataDir, 'messages');
fs.mkdirSync(MESSAGES, { recursive: true });

const { ChatStore } = await import('../src/store.js');
const { internals } = await import('../plugins/silence-ping/index.js');
const { appendSelfToFile } = internals;

const c = createChecker('W3 silence-ping 统一锁');

const fileOf = (key) => path.join(MESSAGES, `${key.replace(':', '_')}.json`);
const readDisk = (key) => JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
const seed = (key, messages = [], nextLocalId = 1) => {
  fs.writeFileSync(fileOf(key), JSON.stringify({ chatKey: key, nextLocalId, messages }, null, 1), 'utf8');
};

function runChild(tag, body) {
  return new Promise((resolve) => {
    const outFile = path.join(dataDir, `${tag}.out`);
    const errFile = path.join(dataDir, `${tag}.err`);
    const out = fs.openSync(outFile, 'a');
    const err = fs.openSync(errFile, 'a');
    const child = spawn(process.execPath, ['--input-type=module', '-e', body], {
      cwd: process.cwd(), env: { ...process.env, QQ_AGENT_DATA_DIR: dataDir },
      stdio: ['ignore', out, err], windowsHide: true
    });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 60000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* ignore */ }
      try { fs.closeSync(err); } catch { /* ignore */ }
      resolve({
        code,
        out: (() => { try { return fs.readFileSync(outFile, 'utf8'); } catch { return ''; } })(),
        err: (() => { try { return fs.readFileSync(errFile, 'utf8').slice(0, 300); } catch { return ''; } })()
      });
    });
  });
}

try {
  c.section('1. 基本追加：id 递增、mid=null、锁释放');
  {
    seed('private:10001');
    const ok = appendSelfToFile('private:10001', { text: '主动私信一句', ts: 1700000000000 });
    await c.check('返回 true', () => { if (ok !== true) throw new Error('false'); });
    await c.check('磁盘 1 条，id=1，nextLocalId=2，mid=null', () => {
      const d = readDisk('private:10001');
      if (d.messages.length !== 1) throw new Error(`len=${d.messages.length}`);
      const m = d.messages[0];
      if (m.id !== 1 || d.nextLocalId !== 2) throw new Error(`id=${m.id} next=${d.nextLocalId}`);
      if (m.mid !== null) throw new Error(`mid=${m.mid}`);
      if (m.self !== true || m.read !== true) throw new Error('self/read 不对');
    });
    await c.check('锁文件已释放', () => {
      if (fs.existsSync(`${fileOf('private:10001')}.lock`)) throw new Error('lock 还在');
    });
    appendSelfToFile('private:10001', { text: '第二句', ts: 1700000001000 });
    await c.check('第二次追加 id=2', () => {
      const d = readDisk('private:10001');
      if (d.messages.length !== 2 || d.messages[1].id !== 2) throw new Error(JSON.stringify(d.messages.map((m) => m.id)));
    });
  }

  c.section('2. 与核心 ChatStore 混写：同一把锁，互不覆盖');
  {
    seed('private:10002');
    const store = new ChatStore(0);
    await store.appendIncoming('private:10002', { mid: 7001, ts: Date.now(), senderId: '1', senderName: '甲', text: '核心写的' });
    appendSelfToFile('private:10002', { text: '插件写的', ts: Date.now() });
    await store.appendSelf('private:10002', { mid: 7002, text: '核心又写', ts: Date.now() });
    await c.check('三条都在，id 连续 1/2/3', () => {
      const d = readDisk('private:10002');
      const texts = d.messages.map((m) => m.text);
      if (d.messages.length !== 3) throw new Error(`len=${d.messages.length} ${texts.join('|')}`);
      const ids = d.messages.map((m) => m.id);
      if (ids.join(',') !== '1,2,3') throw new Error(`ids=${ids.join(',')}`);
    });
  }

  c.section('3. 失败路径：文件不存在 / 损坏 / 锁被持有');
  {
    await c.check('文件不存在 → 返回 false，不炸', () => {
      if (appendSelfToFile('private:19999', { text: 'x' }) !== false) throw new Error('应 false');
      if (fs.existsSync(fileOf('private:19999'))) throw new Error('不该创建文件');
    });
    await c.check('损坏文件 → 返回 false，原文件不变', () => {
      const raw = '{ 坏掉的 JSON';
      fs.writeFileSync(fileOf('private:10003'), raw, 'utf8');
      if (appendSelfToFile('private:10003', { text: 'x' }) !== false) throw new Error('应 false');
      if (fs.readFileSync(fileOf('private:10003'), 'utf8') !== raw) throw new Error('原文件被改了');
    });
    await c.check('锁被活进程持有 → 返回 false（等满预算）', () => {
      seed('private:10004');
      const lock = `${fileOf('private:10004')}.lock`;
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'held', startedAt: Date.now(), host: '' }), 'utf8');
      const t0 = Date.now();
      const r = appendSelfToFile('private:10004', { text: 'x' });
      const elapsed = Date.now() - t0;
      fs.unlinkSync(lock);
      if (r !== false) throw new Error('应 false');
      if (elapsed < 1500) throw new Error(`只等了 ${elapsed}ms`);
      if (readDisk('private:10004').messages.length !== 0) throw new Error('锁超时却写了盘');
    });
  }

  c.section('4. 真并发：插件子进程 20 条 + 主进程 ChatStore 20 条，一条不丢');
  {
    seed('private:10005');
    const pluginMod = new URL('../plugins/silence-ping/index.js', import.meta.url).href;
    const body = `
const { internals } = await import(${JSON.stringify(pluginMod)});
const { appendSelfToFile } = internals;
for (let i = 0; i < 20; i++) appendSelfToFile('private:10005', { text: '插件-'+i, ts: Date.now()+i });
process.stdout.write('ok');
`;
    const child = runChild('plugin', body);
    const store = new ChatStore(0);
    for (let i = 0; i < 20; i++) {
      await store.appendSelf('private:10005', { mid: 9000 + i, text: `核心-${i}`, ts: Date.now() + i });
    }
    const r = await child;
    await c.check('子进程跑完', () => {
      if (r.code !== 0 || r.out !== 'ok') throw new Error(`code=${r.code} err=${r.err}`);
    });
    await c.check('总数 40，id 无重复且连续 1..40', () => {
      const d = readDisk('private:10005');
      if (d.messages.length !== 40) throw new Error(`len=${d.messages.length}`);
      const ids = d.messages.map((m) => m.id).sort((a, b) => a - b);
      for (let i = 0; i < 40; i++) if (ids[i] !== i + 1) throw new Error(`id 断裂：第 ${i} 位是 ${ids[i]}`);
    });
    await c.check('插件的 20 条与核心的 20 条都在', () => {
      const texts = readDisk('private:10005').messages.map((m) => m.text);
      const plugin = texts.filter((t) => t.startsWith('插件-')).length;
      const core = texts.filter((t) => t.startsWith('核心-')).length;
      if (plugin !== 20 || core !== 20) throw new Error(`plugin=${plugin} core=${core}`);
    });
  }

  c.section('5. 面板 test-send 的 mid 已补（路由源码级 + 运行时见 coverage-http）');
  {
    const src = fs.readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
    await c.check('routes.js 的 test-send 把 data.message_id 传给 appendSelf', () => {
      if (!/appendSelf\(chatKey,\s*\{ text, ts: Date\.now\(\), mid: data\?\.message_id \?\? null \}\)/.test(src)) {
        throw new Error('没找到 mid 传递');
      }
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
