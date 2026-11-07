// 小黑盒写操作：发评论 / 回复楼中楼 / @ 人。
//
// 契约（2026-10-24 实测，非官方接口）：
//   POST https://workshopapi.xiaoheihe.cn/bbs/app/comment/create
//   参数**必须全部放在 query**（放 body 会报「缺失参数」）；
//   必带 `_rnd=15:<任意>`：缺了报「缺失参数」，给了（哪怕假值）才进业务层。
//   is_cy=0 / link_id / reply_id(-1=主评论) / root_id(-1=主评论) / text
//
// ⚠️ 当前账号（uid 21987774）调用会被服务端拒绝，返回：
//      {"msg":"评论功能暂不可用","status":"failed"}
//   同一账号的 /bbs/app/api/user/permission 里 bbs_basic_permission=0 —— 是
//   **账号侧社区权限**没开通，不是签名问题（换 _rnd、换帖子、换域名都一样）。
//   所以这个文件实现完整链路，但会把这句原样交给上层，让她能如实说
//   「我号说不了话」，而不是含糊地报错。
//
// 幂等（机主要求，写操作前必须做）：
//   · 发送前先落 pending（link_id + reply_id + 正文指纹）；
//   · pending 未决时禁止再发同一条；
//   · 超时 / 5xx / 结构异常 → send_unknown，先用最近评论核对，绝不自动重发；
//   · 只有明确的业务失败才算失败。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSignedParams } from '../xhh/sign.js';

const WRITE = 'https://workshopapi.xiaoheihe.cn';
const READ = 'https://api.xiaoheihe.cn';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const CREATE_PATH = '/bbs/app/comment/create';

/** 正文指纹：同一帖子、同一父评论、同一内容视为同一条。 */
export function fingerprint({ linkId, replyId, text }) {
  return crypto.createHash('sha1')
    .update(`${linkId}|${replyId || '-1'}|${String(text || '').trim()}`)
    .digest('hex')
    .slice(0, 16);
}

