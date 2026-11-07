// 她说话的行为指纹 —— 只读日志，不改任何运行逻辑。
//
// 为什么要有它：改人设/提示词之前得有个尺子。手册里那句「行为指纹优于用词指纹」
// 说的就是这件事：不要凭感觉判断"这次是不是更像人"，要有一组可复现的数。
//
// 三个原则（2026-10-28 和机主定的）：
//   1. 长度只做预警，不判人格质量 —— 认真回答时变长是好事，不是退化。
//   2. 示例句分两档：精确复现（逐字）只观察、不设目标；不自然复读（同模板反复）
//      才是要压的 —— 「晚安，老大」这种正常接话不算抄。
//   3. 绝不打印聊天原文（日志里有隐私）——只打指标和必要的脱敏样本。
//
// 用法：
//   node scripts/ai-tone-check.mjs                 # 近 7 天
//   node scripts/ai-tone-check.mjs --since 30d
//   node scripts/ai-tone-check.mjs --json          # 机器可读
//   node scripts/ai-tone-check.mjs --out data/ai-tone-baseline.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG_DIR = path.join(ROOT, 'data', 'logs');
const CONFIG = path.join(ROOT, 'data', 'config.json');

// ── 参数 ────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const sinceArg = (argv.find((a) => a.startsWith('--since=')) || '').split('=')[1]
  || (argv.includes('--since') ? argv[argv.indexOf('--since') + 1] : '')
  || '7d';
const asJson = argv.includes('--json');
const outArg = (argv.find((a) => a.startsWith('--out=')) || '').split('=')[1]
  || (argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '')
  || '';

function parseSince(s) {
  const m = /^(\d+)([dhm])$/.exec(String(s).trim());
  if (!m) return 7 * 86400000;
  const n = Number(m[1]);
  return n * (m[2] === 'd' ? 86400000 : m[2] === 'h' ? 3600000 : 60000);
}

// ── 读日志 ──────────────────────────────────────────────────────────────
/**
 * 日志行格式（2026-10 现状）：
 *   21:46:07 [INFO ] [app] [发送 -> private:1846383180] 内容
 * 日期只在文件名里，所以按文件名取日期，再拼上时间。
 */
function collectSends(sinceMs) {
  const cutoff = Date.now() - sinceMs;
  const rows = [];
  const files = fs.existsSync(LOG_DIR)
    ? fs.readdirSync(LOG_DIR).filter((f) => /^qq-agent-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort()
    : [];
  for (const file of files) {
    const day = file.replace(/^qq-agent-/, '').replace(/\.log$/, '');
    let text = '';
    try { text = fs.readFileSync(path.join(LOG_DIR, file), 'utf8'); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      const m = /^(\d{2}):(\d{2}):(\d{2}) \[[^\]]*\] \[[^\]]*\] \[发送 -> ([^\]]+)\]\s?(.*)$/.exec(line);
      if (!m) continue;
      const at = new Date(`${day}T${m[1]}:${m[2]}:${m[3]}+08:00`).getTime();
      if (!Number.isFinite(at) || at < cutoff) continue;
      const body = m[5].trim();
      if (!body) continue;
      rows.push({ at, day, chat: m[4].trim(), text: body });
    }
  }
  rows.sort((a, b) => a.at - b.at);
  return rows;
}

// ── 指标 ────────────────────────────────────────────────────────────────
const pct = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : 0);

/**
 * 去标点、去数字、压缩空白 —— 用于"模板"比较。
 *
 * 两个例外：
 *   1. 链接原样比 —— 小黑盒的帖子 ID 全在数字里，归一化成 # 会让不同帖子变成"同一句"。
 *   2. 占位符直接不算内容 —— 日志里「[表情包]」「[拍一拍]」只是类型标记，
 *      两个不同的表情包都会显示成 [表情包]，拿来判"复读"必然误报。
 */
const PLACEHOLDER = /^\[[^\]]{1,8}\]$/;

