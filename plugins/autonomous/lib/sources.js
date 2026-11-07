// 内容来源适配器。
//
// 设计约束（来自机主的明确要求）：
//   · 只用**无需登录**就能拿到的公开内容；不伪造登录态、不绕验证码、不猜内部接口。
//   · 每个来源独立配置入口、超时、最小间隔、解析器版本，并各自记录「最近一次成功时间」。
//   · 失败（401/403/429/验证码/登录墙/结构变化/空结果）只记一笔并跳过，不重试到失控；
//     一个来源失败不影响整轮，其它来源照常跑；全失败就以「本轮无新内容」结束。
//
// 关于「为什么用 API 不用网页」——2026-10-20 实测（未登录、无 Cookie、普通 UA）：
//   · https://www.bilibili.com/v/popular/rank/all  → 200，但只有 4.9KB 骨架页（_GreyResult 灰度脚本），
//     真实列表由前端接口异步拉取，纯 HTML 拿不到条目；
//   · https://www.bilibili.com/                    → 200，166KB，可解析但混着大量推荐位/广告位；
//   · https://api.bilibili.com/x/web-interface/ranking/v2 → 200，167KB JSON，code:0，字段完整；
//   · https://api.bilibili.com/x/web-interface/popular    → 200，33KB JSON，code:0；
//   · https://www.xiaoheihe.cn/                    → 200，3.5KB，是 SPA 骨架（static.max-c.com 的
//     webapp 壳），页面内容全部由 JS + 签名接口渲染，匿名静态抓取拿不到任何条目。
// 所以 B 站用公开 JSON 接口（一样不需要登录、不需要签名），小黑盒第一版标记为不可用。

import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XhhClient } from './xhh/client.js';
import { BiliClient } from './bili/api.js';

const execFileP = promisify(execFile);

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 本文件在 plugins/autonomous/lib/ 下，往上三层就是项目根。 */
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const DATA_DIR = path.resolve(HERE, '..', '..', '..', 'data');
const XHH_AUTH_FILE = path.join(DATA_DIR, 'xhh-auth.json');

/** 从各种形态的 B 站链接里抽出 BV/av 号，用作去重键。 */
export function contentKeyOf(item) {
  if (item?.contentId) return `${item.source}:${item.contentId}`;
  const url = String(item?.url ?? '');
  const bv = url.match(/\/video\/(BV[0-9A-Za-z]+)/);
  if (bv) return `bili:${bv[1]}`;
  const av = url.match(/\/video\/av(\d+)/i);
  if (av) return `bili:av${av[1]}`;
  return `${item?.source ?? 'unknown'}:${url}`;
}

/**
 * 内容安全过滤（程序侧，不花 token）。
 * 排行榜里偶尔会冒出成人科普、赌博、诈骗之类的内容——B 站自己合规，不代表适合她转发。
 * 命中就直接不进入候选，也不记入 seen（下次出现还会再判一次）。
 */
export const UNSAFE_PATTERN = /(成人内容|色情|淫秽|约炮|裸聊|赌博|博彩|赌球|毒品|冰毒|海洛因|代孕|洗钱|诈骗|传销|枪支|恐怖主义)/;

export function isSafeCandidate(item) {
  const text = [item?.title, item?.summary, ...(Array.isArray(item?.tags) ? item.tags : [])].filter(Boolean).join(' ');
  return !UNSAFE_PATTERN.test(text);
}

