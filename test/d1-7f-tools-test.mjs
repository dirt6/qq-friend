// D1-7F2/F3 工具纯函数专项（不触碰生产）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';
import { evaluateIdentity, validateAuthorization, consumeMarker } from '../scripts/d1-7f-restart.mjs';
import { compareBaseline } from '../scripts/d1-7f-runtime-acceptance.mjs';

const c = createChecker('D1-7F 工具');
const now = Date.parse('2026-11-04T15:00:00Z');
const goodMarker = {
  scope: 'restart-production', action: 'restart', authorizedBy: 'owner',
  targetHead: 'abc123', pid: 25300, startTime: '2026-11-04T12:26:53Z',
  configSha256: 'cfg-sha', nonce: '0123456789abcdef0123456789abcdef',
  issuedAt: '2026-11-04T14:00:00Z', expiresAt: '2026-11-04T16:00:00Z'
};
const expected = { targetHead: 'abc123', pid: 25300, startTime: '2026-11-04T12:26:53Z', configSha256: 'cfg-sha', action: 'restart', now };
let TMP = '';
try {
  c.section('1. 身份联合验证');
  await c.check('四要素齐全才 verified', () => {
    assert.equal(evaluateIdentity({ pid: 1, startTime: 't', path: 'p', commandLine: 'c' }).verified, true);
  });
  await c.check('缺 executablePath/commandLine → unverified（当前生产情形）', () => {
    const r = evaluateIdentity({ pid: 25300, startTime: '2026-11-04T12:26:53Z', path: null, commandLine: null });
    assert.equal(r.verified, false);
    assert.ok(r.missing.includes('executablePath') && r.missing.includes('commandLine'));
  });

  c.section('2. 授权标记绑定');
  await c.check('缺少标记拒绝', () => assert.equal(validateAuthorization(null, expected).ok, false));
  await c.check('scope 不符拒绝', () => assert.equal(validateAuthorization({ ...goodMarker, scope: 'other' }, expected).ok, false));
  await c.check('action 不符拒绝', () => assert.equal(validateAuthorization({ ...goodMarker, action: 'force' }, expected).ok, false));
  await c.check('targetHead 不符拒绝', () => assert.equal(validateAuthorization(goodMarker, { ...expected, targetHead: 'different' }).ok, false));
  await c.check('pid 不符拒绝', () => assert.equal(validateAuthorization(goodMarker, { ...expected, pid: 1 }).ok, false));
  await c.check('startTime 不符拒绝', () => assert.equal(validateAuthorization(goodMarker, { ...expected, startTime: 'other' }).ok, false));
  await c.check('configSha256 不符拒绝', () => assert.equal(validateAuthorization(goodMarker, { ...expected, configSha256: 'changed' }).ok, false));
  await c.check('缺少 nonce 拒绝', () => assert.equal(validateAuthorization({ ...goodMarker, nonce: '' }, expected).ok, false));
  await c.check('issuedAt 在未来拒绝', () => assert.equal(validateAuthorization({ ...goodMarker, issuedAt: '2026-11-04T15:01:00Z' }, expected).ok, false));
  await c.check('过期拒绝', () => assert.equal(validateAuthorization({ ...goodMarker, expiresAt: '2026-11-04T14:00:00Z' }, expected).ok, false));
  await c.check('完全匹配才通过', () => assert.equal(validateAuthorization(goodMarker, expected).ok, true));

  c.section('3. 一次性消费');
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd17f-marker-'));
  const stateFile = path.join(TMP, 'state.json');
  await c.check('首次消费成功', () => assert.equal(consumeMarker({ stateFile, nonce: goodMarker.nonce, now }).ok, true));
  await c.check('重放同一 nonce 拒绝', () => assert.equal(consumeMarker({ stateFile, nonce: goodMarker.nonce, now }).ok, false));
  await c.check('不同 nonce 可消费', () => assert.equal(consumeMarker({ stateFile, nonce: 'ffffffffffffffffffffffffffffffff', now }).ok, true));

  c.section('4. 数据基线比较');
  await c.check('hash 一致 PASS', () => assert.equal(compareBaseline({ learned: 'a', pending: 'b' }, { hashes: { learned: 'a', pending: 'b' } }).ok, true));
  await c.check('hash 不一致 FAIL 且列出 key', () => {
    const r = compareBaseline({ learned: 'x', pending: 'b' }, { hashes: { learned: 'a', pending: 'b' } });
    assert.equal(r.ok, false);
    assert.equal(r.problems[0].key, 'learned');
  });
  await c.check('目录对象 hash 比较', () => assert.equal(compareBaseline({ diary: { sha256: 'd' } }, { hashes: { diary: { sha256: 'd' } } }).ok, true));
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ } }
}
process.exit(c.finish() ? 0 : 1);
