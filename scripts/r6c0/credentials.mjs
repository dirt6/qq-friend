// R6-C 实验凭据方案（4.0 / R6-C0-B）。
//
// ── 机主的硬要求 ────────────────────────────────────────────────
//   · 不要求用户在聊天、报告或命令行参数中粘贴 Key
//   · 日志必须脱敏
//   · 检查凭据是否存在，但**不输出凭据值**
//   · 实验脚本**默认拒绝在凭据缺失时退回生产配置**
//
// ── 三种合法来源（按优先级）─────────────────────────────────────
//   ① `QQ_R6C_DEEPSEEK_API_KEY` —— 实验专用环境变量（**推荐**）
//   ② `DEEPSEEK_API_KEY`        —— DSH 自己认的标准变量（如果实验环境已经隔离，也可以）
//   ③ 文件 `{实验根}/credentials/api-key` —— 用户自己放进去，脚本只读不写
//
// ── 明确拒绝的 ──────────────────────────────────────────────────
//   · 从生产 `data/dsh-home/.credentials.yaml` 读
//   · 从命令行参数传
//   · 从聊天/报告里粘贴
//   · 回退到 QQ-agent 的生产 config
//
// ── 脱敏规则 ────────────────────────────────────────────────────
//   · 任何日志里，Key 只显示为 `sk-****（长度 N）`
//   · 连前 4 位都不显示（避免拼接猜测）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * 从**用户级环境变量**读一个值（Windows 专用回退）。
 *
 * 为什么需要这个：
 *   Windows 进程在**启动那一刻**继承环境变量。机主设好之后，
 *   已经在跑的服务（DSH 的后台执行器）看不到新值 —— 除非重启那个服务。
 *   实测重启 DSH Web 也不一定管用（后端服务可能是长驻的）。
 *
 * 所以这里加一条**只针对 Windows** 的回退：直接读 HKCU\Environment。
 *
 * ⚠️ 它**只读用户级**，不读机器级、不读任何文件、不读生产凭据。
 *
 * @param {string} name
 * @returns {string} 没有就空串
 */
function readUserEnvFromRegistry(name) {
  if (process.platform !== 'win32') return '';
  try {
    // 用 reg query —— 不引入新依赖
    const out = execFileSync('reg', ['query', 'HKCU\\Environment', '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000
    });
    // 输出形如：    QQ_R6C_DEEPSEEK_API_KEY    REG_SZ    sk-xxxx
    const m = out.match(new RegExp(name + '\\s+REG_[A-Z_]+\\s+(.+)\\r?\\n'));
    return m ? String(m[1]).trim() : '';
  } catch {
    return '';
  }
}

/** 实验专用环境变量的名字（推荐用这个，和生产完全分开）。 */
export const EXPERIMENT_KEY_ENV = 'QQ_R6C_DEEPSEEK_API_KEY';

/** DSH 自己认的标准变量。 */
export const STANDARD_KEY_ENV = 'DEEPSEEK_API_KEY';

/** 凭据文件相对于实验根的位置（用户自己放，脚本只读）。 */
export const CREDENTIALS_SUBPATH = 'credentials/api-key';

/**
 * 把一个 Key 脱敏成可安全打印的形式。
 *
 * **不显示任何字符** —— 只给长度。这样连"前几位"的线索都不泄露。
 */
export function maskKey(key) {
  const s = String(key ?? '');
  if (!s) return '(空)';
  return `****（长度 ${s.length}）`;
}

/**
 * 检查凭据是否可用（**不返回 Key 本身**）。
 *
 * @param {object} dirs 实验环境目录（createExperiment 的 dirs）
 * @param {object} [o]
 * @param {boolean} [o.allowStandardEnv] 是否允许用 DEEPSEEK_API_KEY（默认 true）
 * @returns {{ok:boolean, source?:string, masked?:string, length?:number, error?:string, code?:string}}
 */
