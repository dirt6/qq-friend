// 隔离预加载：必须在测试主模块/数据模块之前执行。
// 用法：node --import ./test/_isolation-preload.mjs test/xxx.mjs
// 对需要只读检查生产路径的测试，可用 QQ_AGENT_TEST_SKIP_PRELOAD=1 显式退出（静态审计会列出）。
import { createIsolationRoot } from './_isolation.mjs';
import { cleanupIsolation } from './_isolation.mjs';

if (process.env.QQ_AGENT_TEST_SKIP_PRELOAD !== '1' && process.env.QQ_AGENT_TEST_ISOLATION !== '1') {
  const iso = createIsolationRoot('qqa-preload-');
  process.env.QQ_AGENT_TEST_ISOLATION = '1';
  process.env.QQ_AGENT_TEST_ROOT = iso.root;
  process.env.QQ_AGENT_DATA_DIR = iso.dataDir;
  process.env.QQ_AGENT_DIARY_ROOT = iso.diaryRoot;
  process.on('exit', () => {
    const r = cleanupIsolation(iso.root);
    if (!r.ok) console.error(`[isolation] 临时目录清理失败：${iso.root}：${r.error}`);
  });
}
