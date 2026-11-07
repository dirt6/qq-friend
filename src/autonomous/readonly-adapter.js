// 5.0-E6：只读空闲探索适配器（公开 B 站榜单）。
// 无登录、无 Cookie、不写文件、不发消息、不调模型；失败只返回错误。
// 小黑盒匿名接口不可用；本适配器不伪造登录态。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const UNSAFE = /(成人内容|色情|淫秽|约炮|裸聊|赌博|博彩|赌球|毒品|冰毒|海洛因|代孕|洗钱|诈骗|传销|枪支|恐怖主义)/;
const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const stripHtml = (v) => textOf(String(v ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' '));
const norm = (raw, source = 'bili-search') => {
  const title = stripHtml(raw?.title);
  if (!title) return null;
  const bvid = textOf(raw?.bvid);
  if (!bvid) return null;
  const content = [title, raw?.description, raw?.tag].map(textOf).join(' ');
  if (UNSAFE.test(content)) return null;
  return {
    source, contentId: bvid, url: `https://www.bilibili.com/video/${bvid}`,
    title: title.slice(0, 120), summary: stripHtml(raw?.description).slice(0, 160),
    tags: stripHtml(raw?.tag).split(/\s+/).filter(Boolean).slice(0, 3).map((x) => x.slice(0, 12))
  };
};
function requestJson(fetchImpl, url, timeoutMs) {
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ac?.abort(), Math.max(2000, Number(timeoutMs) || 12000));
  return fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'application/json,text/plain,*/*', referer: 'https://www.bilibili.com/' },
    redirect: 'follow', signal: ac?.signal
  }).then(async (res) => {
    if (!res?.ok) return { ok: false, error: `http_${res?.status || 0}` };
    const json = await res.json().catch(() => null);
    if (!json || json.code !== 0) return { ok: false, error: `api_${json?.code ?? 'parse'}` };
    return { ok: true, json };
  }).catch((e) => ({ ok: false, error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)) }))
    .finally(() => clearTimeout(timer));
}

export function createReadonlyAdapter({ fetchImpl = globalThis.fetch, url = 'https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all', timeoutMs = 12000 } = {}) {
  async function read({ limit = 8 } = {}) {
    if (typeof fetchImpl !== 'function') return { ok: false, items: [], error: 'fetch_unavailable' };
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = setTimeout(() => ac?.abort(), Math.max(2000, Number(timeoutMs) || 12000));
    try {
      const res = await fetchImpl(url, {
        headers: { 'user-agent': BROWSER_UA, accept: 'application/json,text/plain,*/*', referer: 'https://www.bilibili.com/' },
        redirect: 'follow', signal: ac?.signal
      });
      if (!res?.ok) return { ok: false, items: [], error: `http_${res?.status || 0}` };
      const json = await res.json().catch(() => null);
      if (!json || json.code !== 0) return { ok: false, items: [], error: `api_${json?.code ?? 'parse'}` };
      const list = json?.data?.list;
      if (!Array.isArray(list)) return { ok: false, items: [], error: 'no_list' };
      const items = [];
      for (const raw of list) {
        const title = textOf(raw?.title);
        const content = [title, raw?.desc, raw?.tname].map(textOf).join(' ');
        if (!title || UNSAFE.test(content)) continue;
        const bvid = textOf(raw?.bvid);
        const aid = raw?.aid ? String(raw.aid) : '';
        if (!bvid && !aid) continue;
        items.push({
          source: 'bili', contentId: bvid || `av${aid}`,
          url: bvid ? `https://www.bilibili.com/video/${bvid}` : `https://www.bilibili.com/video/av${aid}`,
          title: title.slice(0, 120), summary: textOf(raw?.desc).slice(0, 160),
          tags: raw?.tname ? [textOf(raw.tname).slice(0, 20)] : []
        });
        if (items.length >= Math.max(1, Math.min(30, Number(limit) || 8))) break;
      }
      return { ok: true, items, source: 'bili' };
    } catch (e) {
      return { ok: false, items: [], error: String(e?.name === 'AbortError' ? 'timeout' : (e?.message || e)) };
    } finally { clearTimeout(timer); }
  }
  async function search({ keyword = '', limit = 8 } = {}) {
    const kw = textOf(keyword);
    if (!kw) return { ok: false, items: [], error: 'keyword_required' };
    const u = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(kw)}`;
    const r = await requestJson(fetchImpl, u, timeoutMs);
    if (!r.ok) return { ok: false, items: [], error: r.error };
    const list = r.json?.data?.result;
    if (!Array.isArray(list)) return { ok: false, items: [], error: 'no_search_result' };
    const items = [];
    for (const raw of list) {
      const it = norm(raw);
      if (!it) continue;
      items.push(it);
      if (items.length >= Math.max(1, Math.min(30, Number(limit) || 8))) break;
    }
    return { ok: true, items, source: 'bili', keyword: kw };
  }
  return { read, search, source: 'bili' };
}

export default createReadonlyAdapter;
