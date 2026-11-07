// 统一测试隔离工具（4.0 P1）。测试必须在导入数据模块前设置隔离环境。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROD_DATA_DIR = path.resolve('E:/dsh/QQ-agent/data');
export const PROD_DIARY_ROOT = path.resolve('E:/dsh/本子/日记');

export function createIsolationRoot(prefix = 'qqa-iso-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const diaryRoot = path.join(root, 'diary');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(diaryRoot, '每日'), { recursive: true });
  // 最小 config：只固定 diary root；其余让 config 合并默认值。
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ skills: { diary: { root: diaryRoot } } }), 'utf8');
  return { root, dataDir, diaryRoot, env: isolationEnv({ root, dataDir, diaryRoot }) };
}

export function isolationEnv({ root, dataDir, diaryRoot }) {
  return {
    ...process.env,
    QQ_AGENT_TEST_ISOLATION: '1',
    QQ_AGENT_TEST_ROOT: root,
    QQ_AGENT_DATA_DIR: dataDir,
    QQ_AGENT_DIARY_ROOT: diaryRoot
  };
}

export function isUnder(child, parent) {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

export function isProductionPath(p) {
  return isUnder(p, PROD_DATA_DIR) || isUnder(p, PROD_DIARY_ROOT);
}

export function assertIsolatedPaths({ dataDir, diaryRoot } = {}) {
  const data = dataDir || process.env.QQ_AGENT_DATA_DIR;
  const diary = diaryRoot || process.env.QQ_AGENT_DIARY_ROOT;
  if (!data) throw new Error('ISOLATION: 缺少 QQ_AGENT_DATA_DIR');
  if (!diary) throw new Error('ISOLATION: 缺少 QQ_AGENT_DIARY_ROOT');
  if (isProductionPath(data)) throw new Error(`ISOLATION: dataDir 指向生产：${data}`);
  if (isProductionPath(diary)) throw new Error(`ISOLATION: diaryRoot 指向生产：${diary}`);
  const root = process.env.QQ_AGENT_TEST_ROOT;
  if (!root) throw new Error('ISOLATION: 缺少 QQ_AGENT_TEST_ROOT');
  if (!isUnder(data, root) || !isUnder(diary, root)) throw new Error('ISOLATION: 路径不在测试根内');
  return { root, dataDir: path.resolve(data), diaryRoot: path.resolve(diary) };
}

export function assertTestEnv() {
  if (process.env.QQ_AGENT_TEST_ISOLATION !== '1') throw new Error('ISOLATION: 未设置 QQ_AGENT_TEST_ISOLATION（拒绝启动）');
  return assertIsolatedPaths();
}

export function cleanupIsolation(root) {
  if (!root) return { ok: false, error: '缺少 root' };
  try {
    fs.rmSync(root, { recursive: true, force: true });
    if (fs.existsSync(root)) return { ok: false, error: '临时目录仍存在' };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