export class XhhWriter {
  constructor({ authFile, outboxFile, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.authFile = authFile;
    this.outboxFile = outboxFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.auth = null;
    this.lastAuthError = '';
    this.reload();
  }

  reload() {
    try {
      const j = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      if (!j?.cookies || typeof j.cookies !== 'object') throw new Error('没有 cookies 字段');
      this.auth = {
        uid: String(j.uid || ''),
        nickname: String(j.nickname || ''),
        deviceId: String(j.deviceId || ''),
        cookies: j.cookies
      };
      this.lastAuthError = '';
      return true;
    } catch (e) {
      this.auth = null;
      this.lastAuthError = e?.code === 'ENOENT' ? '还没导入小黑盒登录态' : String(e?.message ?? e);
      return false;
    }
  }

  get loggedIn() {
    return Boolean(this.auth && Object.keys(this.auth.cookies || {}).length);
  }

  get uid() {
    return this.auth?.uid || '';
  }

  cookieHeader() {
    return Object.entries(this.auth?.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /* ── 幂等台账 ─────────────────────────────────────────────────── */

  loadLedger() {
    try {
      return JSON.parse(fs.readFileSync(this.outboxFile, 'utf8'));
    } catch {
      return { version: 1, items: [] };
    }
  }

  saveLedger(ledger) {
    fs.mkdirSync(path.dirname(this.outboxFile), { recursive: true });
    // 只留最近 200 条，避免无限增长
    ledger.items = ledger.items.slice(-200);
    fs.writeFileSync(this.outboxFile, JSON.stringify(ledger, null, 1), 'utf8');
  }

  /** 同一指纹最近 10 分钟内是否还有未决/成功的记录。 */
  findRecent(fp, withinMs = 10 * 60_000) {
    const now = Date.now();
    return this.loadLedger().items.find((x) => x.fp === fp
      && (x.state === 'pending' || x.state === 'ok' || x.state === 'send_unknown')
      && now - (x.at || 0) < withinMs);
  }

  /* ── 读接口（核对用） ─────────────────────────────────────────── */

  async read(pathname, params = {}) {
    if (!this.reload()) return { ok: false, error: this.lastAuthError };
    const withUid = { ...params, heybox_id: this.uid };
    const { params: signed } = buildSignedParams({ path: pathname, params: withUid, deviceId: this.auth.deviceId });
    let res;
    try {
      res = await this.fetchImpl(`${READ}${pathname}?${new URLSearchParams(signed).toString()}`, {
        headers: { 'user-agent': UA, referer: 'https://www.xiaoheihe.cn/', cookie: this.cookieHeader() },
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* ignore */ }
    if (!json) return { ok: false, error: `返回不是 JSON（HTTP ${res.status}）` };
    if (String(json.status || '').toLowerCase() === 'failed') {
      return { ok: false, error: String(json.msg || '接口失败'), json };
    }
    return { ok: true, json };
  }

  /** 我最近发过的评论（幂等核对：send_unknown 时查这里，不重发）。 */
  async recentComments({ limit = 20 } = {}) {
    const r = await this.read('/bbs/app/comment/user', { offset: '0', limit: String(limit) });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const list = r.json?.result?.comments || r.json?.result?.list || r.json?.result || [];
    return { ok: true, items: Array.isArray(list) ? list : [] };
  }

  /* ── 写：发评论 / 回复楼中楼 / @ ──────────────────────────────── */

  /**
   * @param {object} o
   * @param {string} o.linkId   帖子 id
   * @param {string} o.text     正文
   * @param {string} [o.replyId] 回复哪条评论（楼中楼）
   * @param {string} [o.rootId]  楼中楼根评论
   * @param {string} [o.mention] 要 @ 的昵称（纯文本前缀；小黑盒的 @ 是正文的一部分）
   */
  async comment({ linkId, text, replyId = '-1', rootId = '-1', mention = '' } = {}) {
    if (!this.reload()) return { ok: false, error: this.lastAuthError };
    const id = String(linkId || '').replace(/[^0-9a-zA-Z]/g, '');
    const body = String(text || '').trim();
    if (!id) return { ok: false, error: 'link_id 为空' };
    if (!body) return { ok: false, error: '评论内容为空' };

    const at = String(mention || '').trim();
    const finalText = at
      ? (body.startsWith(`@${at}`) ? body : `@${at} ${body}`)
      : body;
    const rid = String(replyId || '-1');
    const fp = fingerprint({ linkId: id, replyId: rid, text: finalText });

    // 幂等闸门：同一条 10 分钟内发过（或结果未决）就不再发
    const dup = this.findRecent(fp);
    if (dup) {
      return {
        ok: dup.state === 'ok',
        duplicated: true,
        state: dup.state,
        error: dup.state === 'ok'
          ? '这条刚发过，没有重复发送'
          : `上一条还没确认结果（${dup.state}），不再重发；先核对最近评论`
      };
    }

    const ledger = this.loadLedger();
    const entry = {
      fp, linkId: id, replyId: rid, rootId: String(rootId || '-1'),
      text: finalText, state: 'pending', at: Date.now(), rpid: 0, error: ''
    };
    ledger.items.push(entry);

    const params = {
      is_cy: '0',
      link_id: id,
      reply_id: rid,
      root_id: String(rootId || rid || '-1'),
      text: finalText,
      _rnd: `15:${String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0')}`
    };
    const withUid = { ...params, heybox_id: this.uid };
    const { params: signed } = buildSignedParams({ path: CREATE_PATH, params: withUid, deviceId: this.auth.deviceId });
    signed._rnd = params._rnd;

    let res;
    try {
      res = await this.fetchImpl(`${WRITE}${CREATE_PATH}?${new URLSearchParams(signed).toString()}`, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          referer: 'https://www.xiaoheihe.cn/',
          origin: 'https://www.xiaoheihe.cn',
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: this.cookieHeader()
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      entry.state = 'send_unknown';
      entry.error = String(e?.message ?? e);
      this.saveLedger(ledger);
      return { ok: false, sendUnknown: true, error: `网络异常，结果未知：${entry.error}` };
    }

    const text2 = await res.text();
    let json = null;
    try { json = JSON.parse(text2); } catch { /* ignore */ }
    const failed = !json || String(json.status || '').toLowerCase() === 'failed' || res.status >= 500;

    if (!failed && json?.result) {
      entry.state = 'ok';
      entry.rpid = String(json.result.comment_id || json.result.comment?.comment_id || json.result.id || '');
      entry.at = Date.now();
      this.saveLedger(ledger);
      return { ok: true, rpid: entry.rpid, text: finalText, mentioned: at };
    }

    const msg = String(json?.msg || `HTTP ${res.status}`);
    // 明确的业务拒绝（不是网络问题）→ 记为 failed，可以重试（改内容再试）
    entry.state = 'failed';
    entry.error = msg;
    this.saveLedger(ledger);
    return { ok: false, error: msg, code: res.status, raw: json };
  }

  /** 删除自己的评论（可选，测试用）。 */
  async deleteComment(commentId) {
    if (!this.reload()) return { ok: false, error: this.lastAuthError };
    const params = { comment_id: String(commentId) };
    const withUid = { ...params, heybox_id: this.uid };
    const { params: signed } = buildSignedParams({ path: '/bbs/app/comment/delete', params: withUid, deviceId: this.auth.deviceId });
    signed._rnd = '15:000000';
    try {
      const res = await this.fetchImpl(`${WRITE}/bbs/app/comment/delete?${new URLSearchParams(signed).toString()}`, {
        method: 'POST',
        headers: {
          'user-agent': UA, referer: 'https://www.xiaoheihe.cn/',
          cookie: this.cookieHeader(), 'content-type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
      const j = JSON.parse(await res.text());
      return String(j?.status || '') === 'failed'
        ? { ok: false, error: String(j.msg || '删除失败') }
        : { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }
}
