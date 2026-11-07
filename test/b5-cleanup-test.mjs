// D1-3b-B5 专项：chat clear / delete-messages、learned 单条删除、自动清理保护。
// 全部在隔离临时数据目录内运行（QQ_AGENT_DATA_DIR 由 makeDataDir 注入），不碰生产 data/。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createChecker, makeDataDir } from './_harness.mjs';

const c = createChecker('D1-3b B5 清理入口');
const DATA = makeDataDir('b5-cleanup-');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return 'missing'; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const storeMod = await import('../src/store.js');
const sessionsMod = await import('../src/sessions.js');
const learned = await import('../src/learned.js');
const companion = await import('../src/companion/state.js');

const msg = (mid, text) => ({ mid, ts: Date.now(), senderId: '111', senderName: '甲', text });

try {
  console.log('【① chat clear / delete-messages：锁内备份 + 审计】');
  {
    const store = new storeMod.ChatStore();
    await store.appendIncoming('group:1', msg(7001, '一'));
    await store.appendIncoming('group:1', msg(7002, '二'));
    await store.appendIncoming('group:2', msg(7003, '别的会话'));
    const info = {};
    const removed = await store.clearChat('group:1', info);
    assert.equal(removed, 2);
    assert.ok(info.backupDir && fs.existsSync(info.backupDir), '应有备份目录');
    const bm = JSON.parse(fs.readFileSync(path.join(info.backupDir, 'manifest.json'), 'utf8'));
    assert.equal(bm.chatKey, 'group:1');
    assert.equal(bm.file.sha256, sha(path.join(info.backupDir, 'messages.json')));
    assert.equal(bm.file.size, fs.statSync(path.join(info.backupDir, 'messages.json')).size);
    const chat = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'group_1.json'), 'utf8'));
    assert.equal(chat.messages.length, 0, '清空后 messages 应为空');
    const other = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'group_2.json'), 'utf8'));
    assert.equal(other.messages.length, 1, '其他会话不受影响');
    const audit = fs.readFileSync(path.join(DATA, 'backups', 'chats', 'audit.jsonl'), 'utf8');
    assert.ok(audit.includes('"reason":"clear"') && audit.includes('"result":"ok"'));
    c.ok('clearChat：备份 hash/大小一致、目标清空、其他会话不受影响、审计有记录');

    const store2 = new storeMod.ChatStore();
    await store2.appendIncoming('group:3', msg(8001, 'a'));
    await store2.appendIncoming('group:3', msg(8002, 'b'));
    const idsBefore = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'group_3.json'), 'utf8')).messages.map((m) => m.id);
    const info2 = {};
    const r2 = await store2.removeByLocalIds('group:3', [idsBefore[0]], info2);
    assert.equal(r2, 1);
    assert.ok(info2.backupDir && fs.existsSync(info2.backupDir));
    const left = JSON.parse(fs.readFileSync(path.join(DATA, 'messages', 'group_3.json'), 'utf8'));
    assert.deepEqual(left.messages.map((m) => m.mid), [8002]);
    const info3 = {};
    const r3 = await store2.removeByLocalIds('group:3', [999999], info3);
    assert.equal(r3, 0);
    assert.equal(info3.backupDir, undefined, '没有实际删除时不应产生备份');
    c.ok('removeByLocalIds：精确删除 + 备份；无命中不产生备份');

    // 备份失败 → 抛错、不删除
    fs.rmSync(path.join(DATA, 'backups'), { recursive: true, force: true });
    fs.writeFileSync(path.join(DATA, 'backups'), 'not-a-dir', 'utf8');
    const before = fs.readFileSync(path.join(DATA, 'messages', 'group_3.json'), 'utf8');
    let threw = false;
    try { await store2.clearChat('group:3'); } catch { threw = true; }
    assert.equal(threw, true, '备份失败应抛错');
    assert.equal(fs.readFileSync(path.join(DATA, 'messages', 'group_3.json'), 'utf8'), before, '备份失败不得删除');
    fs.rmSync(path.join(DATA, 'backups'), { force: true });
    c.ok('备份失败 → 清空抛错且消息原样保留');

    // reset 屏障期间禁止清空
    const barrier = await import('../src/reset-barrier.js');
    barrier.beginResetBarrier({ opId: 'b5-barrier', backupRoot: path.join(DATA, 'barrier-root') });
    let blocked = false;
    try { await store2.clearChat('group:3'); } catch (e) { blocked = e?.code === 'ERESETBARRIER'; }
    barrier.endResetBarrier();
    assert.equal(blocked, true, '屏障期间应拒绝 chat 写入');
    c.ok('reset 屏障期间 chat clear 被拒绝（ERESETBARRIER）');
  }

  console.log('\n【② learned 单条删除：唯一备份 + 失败返回】');
  {
    const file = path.join(DATA, 'learned.json');
    fs.rmSync(path.join(DATA, 'backups'), { recursive: true, force: true });
    fs.writeFileSync(file, JSON.stringify({
      items: [
        { id: 'l1', text: '甲的规则', status: 'active' },
        { id: 'l2', text: '乙的规则', status: 'active' }
      ]
    }), 'utf8');
    const r = learned.removeItem('l1');
    assert.equal(r.ok, true);
    assert.ok(r.backupDir && fs.existsSync(r.backupDir));
    const bm = JSON.parse(fs.readFileSync(path.join(r.backupDir, 'manifest.json'), 'utf8'));
    assert.equal(bm.file.sha256, sha(path.join(r.backupDir, 'learned.json')));
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(after.items.map((x) => x.id), ['l2'], '只删目标，其他记录保留');
    assert.ok(fs.readFileSync(path.join(DATA, 'backups', 'learned', 'audit.jsonl'), 'utf8').includes('"result":"ok"'));
    assert.equal(learned.removeItem('nope').ok, false);
    c.ok('removeItem：备份 hash 一致、只删目标、审计、未知 id 返回失败');

    // 备份失败 → 返回 ok:false 且文件不变（不抛错、不删）
    fs.rmSync(path.join(DATA, 'backups'), { recursive: true, force: true });
    fs.writeFileSync(path.join(DATA, 'backups'), 'not-a-dir', 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const r2 = learned.removeItem('l2');
    assert.equal(r2.ok, false);
    assert.match(String(r2.reason), /备份失败/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, '备份失败不得改动经验库');
    fs.rmSync(path.join(DATA, 'backups'), { force: true });
    c.ok('备份失败 → removeItem 返回 ok:false（不抛错）、经验库原样保留');
  }

  console.log('\n【③ 自动清理保护：keepFiles / discard / tidyPending】');
  {
    const { SessionRegistry } = sessionsMod;
    fs.rmSync(path.join(DATA, 'sessions'), { recursive: true, force: true });
    fs.mkdirSync(path.join(DATA, 'sessions'), { recursive: true });
    const reg = new SessionRegistry(1);
    // 让一个会话保持运行中（在 current 里），再制造两条已结束会话
    const running = reg.create({ chatKey: 'group:9', trigger: '运行中' });
    await sleep(5);
    const a = reg.create({ chatKey: 'group:9', trigger: 'a' });
    reg.finish(a.id, 'done');
    await sleep(5);
    const b = reg.create({ chatKey: 'group:9', trigger: 'b' });
    reg.finish(b.id, 'done'); // 触发 keepFiles=1 裁剪
    const files = fs.readdirSync(path.join(DATA, 'sessions')).filter((f) => f.endsWith('.json'));
    assert.ok(files.includes(`${running.id}.json`), '运行中的会话文件不得被 keepFiles 删除');
    assert.ok(files.includes(`${b.id}.json`), '最新已结束会话保留');
    assert.ok(!files.includes(`${a.id}.json`), '超出保留数的最旧已结束会话被清理');
    // 未知/坏文件 → fail-closed 保留
    fs.writeFileSync(path.join(DATA, 'sessions', 'weird.json'), '{ not json', 'utf8');
    reg.setKeepFiles(1);
    await sleep(5);
    const b2 = reg.create({ chatKey: 'group:9', trigger: 'c' });
    reg.finish(b2.id, 'done');
    assert.ok(fs.existsSync(path.join(DATA, 'sessions', 'weird.json')), '坏文件（未知状态）不得被清理');
    c.ok('finish keepFiles：保护运行中、坏文件，失败不静默忽略');

    // discard：内存里的运行中拒绝；磁盘 running 拒绝；磁盘 waiting 允许
    assert.equal(reg.discard(running.id), false, '运行中不得 discard');
    assert.ok(fs.existsSync(path.join(DATA, 'sessions', `${running.id}.json`)));
    fs.writeFileSync(path.join(DATA, 'sessions', 'disk-running.json'), JSON.stringify({ id: 'disk-running', status: 'running' }), 'utf8');
    assert.equal(reg.discard('disk-running'), false, '磁盘 running 不得 discard');
    assert.ok(fs.existsSync(path.join(DATA, 'sessions', 'disk-running.json')));
    fs.writeFileSync(path.join(DATA, 'sessions', 'disk-waiting.json'), JSON.stringify({ id: 'disk-waiting', status: 'waiting' }), 'utf8');
    assert.equal(reg.discard('disk-waiting'), true, '磁盘 waiting 可 discard');
    assert.ok(!fs.existsSync(path.join(DATA, 'sessions', 'disk-waiting.json')));
    c.ok('discard：内存/磁盘状态校验（running 拒绝、waiting 允许）');

    // tidyPending：未结算永不丢
    const active = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, status: 'pending', at: new Date().toISOString() }));
    const settled = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, status: 'done', at: new Date(Date.now() - 86400e3).toISOString(), settledAt: new Date(Date.now() - 3600e3).toISOString() }));
    const out = companion.__internals.tidyPending([...active, ...settled]);
    assert.equal(out.filter((p) => p.status === 'pending').length, 25, '未结算项一条都不能丢');
    assert.ok(out.length <= 25 + companion.__internals.MAX_PENDING, '只允许保留有上限的已结算项');
    c.ok('tidyPending：active 超过上限时全部保留（不再 slice 截断未结算项）');
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
