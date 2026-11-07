// 听歌（now-playing）：读 Windows 媒体会话（SMTC）拿"正在播什么"，
// 需要时再去网易云取歌词，按播放进度对出当前这一句。
//
// 为什么用 SMTC 而不是读网易云的本地文件：
//   · 系统级接口，不需要登录、不需要抓包、不碰客户端数据；
//   · 网易云、QQ 音乐、Spotify 的播放都能读到（只是我们优先选网易云）；
//   · 只读，不会误触播放/切歌。
// 代价是 SMTC 的进度不一定精准（有些播放器只报整秒/偶尔不更新），
// 所以歌词对不上时不要硬报"第几句"，退回到歌名/歌手就行。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'scripts', 'smtc.ps1');

let cfg = () => ({});

function conf() {
  const c = cfg() || {};
  return {
    enabled: c.enabled !== false,
    includeLyric: c.includeLyric !== false,
    timeoutMs: Math.max(1500, Math.min(30000, Number(c.timeoutMs) || 8000))
  };
}

/* ── 读 SMTC ───────────────────────────────────────────────────────────── */

function runSmtc(timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], {
        windowsHide: true
      });
    } catch (error) {
      return finish({ ok: false, error: `启动 PowerShell 失败：${error?.message ?? error}` });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ ok: false, error: `读取媒体会话超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish({ ok: false, error: `无法运行 PowerShell：${error?.message ?? error}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text) {
        return finish({ ok: false, error: `媒体会话没有输出（exit ${code}）${err ? '：' + err.trim().slice(0, 200) : ''}` });
      }
      try {
        const j = JSON.parse(text);
        return finish({ ok: true, sessions: Array.isArray(j.sessions) ? j.sessions : (j.sessions ? [j.sessions] : []), raw: j });
      } catch {
        return finish({ ok: false, error: `媒体会话返回的不是 JSON：${text.slice(0, 200)}` });
      }
    });
  });
}

function pickSession(sessions) {
  if (!Array.isArray(sessions) || !sessions.length) return null;
  // 优先级：正在播 > 暂停；同状态里 QQ 音乐 > 网易云 > 其他播放器。
  // （网易云 3.1.40 自己禁用了 MediaSessionService，读不到；QQ 音乐是当前主力。）
  const APP_RANK = [/qqmusic/i, /cloudmusic|netease/i, /spotify|kugou|foobar/i];
  const rankOf = (s) => {
    const app = String(s?.app || '');
    const i = APP_RANK.findIndex((re) => re.test(app));
    return i < 0 ? 9 : i;
  };
  const playing = (s) => (String(s?.status || '').toLowerCase() === 'playing' ? 0 : 1);
  return [...sessions].sort((a, b) => playing(a) - playing(b) || rankOf(a) - rankOf(b))[0] || null;
}

/* ── 网易云歌词 ───────────────────────────────────────────────────────── */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const songCache = new Map();  // "title|artist" -> { id, lyric, at }
const CACHE_MS = 10 * 60 * 1000;

async function neteaseJson(url) {
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://music.163.com/', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(6000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function lyricFor(title, artist) {
  const key = `${title}|${artist}`;
  const hit = songCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  let entry = { id: null, lyric: '', at: Date.now() };
  try {
    const q = `${title} ${artist}`.trim();
    const search = await neteaseJson(
      `https://music.163.com/api/search/get/web?csrf_token=&s=${encodeURIComponent(q)}&type=1&offset=0&total=true&limit=3`
    );
    const song = search?.result?.songs?.[0];
    if (song?.id) {
      entry.id = song.id;
      const lrc = await neteaseJson(`https://music.163.com/api/song/lyric?id=${song.id}&lv=1&tv=-1`);
      entry.lyric = String(lrc?.lrc?.lyric || '');
    }
  } catch { /* 网络失败就只报歌名 */ }
  songCache.set(key, entry);
  return entry;
}

/** LRC → 当前行。[mm:ss.xx] 或 [mm:ss]；多行同时间取最后一条。 */
const META_LINE = /^(作词|作曲|编曲|制作人|混音|母带|录音|监制|出品|发行|OP|SP)\s*[:：]/i;
function currentLyricLine(lrc, posSec) {
  const lines = String(lrc || '').split('\n');
  let best = '';
  let bestAt = -1;
  for (const raw of lines) {
    const m = /^\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const at = Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(m[3]) / (m[3].length === 3 ? 1000 : 100) : 0);
    const text = String(m[4] || '').trim();
    // 作词/作曲这些元信息挂在 0 秒，进度一过 0 就会变成"当前歌词"，要跳过
    if (!text || META_LINE.test(text)) continue;
    if (at <= posSec + 0.3 && at > bestAt) { bestAt = at; best = text; }
  }
  return best;
}

const fmt = (sec) => {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/* ── 入口 ─────────────────────────────────────────────────────────────── */

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'now_playing',
    name: '看看在听什么',
    description: '看老大电脑上正在播什么歌：歌名、歌手、专辑、放到第几秒、是播放还是暂停，顺便对出当前那一句歌词。聊到音乐、他说在听歌、或者你想接一句歌词时用。只读，不会控制播放器。',
    category: 'media',
    icon: '🎧',
    parameters: {
      type: 'object',
      properties: {
        withLyric: { type: 'boolean', description: '是否顺便取当前歌词（默认跟随设置，一般不用传）' }
      }
    },
    async execute(_ctx, args) {
      const c = conf();
      if (!c.enabled) return { content: '听歌功能关着（配置里 enabled=false），你看不到他在听什么。', isError: true };

      const r = await runSmtc(c.timeoutMs);
      if (!r.ok) return { content: `读不到媒体会话：${r.error}`, isError: true };
      const s = pickSession(r.sessions);
      if (!s) return { content: '现在没有在听歌——系统里没有任何播放器在放东西（网易云没开，或者刚关掉）。' };

      const title = String(s.title || '').trim();
      const artist = String(s.artist || '').trim();
      if (!title) return { content: '有一个播放器会话，但读不到歌名（可能刚切歌，或者播放器没把标题交给系统）。' };

      const playing = String(s.status || '').toLowerCase() === 'playing';
      const lines = [`${playing ? '正在听' : '停在'}：《${title}》${artist ? ` — ${artist}` : ''}`];
      if (s.album) lines.push(`专辑：${s.album}`);
      if (Number(s.end) > 0) lines.push(`进度：${fmt(s.pos)} / ${fmt(s.end)}${playing ? '' : '（暂停）'}`);

      const wantLyric = args?.withLyric === undefined ? c.includeLyric : args.withLyric !== false;
      if (wantLyric && playing) {
        try {
          const { lyric } = await lyricFor(title, artist);
          const line = currentLyricLine(lyric, Number(s.pos) || 0);
          if (line) lines.push(`当前歌词：${line}`);
          else if (lyric) lines.push('（这句还没到歌词，或者纯音乐）');
        } catch { /* 歌词失败不影响主结果 */ }
      }
      return { content: lines.join('\n') };
    }
  });
}

export function available() {
  return { ok: true };
}

/** 自测用。 */
export const internals = { conf, pickSession, currentLyricLine, fmt };
