// 统一伙伴核心（Companion Core）门面 —— R8 批次 A。
//
// 定位：**只做统一访问与协调，不替代各领域模块的业务逻辑。**
//   · memory   → 委托 src/memory-hub（唯一的记忆读取入口）
//   · state    → 委托 src/companion/state.js
//   · goals / pending → 委托 src/companion/state.js 的领域函数
//   · diary    → 委托 src/diary/index.js（读）与 memory-hub 的写入口（后续批次）
//   · activity → 委托 memory-hub/adapters.readActivities
//   · context  → 委托聊天存档（ChatStore），由调用方注入
//
// 约束：
//   · 不创建第二套 Memory Hub；
//   · 不改变任何数据格式；
//   · 初始化失败时抛 ECOMPANION_CORE_INIT，不静默退化；
//   · 依赖注入优先，插件不直接依赖全局单例。
import * as memoryHubDefault from '../memory-hub/index.js';
import * as companionDefault from '../companion/state.js';
import * as diaryDefault from '../diary/index.js';
import { readActivities as readActivitiesDefault } from '../memory-hub/adapters.js';
import { todayKey } from '../util.js';
import { getChatStore } from './context.js';

export const COMPANION_CORE_VERSION = 1;

/** 初始化错误（明确失败，不退化）。 */
export class CompanionCoreInitError extends Error {
  constructor(message, detail = '') {
    super(`ECOMPANION_CORE_INIT: ${message}${detail ? `（${detail}）` : ''}`);
    this.name = 'CompanionCoreInitError';
    this.code = 'ECOMPANION_CORE_INIT';
    this.detail = detail;
  }
}

function assertMethods(obj, name, methods) {
  if (!obj || typeof obj !== 'object') {
    throw new CompanionCoreInitError(`${name} 未提供`, '需要对象');
  }
  for (const m of methods) {
    if (typeof obj[m] !== 'function') {
      throw new CompanionCoreInitError(`${name}.${m} 不是函数`, '接口不完整');
    }
  }
}

/**
 * 创建统一伙伴核心门面。
 *
 * @param {object} [deps]
 * @param {object} [deps.memoryHub]  Memory Hub（默认 src/memory-hub）
 * @param {object} [deps.companion]  companion/state（默认真实模块）
 * @param {object} [deps.diary]      diary/index（默认真实模块）
 * @param {function} [deps.readActivities] 活动读取（默认 adapters.readActivities）
 * @param {object} [deps.chatStore]  聊天存档（可选；不传则 context 明确报错）
 * @returns {object} 稳定门面
 */
/**
 * 插件最小能力端口（4.0 阶段 5）。插件不直接拿文件/领域实现；
 * 默认只读；需要写入的插件显式 allowWrite。
 */
export function createCompanionPorts(core, { allowWrite = false } = {}) {
  if (!core || typeof core.readChatSnapshot !== 'function') throw new CompanionCoreInitError('ports 需要 Companion Core');
  const diaryRead = {
    root: () => core.diary.root(),
    readDay: (day, root) => core.diary.readDay(day, root),
    readRaw: (day, root) => core.diary.readRaw(day, root),
    readLines: (file) => core.diary.readLines(file)
  };
  return {
    version: COMPANION_CORE_VERSION,
    state: { get: () => core.state.get(), prompt: (opts) => core.state.prompt(opts) },
    memory: {
      search: (opts) => core.memory.search(opts),
      get: (type, id) => core.memory.get(type, id),
      stats: () => core.memory.stats()
    },
    goals: { active: () => core.goals.active(), paused: () => core.goals.paused() },
    pending: { active: () => core.pending.active() },
    activity: { recent: (opts) => core.activity.recent(opts) },
    diary: allowWrite ? {
      ...diaryRead,
      write: (opts) => core.diary.write(opts),
      removeLine: (opts) => core.diary.removeLine(opts),
      relevelLine: (opts) => core.diary.relevelLine(opts)
    } : diaryRead
  };
}

