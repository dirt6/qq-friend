// R6-C 实验场景定义（4.0 / R6-C0-C）。
//
// ── 本文件只做定义，不执行真实 DSH ─────────────────────────────
//   每个场景给出：目的、输入、断言、结果判定的三种状态。
//
// ── 三态判定（机主硬要求）───────────────────────────────────────
//   · PASS        —— 断言全部满足，有真实数据支持
//   · FAIL        —— 有真实数据，且明确不满足
//   · INCONCLUSIVE —— **没拿到足够数据**（凭据缺失 / 超时 / 样本不足）
//
//   ⚠️ **INCONCLUSIVE 不是 PASS。**
//      没拿到数据 = 不知道，不是"没问题"。

/** 结果三态。 */
export const VERDICT = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCONCLUSIVE: 'INCONCLUSIVE'
});

/**
 * 一个场景的骨架。
 * @typedef {object} Scenario
 * @property {string} id
 * @property {string} title
 * @property {string} purpose
 * @property {object} input
 * @property {string[]} assertions
 * @property {string[]} notCovered
 * @property {number} minSamples
 */

/**
 * 8 个场景的定义（**不含执行逻辑**）。
 *
 * @returns {Scenario[]}
 */
export function scenarioCatalog() {
  return [
    {
      id: 'S1',
      title: 'Session 创建与恢复',
      purpose: '验证不带 --session-id 能创建、带 --session-id 能恢复，且恢复的是**真实历史**（不只返回同一个 id）',
      input: {
        steps: [
          '① 在实验 DSH_HOME + 实验 cwd 下跑一次任务 A（不带 --session-id）',
          '② 从事件流里取 sessionId',
          '③ 用同一个 sessionId 跑任务 B',
          '④ 检查第二次的 turn 编号是否 > 第一次'
        ],
        markers: ['随机标记 R1（放进任务 A）', '随机标记 R2（放进任务 B）']
      },
      assertions: [
        '第一次事件流里有 type:session 且 sessionId 非空',
        '第二次事件流里的 sessionId 与第一次**相同**',
        '**第二次的 turn_start.turn > 第一次**（证明历史被读取）',
        'session 文件落在实验 DSH_HOME 内（不在生产）'
      ],
      notCovered: [
        '"历史真的被模型看到"—— 只能间接由 turn 编号证明，不能直接验证上下文内容'
      ],
      minSamples: 1
    },

    {
      id: 'S2',
      title: '两个 Session 的真实内容隔离',
      purpose: '验证两个不同 sessionId 的对话内容不会互相看见',
      input: {
        steps: [
          '① session-A：告诉它一个随机标记 M1（"记住这个词：M1"）',
          '② session-B：告诉它一个随机标记 M2',
          '③ session-A：问它 "刚才那个词是什么"',
          '④ session-B：问同样的问题'
        ],
        markers: ['M1 = 随机 8 位字母数字', 'M2 = 另一个随机 8 位']
      },
      assertions: [
        '**A 的回答里出现 M1，不出现 M2**',
        '**B 的回答里出现 M2，不出现 M1**',
        '两次的 sessionId 不同',
        '两个 session 目录都在实验 DSH_HOME 内'
      ],
      notCovered: [
        '模型可能记不住（即使隔离正确）—— 这会导致 INCONCLUSIVE 而不是 FAIL',
        '需要先跑一次"记忆能力基线"来确定模型确实能记住'
      ],
      minSamples: 1
    },

    {
      id: 'S3',
      title: '两个 Session 并发运行及内容串扰检查',
      purpose: '验证并发时输入不交叉、输出不串',
      input: {
        steps: [
          '① 同时启动两个进程，分别用 session-A 和 session-B',
          '② A 的任务里带随机标记 M_A，B 的任务里带 M_B',
          '③ 两个都问"你刚才收到的标记是什么"',
          '④ 比对返回'
        ],
        markers: ['M_A / M_B 各自动生成，互不相同'],
        concurrency: '两个进程**真并发**（不加锁）'
      },
      assertions: [
        '**A 的输出只含 M_A**，不含 M_B',
        '**B 的输出只含 M_B**，不含 M_A',
        '两个进程的 sessionId 不同（**不许用同一个 session 做并发测试**）',
        '两个的 turn 编号各自独立递增'
      ],
      notCovered: [
        '进程级并发调度（谁先谁后）不可控',
        '如果两个进程抢同一个 sessionId，那是另一种情况（R6-A 已测过 turn 串行）'
      ],
      minSamples: 3
    },

    {
      id: 'S4',
      title: '工具调用是否重复',
      purpose: '验证一次请求只触发一次工具执行（不因重试/回退而重复）',
      input: {
        steps: [
          '① 注册一个**无外部副作用**的测试工具（只写本地实验目录的计数器文件）',
          '② 发起一次会调用它的请求',
          '③ 读计数器'
        ],
        markers: ['计数器文件放在实验 results/ 里']
      },
      assertions: [
        '**计数器 === 1**（一次请求只执行一次）',
        '失败/超时场景里，计数器 **≤ 1**（绝不能 2）'
      ],
      notCovered: [
        '真实工具的副作用（发消息、发帖）不在本实验范围',
        '如果模型决定不调工具，计数为 0 —— 那是 INCONCLUSIVE 不是 FAIL'
      ],
      minSamples: 1
    },

    {
      id: 'S5',
      title: '正常事件流与 final.text',
      purpose: '验证正常完成时的事件流形态（R6-A 只见过错误态）',
      input: {
        steps: ['发起一次最简单、最可能成功的请求（如"回一个字：好"）'],
        markers: ['记录完整原始事件流（每一行 JSON）']
      },
      assertions: [
        '**收到 type:final 且 text 非空**',
        '事件类型集合 ⊆ {session, status, final, error}',
        '**没有 type:error 事件**',
        'turn_end 的 reason 不是 error'
      ],
      notCovered: [
        '模型回复可能是空串（极小概率）—— 那会判 INCONCLUSIVE'
      ],
      minSamples: 3
    },

    {
      id: 'S6',
      title: '正常态 usage 是否存在、字段含义与统计口径',
      purpose: 'R6-A 只在错误态看过，没见过正常态的 usage',
      input: {
        steps: ['同 S5，但**专门检查 status 事件里有没有 usage 字段**'],
        markers: ['把每次的 status.turn_end 原样记下来']
      },
      assertions: [
        '要么：**明确找到 usage 字段**，并记录其结构',
        '要么：**明确没有 usage**（连续 3 次正常完成都没有）',
        '不能因为"某次没看到"就判"没有"'
      ],
      notCovered: [
        'usage 可能与 turn 有关（某些 turn 有、某些没有）',
        '如果样本不足 3 次 → INCONCLUSIVE'
      ],
      minSamples: 3
    },

    {
      id: 'S7',
      title: '请求延迟及 P95 计算',
      purpose: '为 R6-C 的「P95 延迟」硬门槛提供数据',
      input: {
        steps: [
          '① 发起 N 次**相同复杂度**的请求（N ≥ 10，建议 20）',
          '② 每次记录 startedAt / finishedAt',
          '③ 计算 P50 / P95'
        ],
        markers: ['必须记录样本数、失败数、超时数']
      },
      assertions: [
        '**样本数 ≥ 10**（否则 INCONCLUSIVE）',
        'P95 用**排序后的第 ceil(0.95×N) 个**，不是平均值',
        '失败和超时的样本**单独计数**，不能混进延迟里',
        '报告里写明计算方法'
      ],
      notCovered: [
        '网络波动、模型负载会影响延迟',
        '单次运行不能代替 P95'
      ],
      minSamples: 10
    },

    {
      id: 'S8',
      title: '超时、异常退出和中断恢复',
      purpose: '验证异常路径的分类正确，且中断后能恢复',
      input: {
        steps: [
          '① 用**假的 dsh**（test/fixtures/fake-dsh.cmd）模拟超时/异常退出',
          '② 验证错误分类',
          '③ 真实验：在请求中途 kill 进程，看 session 文件是否损坏、能否恢复'
        ],
        markers: ['假 dsh 不消耗 token；真实验消耗 1 次']
      },
      assertions: [
        '超时 → errorSource=timeout，**不可重试**',
        '异常退出 → errorSource=exit，**不可重试**',
        '**中断后 session 仍能恢复**（下一次用同一 id 能跑起来）',
        '中断不会让 session 文件变成无法解析'
      ],
      notCovered: [
        'kill 的时机不可控（可能在模型调用中间）',
        '磁盘层损坏不在本实验范围'
      ],
      minSamples: 1
    }
  ];
}

