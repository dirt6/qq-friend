// B6：四条历史误分类 Goal 的一次性维护（4.0 / 2.6-B6）。
//
// 机主 2026-11-02 逐条确认：
//   · 四条全部 cancelled，不区分 g-legacy-1
//   · 一条一条执行，按创建时间：g-legacy-1 → g-ce9d75 → g-ec778f → g-bda0fa
//   · 任何一条失败就暂停，不继续后面的
//   · 备份用独立时间戳文件名（不覆盖已有备份）
//   · **必须走正式取消接口**，不能直接改 JSON 绕过状态机
//   · 原因统一，原文/ID/since/source/原有 history 全部保留
//
// 用法：
//   node scripts/b6-maintain-legacy-goals.mjs            # 演练（不写盘）
//   node scripts/b6-maintain-legacy-goals.mjs --live     # 真跑
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = 'E:/dsh/QQ-agent';
process.chdir(ROOT);
process.env.QQ_AGENT_DATA_DIR = path.join(ROOT, 'data');

const LIVE = process.argv.includes('--live');
const CS = path.join(ROOT, 'data', 'companion-state.json');
const CONFIG = path.join(ROOT, 'data', 'config.json');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const LOG_FILE = path.join(ROOT, 'data', 'b6-maintenance.log');

const REASON = 'misclassified_legacy_goal：2.6-A 之前 decision.goal（Action Objective）被误当成长期 Goal';

/** 按创建时间排序的四条。 */
const TARGETS = ['g-legacy-1', 'g-ce9d75', 'g-ec778f', 'g-bda0fa'];

function log(line) {
  const s = `[${new Date().toISOString()}] ${line}`;
  console.log(s);
  if (LIVE) {
    try { fs.appendFileSync(LOG_FILE, s + '\n', 'utf8'); } catch { /* ignore */ }
  }
}