function normalize(s) {
  const t = String(s).trim();
  if (/^https?:\/\//i.test(t)) return t;
  return t
    .replace(/[\s，。！？、；：""''（）【】《》…~～,.!?;:()"']/g, '')
    .replace(/\d+/g, '#')
    .trim();
}

/** 开头骨架：前 4 个非标点字符。 */
function head4(s) {
  return normalize(s).slice(0, 4);
}

/** 长度分布。只做预警，不下结论。 */
function lengthStats(texts) {
  const lens = texts.map((t) => t.length).sort((a, b) => a - b);
  if (!lens.length) return { n: 0 };
  const at = (p) => lens[Math.min(lens.length - 1, Math.floor(lens.length * p))];
  const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
  return {
    n: lens.length,
    median: at(0.5),
    mean: Math.round(mean * 10) / 10,
    p90: at(0.9),
    max: lens[lens.length - 1],
    over30: lens.filter((x) => x > 30).length,
    over30Pct: pct(lens.filter((x) => x > 30).length, lens.length),
  };
}

/** 人设里的示例句：引号包起来的短句。太短的不算（「老大」「嗯」这种是称呼，不是台词）。 */
function personaExamples() {
  let roleText = '';
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    roleText = String(cfg?.persona?.roleText || '');
  } catch { return []; }
  const out = new Set();
  for (const m of roleText.matchAll(/[「“"]([^」”"]{2,40})[」”"]/g)) {
    const s = m[1].trim();
    // 少于 4 个字的多半是称呼/语气词（「老大」「嗯」「哪有」），命中率高但没有诊断意义
    if (s.length < 4) continue;
    // 否定语境里的引号句是**反面例子**，不是台词。
    // 例：「不能把「我记住了」「我做完了」当成实际执行成功」——这两句被当成示例会误报。
    const lineStart = roleText.lastIndexOf('\n', m.index) + 1;
    const linePrefix = roleText.slice(lineStart, m.index);
    if (/(不能|不要|别|禁止|不是)/.test(linePrefix)) continue;
    out.add(s);
  }
  return [...out];
}

/**
 * 示例句命中：两档。
 * - exact：回复里逐字出现某条示例
 * - normalized：去掉标点空格数字后仍相同（擦边复现）
 */
function exampleHits(texts, examples) {
  const exact = [];
  const normalized = [];
  for (const t of texts) {
    for (const e of examples) {
      if (t.includes(e)) { exact.push({ e, t }); break; }
    }
    const nt = normalize(t);
    for (const e of examples) {
      const ne = normalize(e);
      if (ne.length >= 4 && nt === ne) { normalized.push({ e, t }); break; }
    }
  }
  return { exact, normalized };
}

/**
 * 不自然复读：同一条会话里，连续 WINDOW 条内出现同一个"模板"两次及以上。
 * 只统计窗口内**相邻**的重复，避免把"隔了两小时又说了一次晚安"算进去。
 */
function repeatHits(rows, window = 3) {
  const hits = [];
  for (let i = 0; i < rows.length; i++) {
    if (PLACEHOLDER.test(rows[i].text.trim())) continue;   // 「[表情包]」不是内容
    const cur = normalize(rows[i].text);
    if (cur.length < 3) continue;
    for (let j = Math.max(0, i - window); j < i; j++) {
      if (rows[j].chat !== rows[i].chat) continue;
      if (normalize(rows[j].text) === cur) {
        hits.push({ at: rows[i].at, text: rows[i].text, prev: rows[j].text });
        break;
      }
    }
  }
  return hits;
}

/**
 * 同情境重复度：把间隔 < 5 分钟的连续消息当一段"情境"，
 * 算段内相邻两条的开头骨架相同率（衡量"自我传染"，比长度方差抗话题干扰）。
 */
function sameContextRepeat(rows, gapMs = 5 * 60 * 1000) {
  let pairs = 0;
  let same = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].chat !== rows[i - 1].chat) continue;
    if (rows[i].at - rows[i - 1].at > gapMs) continue;
    pairs += 1;
    if (head4(rows[i].text) && head4(rows[i].text) === head4(rows[i - 1].text)) same += 1;
  }
  return { pairs, same, pct: pct(same, pairs) };
}

/** 一轮发几条：间隔 < 10 秒的连续消息算同一轮。 */
function burstStats(rows, gapMs = 10 * 1000) {
  const bursts = [];
  let cur = 1;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].chat === rows[i - 1].chat && rows[i].at - rows[i - 1].at <= gapMs) cur += 1;
    else { bursts.push(cur); cur = 1; }
  }
  if (rows.length) bursts.push(cur);
  const avg = bursts.length ? bursts.reduce((a, b) => a + b, 0) / bursts.length : 0;
  return { turns: bursts.length, avgPerTurn: Math.round(avg * 10) / 10, max: bursts.length ? Math.max(...bursts) : 0 };
}

