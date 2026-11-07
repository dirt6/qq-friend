// 回退决策（4.0 / R6-B3）。
//
// ── 为什么单独一个模块 ───────────────────────────────────────────
// 机主 2026-11-03 的明确警告：
//   「**B3 的回退不能在请求结果不确定时盲目重发**，否则可能造成同一个任务执行两次。」
//
// 所以回退必须建立在「这次调用到底有没有真的跑起来」这个判断上。
// 判断错了就会重复执行 —— 那是比失败更严重的问题。
//
// ── 一次 DSH 调用的生命周期 ─────────────────────────────────────
//
//   spawn ──失败──→ **没跑起来** → 可以安全重试
//     │
//     └─成功─→ 进程起来了 ──→ **可能已经执行了任务** → 不能重试
//                            （只能如实报告失败）
//
// ── 结论 ────────────────────────────────────────────────────────
//   · `ok: true`                     → 不需要重试
//   · `errorSource: 'event'|'turn'`  → **DSH 跑过了** → 不能重试
//   · `errorSource: 'exit'`          → **进程跑过了** → 不能重试
//   · `errorSource: 'empty'`         → **进程跑过了** → 不能重试
//   · 超时                            → **进程跑过了** → 不能重试
//   · `spawn` 失败（起不来）           → **没跑起来** → **可以重试**
//   · 参数/配置错误（本地校验失败）     → **没跑** → 可以重试（但要先修参数）

/** 可以安全重试的错误来源（这些情况确定没执行过任务）。 */
export const SAFE_RETRY_SOURCES = Object.freeze([
  'spawn'      // 进程没起来
]);

/** 明确**不能**重试的错误来源（进程已经起来了，可能执行过）。 */
export const UNSAFE_RETRY_SOURCES = Object.freeze([
  'event',                // DSH 主动报了错，说明它跑了
  'turn',                 // 回合内部错误，说明它跑了
  'exit',                 // 进程退出码非零，说明它跑了
  'empty',                // 正常退出但没输出，说明它跑了
  'runtime',              // **4.0 / R6-C0**：进程已启动后的运行期错误（kill 失败 / 流错误）
  'timeout',              // **4.0 / R6-C0**：超时（进程跑了一段时间）
  'timeout_kill_failed'   // **4.0 / R6-C0**：超时且 kill 失败（进程还活着，绝对不能重发）
]);

/**
 * 这次失败能不能安全重试？
 *
 * @param {object} result `ask()` 的返回值
 * @returns {{retryable:boolean, reason:string}}
 */
export function canSafelyRetry(result) {
  if (!result || typeof result !== 'object') {
    return { retryable: false, reason: '结果不是对象，无法判断是否执行过' };
  }

  if (result.ok === true) {
    return { retryable: false, reason: '成功了，不需要重试' };
  }

  const src = String(result.errorSource || '');

  // 明确安全：进程没起来
  if (src === 'spawn') {
    return { retryable: true, reason: 'DSH 进程没起来，任务肯定没执行过' };
  }

  // 明确不安全：进程跑过了
  if (UNSAFE_RETRY_SOURCES.includes(src)) {
    return {
      retryable: false,
      reason: `DSH 进程已启动（errorSource=${src}），任务可能已执行 —— **重试会造成重复执行**`
    };
  }

  // 超时：错误文案里有"超时"
  if (/超时/.test(String(result.error || ''))) {
    return {
      retryable: false,
      reason: 'DSH 超时 —— 进程已经跑了一段时间，任务可能已执行，不能重试'
    };
  }

  // 没带 errorSource 的失败：保守认为不安全
  return {
    retryable: false,
    reason: '无法确认 DSH 是否执行过（没有 errorSource）—— 保守起见不重试'
  };
}

/**
 * 决定是否回退到旧路径（API）。
 *
 * ⚠️ **回退 ≠ 重试**：
 *   · 回退到 API 是**换一条完全不同的执行路径**（不走 DSH），
 *     所以对"DSH 没执行过"的情况是安全的；
 *   · 但如果 DSH **可能已经执行过**，回退到 API 会**让同一件事做两遍**
 *     （DSH 做了一次，API 又做一次）。
 *
 * 所以回退的条件和重试一样苛刻：只有确定 DSH 没执行过才回退。
 *
 * @param {object} result
 * @returns {{fallback:boolean, reason:string}}
 */
export function shouldFallbackToApi(result) {
  const r = canSafelyRetry(result);
  return { fallback: r.retryable, reason: r.reason };
}

/**
 * 把这套规则讲成一句人能看懂的话（日志/报告用）。
 */
export function describePolicy() {
  return [
    '只有「DSH 进程没起来」才能重试/回退，',
    '因为那时任务肯定没执行过。',
    '一旦进程起来了（不管报什么错、包括超时），',
    '都按失败如实报告，绝不重发 —— 宁可这轮失败，也不能让她把同一句话说两遍。'
  ].join('');
}

export const __internals = { SAFE_RETRY_SOURCES, UNSAFE_RETRY_SOURCES };
