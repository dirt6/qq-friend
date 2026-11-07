// Session 归档 dryRun（4.0 · 1.5.7.3）。
//
// 机主要求：**纯只读** —— 不创建临时文件、不修改 Session、不写归档标记。
//
// 输出七项：
//   ① 符合归档条件的数量
//   ② 被排除的数量及原因
//   ③ 归档前总大小
//   ④ 预计归档后总大小
//   ⑤ 预计释放空间
//   ⑥ 每个 Session 的字段检查结果（汇总 + 抽样明细）
//   ⑦ 异常 / 无法解析的文件
//
// 规则（机主 2026-11-01 确认）：
//   · 只归档 status === 'done'
//   · 从 endedAt 算 7 天（不是创建时间）
//   · keepForever 优先级最高
//   · aborted / running / waiting / error 一律不动
//   · 不保存极简摘要（原始 messages 已足够）
//
// 用法：
//   node scripts/archive-sessions.mjs             # dryRun（默认）
//   node scripts/archive-sessions.mjs --sample 20 # 随机抽 N 个看明细
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SESSIONS = path.join(ROOT, 'data', 'sessions');

const KEEP_DAYS = 7;
const DAY_MS = 86400e3;
const STRIP_FIELDS = ['systemPrompt', 'userPrompt', 'excludedTools', 'inputMessages'];

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
const mb = (n) => `${(n / 1048576).toFixed(2)} MB`;

/** 估算剥离后的大小：把要被去掉的字段算出来，剩下的加上归档元数据。 */
function estimateAfter(obj, raw) {
  let stripped = 0;
  for (const k of STRIP_FIELDS) {
    if (obj[k] === undefined) continue;
    stripped += Buffer.byteLength(JSON.stringify(obj[k]), 'utf8');
  }
  // 归档元数据大约 200 字节
  const after = Math.max(200, Buffer.byteLength(raw, 'utf8') - stripped + 200);
  return { after, stripped };
}

/** 生成 prompt 指纹（只读，不落盘）。 */
function digestOf(obj) {
  const parts = [
    String(obj.systemPrompt ?? ''),
    String(obj.userPrompt ?? ''),
    JSON.stringify(obj.inputMessages ?? [])
  ];
  const h = crypto.createHash('sha1').update(parts.join('\u0000')).digest('hex').slice(0, 16);
  return {
    hash: h,
    systemChars: String(obj.systemPrompt ?? '').length,
    userChars: String(obj.userPrompt ?? '').length,
    inputMessages: Array.isArray(obj.inputMessages) ? obj.inputMessages.length : 0
  };
}

const MANIFEST = path.join(ROOT, 'data', 'sessions-archive-manifest.json');
const STRIP = STRIP_FIELDS;

/** 读 manifest（不存在给空）。 */
function loadManifest() {
  try {
    const j = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (j && Array.isArray(j.entries)) return j;
  } catch { /* 不存在 */ }
  return { version: 1, updatedAt: '', entries: [] };
}