/** 独立时间戳文件名：不覆盖已有备份。 */
function backupPath() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-`
    + `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-`
    + `${pad(d.getMilliseconds(), 3)}`;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  let p = path.join(BACKUP_DIR, `companion-state.b6-${stamp}.json`);
  // 极端情况下同毫秒重名 → 加后缀，绝不覆盖
  let i = 1;
  while (fs.existsSync(p)) {
    p = path.join(BACKUP_DIR, `companion-state.b6-${stamp}-${i}.json`);
    i += 1;
  }
  return p;
}

function readJson(f) { return JSON.parse(fs.readFileSync(f, 'utf8')); }

async function main() {
  log(`=== B6 维护开始（${LIVE ? 'LIVE 真跑' : '演练，不写盘'}）===`);

  // ── ① 暂停自主写入（避免备份和修改期间竞争）──
  const cfg = readJson(CONFIG);
  const wasEnabled = cfg.skills?.autonomous?.enabled;
  log(`① autonomous.enabled 当前 = ${wasEnabled}`);
  if (LIVE && wasEnabled !== false) {
    cfg.skills.autonomous.enabled = false;
    fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    log('   已暂停自主写入（维护结束后恢复）');
  }

  try {
    // ── ② 备份 ──
    const before = fs.readFileSync(CS, 'utf8');
    const bp = backupPath();
    if (LIVE) {
      // 排他创建：'wx' 存在就报错，不会覆盖
      fs.writeFileSync(bp, before, { encoding: 'utf8', flag: 'wx' });
      const back = fs.readFileSync(bp, 'utf8');
      if (back !== before) throw new Error('备份内容与原文件不一致');
      log(`② 备份完成：${path.basename(bp)}（${before.length} 字节，读回一致）`);
    } else {
      log(`② [演练] 会备份到 ${path.basename(bp)}`);
    }

    // ── ③ 逐条取消 ──
    const cs = await import(pathToFileURL(path.join(ROOT, 'src', 'companion', 'state.js')).href);

    const before_state = cs.readCompanion();
    const expect = new Map(TARGETS.map((id) => [id, before_state.goals.find((g) => g.id === id)]));
    for (const id of TARGETS) {
      const g = expect.get(id);
      if (!g) throw new Error(`找不到 ${id}，停止`);
      if (!g.text) throw new Error(`${id} 没有文本，停止`);
      log(`   检查 ${id}：${g.status} / ${g.text}`);
    }

    const results = [];
    for (const id of TARGETS) {
      const g0 = expect.get(id);
      log(`③ 取消 ${id}（${g0.text}）…`);
      const r = cs.cancelGoal(id, { by: 'user_directed', reason: REASON });
      if (!r || r.ok !== true) {
        log(`   ✗ 失败：${JSON.stringify(r)}`);
        throw new Error(`${id} 取消失败：${r?.error || r?.code || 'unknown'}`);
      }
      log(`   ✓ ok（code=${r.code || '-'}）`);

      // 逐条验证
      const st = cs.readCompanion();
      const g = st.goals.find((x) => x.id === id);
      if (!g) throw new Error(`${id} 取消后找不到`);
      if (g.status !== 'cancelled') throw new Error(`${id} 状态不是 cancelled（${g.status}）`);
      if (!String(g.reason || '').includes('misclassified_legacy_goal')) {
        throw new Error(`${id} reason 没写上：${g.reason}`);
      }
      const hLen = (g.history || []).length;
      if (hLen < 1) throw new Error(`${id} 没有 history 记录`);
      const last = g.history[g.history.length - 1];
      if (last.to !== 'cancelled') throw new Error(`${id} 最后一条 history 不是 cancelled`);
      log(`   ✓ 验证：status=cancelled  reason=已写  history=${hLen} 条（最后 ${last.from}→${last.to}）`);
      results.push({ id, text: g.text, historyLen: hLen, by: last.by });
    }

    // ── ④ 全部完成后重新读取验证 ──
    const after = cs.readCompanion();
    log('④ 最终状态');
    for (const id of TARGETS) {
      const g = after.goals.find((x) => x.id === id);
      log(`   ${id}: ${g.status}  ${String(g.text).slice(0, 30)}`);
    }
    const active = after.goals.filter((g) => g.status === 'active').length;
    const paused = after.goals.filter((g) => g.status === 'paused').length;
    const cancelled = after.goals.filter((g) => g.status === 'cancelled').length;
    log(`   统计：active=${active}  paused=${paused}  cancelled=${cancelled}  总数=${after.goals.length}`);

    // 不只看数量：四条确实存在且状态正确
    for (const id of TARGETS) {
      const g = after.goals.find((x) => x.id === id);
      if (!g) throw new Error(`最终验证：${id} 不见了`);
      if (g.status !== 'cancelled') throw new Error(`最终验证：${id} 状态是 ${g.status}`);
    }
    log('   ✓ 四条都在，都是 cancelled');

    // 其它字段没被意外改动
    const before_raw = JSON.parse(before);
    const after_raw = JSON.parse(fs.readFileSync(CS, 'utf8'));
    const keys = new Set([...Object.keys(before_raw), ...Object.keys(after_raw)]);
    const changed = [];
    for (const k of keys) {
      if (k === 'goals' || k === 'updatedAt' || k === '_v' || k === '_updatedAt') continue;
      if (JSON.stringify(before_raw[k]) !== JSON.stringify(after_raw[k])) changed.push(k);
    }
    if (changed.length) throw new Error(`意外改动了这些字段：${changed.join(', ')}`);
    log(`   ✓ 其它顶层字段未变（pending=${(after_raw.pending || []).length}，topic=${after_raw.topic ? '有' : '无'}）`);

    log(`=== B6 维护完成：4 条全部 cancelled ===`);
    return results;
  } finally {
    // ── ⑤ 恢复自主写入 ──
    if (LIVE) {
      const c2 = readJson(CONFIG);
      if (c2.skills?.autonomous) {
        c2.skills.autonomous.enabled = wasEnabled === true;
        fs.writeFileSync(CONFIG, JSON.stringify(c2, null, 2) + '\n', 'utf8');
        log(`⑤ 恢复 autonomous.enabled = ${c2.skills.autonomous.enabled}`);
      }
    }
  }
}

main().then((r) => {
  console.log('\n结果：');
  for (const x of r) console.log(`  ${x.id}  history=${x.historyLen}  by=${x.by}`);
  process.exit(0);
}).catch((e) => {
  console.error('\n[失败] ' + (e?.message || e));
  process.exit(1);
});
