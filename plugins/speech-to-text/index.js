// 语音转文字（speech-to-text）：核心预留的 media.transcribe 能力的本地实现。
//
// 核心在 src/onebot.js 里留好了钩子：
//   fn = skillManager.getCapabilityProviders('media.transcribe')[0]?.fn
//   r  = await fn({ record, onebot })   // 我们要返回 { ok, text }
// 没有提供者、或我们返回 ok:false，核心就退回「[语音]」占位 —— 行为完全回退。
//
// 链路：
//   1. 用 onebot 的 get_record 把语音取成 wav（NapCat 支持 out_format=wav，
//      它会自己把 silk 转好；取不到再退 mp3，最后才试直链下载）；
//   2. 调本机的 whisper（whisper.cpp 的 whisper-cli.exe，或 python -m whisper）；
//   3. 清掉时间戳/空音频标记，返回纯文本。
//
// 为什么坚持本地：语音是最私人的东西，不上传第三方。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getConfig } from '../../src/config.js';

// 插件的设置 = config.skills['speech-to-text']（面板写的也是这里）。
// 注意：确定性型插件没有 setup(api)，不能等 api.config —— 必须自己从 getConfig 读，
// 否则 conf() 永远是空对象、enabled 永远 false（这就是"她说听不见"的根因）。
let cfgOverride = null;
const warn = (msg) => { try { console.warn(`[speech-to-text] ${msg}`); } catch { /* ignore */ } };
// 临时文件放应用数据目录：系统 %TEMP% 在部分机器上被策略/杀软拦写入
// （实测 whisper-cli 报 "failed to open ... for writing"，exit 11），
// 而 data/ 一定可写，也方便清理。
const HERE = path.dirname(fileURLToPath(import.meta.url));
const TMP_DIR = path.join(HERE, '..', '..', 'data', 'stt-tmp');
// 转写后的原始语音留档：DSH 那边没有同步转写通道，但她可以用 pwsh 自己
// 再跑一遍 whisper（校对/重听）。所以把文件复制到固定目录并把路径回传。
const VOICE_DIR = path.join(HERE, '..', '..', 'data', 'voice-in');

function conf() {
  const c = (cfgOverride ? cfgOverride() : null) || getConfig()?.skills?.['speech-to-text'] || {};
  const pick = (v) => String(v ?? '').trim();
  return {
    enabled: c.enabled === true,
    engine: pick(c.engine) || 'auto',
    exePath: pick(c.exePath),
    modelPath: pick(c.modelPath),
    pythonExe: pick(c.pythonExe),
    pythonModel: pick(c.pythonModel) || 'base',
    language: pick(c.language),
    // 默认不加 initial prompt：实测它对一两秒的短语音干扰极大
    // （会把「那我先打电话」带成「那是你打的」，甚至整段输出星号）。
    // 简体改由下面的 opencc 后处理完成，不依赖提示词。
    initialPrompt: typeof c.initialPrompt === 'string' ? c.initialPrompt.trim() : '',
    timeoutMs: Math.max(5000, Math.min(300000, Number(c.timeoutMs) || 60000))
  };
}

function runFile(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (error) {
      return finish({ code: -1, out: '', err: `启动失败：${error?.message ?? error}` });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish({ code: -1, out, err: `超时（${timeoutMs}ms）` });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, out, err: String(e?.message ?? e) }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code, out, err }); });
  });
}

/* ── 取语音文件 ───────────────────────────────────────────────────────── */

