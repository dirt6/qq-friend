// 日记模块的统一出口（4.0 · 1.5.1）。
//
// 现在只有 writer（写入口）。reader / lock 等按 D3 的目录规划后续补，
// 但**不急着建空文件** —— 用到再拆。
export {
  write,
  removeLine,
  relevelLine,
  readDay,
  readRawDay,
  readLines,
  formatLine,
  contentHash,
  stripMoodPrefix,
  diaryRoot,
  diaryDir,
  dateKey,
  __internals
} from './writer.js';
