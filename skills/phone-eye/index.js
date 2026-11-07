// 借来的手机（phone-eye）：把 AIPhone 的手机采集链路包成两个只读工具。
//
// 为什么要走外部 Python 而不是在 Node 里重写：
//   · OCR 引擎（RapidOCR）和卡片切分算法都在 E:\dsh\AIPhone 的 venv 里，
//     重写一份只会两边不一致；
//   · adb 的路径、串口、屏幕尺寸也都在那边维护。
// 所以这里只做「起进程 → 解析 JSON → 变成一段人话」，不做任何识别逻辑。
//
// 刻意不给的能力：点击、点赞、评论、@、发帖。目前只有截图和读屏。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const pexec = promisify(execFile);

const DEFAULT_PYTHON = 'E:\\dsh\\AIPhone\\ocr\\venv\\Scripts\\python.exe';
const DEFAULT_SCRIPT = 'E:\\dsh\\AIPhone\\phone_eye.py';
// 最近一次调用的原始结果：她如果再说「手机用不了」，先看这个文件，
// 能直接分清是 adb 没起来、设备未授权，还是脚本路径错了。
const LAST_CALL = 'E:\\dsh\\QQ-agent\\data\\phone-eye-last.json';

let cfg = () => ({});

function conf() {
  const c = cfg() || {};
  return {
    pythonPath: String(c.pythonPath || DEFAULT_PYTHON),
    scriptPath: String(c.scriptPath || DEFAULT_SCRIPT),
    defaultApp: String(c.defaultApp || 'xiaoheihe'),
    timeoutMs: Math.max(30_000, Math.min(600_000, Number(c.timeoutMs) || 180_000))
  };
}

/**
 * 跑一次 phone_eye.py，返回它最后一行 JSON。
 * 脚本本身把诊断写 stderr、结果写 stdout，所以这里只取最后一行，避免
 * RapidOCR 的 INFO 日志混进来。
 */
async function runPhone(args) {
  const { pythonPath, scriptPath, timeoutMs } = conf();
  const started = Date.now();
  // 显式给 adb 路径：机器人进程的 PATH 是启动快照，可能找不到 adb，
  // 也可能命中另一个版本（server 版本冲突 → 设备列表为空 → 假“未授权”）。
  // TEMP 也要指到工作区：adb server 启动时要写 %TEMP%\adb.log，沙箱不放行用户 Temp。
  const phoneTmp = 'E:\\dsh\\QQ-agent\\data\\tmp';
  try { fs.mkdirSync(phoneTmp, { recursive: true }); } catch { /* ignore */ }
  const env = {
    ...process.env,
    AIPHONE_ADB: 'C:\\Users\\lenovo\\AppData\\Local\\Microsoft\\WinGet\\Packages\\'
      + 'Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\\scrcpy-win64-v4.1\\adb.exe',
    TEMP: phoneTmp,
    TMP: phoneTmp
  };
  try {
    const { stdout, stderr } = await pexec(pythonPath, ['-X', 'utf8', scriptPath, ...args], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env
    });
    const line = String(stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (!line) throw new Error('手机脚本没有输出');
    const out = JSON.parse(line);
    noteLastCall({
      at: new Date().toISOString(),
      args,
      ms: Date.now() - started,
      pythonPath,
      ok: out?.ok,
      result: out,
      stderr: String(stderr || '').slice(-800)
    });
    return out;
  } catch (e) {
    noteLastCall({
      at: new Date().toISOString(),
      args,
      ms: Date.now() - started,
      pythonPath,
      error: String(e?.message ?? e),
      stdout: String(e?.stdout || '').slice(-1500),
      stderr: String(e?.stderr || '').slice(-1500)
    });
    throw e;
  }
}

