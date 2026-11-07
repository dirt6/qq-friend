// 5.0-E5/P1：执行结果语义。异常本身不能证明“副作用未发生”。
export function classifyExecutionOutcome(outcome, { threw = false, timedOut = false } = {}) {
  if (timedOut) return { state: 'unknown', reason: 'timeout_side_effect_unknown' };
  if (threw) return { state: 'unknown', reason: 'exception_side_effect_unknown' };
  if (!outcome || typeof outcome !== 'object') return { state: 'unknown', reason: 'missing_outcome' };
  if (outcome.unknown === true || outcome.status === 'unknown') return { state: 'unknown', reason: 'executor_reported_unknown' };
  if (outcome.ok === false) {
    if (outcome.sideEffect === 'none') return { state: 'failed', reason: 'known_no_side_effect' };
    return { state: 'unknown', reason: 'failure_side_effect_unknown' };
  }
  if (outcome.ok === true) return { state: 'succeeded', reason: 'executor_succeeded' };
  return { state: 'unknown', reason: 'indeterminate_outcome' };
}
export default classifyExecutionOutcome;