export function createCompanionCore(deps = {}) {  const memoryHub = deps.memoryHub || memoryHubDefault;
  const companion = deps.companion || companionDefault;
  const diary = deps.diary || diaryDefault;
  const readActivities = deps.readActivities || readActivitiesDefault;
  const chatStore = deps.chatStore || null;

  assertMethods(memoryHub, 'memoryHub', ['search', 'get', 'stats']);
  assertMethods(companion, 'companion', [
    'readCompanion', 'updateCompanion', 'promptSection',
    'activeGoal', 'pausedGoals',
    'createGoal', 'createUserGoal', 'updateGoal', 'pauseGoal', 'resumeGoal',
    'completeGoal', 'cancelGoal', 'supersedeGoal',
    'addPending', 'settlePending', 'activePending'
  ]);
  assertMethods(diary, 'diary', ['write', 'readDay', 'readLines', 'diaryRoot']);
  if (typeof readActivities !== 'function') {
    throw new CompanionCoreInitError('readActivities 不是函数', '接口不完整');
  }

  const requireChatStore = () => {
    const s = chatStore || getChatStore();
    if (!s || typeof s.recent !== 'function') {
      throw new CompanionCoreInitError('context 需要注入 chatStore', '未注入聊天存档');
    }
    return s;
  };

  return {
    version: COMPANION_CORE_VERSION,

    memory: {
      search: (opts) => memoryHub.search(opts),
      get: (type, id) => memoryHub.get(type, id),
      stats: () => memoryHub.stats()
    },

    state: {
      get: () => companion.readCompanion(),
      update: (fn) => companion.updateCompanion(fn),
      prompt: (opts) => companion.promptSection(opts)
    },

    goals: {
      active: () => companion.activeGoal(companion.readCompanion()),
      paused: () => companion.pausedGoals(companion.readCompanion()),
      create: (opts) => companion.createGoal(opts),
      createUser: (opts) => companion.createUserGoal(opts),
      update: (id, opts) => companion.updateGoal(id, opts),
      pause: (id, opts) => companion.pauseGoal(id, opts),
      resume: (id, opts) => companion.resumeGoal(id, opts),
      complete: (id, opts) => companion.completeGoal(id, opts),
      cancel: (id, opts) => companion.cancelGoal(id, opts),
      supersede: (id, opts) => companion.supersedeGoal(id, opts),
      // 兼容 domain 的旧便捷入口；仍由 companion/state.js 唯一维护。
      set: (text, opts) => companion.setGoal(text, opts),
      clear: (opts) => companion.clearGoal(opts),
      bumpAsk: (...args) => companion.bumpAskCount(...args)
    },

    pending: {
      active: () => companion.activePending(),
      add: (opts) => companion.addPending(opts),
      settle: (id, outcome, opts) => companion.settlePending(id, outcome, opts)
    },

    diary: {
      root: () => diary.diaryRoot(),
      readDay: (day, root) => diary.readDay(day, root),
      readRaw: (day, root) => diary.readRawDay(day, root),
      readLines: (file) => diary.readLines(file),
      write: (opts) => diary.write(opts),
      removeLine: (opts) => diary.removeLine(opts),
      relevelLine: (opts) => diary.relevelLine(opts)
    },

    activity: {
      recent: (opts = {}) => readActivities(opts)
    },

    context: {
      recent: (chatKey, opts) => requireChatStore().recent(chatKey, opts),
      meta: (chatKey) => requireChatStore().getChatMeta(chatKey),
      /**
       * 私聊历史只读入口（ChatStore 仍是唯一维护者）。
       * 返回归一化消息；无效 chatKey/未注入 store 明确失败，不伪装成空历史。
       */
      readPrivateHistory: (chatKey, { limit = 40, offset = 0, includeSelf = true, mine = false, since = 0, all = false } = {}) => {
        const key = String(chatKey || '');
        if (!/^private:\d+$/.test(key)) return { ok: false, error: `非法 private chatKey：${key}` };
        let s = null;
        try { s = requireChatStore(); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
        try {
          if (typeof s.chatStatus === 'function') {
            const st = s.chatStatus(key);
            if (st && st.valid === false) return { ok: false, error: `聊天存档损坏：${st.error || '结构无效'}` };
          }
          const n = all ? Number.MAX_SAFE_INTEGER : Math.max(1, Number(limit) || 1);
          const raw = s.recent(key, { limit: n, offset: Math.max(0, Number(offset) || 0), includeSelf, mine }) || [];
          const messages = raw.map((m) => ({
            self: Boolean(m?.self),
            text: String(m?.text ?? m?.content ?? ''),
            ts: Number(m?.ts) || 0,
            mid: m?.mid ?? null,
            id: m?.id ?? null,
            senderId: m?.senderId ?? null,
            recalled: Boolean(m?.recalled)
          })).filter((m) => !since || m.ts >= since);
          return { ok: true, chatKey: key, messages, count: messages.length };
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      }
    },

    /**
     * 聊天统一伙伴快照（只读）。companionText 仍由 companion.promptSection() 生成，
     * 保证聊天 prompt 字节不变；其余字段是结构化只读视图。
     */
    readChatSnapshot: ({ chatKey = '', now = Date.now(), contextLimit = 20 } = {}) => {
      let state = null;
      try { state = companion.readCompanion(); } catch { state = null; }
      let companionText = '';
      try { companionText = companion.promptSection(); } catch { companionText = ''; }
      let goals = { active: null, paused: [] };
      try {
        goals = {
          active: state ? companion.activeGoal(state) : null,
          paused: state ? companion.pausedGoals(state) : []
        };
      } catch { /* keep empty */ }
      let pending = [];
      try { pending = companion.activePending(); } catch { /* keep empty */ }
      let activity = [];
      try { activity = readActivities({ maxRounds: 5 })?.items || []; } catch { /* keep empty */ }
      let diaryDay = null;
      try { diaryDay = diary.readDay(todayKey(now)); } catch { /* keep null */ }      let memoryStats = null;
      try { memoryStats = memoryHub.stats(); } catch { /* optional */ }
      let context = [];
      if (chatStore && chatKey) {
        try { context = chatStore.recent(chatKey, { limit: contextLimit }); } catch { /* optional */ }
      }
      return {
        schema: 1,
        generatedAt: new Date(now).toISOString(),
        chatKey,
        companionText,
        state,
        goals,
        pending,
        activity,
        diary: diaryDay,
        memoryStats,
        context
      };
    }
  };
}
