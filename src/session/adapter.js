// DSH Session Adapter（4.0 / R6-B2）。
//
// ── 一句话定位 ────────────────────────────────────────────────────
// 把「DSH 0.2.0-rc.2 的 CLI Session 能力」封装成一个明确、可测的接口。
//
// ── 能力边界（**严格按本地实测，不包装不存在的东西**）──────────────
//
// R6-A 实测（见 docs/roadmap/DSH-RC2-API-INVENTORY.md）：
//
//   ✅ 支持：
//      · `--session-id <id>` 恢复会话（turn 编号递进证明历史真恢复）
//      · 不带 `--session-id` 创建新会话
//      · `--json` 事件流（session / status / final / error）
//      · 会话文件落在 `{DSH_HOME}/sessions/<cwd编码>/<sessionId>/session.v4.jsonl.zstd`
//
//   ❌ 不支持（**Adapter 不会假装有**）：
//      · `--session-key`（实测 unknown option）
//      · 可编程 Session API（package.json 只导出 profile-boot）
//      · 任何清理 / 删除 / TTL / 列举命令（`--help` 里没有）
//
// 所以：
//   · **创建 / 恢复** = DSH 的能力（Adapter 只负责拼参数、解析结果）
//   · **列举 / 清理 / TTL** = **QQ-agent 自己的责任**（Adapter 明确拒绝这些请求，
//     相关逻辑不在这里，避免两层重复管理）
//
// ── Session 生命周期的唯一 owner ─────────────────────────────────
//   · **会话文件**：DSH 拥有（存在 DSH_HOME 里，Adapter 不读不删）
//   · **chatKey → sessionId 映射**：QQ-agent 拥有（dsh-sessions.json）
//   · **何时新建、何时复用、何时丢弃映射**：QQ-agent 决定
//   · **会话文件何时消失**：DSH 没有 TTL，所以**永远不消失** ——
//     这是已知事实，不是 bug；要清理只能由 QQ-agent 显式删目录（本批不做）
//
// ── cwd 是硬约束 ────────────────────────────────────────────────
// DSH 会话记录了创建时的 cwd，恢复时 cwd 不一致会直接报错：
//   session "..." was recorded in "E:\dsh\QQ-agent", not "C:\..."
// 所以 Adapter 把 cwd 当成**显式参数**，并且**必须由调用方传入**（不猜）。

import path from 'node:path';

/** Adapter 明确支持的能力（对应 DSH 实测能力）。 */
export const CAPABILITIES = Object.freeze({
  create: true,      // 不带 --session-id
  resume: true,      // 带 --session-id
  list: false,       // DSH 没有
  delete: false,     // DSH 没有
  ttl: false,        // DSH 没有
  naming: false      // DSH 没有 --session-key
});

/** 不支持的请求，给一个明确的错误码。 */
export const ERR = Object.freeze({
  UNSUPPORTED: 'ADAPTER_UNSUPPORTED',
  CWD_REQUIRED: 'ADAPTER_CWD_REQUIRED',
  PROFILE_REQUIRED: 'ADAPTER_PROFILE_REQUIRED',
  BAD_SESSION_ID: 'ADAPTER_BAD_SESSION_ID'
});

/**
 * 校验一个 sessionId 的形状。
 *
 * 实测的 id 形如 `session-<uuid>`。这里**不强制**必须是 uuid
 * （DSH 将来可能改格式），只挡明显非法的输入（空串 / 空白 / 换行）。
 *
 * @param {string} id
 * @returns {{ok:boolean, reason?:string}}
 */
export function validateSessionId(id) {
  const s = String(id ?? '');
  if (!s) return { ok: false, reason: '空 sessionId' };
  if (s !== s.trim()) return { ok: false, reason: 'sessionId 首尾有空白' };
  if (/[\r\n]/.test(s)) return { ok: false, reason: 'sessionId 含换行' };
  if (s.length > 200) return { ok: false, reason: 'sessionId 过长' };
  return { ok: true };
}

/**
 * 构造一次 DSH 调用的参数（**纯函数，不碰文件系统**）。
 *
 * 参数顺序**有意固定**（R6-A 实测踩过坑）：
 *   `--patch` 必须放在 `--json` **之前** —— `--json` 之后的所有参数都归 headless app，
 *   `--patch` 是 launcher 的参数，放后面会报 `unknown option '--patch'`。
 *
 * @param {object} o
 * @param {string} o.profile  profile 名（必填，通常 'headless'）
 * @param {string} [o.sessionId]  有值 = 恢复；无值 = 新建
 * @param {string[]} [o.patchFiles]  --patch 覆盖层（可多个）
 * @returns {{ok:boolean, args?:string[], mode?:'create'|'resume', error?:string, code?:string}}
 */
