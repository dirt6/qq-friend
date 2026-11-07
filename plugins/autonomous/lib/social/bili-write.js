// B 站写操作：发表评论 / 回复楼中楼 / @ 人。
//
// 为什么单独一个文件：只读的 api.js 不需要登录态，而写操作**必须**带 Cookie
// （SESSDATA + bili_jct）。把两者分开，读接口在没登录时照样能用。
//
// 登录态存在 data/bili-auth.json（用 scripts/bili-import.mjs 导入）：
//   { "cookies": { "SESSDATA": "...", "bili_jct": "...", ... }, "uid": "...", "nickname": "" }
// 其中 bili_jct 同时是 CSRF token（B 站约定：csrf 参数 = bili_jct 的值）。
//
// 接口（2026-10 实测契约，非公开 API）：
//   POST /x/v2/reply/add   oid=<aid> type=1 message=<正文> root=<根评论> parent=<父评论> plat=1 csrf=<jct>
//   POST /x/v2/reply/del   oid=<aid> type=1 rpid=<评论> csrf=<jct>
//   POST /x/v2/reply/action oid=<aid> type=1 rpid=<评论> action=1(赞)/0(取消) csrf=<jct>
//
// @ 的实现：B 站评论没有独立的 at 参数，是在正文里写 `@昵称`，由服务端解析并通知。
// 所以这里做两件事：①把昵称拼进正文开头；②保留原始正文供核对。
//
// 所有失败都返回结构化的 { ok:false, error, code }，不抛异常 —— 调用方要能
// 把「没登录」「被风控」「评论已关闭」区分开，而不是笼统说一句失败。

import fs from 'node:fs';

const API = 'https://api.bilibili.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** B 站业务错误码 → 人话。新增错误码时只改这里。 */
const CODE_TEXT = {
  '-101': '账号未登录（Cookie 过期或没导入）',
  '-102': '账号被封禁',
  '-111': 'CSRF 校验失败（bili_jct 不对）',
  '-400': '请求参数错误',
  '-403': '访问权限不足（可能被风控）',
  '-404': '什么也没找到',
  '-509': '请求过于频繁（被限流）',
  '-500': '服务器开小差了',
  '12002': '评论区已关闭',
  '12009': '评论内容被拦截（触发审核/敏感词）',
  '12015': '需要绑定手机号才能评论',
  '12016': '评论太频繁，歇一会儿',
  '12035': '该视频禁止评论',
  '12051': '评论包含敏感内容',
  '12061': '评论内容为空'
};

export class BiliAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BiliAuthError';
  }
}

/** B 站接口返回的 code 转成人话（不带 code 时返回空串）。 */
export function explainCode(code) {
  return CODE_TEXT[String(code)] || '';
}

export class BiliWriter {
  constructor({ authFile, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.authFile = authFile;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.auth = null;
    this.lastAuthError = '';
    this.reload();
  }

  /** 每次调用前重读，这样重新导入 Cookie 不用重启进程。 */
  reload() {
    try {
      const j = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
      const cookies = j?.cookies;
      if (!cookies || typeof cookies !== 'object') throw new Error('没有 cookies 字段');
      if (!cookies.SESSDATA) throw new Error('缺少 SESSDATA');
      if (!cookies.bili_jct) throw new Error('缺少 bili_jct（评论要用它当 CSRF token）');
      this.auth = {
        uid: String(j.uid || ''),
        nickname: String(j.nickname || ''),
        cookies,
        loggedInAt: j.loggedInAt || ''
      };
      this.lastAuthError = '';
      return true;
    } catch (e) {
      this.auth = null;
      this.lastAuthError = e?.code === 'ENOENT' ? '还没导入 B 站登录态' : String(e?.message ?? e);
      return false;
    }
  }

  get loggedIn() {
    return Boolean(this.auth?.cookies?.SESSDATA);
  }

  get csrf() {
    return String(this.auth?.cookies?.bili_jct || '');
  }

  cookieHeader() {
    return Object.entries(this.auth?.cookies || {}).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  /**
   * 带 Cookie 发一个 POST（x-www-form-urlencoded，B 站写接口的约定）。
   * @returns {{ok:boolean, status:number, json:any, error?:string}}
   */
  async post(path, params = {}) {
    if (!this.reload()) throw new BiliAuthError(this.lastAuthError);
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null) continue;
      body.set(String(k), String(v));
    }
    body.set('csrf', this.csrf);
    let res;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method: 'POST',
        headers: {
          'user-agent': UA,
          referer: 'https://www.bilibili.com/',
          origin: 'https://www.bilibili.com',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: this.cookieHeader()
        },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (e) {
      return {
        ok: false,
        status: 0,
        error: e?.name === 'AbortError' ? `超时（${this.timeoutMs}ms）` : `网络错误：${String(e?.message ?? e)}`
      };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* 非 JSON */ }
    if (!json) return { ok: false, status: res.status, error: `返回不是 JSON（${text.length} 字节）` };
    if (res.status === 412) return { ok: false, status: 412, json, error: '被风控（HTTP 412），歇一会儿再试' };
    if (json.code !== 0) {
      const hint = explainCode(json.code);
      return {
        ok: false,
        status: res.status,
        json,
        code: json.code,
        error: `B 站返回 ${json.code}：${json.message || '未知错误'}${hint ? `（${hint}）` : ''}`
      };
    }
    return { ok: true, status: res.status, json };
  }