export function checkCredential(dirs, { allowStandardEnv = true } = {}) {
  // ⚠️ 前置：实验环境必须有效（防止在没隔离的环境里读凭据）
  if (!dirs || !dirs.root) {
    return { ok: false, code: 'NO_EXPERIMENT', error: '没有实验环境，拒绝检查凭据' };
  }

  // ① 实验专用变量（最优先）
  const v1 = String(process.env[EXPERIMENT_KEY_ENV] || '').trim();
  if (v1) {
    return {
      ok: true,
      source: EXPERIMENT_KEY_ENV,
      masked: maskKey(v1),
      length: v1.length
    };
  }

  // ② 标准变量（可选）
  if (allowStandardEnv) {
    const v2 = String(process.env[STANDARD_KEY_ENV] || '').trim();
    if (v2) {
      return {
        ok: true,
        source: STANDARD_KEY_ENV,
        masked: maskKey(v2),
        length: v2.length
      };
    }
  }

  // ②b **Windows 专用回退**：从用户级环境变量读
  //     （进程启动早于设置时，process.env 里看不到，但注册表里已经有了）
  {
    const fromReg = readUserEnvFromRegistry(EXPERIMENT_KEY_ENV);
    if (fromReg) {
      return {
        ok: true,
        source: EXPERIMENT_KEY_ENV + ':registry',
        masked: maskKey(fromReg),
        length: fromReg.length
      };
    }
  }

  // ③ 实验根下的凭据文件（用户自己放）
  const f = path.join(dirs.root, CREDENTIALS_SUBPATH);
  try {
    if (fs.existsSync(f)) {
      const v3 = fs.readFileSync(f, 'utf8').trim();
      if (v3) {
        return {
          ok: true,
          source: 'file:' + CREDENTIALS_SUBPATH,
          masked: maskKey(v3),
          length: v3.length
        };
      }
    }
  } catch { /* 读不了就当没有 */ }

  return {
    ok: false,
    code: 'NO_CREDENTIAL',
    error: [
      '没有找到实验凭据。',
      `请设置环境变量 ${EXPERIMENT_KEY_ENV}（推荐），`,
      `或 ${STANDARD_KEY_ENV}，`,
      `或把 Key 写进 {实验根}/${CREDENTIALS_SUBPATH}（自己创建，脚本只读）。`,
      '',
      '⚠️ 本脚本**不会**回退到生产配置，也不会读生产的 .credentials.yaml。'
    ].join('')
  };
}

/**
 * 取出凭据值（**只在真正要发请求时调用**）。
 *
 * ⚠️ 返回值**绝不能被日志、报告、异常信息捕获**。
 *   调用方用完立刻丢弃。
 *
 * @param {object} dirs
 * @param {object} [o]
 * @returns {{ok:boolean, value?:string, source?:string, error?:string, code?:string}}
 */
export function resolveCredential(dirs, { allowStandardEnv = true } = {}) {
  const chk = checkCredential(dirs, { allowStandardEnv });
  if (!chk.ok) return chk;

  let value = '';
  if (chk.source === EXPERIMENT_KEY_ENV) value = String(process.env[EXPERIMENT_KEY_ENV] || '').trim();
  else if (chk.source === STANDARD_KEY_ENV) value = String(process.env[STANDARD_KEY_ENV] || '').trim();
  else if (chk.source.startsWith('file:')) {
    try { value = fs.readFileSync(path.join(dirs.root, CREDENTIALS_SUBPATH), 'utf8').trim(); } catch { value = ''; }
  }

  if (!value) return { ok: false, code: 'NO_CREDENTIAL', error: '凭据读取失败' };
  return { ok: true, value, source: chk.source };
}

/**
 * 确认**没有**从生产路径读凭据。
 *
 * 这是一个显式的"自证清白"检查：如果实验里配置了指向生产凭据文件的路径，要报错。
 *
 * @param {object} dirs
 * @returns {{ok:boolean, error?:string}}
 */
export function assertNoProductionCredential(dirs) {
  if (!dirs || !dirs.root) return { ok: false, error: '没有实验环境' };

  // DSH 的凭据文件如果在 DSH_HOME 里，那实验的 DSH_HOME 必须是实验根下的
  const dshHome = String(process.env.DSH_HOME || '');
  if (!dshHome) return { ok: true };   // 没设就由调用方设成实验目录

  const resolved = path.resolve(dshHome);
  const expRoot = path.resolve(dirs.root);
  if (!(resolved === expRoot || resolved.startsWith(expRoot + path.sep))) {
    return {
      ok: false,
      error: `DSH_HOME 指向实验根之外（${resolved}）—— 可能读到生产凭据，拒绝继续`
    };
  }
  return { ok: true };
}

/**
 * 扫描一段文本，检查有没有泄露疑似 Key 的字符串。
 *
 * 用于**测试和自检**：报告/日志写出去之前过一遍。
 *
 * @param {string} text
 * @returns {{clean:boolean, hits:string[]}}
 */
export function scanForLeaks(text) {
  const s = String(text ?? '');
  const hits = [];
  // DeepSeek key 形如 sk-xxxx（长度 20+）
  const re = /\bsk-[A-Za-z0-9_-]{16,}\b/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    hits.push(m[0].slice(0, 6) + '...(' + m[0].length + ')');
  }
  return { clean: hits.length === 0, hits };
}

/** 凭据检查结果的一句话摘要（**永不包含 Key**）。 */
export function describeCredential(chk) {
  if (!chk.ok) return `凭据：未找到（${chk.code || '未知'}）`;
  return `凭据：找到（来源=${chk.source}，${chk.masked}）`;
}
