// 输入预算：调用模型前由**程序**检查的硬闸门。
//
// 为什么不在提示词里写「请控制在 8000 token 以内」：
//   模型算不了自己的 token，写了也只是让它显得配合。超限的后果是请求被端点拒绝、
//   或被上游截断成半句话——两种都比「提前少给一点」更糟。所以这里做的是：
//   先估、再裁、裁不动就整轮跳过，绝不把超限请求发出去。
//
// 裁剪顺序是固定的（用户拍板）：
//   1) 先减候选数量     —— 少看几条，不影响判断质量
//   2) 再缩短摘要       —— 从 200 字压到 60 字，标题/链接/分区始终保留
//   3) 最后才动正文片段 —— 片段本来就是可选的补充材料
//   安全规则、任务说明、必要状态（兴趣/上轮进度）**不参与裁剪**；它们由 build 固定生成，
//   所以永远不会被这里删掉。
//
// 估算精度：没有 tokenizer 依赖，用字符构成估（见 estimateText）。估偏保守（宁可多算），
// 并用真实 usage 校准（recordCalibration），越跑越准。

/** CJK 与全角标点的粗略判定。 */
function isWide(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x3400 && c <= 0x9fff) ||   // 汉字扩展 + 基本区
    (c >= 0xf900 && c <= 0xfaff) ||   // 兼容汉字
    (c >= 0x3000 && c <= 0x303f) ||   // CJK 标点
    (c >= 0xff00 && c <= 0xffef) ||   // 全角字符
    (c >= 0x3040 && c <= 0x30ff) ||   // 日文假名
    (c >= 0xac00 && c <= 0xd7af)      // 韩文
  );
}

/**
 * 估算一段文本的 token 数。
 * 经验值：中文约 0.6 token/字，英文约 0.3 token/字符。这里**故意往高估**：
 * 中文按 0.95、其它按 1/3，再乘 1.05 —— 估高一点只是多裁两条候选，估低了请求会被打回。
 */
export function estimateText(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of s) {
    if (isWide(ch)) wide += 1;
    else narrow += 1;
  }
  return Math.ceil((wide * 0.95 + narrow / 3.0) * 1.05);
}

/** 估算一整组 messages（含 role 包装的固定开销）。 */
export function estimateMessages(messages = []) {
  let total = 0;
  for (const m of messages) {
    total += 4;                                  // role/分隔符的固定开销
    if (typeof m.content === 'string') total += estimateText(m.content);
    else if (Array.isArray(m.content)) {
      for (const part of m.content) total += estimateText(part?.text ?? '');
    }
    if (m.tool_calls) total += estimateText(JSON.stringify(m.tool_calls));
  }
  return Math.ceil(total * 1.05);
}

/**
 * 在候选/摘要两个维度上逐级降档，直到满足预算。
 *
 * @param {object} o
 * @param {number} o.limit        本次调用的 token 硬上限
 * @param {Function} o.build      (candidateCount, summaryChars, bodyChars) => messages
 * @param {Array} o.candidates    候选内容（至少会试 1 条）
 * @param {number} [o.calibration] 估算校准系数（1 = 不校准）
 * @returns {{ok:boolean, messages?:Array, tokens?:number, plan?:object, reason?:string}}
 */
export function fitToBudget({ limit, build, candidates = [], calibration = 1 }) {
  const n = candidates.length;
  // 降档表：先砍数量（10→6→3→1），数量砍到 1 再压摘要（200→120→60→0），最后砍正文片段。
  // 候选为 0（例如"日记回顾"这种没有候选的调用）也要走一遍：用 0 当档位，只压摘要。
  const steps = [];
  const counts = n > 0
    ? [n, 6, 3, 1].filter((c, i, arr) => c >= 1 && c <= n && arr.indexOf(c) === i)
    : [0];
  for (const c of counts) {
    for (const sum of [200, 120, 60, 0]) steps.push({ candidates: c, summaryChars: sum, bodyChars: sum ? Math.min(400, sum * 3) : 0 });
  }
  // 去重（数量=1 时只有一组有效降档）
  const seenPlan = new Set();
  for (const step of steps) {
    const key = `${step.candidates}|${step.summaryChars}|${step.bodyChars}`;
    if (seenPlan.has(key)) continue;
    seenPlan.add(key);
    let messages;
    try {
      messages = build(step.candidates, step.summaryChars, step.bodyChars);
    } catch (e) {
      return { ok: false, reason: `构造请求失败：${e?.message ?? e}` };
    }
    const tokens = Math.ceil(estimateMessages(messages) * (Number(calibration) > 0 ? Number(calibration) : 1));
    if (tokens <= limit) return { ok: true, messages, tokens, plan: step };
  }
  return {
    ok: false,
    reason: `裁剪到最少候选（1 条、无摘要/无正文）仍超过 ${limit} tokens，本轮跳过`
  };
}

/**
 * 用真实 usage 校准估算系数。
 * 只保留最近 20 次样本，取中位数比值，避免一次异常把系数带偏。
 */
export function recordCalibration(state, estimated, actual) {
  if (!(estimated > 0) || !(actual > 0)) return state;
  const list = Array.isArray(state.calibrationSamples) ? state.calibrationSamples : [];
  list.push(Number((actual / estimated).toFixed(3)));
  while (list.length > 20) list.shift();
  const sorted = [...list].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  // 夹在 0.5~1.5，防止极端样本让系数失控
  state.calibration = Math.min(1.5, Math.max(0.5, median));
  state.calibrationSamples = list;
  return state;
}

/** 从模型返回的 usage 里取输入 token（不同网关字段名不一致）。 */
export function promptTokensOf(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  const keys = ['prompt_tokens', 'input_tokens', 'promptTokens', 'inputTokens'];
  for (const k of keys) {
    const v = Number(usage[k]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}
