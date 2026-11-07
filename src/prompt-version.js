// 提示词指纹：给每轮实际注入的 prompt 记一个「版本」，以后能回答
// 「这句话是在哪一版人设 / 哪几条经验 / 哪版模板下说的」。
//
// 为什么分开记（2026-10-29 机主定的）：
//   人设改了、prompt.js 改了、只是这轮选中的经验不同 —— 三种变化的性质完全不同，
//   混成一个哈希就分不清是谁带来的。所以：
//     persona          人设文本哈希（改一个字就变）
//     promptJs         聊天侧 src/prompt.js 文件哈希（改代码才变）
//     learnedTemplate  经验注入的模板骨架哈希（改格式才变）
//     learnedIds       本轮实际选中的经验条目 id 列表（每轮都可能不同）
//
// 只记指纹，不记全文 —— 日志里不能出现聊天内容和密钥。
// 需要看全文时设 QQ_PROMPT_SNAPSHOT=1，快照落在 data/prompt-archive/snapshots/，
// 用 purgeSnapshots() 按天清理。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { ROOT, DATA_DIR } from './config.js';

const ARCHIVE_DIR = path.join(DATA_DIR, 'prompt-archive');
const TURNS_FILE = path.join(ARCHIVE_DIR, 'turns.ndjson');
const SNAPSHOT_DIR = path.join(ARCHIVE_DIR, 'snapshots');

/** 12 位十六进制，够短也够不撞。 */
export function hashOf(text) {
  return crypto.createHash('sha1').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12);
}

let promptJsCache = null;
/** 聊天侧提示词源码的版本。进程内算一次就够。 */
export function promptJsVersion() {
  if (promptJsCache) return promptJsCache;
  try {
    promptJsCache = hashOf(fs.readFileSync(path.join(ROOT, 'src', 'prompt.js'), 'utf8'));
  } catch { promptJsCache = 'missing'; }
  return promptJsCache;
}

// 经验注入的「模板骨架」，不含具体条目。模板一改版本就变，
// 这样"这轮只是选的条目不一样"和"注入格式整体改了"能区分开。
const LEARNED_TEMPLATE = '【你记住的经验】\n- {text}{mark}\n（库里还有 {n} 条没带，需要时先翻日记再答）';
export function learnedTemplateVersion() {
  return hashOf(LEARNED_TEMPLATE);
}

/**
 * 记一轮。字段都短，只有指纹和 id。
 * 写失败一律吞掉 —— 记账绝不能影响她说话。
 */
export function recordTurn(entry = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    fs.appendFileSync(TURNS_FILE, line + '\n', 'utf8');
  } catch { /* 记不了就算了 */ }
  return line.length;
}

export function snapshotEnabled() {
  return process.env.QQ_PROMPT_SNAPSHOT === '1';
}

/** 调试用：把这一轮实际注入的全文存一份。默认关闭。 */
export function saveSnapshot(text) {
  if (!snapshotEnabled()) return '';
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(SNAPSHOT_DIR, `${stamp}-${hashOf(text)}.txt`);
    fs.writeFileSync(file, String(text), 'utf8');
    return file;
  } catch { return ''; }
}

/** 删掉超过 days 天的快照，返回删了几个。 */
export function purgeSnapshots(days = 7) {
  const cutoff = Date.now() - Math.max(1, days) * 86400_000;
  let removed = 0;
  try {
    for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
      const p = path.join(SNAPSHOT_DIR, f);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) { fs.rmSync(p, { force: true }); removed += 1; }
      } catch { /* 单个失败不影响其它 */ }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}

/** 读最近 n 轮（给排查用）。 */
export function recentTurns(n = 20) {
  try {
    const lines = fs.readFileSync(TURNS_FILE, 'utf8').split(/\r?\n/).filter(Boolean);
    return lines.slice(-Math.max(1, n)).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