export function buildArgs({ profile = '', sessionId = '', patchFiles = [] } = {}) {
  const prof = String(profile || '').trim();
  if (!prof) {
    return { ok: false, error: '必须指定 profile', code: ERR.PROFILE_REQUIRED };
  }

  const args = ['--profile', prof];

  // --patch 必须在 --json 之前
  for (const p of (Array.isArray(patchFiles) ? patchFiles : [])) {
    const f = String(p || '').trim();
    if (f) args.push('--patch', f);
  }

  args.push('--json');

  let mode = 'create';
  // ⚠️ 这里**故意不 trim**：
  //   · 空串 / 纯空白 = 没传 → 新建（下方判断）
  //   · 有内容的但首尾带空白 = **调用方传错了**，交给 validateSessionId 拒绝
  // 如果这里先 trim 掉，' a ' 就会被当成 'a' 静默接受 —— 掩盖调用方的问题。
  const raw = String(sessionId ?? '');
  const sid = raw.trim() ? raw : '';          // 纯空白视同没传
  if (sid) {
    const v = validateSessionId(sid);
    if (!v.ok) {
      return { ok: false, error: `sessionId 不合法：${v.reason}`, code: ERR.BAD_SESSION_ID };
    }
    args.push('--session-id', sid);
    mode = 'resume';
  }

  // 任务文本走 stdin（`-`）：cmd 的参数通道会弄丢中文
  args.push('-');

  return { ok: true, args, mode };
}

/**
 * 校验一次调用的运行环境（**cwd 是硬约束**）。
 *
 * @param {object} o
 * @param {string} o.cwd        **必须显式传入**，Adapter 不猜
 * @param {string} [o.appRoot]  期望的根目录（有值时校验 cwd 是否一致）
 * @returns {{ok:boolean, error?:string, code?:string}}
 */
export function checkContext({ cwd = '', appRoot = '' } = {}) {
  const c = String(cwd || '').trim();
  if (!c) {
    return { ok: false, error: 'cwd 必须显式传入（DSH 会话绑定了创建时的 cwd）', code: ERR.CWD_REQUIRED };
  }
  if (!path.isAbsolute(c)) {
    return { ok: false, error: `cwd 必须是绝对路径：${c}`, code: ERR.CWD_REQUIRED };
  }
  if (appRoot) {
    const a = path.resolve(String(appRoot));
    const r = path.resolve(c);
    if (a !== r) {
      return {
        ok: false,
        error: `cwd 必须与 DSH 会话记录的一致：期望 ${a}，实际 ${r}`,
        code: ERR.CWD_REQUIRED
      };
    }
  }
  return { ok: true };
}

/**
 * 拼装一次完整的调用描述（参数 + 环境 + 任务），**纯函数**。
 *
 * 真正执行 spawn 的仍然是 dsh-gateway（本批不改变执行路径）。
 * 这个函数存在的意义：**把"一次调用需要哪些东西"变成可断言的数据**。
 *
 * @param {object} o
 * @param {string} o.profile
 * @param {string} o.cwd
 * @param {string} [o.sessionId]
 * @param {string[]} [o.patchFiles]
 * @param {string} o.text       任务文本（会从 stdin 送进去）
 * @param {object} [o.env]      额外环境变量（DSH_HOME 之类）
 * @param {string} [o.appRoot]  期望的根目录（校验 cwd）
 * @returns {{ok:boolean, plan?:object, error?:string, code?:string}}
 */
export function planCall({
  profile = 'headless',
  cwd = '',
  sessionId = '',
  patchFiles = [],
  text = '',
  env = {},
  appRoot = ''
} = {}) {
  const ctx = checkContext({ cwd, appRoot });
  if (!ctx.ok) return ctx;

  const built = buildArgs({ profile, sessionId, patchFiles });
  if (!built.ok) return built;

  return {
    ok: true,
    plan: {
      mode: built.mode,                 // 'create' | 'resume'
      args: built.args,
      cwd: path.resolve(cwd),
      stdin: String(text ?? ''),        // 任务文本走 stdin
      env: { ...env },
      sessionId: String(sessionId || '')
    }
  };
}

/**
 * 拒绝一个**DSH 不支持**的管理请求（枚举 / 清理 / TTL）。
 *
 * 机主 2026-11-03 明确：**不要把不存在的功能包装出来**。
 * 这些能力如果需要，由 QQ-agent 自己负责，并且明确边界。
 *
 * @param {'list'|'delete'|'ttl'|'naming'} what
 * @returns {{ok:false, error:string, code:string}}
 */
export function unsupported(what) {
  const names = {
    list: '枚举会话',
    delete: '删除会话',
    ttl: '会话过期',
    naming: '给会话命名'
  };
  const name = names[what] || String(what);
  return {
    ok: false,
    code: ERR.UNSUPPORTED,
    error: `DSH 0.2.0-rc.2 不支持「${name}」—— 这是 QQ-agent 自己的责任，不在 Adapter 里实现`
  };
}

/** 这个 Adapter 声称能做什么（供文档/测试断言）。 */
export function capabilities() {
  return { ...CAPABILITIES };
}