/** 把最近一次调用的原始结果落到 data\phone-eye-last.json（排障用，失败忽略）。 */
function noteLastCall(obj) {
  try {
    fs.mkdirSync(path.dirname(LAST_CALL), { recursive: true });
    fs.writeFileSync(LAST_CALL, JSON.stringify(obj, null, 1), 'utf8');
  } catch { /* ignore */ }
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

export function setup(api) {
  cfg = api.config;

  api.registerTool({
    id: 'look',
    name: '看看手机',
    description: '看一眼借来的那台手机屏幕上现在有什么。程序会截屏、认字、按卡片拆成一条条帖子（标题/作者/标签/互动数分开），你看到的是一段整理好的文字。只能看，不能点、不能赞、不能评论。一次看一两条就够，别连着刷。默认看的是小黑盒——老大说的是 B 站时要显式传 app="bilibili"，不然会看错 App。',
    category: 'utility',
    icon: '📱',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          enum: ['xiaoheihe', 'bilibili'],
          description: '看哪个应用：xiaoheihe（小黑盒）或 bilibili（B 站）。默认小黑盒；B 站首页是瀑布流，能读到的字比小黑盒少。'
        },
        launch: {
          type: 'boolean',
          description: '要不要先把应用切到前台，默认 true；手机已经停在那个页面时可传 false 省时间'
        },
        scroll: {
          type: 'number',
          description: '往下滚几屏（0-6）。滚一次能多看几条，但只有最后那屏的帖子点得开。默认 0，也就是只看当前屏'
        }
      }
    },
    async execute(_ctx, args) {
      try {
        const app = String(args?.app || conf().defaultApp);
        const launch = args?.launch !== false;
        const scroll = Number.isFinite(Number(args?.scroll)) ? Math.max(0, Math.min(6, Number(args.scroll))) : 0;
        const cmd = ['look', '--app', app];
        if (!launch) cmd.push('--no-launch');
        if (scroll) cmd.push('--scroll', String(scroll));
        const r = await runPhone(cmd);
        if (!r?.ok) return err(r?.error || '手机那边没给出结果');
        const body = String(r.summary || '').trim() || '(屏幕上没认出能看的内容)';
        const bits = [];
        if (r.text_lines) bits.push(`识别 ${r.text_lines} 行`);
        if (r.cards?.length) bits.push(`${r.cards.length} 条`);
        if (r.frames > 1) bits.push(`滚了 ${r.frames - 1} 屏`);
        const meta = bits.length ? `\n（${bits.join(' · ')}）` : '';
        return { content: `${body}${meta}` };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/ETIMEDOUT|timed out/i.test(msg)) return err('手机响应超时，可能没响应或 adb 卡住了');
        if (/ENOENT/i.test(msg)) return err('找不到 Python 或桥接脚本，检查插件设置里的路径');
        return err(msg);
      }
    }
  });

  api.registerTool({
    id: 'open',
    name: '点进去看一条',
    description: '把刚才看到的那条帖子点开，读正文和评论区。前提是先 look 过一次（它才知道点哪里）。纯只读：只看，不点赞、不评论、不收藏。看完会自动退回列表。',
    category: 'utility',
    icon: '👀',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第几条，从 1 开始，来自上一次 look' },
        keyword: { type: 'string', description: '或者按标题关键词挑一条（和 index 二选一）' },
        scroll: { type: 'number', description: '往下滑几次看评论，0-5，默认 1' }
      }
    },
    async execute(_ctx, args) {
      try {
        const index = Number(args?.index) || 0;
        const keyword = String(args?.keyword || '').trim();
        const scroll = Number.isFinite(Number(args?.scroll)) ? Math.max(0, Math.min(5, Number(args.scroll))) : 1;
        if (!index && !keyword) return err('要说第几条（index）或者给个标题关键词（keyword），不然不知道点哪条');
        const cmd = ['open'];
        if (index) cmd.push('--index', String(index));
        if (keyword) cmd.push('--keyword', keyword);
        if (scroll) cmd.push('--scroll', String(scroll));
        const r = await runPhone(cmd);
        if (!r?.ok) return err(r?.error || '点不进去');
        const head = `《${r.from_title}》${r.author ? ` —— ${r.author}` : ''}${r.tag ? `（${r.tag}）` : ''}`;
        const body = String(r.text || '').trim() || '(点开了，但没认出字来)';
        return { content: `${head}\n\n${body}` };
      } catch (e) {
        const msg = String(e?.message ?? e);
        if (/ETIMEDOUT|timed out/i.test(msg)) return err('点进去之后超时了');
        return err(msg);
      }
    }
  });

  api.registerTool({
    id: 'status',
    name: '手机在不在',
    description: '看看那台借来的手机还连着没有（在线、Android 版本、屏幕尺寸）。她说「手机好像没电了」「打不开了」的时候可以先确认一下。',
    category: 'utility',
    icon: '🔌',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const r = await runPhone(['status']);
        if (!r?.online) return { content: `手机不在线：${r?.reason || '没连上'}` };
        return { content: `手机在线：Android ${r.android || '?'}，屏幕 ${r.size || r.screen || '?'}` };
      } catch (e) {
        return err(e?.message ?? e);
      }
    }
  });
}

export function available() {
  return { ok: true };
}
