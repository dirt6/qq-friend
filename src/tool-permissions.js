// R7：工具四级权限（read / write / external_action / destructive）。
//
// 目标（机主 2026-11-02）：
//   · 每个工具都有明确的权限级别；
//   · 执行时**重新检查**，不能因为会话启动时有权限就整会话放行；
//   · 外部动作与破坏性动作要和普通读写分开。
//
// 这一版只做“分级 + 检查 + 可查询”，不改变聊天里的既有行为：
//   · 聊天模式（有人在旁边）沿用现有 route/工具自身的确认语义；
//   · 自主模式（空闲/无人值守）下，destructive 工具必须显式 confirm 才允许；
//   · external_action 在返回值里标记 audit，由调用方决定是否记录。

export const PERMISSION_LEVELS = Object.freeze(['read', 'write', 'external_action', 'destructive']);

const DESTRUCTIVE_RE = /(delete|remove|clear|reset|purge|kick|mute|recall|archive|revoke)/i;
const EXTERNAL_RE = /(send|reply|comment|post|publish|share|upload|mention|at_|group_send|message_send)/i;
const READ_RE = /(query|list|get|search|read|view|check|status|show|stats|whoami|detail|summary|history|members|gallery)/i;
const WRITE_RE = /(append|save|set|update|create|add|write|edit|draw|register|install|import|collect|rename)/i;

/**
 * 推断工具权限。
 * 显式 `def.permission` 优先（合法枚举内）；否则按 id 关键词推断，最后按分类兜底。
 */
export function inferPermission(def = {}) {
  const explicit = String(def.permission || '');
  if (PERMISSION_LEVELS.includes(explicit)) return explicit;
  const id = String(def.id || '');
  if (DESTRUCTIVE_RE.test(id)) return 'destructive';
  if (EXTERNAL_RE.test(id)) return 'external_action';
  // 读在前：memory_query / get_recent_messages / bili_detail 都应判成 read。
  if (READ_RE.test(id)) return 'read';
  if (WRITE_RE.test(id)) return 'write';
  if (String(def.category || '') === 'memory') return 'write';
  return 'read';
}

/**
 * 执行前检查。
 * @param {object} def 工具定义
 * @param {{mode?:'chat'|'autonomous', confirm?:boolean}} [ctx]
 * @returns {{ok:boolean, permission:string, audit?:boolean, code?:string, reason?:string}}
 */
export function checkToolPermission(def, { mode = 'chat', confirm = false } = {}) {
  const permission = inferPermission(def);
  if (permission === 'destructive' && mode === 'autonomous' && confirm !== true) {
    return {
      ok: false,
      permission,
      code: 'CONFIRM_REQUIRED',
      reason: `工具 ${def?.id || ''} 属于 destructive，自主模式必须显式 confirm`
    };
  }
  return { ok: true, permission, audit: permission === 'external_action' };
}

export default checkToolPermission;