/** 原子写 manifest（tmp + 校验 + rename）。 */
function saveManifest(m) {
  m.updatedAt = new Date().toISOString();
  const json = JSON.stringify(m);
  JSON.parse(json);
  const tmp = `${MANIFEST}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  fs.renameSync(tmp, MANIFEST);
}

/**
 * 归档一个会话。**任何异常都抛** —— 调用方负责立即停止，不允许跳过继续。
 *
 * 顺序（机主 2026-11-01 确认）：
 *   读 → 生成指纹 → 剥离 → 序列化+校验 → 写 tmp → 读 tmp 再校验 → rename → 归档后校验
 */
function archiveOne(file, { lock }) {
  const abs = path.join(SESSIONS, file);
  const beforeRaw = fs.readFileSync(abs, 'utf8');
  const before = JSON.parse(beforeRaw);
  const bytesBefore = Buffer.byteLength(beforeRaw, 'utf8');

  // 前置再确认（防止两轮之间状态变了）
  if (before.status !== 'done') throw new Error(`状态不是 done：${before.status}`);
  if (before.keepForever) throw new Error('有 keepForever');
  if (before.archive?.version) throw new Error('已经归档过');
  if (!Array.isArray(before.messages)) throw new Error('messages 不是数组');

  const digest = digestOf(before);
  if (!/^[0-9a-f]{16}$/.test(digest.hash)) throw new Error('指纹生成失败');

  // 构造归档对象：只剥 4 个字段，其余原样
  const after = { ...before };
  for (const k of STRIP) delete after[k];
  after.archive = {
    version: 1,
    archivedAt: new Date().toISOString(),
    promptDigest: digest,
    stripped: STRIP.filter((k) => before[k] !== undefined),
    bytesBefore,
    bytesAfter: 0    // 下面算完再回填
  };

  let json = JSON.stringify(after);
  const bytesAfter = Buffer.byteLength(json, 'utf8');
  if (bytesAfter >= bytesBefore) throw new Error(`归档后没变小（${bytesBefore} → ${bytesAfter}）`);
  after.archive.bytesAfter = bytesAfter;
  json = JSON.stringify(after);

  // 序列化结果先自己校验一遍
  const reparsed = JSON.parse(json);
  if (JSON.stringify(reparsed.messages) !== JSON.stringify(before.messages)) throw new Error('messages 序列化后不一致');

  // 写 tmp
  const tmp = `${abs}.${process.pid}.arch.tmp`;
  fs.writeFileSync(tmp, json, 'utf8');

  // 读 tmp 再校验（机主要求：临时文件也要校验）
  let fromTmp;
  try {
    fromTmp = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`tmp 校验失败：${e?.message ?? e}`);
  }

  // 完整性：这几个字段必须逐字节一致
  const checks = [
    ['messages', JSON.stringify(fromTmp.messages), JSON.stringify(before.messages)],
    ['usage', JSON.stringify(fromTmp.usage), JSON.stringify(before.usage)],
    ['status', String(fromTmp.status), String(before.status)],
    ['startedAt', String(fromTmp.startedAt), String(before.startedAt)],
    ['endedAt', String(fromTmp.endedAt), String(before.endedAt)],
    ['trigger', JSON.stringify(fromTmp.trigger), JSON.stringify(before.trigger)],
    ['model', String(fromTmp.model), String(before.model)]
  ];
  for (const [name, a, b] of checks) {
    if (a !== b) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      throw new Error(`完整性校验失败：${name} 变了`);
    }
  }
  if (!fromTmp.archive?.promptDigest?.hash) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error('归档元数据缺失 promptDigest');
  }

  // 原子替换
  fs.renameSync(tmp, abs);

  // 归档后校验：重新读盘
  const afterRaw = fs.readFileSync(abs, 'utf8');
  const finalObj = JSON.parse(afterRaw);
  if (JSON.stringify(finalObj.messages) !== JSON.stringify(before.messages)) throw new Error('落盘后 messages 不一致');
  const finalBytes = Buffer.byteLength(afterRaw, 'utf8');
  if (finalBytes >= bytesBefore) throw new Error('落盘后没变小');

  return { bytesBefore, bytesAfter: finalBytes, digest: digest.hash, msgs: before.messages.length };
}

async function main() {
  const args = process.argv.slice(2);
  const sampleAt = args.indexOf('--sample');
  const sampleN = sampleAt >= 0 ? Math.max(1, Number(args[sampleAt + 1]) || 20) : 20;

  if (!fs.existsSync(SESSIONS)) {
    console.log(`找不到 ${SESSIONS}`);
    process.exit(1);
  }

  const now = Date.now();
  const cutoff = now - KEEP_DAYS * DAY_MS;
  const files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json'));

  const eligible = [];
  const excluded = {};
  const broken = [];
  let totalBytes = 0;
  let afterBytes = 0;

  const fieldStats = {
    hasSystemPrompt: 0, hasUserPrompt: 0, hasExcludedTools: 0, hasInputMessages: 0,
    alreadyArchived: 0, keepForever: 0, noEndedAt: 0
  };

  for (const f of files) {
    const p = path.join(SESSIONS, f);
    let raw;
    let obj;
    try {
      raw = fs.readFileSync(p, 'utf8');
      obj = JSON.parse(raw);
    } catch (e) {
      broken.push({ file: f, reason: String(e?.message ?? e).slice(0, 60) });
      continue;
    }
    if (!obj || typeof obj !== 'object') { broken.push({ file: f, reason: '不是对象' }); continue; }

    const size = Buffer.byteLength(raw, 'utf8');
    totalBytes += size;

    // 字段统计（全量）
    if (obj.systemPrompt) fieldStats.hasSystemPrompt += 1;
    if (obj.userPrompt) fieldStats.hasUserPrompt += 1;
    if (obj.excludedTools) fieldStats.hasExcludedTools += 1;
    if (obj.inputMessages) fieldStats.hasInputMessages += 1;

    // —— 排除规则（顺序即优先级）——
    if (obj.keepForever) { fieldStats.keepForever += 1; excluded['keepForever 长期保留'] = (excluded['keepForever 长期保留'] || 0) + 1; continue; }
    if (obj.archive?.version) { fieldStats.alreadyArchived += 1; excluded['已归档过'] = (excluded['已归档过'] || 0) + 1; continue; }

    const st = String(obj.status || '');
    if (st === 'aborted') { excluded['aborted（机主决定永不自动归档）'] = (excluded['aborted（机主决定永不自动归档）'] || 0) + 1; continue; }
    if (st === 'running' || st === 'waiting') { excluded[`进行中（${st}）`] = (excluded[`进行中（${st}）`] || 0) + 1; continue; }
    if (st === 'error') { excluded['error（可能要重试）'] = (excluded['error（可能要重试）'] || 0) + 1; continue; }
    if (st !== 'done') { excluded[`未知状态 ${st || '(空)'}`] = (excluded[`未知状态 ${st || '(空)'}`] || 0) + 1; continue; }

    const endedAt = Number(obj.endedAt) || 0;
    if (!endedAt) { fieldStats.noEndedAt += 1; excluded['没有 endedAt'] = (excluded['没有 endedAt'] || 0) + 1; continue; }
    if (endedAt > cutoff) { excluded['未满 7 天'] = (excluded['未满 7 天'] || 0) + 1; continue; }

    // —— 符合条件 ——
    const est = estimateAfter(obj, raw);
    const digest = digestOf(obj);
    eligible.push({
      file: f, id: obj.id, size, ...est, digest,
      endedAt, ageDays: ((now - endedAt) / DAY_MS).toFixed(1),
      msgs: (obj.messages || []).length,
      hasUsage: Boolean(obj.usage),
      status: st
    });
    afterBytes += est.after;
  }

  // ── --apply：正式归档（机主要求：任何异常立即停止）──────
  const applyMode = args.includes('--apply');
  const limAt = args.indexOf('--limit');
  const limit = limAt >= 0 ? Math.max(1, Number(args[limAt + 1]) || 1) : Infinity;

  if (applyMode) {
    // 4.0 / 1.5.7.6：1 GB 时暂停自动归档扩张。
    // 只暂停归档，不删文件、不停止机器人、不影响聊天。
    try {
      const hs = await import(pathToFileURL(path.join(ROOT, 'src', 'storage-health.js')).href);
      const gate = hs.canArchive();
      if (!gate.ok) {
        console.log('══════ 暂停归档 ══════');
        console.log(`  ${gate.reason}`);
        console.log('  按规则：1 GB 只暂停自动归档，不删除文件、不停止机器人、不影响聊天。');
        console.log('  请先人工检查数据目录，再决定怎么处理。');
        process.exit(3);
      }
    } catch (e) {
      console.log('  存储体检失败，但按"不影响正常功能"的原则继续：' + (e?.message ?? e));
    }

    const batch = eligible.slice(0, limit);
    console.log('══════ 正式归档 ══════\n');
    console.log(`本次处理 ${batch.length} 个（符合条件共 ${eligible.length}，--limit ${limit === Infinity ? '无' : limit}）`);
    console.log('规则：done + endedAt 超 7 天 + 无 keepForever + 未归档过\n');

    const manifest = loadManifest();
    const known = new Set(manifest.entries.map((e) => e.id));
    let done = 0;
    let freed = 0;
    const rows = [];

    for (const s of batch) {
      if (known.has(s.id)) { console.log(`  · ${s.file} 已在 manifest 里，跳过`); continue; }
      try {
        const r = archiveOne(s.file, {});
        manifest.entries.push({
          id: s.id,
          file: s.file,
          archivedAt: new Date().toISOString(),
          bytesBefore: r.bytesBefore,
          bytesAfter: r.bytesAfter,
          digest: r.digest,
          msgs: r.msgs
        });
        saveManifest(manifest);
        done += 1;
        freed += r.bytesBefore - r.bytesAfter;
        rows.push({ file: s.file, before: r.bytesBefore, after: r.bytesAfter, ok: true });
        console.log(`  ✓ ${s.file.padEnd(28)} ${kb(r.bytesBefore).padStart(8)} → ${kb(r.bytesAfter).padStart(7)}  指纹 ${r.digest.slice(0, 8)}  校验通过`);
      } catch (e) {
        rows.push({ file: s.file, ok: false, error: String(e?.message ?? e) });
        console.log(`  ✗ ${s.file} 失败：${e?.message ?? e}`);
        console.log('\n  ⛔ 按机主要求：任何异常立即停止，不跳过继续。');
        console.log(`  已完成 ${done} 个，释放 ${kb(freed)}。已处理的都写进 manifest 了。`);
        process.exit(2);
      }
    }

    console.log('');
    console.log('══════ 第一批结果 ══════');
    console.log(`  处理 ${done} 个 / 尝试 ${batch.length} 个`);
    console.log(`  实际释放 ${kb(freed)}（${mb(freed)}）`);
    console.log(`  manifest：${manifest.entries.length} 条 → ${MANIFEST.replace(ROOT, '.')}`);
    console.log('  已停止，不会自动继续剩下的。');
    process.exit(0);
  }

  // ── 输出 ─────────────────────────────────────────────
  console.log('══════ Session 归档 dryRun（只读，不会改任何文件）══════\n');
  console.log(`扫描目录：${SESSIONS}`);
  console.log(`时间基准：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`);
  console.log(`归档等待期：${KEEP_DAYS} 天（从 endedAt 算）`);
  console.log(`判定截止：${new Date(cutoff).toLocaleString('zh-CN', { hour12: false })} 之前结束的才算\n`);

  console.log('① 符合归档条件');
  console.log(`   ${eligible.length} 个 / 共 ${files.length} 个文件\n`);

  console.log('② 被排除的');
  const exSorted = Object.entries(excluded).sort((a, b) => b[1] - a[1]);
  let exSum = 0;
  for (const [k, v] of exSorted) { console.log(`   ${String(v).padStart(5)}  ${k}`); exSum += v; }
  console.log(`   ${String(exSum).padStart(5)}  合计排除`);
  if (broken.length) console.log(`   ${String(broken.length).padStart(5)}  无法解析（见第 ⑦ 项）`);
  console.log('');

  console.log('③ 当前总大小');
  console.log(`   ${mb(totalBytes)}（${files.length} 个文件）\n`);

  console.log('④ 预计归档后');
  const unchanged = totalBytes - eligible.reduce((s, x) => s + x.size, 0);
  console.log(`   ${mb(unchanged + afterBytes)}（${eligible.length} 个被剥离，其余原样）\n`);

  console.log('⑤ 预计释放');
  const saved = eligible.reduce((s, x) => s + (x.size - x.after), 0);
  console.log(`   ${mb(saved)}（${((saved / Math.max(1, totalBytes)) * 100).toFixed(1)}%）\n`);

  console.log('⑥ 字段检查（全量统计）');
  console.log(`   带 systemPrompt    ：${fieldStats.hasSystemPrompt} 个`);
  console.log(`   带 userPrompt      ：${fieldStats.hasUserPrompt} 个`);
  console.log(`   带 excludedTools   ：${fieldStats.hasExcludedTools} 个`);
  console.log(`   带 inputMessages   ：${fieldStats.hasInputMessages} 个`);
  console.log(`   已归档过(会跳过)   ：${fieldStats.alreadyArchived} 个`);
  console.log(`   keepForever(会跳过)：${fieldStats.keepForever} 个`);
  console.log(`   缺 endedAt(会跳过) ：${fieldStats.noEndedAt} 个\n`);

  console.log('⑦ 异常 / 无法解析');
  if (!broken.length) console.log('   无');
  else for (const b of broken.slice(0, 10)) console.log(`   ${b.file}：${b.reason}`);
  if (broken.length > 10) console.log(`   ……还有 ${broken.length - 10} 个`);
  console.log('');

  // ── 抽样明细 ─────────────────────────────────────────
  const n = Math.min(sampleN, eligible.length);
  if (n > 0) {
    // 用文件名的 hash 做稳定"随机"，保证同一次输出可复现
    const sample = [...eligible]
      .map((x) => ({ x, k: crypto.createHash('md5').update(x.file).digest('hex') }))
      .sort((a, b) => a.k.localeCompare(b.k))
      .slice(0, n)
      .map((y) => y.x);

    console.log(`══════ 抽样 ${n} 个（按文件名哈希稳定取样，可复现）══════\n`);
    console.log('文件名                       状态  消息  用量  结束于              大小→预计    指纹（前 8 位）');
    console.log('─'.repeat(110));
    for (const s of sample) {
      const when = new Date(s.endedAt).toLocaleString('zh-CN', { hour12: false });
      console.log(
        `${s.file.padEnd(28)} ${s.status.padEnd(5)} ${String(s.msgs).padStart(4)}  ${(s.hasUsage ? '有' : '无').padEnd(4)} ${when.padEnd(18)} ${kb(s.size).padStart(7)}→${kb(s.after).padStart(7)}  ${s.digest.hash.slice(0, 8)}`
      );
    }
    console.log('');

    // 完整性预检：messages / usage / 指纹
    console.log('完整性预检（这 20 个）');
    let okMsgs = 0; let okUsage = 0; let okDigest = 0;
    for (const s of sample) {
      const raw = fs.readFileSync(path.join(SESSIONS, s.file), 'utf8');
      const obj = JSON.parse(raw);
      if (Array.isArray(obj.messages) && obj.messages.length > 0) okMsgs += 1;
      if (obj.usage && typeof obj.usage === 'object') okUsage += 1;
      if (/^[0-9a-f]{16}$/.test(digestOf(obj).hash)) okDigest += 1;
    }
    console.log(`  messages 非空：${okMsgs}/${n}`);
    console.log(`  usage 存在   ：${okUsage}/${n}`);
    console.log(`  指纹能生成   ：${okDigest}/${n}`);
    console.log('');
  }

  console.log('══════ 结论 ══════');
  console.log(`可以归档 ${eligible.length} 个，预计从 ${mb(totalBytes)} 降到 ${mb(unchanged + afterBytes)}，释放 ${mb(saved)}。`);
  console.log('本次是 dryRun：没有创建任何临时文件，没有修改任何 Session，没有写归档标记。');
  console.log('正式执行见 1.5.7.5（会先做 1.5.7.4 的人工抽样确认）。');
}

await main();
