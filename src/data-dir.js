// 唯一的数据目录解析（R8-0-A1）。
//
// 目标：开发模式、打包 Electron、直接 Node 启动、以及任何启动入口，
// 得到**同一个权威数据目录**。
//
// 打包布局（Windows NSIS）：
//   <安装目录>/QQ Agent.exe
//   <安装目录>/resources/app.asar        ← Electron 侧 ROOT
//   <安装目录>/resources/app/            ← 非 asar / Node 侧 ROOT
//   <安装目录>/data/                     ← 权威数据目录
//
// 所以打包模式下，ROOT 往上两级一定是安装目录；开发模式下 ROOT 就是项目根。
// 这样 Electron 的 `path.dirname(exe)` 与 Node 的 `resources/app` 推导结果一致。
import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析权威数据目录。
 *
 * @param {object} [opts]
 * @param {string} [opts.appRoot] 应用根目录（src/ 的上一级；打包时是 resources/app 或 app.asar）
 * @param {boolean} [opts.packaged] 是否打包模式
 * @param {string} [opts.suffix] 多实例后缀（'' 或 '-2'）
 * @param {string} [opts.envDir] 显式覆盖（默认读 QQ_AGENT_DATA_DIR）
 * @returns {string} 绝对路径
 * @throws 缺少 appRoot 时抛 EDATADIR_UNRESOLVED（fail-closed，不回退到空目录）
 */
export function resolveDataDir({
  appRoot = '',
  packaged = false,
  suffix = '',
  envDir = process.env.QQ_AGENT_DATA_DIR
} = {}) {
  if (envDir) return path.resolve(String(envDir));
  if (!appRoot) {
    const err = new Error('无法解析数据目录：缺少 appRoot（拒绝回退到空目录）');
    err.code = 'EDATADIR_UNRESOLVED';
    throw err;
  }
  const dirName = `data${suffix}`;
  if (packaged) {
    // resources/app(.asar) → resources → 安装目录
    return path.resolve(appRoot, '..', '..', dirName);
  }
  return path.resolve(appRoot, dirName);
}

/**
 * 判断一个 ROOT 是否处于打包布局（resources/app 或 resources/app.asar）。
 * 用于 config.js 这种拿不到 Electron `app.isPackaged` 的模块。
 */
export function isPackagedRoot(appRoot) {
  const base = path.basename(String(appRoot || '')).toLowerCase();
  return base === 'app' || base === 'app.asar';
}

/**
 * 只读检查：目标数据目录是否可写；不可写时抛错（fail-closed）。
 * 不创建目录、不写任何文件。
 */
export function assertDataDirUsable(dir) {
  let st;
  try {
    st = fs.statSync(dir);
  } catch (e) {
    if (e?.code === 'ENOENT') {
      // 目录还不存在：检查父目录可写即可（不创建）
      try {
        fs.accessSync(path.dirname(dir), fs.constants.W_OK);
        return;
      } catch {
        const err = new Error(`数据目录不可用：父目录不可写（${path.dirname(dir)}）`);
        err.code = 'EDATADIR_UNUSABLE';
        throw err;
      }
    }
    const err = new Error(`数据目录不可用：${e?.message ?? e}`);
    err.code = 'EDATADIR_UNUSABLE';
    throw err;
  }
  if (!st.isDirectory()) {
    const err = new Error(`数据目录不是目录：${dir}`);
    err.code = 'EDATADIR_UNUSABLE';
    throw err;
  }
}
