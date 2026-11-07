// 日记测试统一启动器（D1-2c-2c）。
//
// 用法：node test/run-diary-test.mjs <test-file>
//
// 职责：
//   · 为本次测试创建独立临时数据根
//   · 在任何日记模块导入前，通过子进程 env 注入 QQ_AGENT_DATA_DIR / DIARY_TEST_TMP / DIARY_TEST_GUARD
//   · 测试结束后清理临时目录；清理失败明确报错
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, '..');
const target = process.argv[2];

if (!target) {
  console.error('用法: node test/run-diary-test.mjs <test-file>');
  process.exit(2);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-iso-'));
const env = {
  ...process.env,
  QQ_AGENT_DATA_DIR: tmp,
  QQ_DIARY_META_WRITE: process.env.QQ_DIARY_META_WRITE ?? '0',
  DIARY_TEST_TMP: tmp,
  DIARY_TEST_GUARD: '1',
  DIARY_TEST_RUNNER: '1',
  DIARY_TEST_PROJECT_ROOT: PROJECT_ROOT
};

const child = spawn(process.execPath, [target], { stdio: 'inherit', env, windowsHide: true });
child.on('exit', (code) => {
  let cleanupError = '';
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (e) {
    cleanupError = String(e?.message ?? e);
  }
  if (cleanupError) {
    console.error(`[diary-iso] 清理临时目录失败：${cleanupError}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