/** 把接口返回的一条原始数据归一成统一结构（只保留判断需要的最小字段）。 */
export function normalizeBili(raw, sourceId = 'bili-rank') {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = String(raw.bvid ?? '').trim();
  const aid = raw.aid ? String(raw.aid) : '';
  if (!bvid && !aid) return null;
  const url = bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`;
  const title = String(raw.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const desc = String(raw.desc ?? '').replace(/\s+/g, ' ').trim();
  const stat = raw.stat || {};
  const view = Number(stat.view);
  return {
    source: sourceId,
    contentId: bvid || `av${aid}`,
    url,
    title: title.slice(0, 120),
    tags: raw.tname ? [String(raw.tname).slice(0, 20)] : [],
    // 摘要只留一小段：默认不把整页正文喂给模型（用户明确要求）
    summary: desc.slice(0, 160),
    publishedAt: Number(raw.pubdate) > 0 ? new Date(Number(raw.pubdate) * 1000).toISOString().slice(0, 10) : '',
    stats: Number.isFinite(view) && view > 0 ? { view } : undefined
  };
}

/** 解析排行榜接口（ranking/v2）。 */
export function parseRanking(json) {
  if (!json || json.code !== 0) return { ok: false, error: `接口返回 code=${json?.code ?? '?'} ${json?.message ?? ''}`.trim() };
  const list = json?.data?.list;
  if (!Array.isArray(list)) return { ok: false, error: '响应里没有 data.list' };
  const items = list.map((x) => normalizeBili(x, 'bili-rank')).filter(Boolean);
  return { ok: true, items };
}

/** 解析热门接口（popular）。 */
export function parsePopular(json) {
  if (!json || json.code !== 0) return { ok: false, error: `接口返回 code=${json?.code ?? '?'} ${json?.message ?? ''}`.trim() };
  const list = json?.data?.list;
  if (!Array.isArray(list)) return { ok: false, error: '响应里没有 data.list' };
  const items = list.map((x) => normalizeBili(x, 'bili-popular')).filter(Boolean);
  return { ok: true, items };
}

/**
 * 判断 HTTP 状态/正文是否属于「该跳过」的情况。
 * 401/403/429、验证码/风控页、登录墙都算——按设计记一笔就换下一个来源。
 */
export function classifyHttpFailure(status, text = '') {
  if (status === 401) return '需要登录（401）';
  if (status === 403) return '被拒绝（403，可能有风控）';
  if (status === 429) return '请求过快（429），本轮不再碰这个来源';
  if (status >= 500) return `对方服务异常（${status}）`;
  const head = String(text).slice(0, 600);
  if (/captcha|验证码|人机验证|访问受限|安全验证/i.test(head)) return '触发验证码/风控页';
  if (/登录后|请先登录|login required/i.test(head)) return '登录墙';
  return '';
}

/**
 * 通用 JSON 抓取：超时、单次尝试、返回结构化结果（不抛异常，失败也是一种结果）。
 * 注意：这里没有重试循环。`retry` 只是为了区分「瞬断要不要补一次」，默认 0。
 */
export async function fetchJson(fetchImpl, url, { timeoutMs = 12000, retry = 0, headers = {} } = {}) {
  let lastError = '';
  for (let attempt = 0; attempt <= retry; attempt += 1) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ac?.abort(), Math.max(2000, Number(timeoutMs) || 12000));
    try {
      const res = await fetchImpl(url, {
        headers: {
          'user-agent': BROWSER_UA,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'zh-CN,zh;q=0.9',
          // B 站接口对空 referer 偶发 -412，带一个站内来源更稳
          referer: 'https://www.bilibili.com/',
          ...headers
        },
        redirect: 'follow',
        signal: ac?.signal
      });
      const text = await res.text();
      const bad = classifyHttpFailure(res.status, text);
      if (bad) return { ok: false, status: res.status, error: bad };
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, status: res.status, error: `不是合法 JSON（${text.length} 字节）` };
      }
      return { ok: true, status: res.status, json };
    } catch (e) {
      lastError = e?.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(e?.message ?? e);
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, status: 0, error: lastError || '未知网络错误' };
}

/* ── B 站搜索（第一步：独立搜索能力）──────────────────────────────────
 * 2026-10-21 实测（未登录、无 Cookie、普通 UA）：
 *   GET https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=钓鱼
 *   → 200, code:0, 20 条，字段含 bvid/title/description/author/play/pubdate/tag
 * 不需要 wbi 签名，也不需要登录。nav 接口返回 -101（未登录）但 wbi_img 照样给，
 * 所以哪天旧接口被收紧，还能补一个 wbi 签名版兜底（本文件保留 nav 探测位）。
 *
 * 搜索结果的 title/description 是 **HTML 片段**（关键词被 <em class="keyword"> 包着、
 * 还有 &quot; 之类的实体），必须先清洗再进模型，否则她会把标签念出来。
 */

/** 去掉 B 站搜索结果的 HTML 高亮标签与实体。 */
export function stripSearchHtml(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把一条搜索结果归一成统一结构（与榜单条目同构，便于共用去重/过滤）。 */
export function normalizeSearchItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = String(raw.bvid ?? '').trim();
  if (!bvid) return null;
  const title = stripSearchHtml(raw.title);
  if (!title) return null;
  const play = Number(raw.play);
  const tagRaw = stripSearchHtml(raw.tag);
  return {
    source: 'bili-search',
    contentId: bvid,
    url: `https://www.bilibili.com/video/${bvid}`,
    title: title.slice(0, 120),
    tags: tagRaw ? tagRaw.split(/\s+/).filter(Boolean).slice(0, 3).map((x) => x.slice(0, 12)) : [],
    summary: stripSearchHtml(raw.description).slice(0, 160),
    publishedAt: Number(raw.pubdate) > 0 ? new Date(Number(raw.pubdate) * 1000).toISOString().slice(0, 10) : '',
    stats: Number.isFinite(play) && play > 0 ? { view: play } : undefined,
    author: stripSearchHtml(raw.author).slice(0, 40) || undefined
  };
}