/**
 * 根据断言结果算判定。
 *
 * @param {object} o
 * @param {number} o.samples       实际拿到的有效样本数
 * @param {number} o.requiredSamples 场景要求的最小样本数
 * @param {boolean} o.allAssertionsPassed 断言是否全过
 * @param {number} [o.failures]    失败的断言数
 * @returns {{verdict:string, reason:string}}
 */
export function decideVerdict({ samples = 0, requiredSamples = 1, allAssertionsPassed = false, failures = 0 }) {
  if (samples < requiredSamples) {
    return {
      verdict: VERDICT.INCONCLUSIVE,
      reason: `样本不足：拿到 ${samples}，需要 ${requiredSamples}`
    };
  }
  if (samples === 0) {
    return { verdict: VERDICT.INCONCLUSIVE, reason: '一个有效样本都没有' };
  }
  if (allAssertionsPassed) {
    return { verdict: VERDICT.PASS, reason: `样本 ${samples}，断言全过` };
  }
  return {
    verdict: VERDICT.FAIL,
    reason: `样本 ${samples}，有 ${failures} 条断言失败`
  };
}

/**
 * 算 P95（**明确计算方法**）。
 *
 * @param {number[]} samples 毫秒
 * @returns {{p50:number, p95:number, n:number, method:string}|null}
 */
export function percentile95(samples) {
  const xs = (Array.isArray(samples) ? samples : []).filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!xs.length) return null;
  const pick = (q) => {
    const idx = Math.min(xs.length - 1, Math.ceil(q * xs.length) - 1);
    return xs[Math.max(0, idx)];
  };
  return {
    p50: pick(0.5),
    p95: pick(0.95),
    n: xs.length,
    method: '排序后取第 ceil(q × n) 个（1-based），不插值'
  };
}

/** 空的结果骨架（每个场景跑完填这个）。 */
export function emptyResult(scenarioId) {
  return {
    scenario: scenarioId,
    startedAt: new Date().toISOString(),
    finishedAt: '',
    samples: 0,
    failures: 0,
    timeouts: 0,
    verdict: VERDICT.INCONCLUSIVE,
    reason: '',
    assertions: [],
    raw: [],
    notes: ''
  };
}