async function recordToFile(record, onebot) {
  const data = record?.data || record || {};
  const file = String(data.file || '').trim();
  if (file && onebot?.call) {
    for (const fmt of ['wav', 'mp3']) {
      try {
        const ret = await onebot.call('get_record', { file, out_format: fmt });
        const d = ret?.data ?? ret;
        const p = String(d?.file || d?.path || '');
        if (p && fs.existsSync(p)) return { path: p, cleanup: false };
      } catch { /* 换下一个格式 */ }
    }
    // 有些实现只回 url
    try {
      const ret = await onebot.call('get_record', { file });
      const d = ret?.data ?? ret;
      const u = String(d?.url || '');
      if (u) return { path: await download(u), cleanup: true };
    } catch { /* ignore */ }
  }
  const url = String(data.url || data.path || '').trim();
  if (/^https?:\/\//i.test(url)) return { path: await download(url), cleanup: true };
  throw new Error('拿不到语音文件（get_record 和直链都失败）');
}

async function download(url) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const ext = (url.match(/\.(wav|mp3|amr|silk|ogg)(?:\?|$)/i)?.[1] || 'bin').toLowerCase();
  const dest = path.join(TMP_DIR, `in_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`);
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`下载语音失败：HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (!buf.length) throw new Error('下载到的语音是空的');
  fs.writeFileSync(dest, buf);
  return dest;
}

/* ── 识别 ─────────────────────────────────────────────────────────────── */

// whisper 的中文训练语料偏繁体，输出常是「打電話/現在」这种。
// 不用 initial prompt 去掰（会干扰短语音、甚至出星号），改成识别完再转简体。
let simplifierPromise = null;
async function toSimplified(text) {
  const t = String(text || '');
  if (!/[\u4e00-\u9fff]/.test(t)) return t;
  if (!simplifierPromise) {
    simplifierPromise = import('opencc-js')
      .then((m) => (m.default || m).Converter({ from: 'tw', to: 'cn' }))
      .catch(() => null);
  }
  const fn = await simplifierPromise;
  try { return fn ? fn(t) : t; } catch { return t; }
}

const cleanText = (raw) => String(raw || '')
  .split('\n')
  // LRC `[mm:ss.xxx]` / `[hh:mm:ss.xxx]` 与 SRT `[... --> ...]` 两种都去掉
  .map((l) => l.replace(/^\s*\[\d{1,3}(?::\d{2}){1,2}(?:[.:]\d{1,3})?\s*(?:-->\s*[^\]]*)?\]\s*/, '').trim())
  .filter((l) => l && !/^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|SOUND)\]$/i.test(l) && !/^\((音乐|掌声|笑声|噪声|静音)\)$/.test(l))
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

async function transcribeWhisperCli(wav, c) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const base = path.join(TMP_DIR, `out_${Date.now()}`);
  // 留一份输入音频 + 记录识别结果：短语音识别差时，需要看原音频才能判断是
  // 模型问题还是音频本身（8k/静音/截断）。日志只留一行，不占空间。
  let kept = wav;
  try {
    if (!path.resolve(wav).startsWith(path.resolve(TMP_DIR))) {
      kept = path.join(TMP_DIR, `in_${Date.now()}.wav`);
      fs.copyFileSync(wav, kept);
    }
  } catch { /* 复制失败不影响识别 */ }
  const args = ['-m', c.modelPath, '-f', wav, '-nt', '-otxt', '-of', base];
  if (c.language) args.push('-l', c.language);
  if (c.initialPrompt) args.push('--prompt', c.initialPrompt);
  const r = await runFile(c.exePath, args, c.timeoutMs);
  // whisper-cli 会写 <base>.txt
  const txt = `${base}.txt`;
  if (fs.existsSync(txt)) {
    const text = cleanText(fs.readFileSync(txt, 'utf8'));
    try { fs.rmSync(txt, { force: true }); } catch { /* ignore */ }
    if (text) {
      const simplified = await toSimplified(text);
      try { warn(`识别 ${path.basename(kept)} (${fs.statSync(kept).size}B) → ${simplified}`); } catch { /* ignore */ }
      return simplified;
    }
  }
  if (r.code !== 0) throw new Error(`whisper-cli 失败（exit ${r.code}）：${r.err.trim().slice(0, 300)}`);
  const text = cleanText(r.out);
  if (!text) throw new Error('whisper-cli 没有输出文字');
  return toSimplified(text);
}

async function transcribePython(wav, c) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const outDir = path.join(TMP_DIR, `py_${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const args = ['-m', 'whisper', wav, '--model', c.pythonModel, '--output_format', 'txt', '--output_dir', outDir, '--task', 'transcribe'];
  if (c.language) args.push('--language', c.language);
  if (c.initialPrompt) args.push('--initial_prompt', c.initialPrompt);
  const r = await runFile(c.pythonExe, args, c.timeoutMs);
  const txt = path.join(outDir, `${path.basename(wav, path.extname(wav))}.txt`);
  if (fs.existsSync(txt)) {
    const text = cleanText(fs.readFileSync(txt, 'utf8'));
    try { fs.rmSync(txt, { force: true }); } catch { /* ignore */ }
    if (text) return toSimplified(text);
  }
  if (r.code !== 0) throw new Error(`python whisper 失败（exit ${r.code}）：${r.err.trim().slice(0, 300)}`);
  const text = cleanText(r.out);
  if (!text) throw new Error('python whisper 没有输出文字');
  return toSimplified(text);
}

function pickEngine(c) {
  if (c.engine === 'whisper-cli') return c.exePath ? 'whisper-cli' : '';
  if (c.engine === 'python') return c.pythonExe ? 'python' : '';
  if (c.exePath) return 'whisper-cli';
  if (c.pythonExe) return 'python';
  return '';
}

/** 把语音文件留一份到 data\voice-in（3 天后自动清），返回它的绝对路径。 */
function persistVoice(file) {
  try {
    fs.mkdirSync(VOICE_DIR, { recursive: true });
    const ext = path.extname(file) || '.wav';
    const dest = path.join(VOICE_DIR, `voice-${Date.now()}${ext}`);
    fs.copyFileSync(file, dest);
    try {
      const now = Date.now();
      for (const n of fs.readdirSync(VOICE_DIR)) {
        const p = path.join(VOICE_DIR, n);
        if (now - fs.statSync(p).mtimeMs > 3 * 86400 * 1000) fs.rmSync(p, { force: true });
      }
    } catch { /* 清理失败无所谓 */ }
    return dest;
  } catch (e) {
    warn(`保留语音文件失败：${e?.message ?? e}`);
    return '';
  }
}

/* ── 能力 ─────────────────────────────────────────────────────────────── */

export const providers = {
  'media.transcribe': async ({ record, onebot } = {}) => {
    const c = conf();
    if (!c.enabled) return { ok: false, error: '语音转文字没开' };
    const engine = pickEngine(c);
    if (!engine) return { ok: false, error: '没有配置 whisper 引擎' };
    if (engine === 'whisper-cli' && !c.modelPath) return { ok: false, error: '没配置 whisper.cpp 模型路径' };

    let file = null;
    let cleanup = false;
    try {
      const got = await recordToFile(record, onebot);
      file = got.path;
      cleanup = got.cleanup;
      if (!/\.wav$/i.test(file) && !/\.mp3$/i.test(file) && !/\.ogg$/i.test(file)) {
        // 兜底：交给 whisper 自己处理；失败时错误信息会说明
      }
      const text = engine === 'whisper-cli' ? await transcribeWhisperCli(file, c) : await transcribePython(file, c);
      return { ok: true, text, engine, file: persistVoice(file), modelPath: c.modelPath || '' };
    } catch (error) {
      const message = String(error?.message ?? error);
      warn(`转写失败：${message}`);
      return { ok: false, error: message };
    } finally {
      if (cleanup && file) { try { fs.rmSync(file, { force: true }); } catch { /* ignore */ } }
    }
  }
};

export function available() {
  const c = conf();
  if (!c.enabled) return { ok: true, reason: '语音转文字未启用' };
  return { ok: true };
}

/** 自测用。 */
export const internals = { conf, cleanText, pickEngine, setConfig: (fn) => { cfgOverride = fn; } };