/** 七族 AI 味句式（手册第 6 节）。命中只说明"像那种句式"，不是判罪。 */
const FAMILIES = [
  ['A 自我评分', /这句(话)?(稳|接得漂亮|说得漂亮)|这话我不接|这句我记下了/],
  ['B 抽象度量', /比(刚才|之前|上次).{0,4}(重|稳|响|好|强)|分量(比|更)/],
  ['C 存档承诺', /我(记下|记上)了|抄上了|这话我留着|收不回(来)?/],
  ['D 旁白分析', /声音.{0,2}没抖|写在脸上|看得出来你|你心里(其实)?/],
  ['E 仪式退让', /我不(催|拦|管)你|你(自己)?掂量|随你(吧|便)/],
  ['F 取消指使', /那就别.{0,6}去(躺|睡|歇)/],
  ['G 强行收尾', /反正我(是|就)|换我我/],
];

function familyHits(texts) {
  return FAMILIES.map(([name, re]) => {
    const hit = texts.filter((t) => re.test(t));
    return { name, count: hit.length, pct: pct(hit.length, texts.length), sample: hit.slice(0, 2) };
  });
}

// ── H 族：自我状态播报（2026-10-31）─────────────────────────────────────
//
// 这一族**故意不做成"命中即问题"**：她说"我刚看到个东西"可能只是自然分享，
// 也可能是在汇报后台活动 —— 这只有看语境才知道，正则判不了。
// 所以脚本只做两件事：
//   ① 把候选（含时间/原文）存进 data/h-family-candidates.json，供人工标 verdict；
//   ② 读回标注，算「有效主动播报率」。
// 默认报告不打印正文：聊天记录不该出现在终端输出里。
//
// verdict 取值：report=主动汇报 | normal=自然分享 | reply=被问后回答 |
//               false=正则误报 | ''=未核实（默认）
const H_PATTERNS = [
  { id: '翻看', re: /我(?:刚才|之前|下午|今天|早上|晚上|昨天|昨晚|上午)?[^，。！？、\s]{0,10}(?:翻了|刷到|看到|逛了|挑了)/ },
  { id: '未完成', re: /我那个[^，。！？]{0,10}(?:还没|没)|我(?:还|一直)没(?:搜|看|弄|去)/ },
  { id: '产出', re: /我(?:刚才|之前|下午|今天|早上|晚上|昨天|昨晚|上午)[^，。！？、\s]{0,10}(?:画了|发了|记了|写了)/ }
];

function hCandidates(rows) {
  const out = [];
  for (const r of rows) {
    const text = String(r.text || '').trim();
    if (!text || /^\[[^\]]{1,8}\]$/.test(text)) continue;   // 表情包/拍一拍占位符不算
    const hit = H_PATTERNS.find((p) => p.re.test(text));
    if (!hit) continue;
    const d = new Date(r.at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
      + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    out.push({ key, at: r.at, chat: r.chat, text, pattern: hit.id });
  }
  return out;
}

/** 合并进候选文件：已存在的条目保留人工填的 verdict，只刷新原文和时间。 */
function mergeCandidates(hits) {
  const file = path.join(ROOT, 'data', 'h-family-candidates.json');
  let prev = [];
  try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 第一次跑 */ }
  const byKey = new Map(prev.filter((x) => x && x.key).map((x) => [x.key, x]));
  for (const h of hits) {
    const old = byKey.get(h.key);
    if (old) { old.text = h.text; old.chat = h.chat; old.pattern = h.pattern; }
    else byKey.set(h.key, { ...h, verdict: '' });
  }
  const list = [...byKey.values()].sort((a, b) => Number(a.at) - Number(b.at)).slice(-300);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
  } catch { /* 写不了不影响报告 */ }
  return list;
}

/** 把候选按人工 verdict 汇总成三个数字（规格 §2）。 */
function hStats(list, eligibleCount) {
  const tally = { report: 0, normal: 0, reply: 0, false: 0, blank: 0 };
  for (const x of list) {
    const v = String(x.verdict || '').trim();
    if (v in tally) tally[v] += 1; else tally.blank += 1;
  }
  const verified = tally.report + tally.normal + tally.reply + tally.false;
  return {
    candidates: list.length,
    verified,
    ...tally,
    eligible: eligibleCount,
    // 有效主动播报率：只拿人工确认过的「主动汇报」当分子
    ratePct: pct(tally.report, eligibleCount),
    thresholdPct: 2
  };
}

// ── 主流程 ──────────────────────────────────────────────────────────────
const rows = collectSends(parseSince(sinceArg));
const texts = rows.map((r) => r.text);
const examples = personaExamples();
const len = lengthStats(texts);
const ex = exampleHits(texts, examples);
const rep = repeatHits(rows);
const ctx = sameContextRepeat(rows);
const bursts = burstStats(rows);
const fams = familyHits(texts);
// H 族：候选进文件等人工标 verdict，报告只给数字（不打印聊天原文）
const hList = mergeCandidates(hCandidates(rows));
const hEligible = rows.filter((r) => {
  const t = String(r.text || '').trim();
  return t && !/^\[[^\]]{1,8}\]$/.test(t);
}).length;
const h = hStats(hList, hEligible);
const days = [...new Set(rows.map((r) => r.day))];

