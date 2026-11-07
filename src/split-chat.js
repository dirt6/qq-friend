// 聊天分条（从 orchestrator 抽出，便于单测）。
//
// 2026-11-03 机主定的密度规则：
//   · 短句一次最多带一个逗号（两个逗号就切）
//   · 长句一次最多带一个句号（两个句号就切）
//
// 2026-11-05 机主补充：**成对的引号/括号不要拆到两条消息里**。
// 切分前先把 “…” / 「…」 / （…） 这类整体替换成占位符，切完再还原。

/**
 * 把成对引号/括号里的内容整体保护起来，避免在中间断句。
 * 只保护同一行内、长度合理的成对内容；不配对的引号不处理。
 */
const PAIR_RES = [
  /“([^”\n]{1,300})”/g,
  /"([^"\n]{1,300})"/g,
  /‘([^’\n]{1,300})’/g,
  /「([^」\n]{1,300})」/g,
  /『([^』\n]{1,300})』/g,
  /（([^）\n]{1,300})）/g,
  /\(([^)\n]{1,300})\)/g,
  /【([^】\n]{1,300})】/g
];

export function protectPairs(text) {
  const store = [];
  let s = String(text || '');
  for (const re of PAIR_RES) {
    s = s.replace(re, (m) => {
      const i = store.length;
      store.push(m);
      return `\u0000${i}\u0000`;
    });
  }
  return {
    text: s,
    restore: (t) => String(t).replace(/\u0000(\d+)\u0000/g, (_, i) => store[Number(i)] ?? '')
  };
}

function splitMasked(s) {
  // 短应答（「老大」「嗯」这种）去掉句末标点，别发成「老大。」
  const clean = (u) => {
    const core = u.replace(/[。！？!?…~，,；;]+$/g, '').trim();
    return core && core.length <= 4 ? core : u;
  };

  /**
   * 2026-11-03 机主定的密度规则：
   *   · **短句一次最多带一个逗号**（两个逗号就切）
   *   · **长句一次最多带一个句号**（两个句号就切）
   *
   * 判据：这一条里有没有句末标点。
   *   没有 → 它是「短句」，按逗号控制密度（≤1 个逗号）
   *   有   → 它是「长句」，按句号控制密度（≤1 个句号）
   */
  const enforceDensity = (unit) => {
    const hasSentenceEnd = /[。！？!?…~]/.test(unit);

    if (!hasSentenceEnd) {
      const commas = (unit.match(/[，,]/g) || []).length;
      if (commas <= 1) return [unit];

      // 机主：「一，二，三，四这样的发一条就可以」。列举不是两句话。
      const pieces = unit.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
      if (pieces.length >= 2 && pieces.every((x) => x.length <= 3)) return [unit];

      const segs = unit.split(/(?<=[，,])/).map((x) => x.trim()).filter(Boolean);
      const out = [];
      let buf = '';
      let bufCommas = 0;
      for (const seg of segs) {
        const c = (seg.match(/[，,]/g) || []).length;
        if (buf && bufCommas + c > 1) { out.push(buf); buf = seg; bufCommas = c; }
        else { buf += seg; bufCommas += c; }
      }
      if (buf) out.push(buf);
      return out.length ? out : [unit];
    }

    const ends = (unit.match(/[。！？!?…~]/g) || []).length;
    if (ends <= 1) return [unit];
    const segs = unit.split(/(?<=[。！？!?…~])/).map((x) => x.trim()).filter(Boolean);
    const out = [];
    let buf = '';
    let bufEnds = 0;
    for (const seg of segs) {
      const e = (seg.match(/[。！？!?…~]/g) || []).length;
      if (buf && bufEnds + e > 1) { out.push(buf); buf = seg; bufEnds = e; }
      else { buf += seg; bufEnds += e; }
    }
    if (buf) out.push(buf);
    return out.length ? out : [unit];
  };

  // ① 用了换行 → 按行分，再对每行做密度检查
  const lines = s.split(/\n+/).map((x) => x.trim()).filter(Boolean);
  if (lines.length >= 2) return lines.flatMap(enforceDensity).map(clean);

  // ② 没换行 → 先按句末标点切，再对每段做密度检查
  const bySentence = s.split(/(?<=[。！？!?…~])/).map((x) => x.trim()).filter(Boolean);
  if (bySentence.length >= 2) return bySentence.flatMap(enforceDensity).map(clean);

  // ③ 单句 → 做一次密度检查再发
  return enforceDensity(s).map(clean);
}

const ZERO_WIDTH = /[\u200B-\u200D\uFEFF\u2060]/g;

export function splitForChat(text) {
  // 2026-11-06：模型“不写字”时会输出零宽空格（U+200B），trim 去不掉，
  // 会变成一条“空字符”消息；这里统一清掉。
  const raw = String(text || '').replace(ZERO_WIDTH, '').trim();
  if (!raw) return [];
  const { text: masked, restore } = protectPairs(raw);
  return splitMasked(masked)
    .map((x) => restore(x))
    .filter((x) => String(x || '').replace(ZERO_WIDTH, '').trim().length > 0);
}

export default splitForChat;
