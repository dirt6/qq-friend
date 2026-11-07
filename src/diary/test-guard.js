// 日记写入的测试门禁（D1-2c-2c）。
//
// 只在测试启动器设置 DIARY_TEST_GUARD=1 时激活；生产运行不设该变量，行为不变。
//
// 规则（全部基于解析后的真实路径，不用字符串前缀）：
//   · 拒绝写生产 data 根及其子路径
//   · 拒绝写测试临时根之外的路径
//   · 拒绝含 `..` 的原始路径
//   · 解析失败（无法可靠确定真实路径）→ 拒绝
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = process.env.DIARY_TEST_PROJECT_ROOT
  ? path.resolve(process.env.DIARY_TEST_PROJECT_ROOT)
  : path.resolve(HERE, '..', '..');
const PROD_DATA = path.join(PROJECT_ROOT, 'data');

/** 解析真实路径：对不存在的路径，找最近存在的祖先 realpath 再拼剩余。 */
function realish(p) {
  const abs = path.resolve(String(p));
  let cur = abs;
  const rest = [];
  for (let i = 0; i < 64; i += 1) {
    try {
      const rp = fs.realpathSync.native(cur);
      return rest.length ? path.join(rp, ...rest.reverse()) : rp;
    } catch (e) {
      const code = e?.code;
      // 只有“这一级不存在/不是目录”才允许继续向上找祖先；
      // 权限、I/O 等错误必须 fail-closed，不能回退到未解析路径。
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw new Error(`EDiaryGuard: realpath 失败（${code ?? 'UNKNOWN'}）：${cur}`);
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
  throw new Error(`EDiaryGuard: 无法可靠解析路径（深度上限或根不可达）：${abs}`);
}

const norm = (p) => realish(p).replace(/[\\/]+/g, '\\').toLowerCase();
const isUnder = (child, parent) => child === parent || child.startsWith(parent + '\\');

/**
 * 测试模式下的写路径门禁；生产模式（未设 DIARY_TEST_GUARD=1）直接放行。
 * @param {string} p 即将写入的文件路径
 */
export function assertDiaryWritePath(p) {
  if (String(process.env.DIARY_TEST_GUARD || '') !== '1') return;

  const raw = String(p ?? '');
  if (!raw) throw new Error('EDiaryGuard: 空路径');
  if (raw.includes('..')) throw new Error(`EDiaryGuard: 拒绝含 .. 的路径：${raw}`);

  const testRoot = String(process.env.DIARY_TEST_TMP || '');
  if (!testRoot) throw new Error('EDiaryGuard: 未设置 DIARY_TEST_TMP（测试启动器缺失）');

  let target;
  try {
    target = norm(raw);
  } catch (e) {
    throw e instanceof Error ? e : new Error(`EDiaryGuard: 路径无法可靠解析：${raw}`);
  }
  const prod = norm(PROD_DATA);
  const root = norm(testRoot);

  if (isUnder(target, prod)) throw new Error(`EDiaryGuard: 拒绝写生产路径：${target}`);
  if (!isUnder(target, root)) throw new Error(`EDiaryGuard: 路径不在测试临时根内：${target}`);
}

export const __internals = { realish, norm, PROD_DATA };