  /**
   * 发一条评论，或者回复某条评论（楼中楼）。
   *
   * @param {string} bvid          视频 bvid（内部换 aid）
   * @param {string} text          正文
   * @param {object} [opts]
   * @param {number|string} [opts.root]   根评论 rpid（楼中楼回复时传）
   * @param {number|string} [opts.parent] 被回复的评论 rpid（楼中楼回复时传）
   * @param {string} [opts.mention]       要 @ 的昵称（会拼到正文开头）
   * @param {(bvid:string)=>Promise<{ok:boolean,aid:number,error?:string}>} opts.resolveAid
   */
  async comment(bvid, text, { root, parent, mention, resolveAid } = {}) {
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: '评论内容为空' };
    if (!bvid) return { ok: false, error: 'bvid 为空' };

    let aid = 0;
    try {
      aid = Number(await resolveAid(bvid));
    } catch { /* 交给下面统一报错 */ }
    if (!aid) return { ok: false, error: '拿不到视频 aid（视频不存在或接口失败）' };

    // @ 是正文的一部分：B 站按 `@昵称` 解析并给该用户发通知。
    // 坑（2026-10-24 实测）：正文里**任何** `@xxx` 都会被解析。我发
    // 「@dirrrt 测试一下@功能」，结果 `@功能` 被认成了一个真实用户
    // （mid 25247147）——要 @ 的人没@到，误@了路人。
    // 所以：mention 拼到开头，其余 `@` 统一换成全角 `＠`（看着一样，不触发解析）。
    const at = String(mention || '').trim();
    const esc = (s) => String(s).replace(/@/g, '＠');
    let finalText;
    if (at) {
      const rest = body.startsWith(`@${at}`) ? body.slice(at.length + 1).trim() : body;
      finalText = `@${at} ${esc(rest)}`;
    } else {
      finalText = esc(body);
    }

    const params = { oid: aid, type: 1, message: finalText, plat: 1 };
    if (root) {
      params.root = String(root);
      // 回复楼中楼时 parent 必须是被回复那条；只给 root 不给 parent 会被当成
      // 「回复楼主」，服务端会悄悄挂到顶层（2026-10 实测的坑）。
      params.parent = String(parent || root);
    } else if (parent) {
      params.parent = String(parent);
    }

    const r = await this.post('/x/v2/reply/add', params);
    if (!r.ok) return { ok: false, error: r.error, code: r.code, raw: r.json };
    const data = r.json?.data || {};
    return {
      ok: true,
      rpid: Number(data.rpid) || 0,
      // B 站回复评论时 data.reply 里是刚发的那条，包含 rpid
      text: finalText,
      mentioned: at || '',
      root: params.root ? Number(params.root) : 0,
      parent: params.parent ? Number(params.parent) : 0,
      raw: data
    };
  }

  /** 删除自己发的评论（测试/发错了用）。 */
  async deleteComment(bvid, rpid, { resolveAid } = {}) {
    const aid = Number(await resolveAid(bvid));
    if (!aid) return { ok: false, error: '拿不到视频 aid' };
    const r = await this.post('/x/v2/reply/del', { oid: aid, type: 1, rpid: String(rpid) });
    return r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code, raw: r.json };
  }

  /** 给评论点赞（action=1）/ 取消（action=0）。 */
  async likeComment(bvid, rpid, on = true, { resolveAid } = {}) {
    const aid = Number(await resolveAid(bvid));
    if (!aid) return { ok: false, error: '拿不到视频 aid' };
    const r = await this.post('/x/v2/reply/action', {
      oid: aid, type: 1, rpid: String(rpid), action: on ? 1 : 0
    });
    return r.ok ? { ok: true } : { ok: false, error: r.error, code: r.code };
  }
}