/** 解析搜索响应。 */
export function parseSearch(json) {
  if (!json || json.code !== 0) {
    return { ok: false, error: `搜索接口返回 code=${json?.code ?? '?'} ${json?.message ?? ''}`.trim() };
  }
  const list = json?.data?.result;
  if (!Array.isArray(list)) return { ok: false, error: '搜索响应里没有 data.result' };
  const items = list.map(normalizeSearchItem).filter(Boolean);
  return { ok: true, items };
}

/* ── 搜索节流 ──────────────────────────────────────────────────────────
 * 2026-10-21 实测：同一 IP 连续两次搜索（间隔 500ms）第二次直接 code=-412
 * "request was banned"；隔 8 秒再发恢复正常。
 * 所以：进程内两次搜索至少隔 3 秒；一旦吃到 -412，整段冷却 10 分钟，
 * 期间不发请求、直接返回"被限流"，由调用方降级到榜单。
 */
const SEARCH_MIN_GAP_MS = 3000;
const SEARCH_BAN_COOLDOWN_MS = 10 * 60 * 1000;
let lastSearchAt = 0;
let searchBannedUntil = 0;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** 测试用：清掉节流状态。 */
export function resetSearchThrottle() {
  lastSearchAt = 0;
  searchBannedUntil = 0;
}

/**
 * 真搜索：按关键词查 B 站视频。返回结构与其它来源一致（ok/items/error），失败不抛异常。
 */
