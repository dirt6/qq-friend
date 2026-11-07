// D1-4 专项：数据一致性只读审计工具（隔离 fixture）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const c = createChecker('D1-4 一致性审计');
const { auditConsistency } = await import('../scripts/data-consistency-audit.mjs');

const DAY = '2026-11-03';
const BODY = `# 2026-11-03 周二\n\n## 记录\n- 心情：平静｜甲\n- 心情：平静｜乙\n`;

function scene() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-'));
  const data = path.join(base, 'data');
  const diary = path.join(base, '日记');
  fs.mkdirSync(path.join(data, 'diary-meta'), { recursive: true });
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(diary, '每日'), { recursive: true });
  return { base, data, diary };
}
const writeJson = (file, obj) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj), 'utf8'); };
const codes = (r) => new Set(r.findings.map((f) => f.code));

try {
  c.section('1. 干净场景');
  {
    const s = scene();
    const r = auditConsistency({ dataDir: s.data, diaryRoot: s.diary });
    await c.check('无 critical/warn，退出结构完整', () => {
      assert.equal(r.counts.critical, 0);
      assert.equal(r.counts.warn, 0);
      assert.equal(r.schema, 1);
    });
    fs.rmSync(s.base, { recursive: true, force: true });
  }

  c.section('2. 异常场景：正文/meta、pending、幂等、sessions、DSH、备份');
  {
    const s = scene();
    fs.writeFileSync(path.join(s.diary, '每日', `${DAY}.md`), BODY, 'utf8');
    // meta：index0 的 quoteHash 错误（非 stale）
    writeJson(path.join(s.data, 'diary-meta', `${DAY}.json`), {
      version: 1, dateKey: DAY, entries: [{ paragraphIndex: 0, quoteHash: 'sha1:bad', quote: '甲', stale: false }]
    });
    // 有正文无 meta / 有 meta 无正文
    fs.writeFileSync(path.join(s.diary, '每日', '2026-11-04.md'), BODY, 'utf8');
    writeJson(path.join(s.data, 'diary-meta', '2026-11-05.json'), { version: 1, dateKey: '2026-11-05', entries: [] });
    // pending：48 小时未完成
    writeJson(path.join(s.data, 'diary-meta', 'pending.json'), {
      version: 1,
      items: { p1: { id: 'p1', op: 'append', dateKey: DAY, stage: 'prepared', createdAt: new Date(Date.now() - 48 * 3600e3).toISOString() } }
    });
    // idem：done 但正文无该行；pending 但正文已有该行；测试残留；合并链；重复键
    fs.writeFileSync(path.join(s.diary, '每日', '2026-11-06.md'), `# 2026-11-06\n\n## 记录\n- 心情：想找人说话｜想找老大说话，没发出去——后继内容\n`, 'utf8');
    fs.mkdirSync(path.join(s.diary, '每日'), { recursive: true });
    fs.writeFileSync(path.join(s.diary, '每日', '2026-11-07.md'), `# 2026-11-07\n\n## 记录\n`, 'utf8');
    writeJson(path.join(s.data, 'diary-idempotency.json'), {
      keys: {
        'auto:2026-11-03:done': { state: 'done', day: DAY, hash: 'done', line: '- 心情：平静｜不存在于正文的行' },
        'auto:2026-11-03:pending': { state: 'pending', day: DAY, hash: 'pending', line: '- 心情：平静｜甲' },
        'auto:2026-11-03:test-residue': { state: 'done', day: DAY, hash: 'testres', source: 'test', line: '- 心情：平静｜测试残留' },
        'auto:2026-11-03:corpus': { state: 'done', day: DAY, hash: 'corpushash', line: '- 心情：平静｜测试语料专用行ABCD' },
        'auto:2026-11-03:badhash': { state: 'done', day: DAY, hash: '0123456789abcdef', line: '- 心情：平静｜hash 不一致条目' },
        'auto:2026-11-06:old': { state: 'done', day: '2026-11-06', hash: 'oldhash', at: 1000, line: '- 心情：想找人说话｜想找老大说话，没发出去——旧内容' },
        'auto:2026-11-06:new': { state: 'done', day: '2026-11-06', hash: 'newhash', at: 2000, line: '- 心情：想找人说话｜想找老大说话，没发出去——后继内容' },
        'auto:2026-11-07:dup-a': { state: 'done', day: '2026-11-07', hash: 'duphash', line: '- 心情：平静｜重复键甲' },
        'auto:2026-11-07:dup-b': { state: 'done', day: '2026-11-07', hash: 'duphash', line: '- 心情：平静｜重复键乙' }
      }
    });
    // sessions：40 天前的 running；索引缓存引用不存在的文件、且未收录真实文件
    writeJson(path.join(s.data, 'sessions', 'z1.json'), { id: 'z1', status: 'running', startedAt: Date.now() - 40 * 86400e3 });
    writeJson(path.join(s.data, 'session-index-cache.json'), { version: 1, entries: [{ id: 'ghost' }] });
    // DSH：映射的 session 目录不存在；本地聊天文件也不存在
    writeJson(path.join(s.data, 'dsh-sessions.json'), { 'private:1': { sessionId: 'session-missing-123' } });
    fs.mkdirSync(path.join(s.data, 'dsh-home', 'sessions', 'proj', 'session-other'), { recursive: true });
    // reset 备份 manifest 损坏
    const opDir = path.join(`${s.data}.reset-backups`, 'op-bad');
    fs.mkdirSync(opDir, { recursive: true });
    fs.writeFileSync(path.join(opDir, 'manifest.json'), '{ bad json', 'utf8');

    const r = auditConsistency({ dataDir: s.data, diaryRoot: s.diary, now: Date.now(), testCorpus: '测试语料专用行ABCD' });
    const cs = codes(r);
    await c.check('meta_missing / meta_orphan / meta_quote_mismatch', () => {
      assert.ok(cs.has('meta_missing'), [...cs].join(','));
      assert.ok(cs.has('meta_orphan'));
      assert.ok(cs.has('meta_quote_mismatch'));
    });
    await c.check('pending_long_unfinished', () => assert.ok(cs.has('pending_long_unfinished'), [...cs].join(',')));
    await c.check('idem_done_line_missing / idem_pending_written_unconfirmed', () => {
      assert.ok(cs.has('idem_done_line_missing'));
      assert.ok(cs.has('idem_pending_written_unconfirmed'));
    });
    await c.check('测试残留与合并链不再误报为 warn', () => {
      assert.ok(cs.has('idem_test_residue'));
      assert.ok(cs.has('idem_done_superseded'));
      const bad = r.findings.filter((f) => f.level === 'warn' && f.code === 'idem_done_line_missing'
        && ['auto:2026-11-03:test-residue', 'auto:2026-11-06:old'].includes(f.key));
      assert.equal(bad.length, 0, JSON.stringify(bad));
    });
    await c.check('重复键（同 day+hash 多形态）→ 独立 warn + historical 判定', () => {
      assert.ok(cs.has('idem_duplicate_done_missing'));
      const dups = r.findings.filter((f) => f.code === 'idem_duplicate_done_missing');
      assert.equal(dups.length, 2);
      assert.ok(dups.every((f) => f.verdict === 'historical_unverifiable'));
    });
    await c.check('verdict 三态：测试语料/记录自身 hash 不一致', () => {
      const corpus = r.findings.find((f) => f.code === 'idem_test_residue' && f.key === 'auto:2026-11-03:corpus');
      assert.equal(corpus?.verdict, 'confirmed_consistent');
      const bad = r.findings.find((f) => f.code === 'idem_hash_mismatch');
      assert.equal(bad?.verdict, 'confirmed_anomaly');
      const hist = r.findings.find((f) => f.code === 'idem_done_line_missing');
      assert.equal(hist?.verdict, 'historical_unverifiable');
    });
    await c.check('session_zombie / cache 异常', () => {
      assert.ok(cs.has('session_zombie'));
      assert.ok(cs.has('session_cache_missing_file'));
      assert.ok(cs.has('session_not_in_cache'));
    });
    await c.check('dsh_session_missing / dsh_map_without_local_chat', () => {
      assert.ok(cs.has('dsh_session_missing'));
      assert.ok(cs.has('dsh_map_without_local_chat'));
    });
    await c.check('reset_backup_manifest_invalid → critical', () => {
      assert.ok(cs.has('reset_backup_manifest_invalid'));
      assert.ok(r.counts.critical >= 1);
    });
    fs.rmSync(s.base, { recursive: true, force: true });
  }

  c.section('3. 损坏 pending → critical');
  {
    const s = scene();
    fs.writeFileSync(path.join(s.data, 'diary-meta', 'pending.json'), '{ bad', 'utf8');
    const r = auditConsistency({ dataDir: s.data, diaryRoot: s.diary });
    await c.check('pending_unreadable 为 critical', () => {
      assert.ok(codes(r).has('pending_unreadable'));
      assert.ok(r.counts.critical >= 1);
    });
    fs.rmSync(s.base, { recursive: true, force: true });
  }

  c.section('4. 只读性');
  {
    const s = scene();
    fs.writeFileSync(path.join(s.diary, '每日', `${DAY}.md`), BODY, 'utf8');
    writeJson(path.join(s.data, 'diary-meta', `${DAY}.json`), { version: 1, dateKey: DAY, entries: [] });
    const before = fs.readFileSync(path.join(s.data, 'diary-meta', `${DAY}.json`), 'utf8');
    const r = auditConsistency({ dataDir: s.data, diaryRoot: s.diary });
    await c.check('审计不修改任何文件', () => {
      assert.equal(fs.readFileSync(path.join(s.data, 'diary-meta', `${DAY}.json`), 'utf8'), before);
      assert.ok(Array.isArray(r.findings));
    });
    fs.rmSync(s.base, { recursive: true, force: true });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
