// 自我记忆：只注入“空闲时她最近做过什么”的极短摘要。
//
// 2026-11-05 机主明确：**本子/日记正文不要每轮注入**——她想读的时候用工具读。
// 所以这里不碰本子和日记内容，只保留最近几条空闲动作（每轮最多 3 条、总长很短），
// 让她知道“我醒着的时候做过这些”，而不是把自己的本子当成别人/脚本写的。
//
// 边界：只读、不改任何存储、不进 Memory Hub 五层；读不到就不注入。
import { createIdleGoalLog, IDLE_GOAL_LOG_FILE } from './idle-goal-log.js';

const ACTION_TEXT = {
  browse: '逛小黑盒', diary: '整理日记', write_diary: '写日记', write_notebook: '写本子',
  share: '分享', chat: '找老大', comment: 'B站评论', reply: 'B站回复',
  sleep: '睡觉', none: '没做', skip: '跳过'
};

const clip = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * @param {object} o
 * @param {string} [o.logFile]  测试可注入；默认 5.0-goal-cycle.json
 * @param {number} [o.recentIdle] 默认 3 条
 * @param {number} [o.now]
 * @returns {string} 空字符串表示没有可注入的内容
 */
export function buildSelfMemorySection({
  logFile = IDLE_GOAL_LOG_FILE,
  recentIdle = 3,
  now = Date.now()
} = {}) {
  try {
    const log = createIdleGoalLog({ file: logFile, now: () => now });
    const entries = log.recent({ limit: Math.max(1, Number(recentIdle) || 3) })
      .filter((e) => e && (e.action || e.title));
    if (!entries.length) return '';
    const lines = entries.map((e) => {
      let t = '';
      try { t = new Date(Number(e.at) || 0).toLocaleString('zh-CN', { hour12: false }); } catch { t = ''; }
      const act = ACTION_TEXT[e.action] || e.action || e.type || '';
      const title = e.title ? `（${clip(e.title, 40)}）` : '';
      const summary = e.summary ? `：${clip(e.summary, 40)}` : '';
      const next = e.next ? `（下一步：${clip(e.next, 30)}）` : '';
      return `- ${t}：${act}${title}${summary}${next}`;
    });
    return '【你醒着的时候（空闲）最近做过】\n'
      + lines.join('\n')
      + '\n这些是你自己做的，不是脚本、也不是别人。更早的细节需要时用 notebook_read / 日记工具自己读，不要凭印象编。';
  } catch {
    return '';
  }
}

export default buildSelfMemorySection;