const warn = [];
if (len.n >= 30) {
  if (len.median < 8 || len.median > 18) warn.push(`中位字数 ${len.median} 偏离 12±3（只提示，不下结论）`);
  if (len.over30Pct > 8) warn.push(`>30 字占比 ${len.over30Pct}% 偏高（认真回答变长不算问题）`);
}
if (ctx.pct > 35 && ctx.pairs >= 20) warn.push(`同情境开头重复 ${ctx.pct}% 偏高（可能有自我传染）`);

const report = {
  generatedAt: new Date().toISOString(),
  since: sinceArg,
  range: days.length ? `${days[0]} ~ ${days[days.length - 1]}` : '(无样本)',
  samples: len.n,
  chats: [...new Set(rows.map((r) => r.chat))],
  length: len,
  examples: {
    total: examples.length,
    exactHits: ex.exact.length,
    exactPct: pct(ex.exact.length, len.n),
    normalizedHits: ex.normalized.length,
    normalizedPct: pct(ex.normalized.length, len.n),
  },
  repeats: { count: rep.length, pct: pct(rep.length, len.n) },
  sameContext: ctx,
  bursts,
  families: fams.map((f) => ({ name: f.name, count: f.count, pct: f.pct })),
  hFamily: h,
  warnings: warn,
};

if (outArg) {
  const p = path.isAbsolute(outArg) ? outArg : path.join(ROOT, outArg);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ ...report, repeatSamples: rep.slice(0, 20) }, null, 2), 'utf8');
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const line = (k, v) => console.log(`  ${k.padEnd(14, '　')}${v}`);
  console.log('\n=== 她说话的行为指纹 ===');
  line('样本', `${report.samples} 条 | ${report.range} | ${report.chats.join(', ') || '无'}`);
  console.log('\n【长度】只做预警，不判质量');
  line('中位/均值', `${len.median} 字 / ${len.mean}`);
  line('P90/最长', `${len.p90} / ${len.max}`);
  line('>30 字', `${len.over30} 条 (${len.over30Pct}%)`);
  line('每轮条数', `均 ${bursts.avgPerTurn} 条，最多 ${bursts.max}（共 ${bursts.turns} 轮）`);
  console.log('\n【示例句】精确复现只观察，不设目标');
  line('人设示例', `${examples.length} 条（≥4 字才算台词）`);
  line('逐字命中', `${report.examples.exactHits} 条 (${report.examples.exactPct}%)`);
  line('归一化命中', `${report.examples.normalizedHits} 条 (${report.examples.normalizedPct}%)`);
  line('不自然复读', `${rep.length} 条 (${report.repeats.pct}%) ← 这个才要压`);
  console.log('\n【同情境重复】间隔 <5 分钟为一段');
  line('开头骨架', `相同 ${ctx.same}/${ctx.pairs} 对 (${ctx.pct}%)`);
  console.log('\n【七族句式】');
  for (const f of fams) line(f.name, `${f.count} 条 (${f.pct}%)`);
  console.log('\n【H 自我状态播报】语境靠人判，正则只捞候选（不打印正文）');
  line('候选', `${h.candidates} 条 → data/h-family-candidates.json`);
  if (h.verified) {
    line('已核实', `${h.verified}/${h.candidates}：主动汇报 ${h.report}｜自然 ${h.normal}｜答问 ${h.reply}｜误报 ${h.false}`);
    line('主动播报率', `${h.report}/${h.eligible} = ${h.ratePct}%（预警线 ${h.thresholdPct}%）`);
  } else {
    line('核实状态', '尚未核实 —— 在候选文件里给每条填 verdict（report/normal/reply/false）再跑一次');
  }
  if (warn.length) {
    console.log('\n【预警】');
    for (const w of warn) console.log('  ⚠ ' + w);
  } else {
    console.log('\n【预警】无');
  }
  if (rep.length) {
    console.log('\n【不自然复读样本（不打印原文，只看形状）】');
    for (const r of rep.slice(0, 5)) {
      const kind = /^https?:/.test(r.text) ? '链接' : r.text.length <= 6 ? '短句' : '正文';
      console.log(`  · ${new Date(r.at).toLocaleString('zh-CN')}  ${kind}｜长度 ${r.text.length}`);
    }
  }
  console.log('');
}

if (outArg) console.log(`已写入 ${outArg}\n`);
