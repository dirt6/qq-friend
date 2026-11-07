// R8-0-A1 专项：统一数据目录解析。
//
// 覆盖：开发/打包/asar、env 覆盖、PROFILE 后缀、fail-closed、只算路径不建目录。
// 不读不写生产 data/。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChecker } from './_harness.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r80-datadir-'));
const c = createChecker('R8-0-A1 数据目录统一');

const { resolveDataDir, isPackagedRoot, assertDataDirUsable } = await import('../src/data-dir.js');

try {
  c.section('1. 开发模式：项目根/data');
  await c.check('appRoot=项目根 → 项目根/data', () => {
    const got = resolveDataDir({ appRoot: 'E:/proj', packaged: false, envDir: '' });
    if (got !== path.resolve('E:/proj/data')) throw new Error(got);
  });
  await c.check('PROFILE 后缀 → data-2', () => {
    const got = resolveDataDir({ appRoot: 'E:/proj', packaged: false, suffix: '-2', envDir: '' });
    if (got !== path.resolve('E:/proj/data-2')) throw new Error(got);
  });

  c.section('2. 打包模式：安装目录/data（resources/app 与 app.asar 一致）');
  {
    const install = 'C:/Program Files/QQ Agent';
    const fromApp = resolveDataDir({ appRoot: `${install}/resources/app`, packaged: true, envDir: '' });
    const fromAsar = resolveDataDir({ appRoot: `${install}/resources/app.asar`, packaged: true, envDir: '' });
    await c.check('resources/app → 安装目录/data', () => {
      if (fromApp !== path.resolve(`${install}/data`)) throw new Error(fromApp);
    });
    await c.check('resources/app.asar → 安装目录/data', () => {
      if (fromAsar !== path.resolve(`${install}/data`)) throw new Error(fromAsar);
    });
    await c.check('两种布局结果相同（Electron 与 Node 一致）', () => {
      if (fromApp !== fromAsar) throw new Error(`${fromApp} vs ${fromAsar}`);
    });
  }

  c.section('3. 显式覆盖优先');
  await c.check('QQ_AGENT_DATA_DIR 优先于推导', () => {
    const got = resolveDataDir({ appRoot: 'E:/proj', packaged: true, envDir: tmp });
    if (got !== path.resolve(tmp)) throw new Error(got);
  });

  c.section('4. fail-closed：缺 appRoot 不返回空目录');
  await c.check('缺 appRoot → 抛 EDATADIR_UNRESOLVED', () => {
    let code = '';
    try { resolveDataDir({ appRoot: '', packaged: false, envDir: '' }); } catch (e) { code = e.code; }
    if (code !== 'EDATADIR_UNRESOLVED') throw new Error(`code=${code}`);
  });

  c.section('5. isPackagedRoot 判定');
  await c.check('resources/app 与 app.asar 判定为打包', () => {
    if (!isPackagedRoot('C:/x/resources/app') || !isPackagedRoot('C:/x/resources/app.asar')) throw new Error('未识别');
  });
  await c.check('项目根不是打包布局', () => {
    if (isPackagedRoot('E:/dsh/QQ-agent')) throw new Error('误判为打包');
  });

  c.section('6. 只算路径、不创建目录');
  {
    const probe = path.join(tmp, 'never-created');
    resolveDataDir({ appRoot: probe, packaged: false, envDir: '' });
    await c.check('resolveDataDir 没有创建任何目录', () => {
      if (fs.existsSync(path.join(probe, 'data'))) throw new Error('创建了 data');
    });
  }

  c.section('7. assertDataDirUsable');
  {
    const okDir = path.join(tmp, 'ok');
    const badParent = path.join(tmp, 'no-such-parent', 'data');
    await c.check('父目录可写（目录尚不存在）→ 通过', () => {
      assertDataDirUsable(okDir);
    });
    await c.check('父目录不存在 → 抛 EDATADIR_UNUSABLE', () => {
      let code = '';
      try { assertDataDirUsable(badParent); } catch (e) { code = e.code; }
      if (code !== 'EDATADIR_UNUSABLE') throw new Error(`code=${code}`);
    });
  }

  c.section('8. config.js 的 DATA_DIR 走同一解析');
  {
    process.env.QQ_AGENT_DATA_DIR = tmp;
    const cfg = await import('../src/config.js');
    await c.check('DATA_DIR = 显式覆盖', () => {
      if (cfg.DATA_DIR !== path.resolve(tmp)) throw new Error(cfg.DATA_DIR);
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
} finally {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
}

process.exit(c.finish() ? 0 : 1);
