// R8-0-A3 专项：所有启动入口接入同一守门 / 同一 DATA_DIR。
//
// 静态检查 + 轻量运行时检查；不启动真实实例、不占生产 3210。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createChecker } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const c = createChecker('R8-0-A3 入口一致性');

try {
  c.section('1. 核心入口都走统一 DATA_DIR 解析');
  {
    const mainSrc = read('electron/main.js');
    const cfgSrc = read('src/config.js');
    await c.check('electron/main.js 使用 resolveDataDir（不再自算 data）', () => {
      if (!mainSrc.includes('resolveDataDir')) throw new Error('未使用');
      if (/path\.join\(path\.dirname\(app\.getPath\('exe'\)\)/.test(mainSrc)) throw new Error('仍有 exe 旁 data 旧推导');
    });
    await c.check('config.js 使用 resolveDataDir', () => {
      if (!cfgSrc.includes('resolveDataDir')) throw new Error('未使用');
    });
    await c.check('8899 面板文件已删除（不再是第二入口）', () => {
      if (fs.existsSync(path.join(ROOT, 'scripts/web-panel-server.mjs'))) throw new Error('仍存在');
    });
  }

  c.section('2. 快速启动器按 PROFILE 定位 config / lock');
  {
    const ps1 = read('快速启动人设.ps1');
    await c.check('ps1 计算 DataDir（env 或 data{-PROFILE}）', () => {
      if (!ps1.includes('$ProfileSuffix') || !ps1.includes('$DataDir')) throw new Error('缺少 DataDir');
    });
    await c.check('ConfigPath 与 LockFile 都指向 DataDir', () => {
      if (!ps1.includes("Join-Path $DataDir 'config.json'")) throw new Error('ConfigPath 未改');
      if (!ps1.includes("Join-Path $DataDir 'qq-agent.lock'")) throw new Error('LockFile 未改');
    });
    await c.check('没有残留 Join-Path $Root \'data\\...\'', () => {
      if (ps1.includes("Join-Path $Root 'data\\config.json'")) throw new Error('残留 config 路径');
      if (ps1.includes("Join-Path $Root 'data\\qq-agent.lock'")) throw new Error('残留 lock 路径');
    });
  }

  c.section('3. 启动入口最终都汇聚到 createApp/start');
  {
    const bats = ['启动QQ机器人.bat', '快速启动.bat'];
    for (const b of bats) {
      await c.check(`${b} 不自行设置端口/数据目录`, () => {
        const s = read(b);
        if (/QQ_AGENT_PORT|QQ_AGENT_DATA_DIR|--port/i.test(s)) throw new Error('bat 里出现端口/目录覆盖');
      });
    }
    await c.check('8899 的启动入口已删除（启动控制面板.bat）', () => {
      if (fs.existsSync(path.join(ROOT, '启动控制面板.bat'))) throw new Error('仍存在');
    });
    await c.check('server.js 调 createApp + start', () => {
      const s = read('src/server.js');
      if (!s.includes('createApp') || !s.includes('.start(')) throw new Error('未接入');
    });
  }

  c.section('4. 守门与锁职责分离');
  {
    const appSrc = read('src/app.js');
    const lockSrc = read('src/instance-lock.js');
    await c.check('app.js 无端口顺延', () => {
      if (/basePort\s*\+\s*10/.test(appSrc) || /for\s*\(let p = basePort/.test(appSrc)) throw new Error('仍有顺延');
    });
    await c.check('listen 成功后才 acquireInstanceLock', () => {
      const a = appSrc.indexOf('await listenExclusive(');
      const b = appSrc.indexOf('const lockResult = acquireInstanceLock()');
      if (a < 0 || b < 0 || a > b) throw new Error(`${a} vs ${b}`);
    });
    await c.check('instance-lock 只诊断，不杀进程', () => {
      if (/process\.kill\(\s*pid\s*,\s*['"]SIG/.test(lockSrc)) throw new Error('仍有终止调用');
      if (!lockSrc.includes('diagnoseSiblings')) throw new Error('缺诊断函数');
    });
    await c.check('releaseInstanceLock 仍校验所有权', () => {
      if (!lockSrc.includes('Number(content) === process.pid')) throw new Error('缺所有权校验');
    });
  }

  c.section('5. 同一 PROFILE 的端口/目录/锁三者对应');
  {
    const profile = read('src/profile.js');
    await c.check('portOffset = (PROFILE-1)*100', () => {
      if (!/\(Number\(PROFILE_ID\) - 1\) \* 100/.test(profile)) throw new Error('公式不符');
    });
    await c.check('dataDirName = data + suffix', () => {
      if (!/data\$\{profileSuffix\(\)\}/.test(profile)) throw new Error('目录公式不符');
    });
    await c.check('锁文件在 DATA_DIR 下（随 PROFILE）', () => {
      const lockSrc = read('src/instance-lock.js');
      if (!lockSrc.includes("path.join(DATA_DIR, 'qq-agent.lock')")) throw new Error('锁路径不在 DATA_DIR');
    });
  }
} catch (e) {
  c.bad('测试执行不抛异常', e);
}

process.exit(c.finish() ? 0 : 1);