export async function searchBili(fetchImpl, keyword, { limit = 10, page = 1, timeoutMs = 12000 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) return { ok: false, items: [], error: '关键词为空' };
  if (kw.length > 60) return { ok: false, items: [], error: '关键词太长' };

  const now = Date.now();
  if (now < searchBannedUntil) {
    const mins = Math.ceil((searchBannedUntil - now) / 60000);
    return { ok: false, items: [], error: `搜索被限流，还要等约 ${mins} 分钟`, banned: true };
  }
  const wait = SEARCH_MIN_GAP_MS - (now - lastSearchAt);
  if (wait > 0) await sleepMs(wait);
  lastSearchAt = Date.now();

  // 首选带 wbi 签名的接口：2026-10 实测未登录可用，比老的 search/type 稳得多
  try {
    const client = new BiliClient({ fetchImpl, timeoutMs });
    const r = await client.search(kw, { limit, page });
    if (r.ok && r.items.length) {
      const safe = r.items.filter(isSafeCandidate);
      if (safe.length) {
        return { ok: true, items: safe.slice(0, Math.max(1, limit)), keyword: kw };
      }
    }
    if (!r.ok && /(^|\D)(-?412)(\D|$)/.test(r.error || '')) {
      searchBannedUntil = Date.now() + SEARCH_BAN_COOLDOWN_MS;
      return { ok: false, items: [], error: '搜索被限流（412），冷却 10 分钟', banned: true };
    }
  } catch { /* 落到下面的旧接口 */ }

  const url = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}&page=${Math.max(1, Math.floor(page))}`;
  const r = await fetchJson(fetchImpl, url, { timeoutMs });
  if (!r.ok) return { ok: false, items: [], error: `请求失败：${r.error}` };

  const code = Number(r.json?.code);
  if (code === -412) {
    searchBannedUntil = Date.now() + SEARCH_BAN_COOLDOWN_MS;
    return { ok: false, items: [], error: '搜索被限流（-412），冷却 10 分钟', banned: true };
  }
  const parsed = parseSearch(r.json);
  if (!parsed.ok) return { ok: false, items: [], error: parsed.error };
  if (!parsed.items.length) return { ok: false, items: [], error: '搜索无结果' };
  const safe = parsed.items.filter(isSafeCandidate);
  if (!safe.length) return { ok: false, items: [], error: `${parsed.items.length} 条全部被安全过滤` };
  return { ok: true, items: safe.slice(0, Math.max(1, limit)), keyword: kw };
}

/**
 * B 站来源。两个入口都只用「排行榜/热门」这类公开列表，不涉及登录态或个性化推荐。
 * 解析器版本跟着字段结构走：哪天入口改版，把 version 提上去，旧 seen 记录仍按 URL 去重。
 */
export const biliSource = {
  id: 'bili',
  label: 'B站',
  parserVersion: 1,
  timeoutMs: 12000,
  minIntervalMs: 30 * 60 * 1000,   // 同一来源半小时内不重复抓（一轮只用一次，做个兜底）
  entries: [
    { id: 'bili-rank', label: '排行榜', url: 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', parse: parseRanking },
    { id: 'bili-popular', label: '热门', url: 'https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1', parse: parsePopular }
  ],

  /**
   * 按关键词真搜索（第一步新增）。失败时由调用方决定是降级到榜单还是直接回话。
   */
  async search({ fetchImpl, keyword, limit = 10 } = {}) {
    return searchBili(fetchImpl, keyword, { limit, timeoutMs: this.timeoutMs });
  },

  /**
   * 拉一批候选。只抓一个入口（优先排行榜），失败就换下一个，仍失败则返回错误。
   * @returns {{ok:boolean, items:Array, error?:string, entry?:string}}
   */
  async list({ fetchImpl, limit = 10, log = () => {} } = {}) {
    const errors = [];
    for (const entry of this.entries) {
      const r = await fetchJson(fetchImpl, entry.url, { timeoutMs: this.timeoutMs });
      if (!r.ok) {
        errors.push(`${entry.label}：${r.error}`);
        continue;
      }
      const parsed = entry.parse(r.json);
      if (!parsed.ok) {
        errors.push(`${entry.label}：${parsed.error}`);
        continue;
      }
      if (!parsed.items.length) {
        errors.push(`${entry.label}：解析后 0 条（可能是空结果或结构变化）`);
        continue;
      }
      // 安全过滤放在来源层：任何调用方拿到的都已经是过滤过的列表
      const safe = parsed.items.filter(isSafeCandidate);
      if (!safe.length) {
        errors.push(`${entry.label}：${parsed.items.length} 条全部被安全过滤`);
        continue;
      }
      log(`${entry.label} 拉到 ${parsed.items.length} 条（安全过滤后 ${safe.length} 条），取前 ${Math.min(limit, safe.length)} 条`);
      return { ok: true, items: safe.slice(0, Math.max(1, limit)), entry: entry.id };
    }
    return { ok: false, items: [], error: errors.join('；') || '全部入口失败' };
  }
};

/**
 * 小黑盒来源（只读）：推荐流 + 搜索。
 *
 * 登录态来自 data/xhh-auth.json（网页 Cookie 导入）。没登录时这个来源直接返回错误，
 * 不影响 B 站——`runSession` 对单个来源失败是隔离的。
 *
 * 注意它不是公开 API：字段和签名会变，失败一律当"这次没内容"，不重试。
 */
export const xhhSource = {
  id: 'xhh',
  label: '小黑盒',
  parserVersion: 1,
  timeoutMs: 15000,
  minIntervalMs: 5 * 60 * 1000,

  async list({ limit = 10 } = {}) {
    const client = new XhhClient({ authFile: XHH_AUTH_FILE });
    if (!client.loggedIn) return { ok: false, items: [], error: `未登录（${client.lastAuthError}）` };
    const r = await client.feed({ limit: Math.max(1, limit * 2) });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const safe = r.items.filter(isSafeCandidate);
    if (!safe.length) return { ok: false, items: [], error: '推荐流条目全部被安全过滤' };
    return { ok: true, items: safe.slice(0, Math.max(1, limit)) };
  },

  async search({ keyword, limit = 10 } = {}) {
    const client = new XhhClient({ authFile: XHH_AUTH_FILE });
    if (!client.loggedIn) return { ok: false, items: [], error: `未登录（${client.lastAuthError}）` };
    const r = await client.search(keyword, { limit: Math.max(1, limit * 2) });
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const safe = r.items.filter(isSafeCandidate);
    if (!safe.length) return { ok: false, items: [], error: '搜索结果全部被安全过滤' };
    return { ok: true, items: safe.slice(0, Math.max(1, limit)), keyword: r.keyword };
  }
};

/**
 * 手机来源（只读）：借来的 vivo T1x，通过 AIPhone 的 phone_eye.py 看屏幕。
 *
 * 边界（写死在代码里，别松）：
 *   · **只读**：只调 status / look，绝不调 open，不点、不赞、不评论、不 @。
 *   · 手机平时不连着，所以失败必须优雅：返回 ok:false，由 runSession 隔离。
 *   · 每次只刷一个 App（按小时轮流小黑盒 / B 站），像人随手划一下就够了。
 */
const PHONE_PYTHON = process.env.AIPHONE_PYTHON || 'E:\\dsh\\AIPhone\\ocr\\venv\\Scripts\\python.exe';
const PHONE_SCRIPT = process.env.AIPHONE_SCRIPT || 'E:\\dsh\\AIPhone\\phone_eye.py';

/** 跑一次 phone_eye.py，把它最后一行 JSON 解析出来（失败也返回对象，不抛）。 */
async function phoneJson(args, timeoutMs) {
  try {
    const { stdout } = await execFileP(PHONE_PYTHON, ['-X', 'utf8', PHONE_SCRIPT, ...args], {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8'
    });
    const lines = String(stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (!lines[i].startsWith('{')) continue;
      try { return JSON.parse(lines[i]); } catch { /* 继续往前找 */ }
    }
    return { ok: false, error: 'phone_eye 没输出 JSON' };
  } catch (e) {
    const raw = String(e?.stdout || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean).pop();
    if (raw && raw.startsWith('{')) {
      try { return JSON.parse(raw); } catch { /* ignore */ }
    }
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

/** 把一张手机卡片归一成候选结构（标题取不到就丢）。 */
export function normalizePhoneCard(card, app) {
  if (!card || typeof card !== 'object') return null;
  const title = String(card.title ?? card.name ?? card.text ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return null;
  const body = String(card.desc ?? card.body ?? card.summary ?? card.content ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    source: 'phone',
    contentId: `${app}:${title.slice(0, 48)}`,
    url: '',
    title: title.slice(0, 120),
    tags: [app === 'xiaoheihe' ? '小黑盒' : 'B站'],
    summary: body.slice(0, 160),
    publishedAt: ''
  };
}

export const phoneSource = {
  id: 'phone',
  label: '手机',
  parserVersion: 1,
  timeoutMs: 90_000,
  minIntervalMs: 15 * 60 * 1000,

  /** 手机自己人在不在。不在就快速返回，不拖整轮。 */
  async available() {
    const st = await phoneJson(['status'], 20_000);
    return st.ok ? { ok: true, status: st } : { ok: false, error: st.reason || st.error || '手机不在线' };
  },

  async list({ limit = 10, log = () => {} } = {}) {
    const st = await phoneJson(['status'], 20_000);
    if (!st.ok) {
      return { ok: false, items: [], error: `手机没连（${st.reason || st.error || '不在线'}）` };
    }
    // 轮流看：偶数小时小黑盒，奇数小时 B 站，免得每次都盯着同一个 App
    const app = Math.floor(Date.now() / 3600000) % 2 === 0 ? 'xiaoheihe' : 'bilibili';
    const r = await phoneJson(['look', '--app', app, '--engine', 'u2'], this.timeoutMs);
    if (!r.ok) {
      return { ok: false, items: [], error: `看手机失败（${app}）：${r.error || r.reason || '未知'}` };
    }
    const cards = Array.isArray(r.cards) ? r.cards : [];
    if (!cards.length) {
      return { ok: false, items: [], error: `手机（${app}）上没认出卡片` };
    }
    const items = [];
    const seen = new Set();
    for (const c of cards) {
      const item = normalizePhoneCard(c, app);
      if (!item || seen.has(item.contentId)) continue;
      seen.add(item.contentId);
      items.push(item);
      if (items.length >= Math.max(1, limit)) break;
    }
    if (!items.length) return { ok: false, items: [], error: '卡片里没有可用标题' };
    log(`手机（${app}）看到 ${items.length} 条`);
    return { ok: true, items };
  }
};

/**
 * 小黑盒：第一版**不启用**。
 * 首页是 SPA 骨架，内容靠带签名的接口渲染；没有验证到任何「无需登录即可稳定读取」的入口。
 * 保留占位是为了让配置里写 xiaoheihe 时能给出明确原因，而不是静默失败。
 */
export const xiaoheiheSource = {
  id: 'xiaoheihe',
  label: '小黑盒',
  parserVersion: 0,
  unavailableReason: '未通过匿名访问验证：首页是 SPA 骨架，内容由带签名的接口渲染，未找到无需登录的稳定公开入口',
  async list() {
    return { ok: false, items: [], error: this.unavailableReason };
  }
};

export const SOURCES = {
  bili: biliSource,
  xhh: xhhSource,
  phone: phoneSource,
  xiaoheihe: xiaoheiheSource
};

/** 按配置里的 "bili,xiaoheihe" 取来源对象列表（未知 id 忽略并给出提示）。 */
export function resolveSources(spec = 'bili') {
  const out = [];
  const unknown = [];
  for (const raw of String(spec ?? '').split(/[,，\s]+/)) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    if (SOURCES[id]) out.push(SOURCES[id]);
    else unknown.push(id);
  }
  return { sources: out, unknown };
}
