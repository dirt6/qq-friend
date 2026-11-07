// 5.0-E6：统一 Action Runtime。
// 职责分离：
//   - 运行状态（paused / G2/G3 开关 / 预算计数）在本文件持久化；
//   - 权限凭证（控制 token / HMAC keys）独立文件，不在状态里；
//   - 恢复：启动强制 paused；执行 store 的 started → UNKNOWN；G3 sending intent → UNKNOWN。
// 本模块不自动调度、不建第二套记忆、不直接调模型/工具。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createExecutionStore } from './execution-store.js';
import { createCoordinator } from './coordinator.js';
import { createActionExecutor } from './action-executor.js';

const VERSION = 1;
const defaultBudget = () => ({ day: '', actions: 0, sends: 0 });
const emptyState = () => ({
  version: VERSION, paused: true, g2: false, g3: false, readonly: false, draw: false, degraded: false,
  budget: defaultBudget(), lastRecovery: null, updatedAt: new Date(0).toISOString()
});
const dayKey = (now) => new Date(now).toLocaleDateString('en-CA');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function createAutonomousRuntime({
  file, stateFile = '', tokenFile = '', learnedAdapter = null, qqAdapter = null, readonlyAdapter = null, drawAdapter = null,
  authorizationService = null, recentSends = [], now = () => Date.now(),
  budgetLimits = { maxActionsPerDay: 20, maxSendsPerDay: 3 }
} = {}) {
  if (!file) throw new Error('runtime 需要显式 execution file');
  const dataDir = path.dirname(path.resolve(file));
  const statePath = path.resolve(stateFile || path.join(dataDir, 'state.json'));
  const controlTokenPath = path.resolve(tokenFile || path.join(path.dirname(statePath), 'control-token'));
  const store = createExecutionStore({ file });
  let state = loadState();
  // 启动安全策略：任何进程重启都先 paused；功能开关 fail-closed 为 disabled。
  // 预算/历史恢复；enabled 状态必须由控制 token 在启动后重新显式打开。
  state.paused = true;
  state.g2 = false;
  state.g3 = false;
  state.readonly = false;
  state.draw = false;
  state.budget = normalizeBudget(state.budget, now());
  saveState();

  const actionExecutor = createActionExecutor({
    learnedAdapter, qqAdapter, readonlyAdapter, drawAdapter, authorizationService,
    paused: () => state.paused, recentSends, now
  });
  const coordinator = createCoordinator({ store, execute: actionExecutor.execute, now });
  let chain = Promise.resolve();

  function loadState() {
    try {
      if (!fs.existsSync(statePath)) return emptyState();
      const raw = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (!raw || typeof raw !== 'object' || raw.version !== VERSION) return { ...emptyState(), degraded: true };
      return {
        ...emptyState(), ...raw,
        paused: raw.paused !== false,
        g2: raw.g2 === true, g3: raw.g3 === true, readonly: raw.readonly === true, draw: raw.draw === true,
        degraded: raw.degraded === true,
        budget: raw.budget && typeof raw.budget === 'object' ? raw.budget : defaultBudget()
      };
    } catch { return { ...emptyState(), degraded: true }; }
  }
  function normalizeBudget(b, at) {
    const day = dayKey(at);
    if (!b || b.day !== day) return { day, actions: 0, sends: 0 };
    return { day, actions: Math.max(0, Number(b.actions) || 0), sends: Math.max(0, Number(b.sends) || 0) };
  }
  function saveState() {
    state.updatedAt = new Date(now()).toISOString();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, statePath);
  }
  function readControlToken() {
    try {
      const t = fs.readFileSync(controlTokenPath, 'utf8').trim();
      return t.length >= 32 ? t : '';
    } catch { return ''; }
  }
  function authorize(req) {
    const expected = readControlToken();
    const supplied = String(req?.headers?.['x-5.0-token'] || '');
    if (!expected || !supplied) return false;
    const a = Buffer.from(supplied); const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  function status() {
    return {
      paused: state.paused, g2Enabled: state.g2, g3Enabled: state.g3, readonlyEnabled: state.readonly, drawEnabled: state.draw,
      degraded: state.degraded, budget: { ...state.budget, limits: { ...budgetLimits } },
      lastRecovery: state.lastRecovery, tokenConfigured: readControlToken() !== '',
      qqTargetConfigured: Boolean(qqAdapter?.target)
    };
  }

  async function recover() {
    const r = await store.recover({ now: now() });
    let qq = null;
    try { qq = qqAdapter && typeof qqAdapter.recover === 'function' ? await qqAdapter.recover() : null; } catch (e) { qq = { ok: false, error: String(e?.message || e) }; }
    state.lastRecovery = { at: new Date(now()).toISOString(), started: r.recovered || [], g3: qq };
    saveState();
    return { ok: true, ...state.lastRecovery };
  }

  async function run(input = {}) {
    if (state.degraded) return { ok: false, reason: 'STATE_CORRUPT', status: 503 };
    if (state.paused) return { ok: false, reason: 'PAUSED' };
    const kind = String(input?.executionPlan?.kind || '');
    if (kind === 'learned' && !state.g2) return { ok: false, reason: 'G2_DISABLED' };
    if (kind === 'qq' && !state.g3) return { ok: false, reason: 'G3_DISABLED' };
    if (kind === 'readonly' && !state.readonly) return { ok: false, reason: 'READONLY_DISABLED' };
    if (kind === 'draw' && !state.draw) return { ok: false, reason: 'DRAW_DISABLED' };
    if (!['learned', 'qq', 'readonly', 'draw'].includes(kind)) return { ok: false, reason: 'KIND_NOT_ALLOWED' };
    if (kind === 'qq') {
      if (!qqAdapter) return { ok: false, reason: 'G3_TARGET_NOT_CONFIGURED' };
      const requested = String(input?.executionPlan?.qqTarget || '');
      if (requested !== String(qqAdapter.target)) return { ok: false, reason: 'TARGET_NOT_ALLOWED' };
    }
    state.budget = normalizeBudget(state.budget, now());
    if (state.budget.actions >= Number(budgetLimits.maxActionsPerDay || 0)) return { ok: false, reason: 'BUDGET_ACTIONS' };
    if (kind === 'qq' && state.budget.sends >= Number(budgetLimits.maxSendsPerDay || 0)) return { ok: false, reason: 'BUDGET_SENDS' };
    // 先记一次尝试，崩溃/超时不会少算；授权失败也会消耗，宁可保守。
    state.budget.actions += 1;
    if (kind === 'qq') state.budget.sends += 1;
    saveState();
    // 统一把 Runtime 的 HMAC 服务注入 Coordinator；调用方不能靠省略 service 绕过签名。
    const runInput = { ...input, authorizationService: input.authorizationService || authorizationService };
    const p = chain.then(() => coordinator.run(runInput), () => coordinator.run(runInput));
    chain = p.catch(() => {});
    return p;
  }

  async function setPaused(v) {
    if (state.degraded && v === false) return { ok: false, reason: 'STATE_CORRUPT' };
    state.paused = v !== false;
    if (state.paused) await store.pause('runtime_paused', { now: now() }); else await store.resume({ now: now() });
    saveState();
    return status();
  }
  function setEnabled(kind, v) {
    if (state.degraded) return { ok: false, reason: 'STATE_CORRUPT' };
    if (kind === 'g2') state.g2 = v === true;
    else if (kind === 'g3') state.g3 = v === true;
    else if (kind === 'readonly') state.readonly = v === true;
    else if (kind === 'draw') state.draw = v === true;
    else return { ok: false, reason: 'KIND_NOT_ALLOWED' };
    saveState();
    return status();
  }

  return { run, recover, setPaused, setEnabled, status, authorize, store, statePath, controlTokenPath };
}

export default createAutonomousRuntime;
export { sha };
