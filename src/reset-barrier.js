// reset 写入屏障（D1-3b-B4-3）。
//
// 目的：reset 删除 DATA_DIR 前，让**同一进程**的领域写入（diary / outbox / meta /
// chat store / memory / sessions / state-store）立即失败，而不是与删除并发。
//
// 诚实边界：
//   · 这是**协作式屏障**，不是内核级文件锁；只有接入了 assertWritesAllowed 的写入会被挡住。
//   · 未接入的写入不会被阻止，但 reset 的「删除前全量复核 / 删除后残留检查」会发现并中止
//     （fail-closed），不会把变化当成成功。
//   · 跨进程：屏障标记写在 backupRoot（DATA_DIR 之外），其他进程只有同样调用
//     isResetBarrierActive() 才会被挡住；标记带 pid，进程已死则视为失效（不会永久卡死）。
//   · 只用于 reset 这种“先停业务、再删除”的短窗口；不改变正常写入行为。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const HOST = process.env.COMPUTERNAME || process.env.HOSTNAME || '';
let active = null; // { opId, backupRoot, startedAt }

/** 进程是否存活（EPERM = 存在但无权限，算活着）。 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function markerPathOf(backupRoot) {
  return path.join(path.resolve(String(backupRoot)), '.reset-barrier.json');
}

function readMarker(backupRoot) {
  const file = markerPathOf(backupRoot);
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object' || !j.opId) return null;
    return { ...j, file };
  } catch {
    return null;
  }
}

/**
 * 开始屏障：写标记（DATA_DIR 之外）+ 设置进程内标记。
 * 若已有**存活**的屏障（本进程或其他进程）→ 拒绝，避免两个 reset 交叉。
 */
export function beginResetBarrier({ opId, backupRoot }) {
  const root = path.resolve(String(backupRoot || ''));
  if (!root) throw new Error('beginResetBarrier 缺少 backupRoot');
  if (active) {
    const e = new Error(`已有 reset 屏障在进行：${active.opId}`);
    e.code = 'ERESETBARRIERACTIVE';
    throw e;
  }
  const existing = readMarker(root);
  if (existing && pidAlive(existing.pid) && String(existing.pid) !== String(process.pid)) {
    const e = new Error(`另一个进程的 reset 屏障仍在生效（pid=${existing.pid}，op=${existing.opId}）`);
    e.code = 'ERESETBARRIERACTIVE';
    throw e;
  }
  const payload = {
    opId: String(opId || ''),
    pid: process.pid,
    startedAt: Date.now(),
    at: new Date().toISOString(),
    host: HOST,
    nonce: crypto.randomBytes(6).toString('hex')
  };
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(markerPathOf(root), JSON.stringify(payload), 'utf8');
  active = { opId: payload.opId, backupRoot: root, startedAt: payload.startedAt };
  return { ...active, file: markerPathOf(root) };
}

/** 结束屏障：清进程内标记 + 删标记文件（只删自己写的）。 */
export function endResetBarrier() {
  const current = active;
  active = null;
  if (!current) return { ok: true };
  try {
    const marker = readMarker(current.backupRoot);
    if (marker && String(marker.pid) === String(process.pid) && marker.opId === current.opId) {
      fs.unlinkSync(marker.file);
    }
  } catch { /* 标记清理失败不影响 reset 结果 */ }
  return { ok: true };
}

/**
 * 屏障是否生效：进程内标记，或 backupRoot 下存在“活进程”写的外部标记。
 * @param {string} [backupRoot] 跨进程检查时传入；不传只检查本进程。
 */
export function isResetBarrierActive(backupRoot = '') {
  if (active) return true;
  if (!backupRoot) return false;
  const marker = readMarker(backupRoot);
  return Boolean(marker && pidAlive(marker.pid));
}

/** 屏障信息（诊断/审计用）。 */
export function resetBarrierState(backupRoot = '') {
  if (active) return { active: true, source: 'process', ...active };
  if (backupRoot) {
    const marker = readMarker(backupRoot);
    if (marker && pidAlive(marker.pid)) return { active: true, source: 'marker', ...marker };
  }
  return { active: false };
}

/**
 * 领域写入的守卫：屏障生效时抛 ERESETBARRIER。
 * 调用点必须在真正读改写之前调用（不要先读旧值再检查）。
 */
export function assertWritesAllowed(what = '写入') {
  if (!active) return;
  const e = new Error(`reset 进行中，已阻止${what}（op=${active.opId}）；请等待重置完成`);
  e.code = 'ERESETBARRIER';
  throw e;
}

/** 非抛出版本：给期望 {ok:false} 而不是异常的调用方（如 state-store）。 */
export function blockedResult(what = '写入') {
  if (!active) return null;
  return {
    ok: false,
    code: 'ERESETBARRIER',
    error: `reset 进行中，已阻止${what}（op=${active.opId}）；请等待重置完成`
  };
}

export const __internals = { markerPathOf, readMarker, pidAlive };
