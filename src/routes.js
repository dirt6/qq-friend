// API 路由表：把 handleHttp 的巨型 if-else 链拆成声明式路由。
//
// 每个路由：{ method, pattern, handler }
//   - method: 'GET' | 'POST' | 'PUT' | 'DELETE' | '*'（'*' 匹配任意方法）
//   - pattern: 字符串（精确匹配）或 RegExp（exec 捕获组传给 handler）
//   - handler: async (ctx) => 结果
//       ctx = { req, res, url, pathname, method, match, body?, ...deps }
//       handler 返回 undefined 表示"已自行写响应"（如 SSE）；否则框架统一 json() 返回。
//
// 依赖（store/memory/sessions/onebot/orchestrator/…）通过 createRoutes(deps) 注入，
// 路由 handler 通过闭包取用，避免在 app.js 里反复传参。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile, spawnSync as childProcessSpawnSync } from 'node:child_process';
import { getConfig, updateConfig, deepMerge as deepMergeConfig, DATA_DIR } from './config.js';
import { setStatus as learnedSetStatus, saveItem as learnedSaveItem, removeItem as learnedRemoveItem, archiveStale as learnedArchiveStale, listAll as learnedListAll } from './learned.js';
import { loadStickerStore, saveStickerStore, mergeStickerLibrary, normalizeStickerEntry } from './stickers.js';
import { customSearch } from './web-search.js';
import { listModels, chatCompletion, chatCompletionObserved, resolveApiKey, estimateCost, cacheHitRate } from './llm.js';
import { resolveOfficialPrice, listOfficialPrices } from './model-prices.js';
import { refreshPriceFeed, priceFeedStatus, initPriceFeed } from './price-feed.js';
import {
  currentProviders, setProviderKey, testAllProviders, testOneProvider,
  testModelChat, fetchModelsFrom, upsertProvider, addModelsToProvider, removeModelFromProvider, removeProvider
} from './providers.js';
import { scanModelsVision, visionResults, modelImageVerdict } from './vision-scan.js';
import { builtinVisionResults } from './model-vision-docs.js';
import { todayKey } from './util.js';
import { logger } from './logger.js';
import { skillManager } from './skills/manager.js';
import { getSkillConfig, setSkillConfig, setSkillEnabled, listConfiguredSkillIds } from './skills/config.js';
import { availabilityOf, listTools, CATEGORY_META } from './tool-registry.js';
import { safeFetchBinary, browseLockState } from './safe-fetch.js';
import { listDrawings, updateDrawingTitle } from './draw.js';
import { write as diaryWrite, removeLine as diaryRemoveLine, relevelLine as diaryRelevel, dateKey as diaryDateKey } from './diary/index.js';
import { readDiaryFiles } from './diary/parse.js';
import { sha8 } from './star-map/projection.js';
import { buildGraphCached as starMapGraph, getNode as starMapNode, stats as starMapStats, readOverrides, writeOverrides } from './star-map/index.js';
import { listIdleActivities, runIdleActivity } from './idle-activities.js';
import { readSelfWake } from './idle-wake.js';
import { readCompanion, activeGoal, activePending } from './companion/state.js';
import { buildIdleMetrics, readUsageDays } from './idle-metrics.js';
import { buildGovernanceView } from './memory-governance-view.js';
import { stats as memoryHubStats } from './memory-hub/index.js';
import { getGlobalBlocklist, updateGlobalBlocklist, FIXED_PRICE_FEED_URL } from './community.js';
import { listAccounts, removeAccount, loginAccount, publishModule, verifyInstallCodes, installByCode } from './market.js';
import { detectDialect as detectThinkingDialect } from './thinking.js';

/**
 * 构建路由表。
 * @param {object} deps 依赖注入
 */
export function createRoutes(deps) {
  // ══ R7-A 记忆写入的公共防护（2026-11-03）══════════════════════════
  //
  // ⚠️ 先说清一个**既存风险**：
  //    data/config.json 的 server.token 未配置 → authorize() 直接放行，
  //    也就是说 3210 **目前没有任何认证**。
  //    下面的检查**不是权限系统**，只是三条"不依赖 token"的最小防护。
  //
  //    真正的权限模型要等 R7 的完整设计（工具分级 + fail-closed）。
  //    在那之前，这些写操作至少做到：只能从本机界面发起、只接受 JSON、危险操作要确认。

  /** 请求是否来自本机界面（缺省来源信息时放行 —— 兼容 curl / 本机脚本）。 */
  function isLocalUiRequest(req) {
    const h = req.headers || {};
    const orig = h.origin || '';
    const ref = h.referer || '';
    const isLoop = (s) => {
      try {
        const u = new URL(String(s));
        return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
      } catch { return false; }
    };
    if (orig && !isLoop(orig)) return false;
    if (ref && !isLoop(ref)) return false;
    return true;
  }

  /** 必须是 JSON 请求（防 CSRF 的简单请求绕过）。 */
  function isJsonRequest(req) {
    const ct = String(req.headers?.['content-type'] || '').toLowerCase();
    return ct.includes('application/json');
  }

  /** 记一条写入审计（**记录结果，不只是请求**）。 */
  function auditMemoryWrite(entry) {
    try {
      const dir = path.join(getConfig()?.dataDir || DATA_DIR, 'logs');
      const file = path.join(dir, 'memory-write-audit.jsonl');
      fs.mkdirSync(dir, { recursive: true });
      // 只轮转一次（不无限增长）
      try {
        const st = fs.statSync(file);
        if (st.size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
      } catch { /* 没有就算了 */ }
      fs.appendFileSync(file, JSON.stringify({
        at: new Date().toISOString(),
        ...entry
      }) + '\n', 'utf8');
    } catch { /* 审计写不了不能影响主流程 */ }
  }

  // ══ R7-B 运维接口的辅助（2026-11-03）════════════════════════════
  //
  // ⚠️ 三条硬约束（机主指定）：
  //   ① **固定动作白名单** —— 下面只有这几个常量函数，不接受任何"执行命令"参数
  //   ② **明确进程归属** —— bot 的 PID 只从 lock 文件读，不按进程名找
  //   ③ NapCat 保留原有提权方式，不改

  /** bot 的进程归属来源：和 8899 完全一致的 lock 文件。 */
  function botLockPath() {
    return path.join(DATA_DIR, 'qq-agent.lock');
  }

  /** 读 bot 的 PID。读不到 = 没在跑（不猜、不按进程名找）。 */
  function botPid() {
    try {
      const v = fs.readFileSync(botLockPath(), 'utf8').trim();
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch { return null; }
  }

  /** PID 还活着吗。 */
  function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** 机器人批处理的路径（**写死**，不接受参数）。 */
  function botBatPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '启动QQ机器人.bat');
  }

  /** NapCat 启动批处理的路径（**写死**）。 */
  function napcatBatPath() {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'napcat', '启动NapCat-QQ.bat');
  }

  /** 运维审计（**记录结果**，不含敏感内容）。 */
  function auditOps(entry) {
    try {
      const dir = path.join(DATA_DIR, 'logs');
      const file = path.join(dir, 'ops-audit.jsonl');
      fs.mkdirSync(dir, { recursive: true });
      try {
        const st = fs.statSync(file);
        if (st.size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
      } catch { /* 没有就算了 */ }
      fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8');
    } catch { /* 审计写不了不能影响主流程 */ }
  }

  /**
   * 统一的写操作前置检查。
   * @returns {null|object} null = 通过；否则是要直接返回的错误对象
   */
  function guardWrite(req, opName, extra = {}) {
    if (!isLocalUiRequest(req)) {
      auditMemoryWrite({ op: opName, result: 'denied', reason: 'NON_LOCAL_ORIGIN', ...extra });
      return { ok: false, code: 'NON_LOCAL_ORIGIN', error: '只接受本机界面的请求' };
    }
    if (!isJsonRequest(req)) {
      auditMemoryWrite({ op: opName, result: 'denied', reason: 'NOT_JSON', ...extra });
      return { ok: false, code: 'NOT_JSON', error: '必须使用 application/json' };
    }
    return null;
  }

  const {
    store, memory, sessions, onebot, orchestrator,
    g1,
    runtime,
    idleScheduler,
    idleGoalLog,
    emit, log,
    // app.js 内部的过程/状态
    localVersion, compareSemver, UPDATE_INFO_URL,
    sanitizeConfig, keyEndpointAllowed, sanitizeProvider,
    readBody, authorize,
    snowlumaDir, snowlumaWsPort, snowlumaWebuiUrl, snowlumaStatus, snowlumaLogs,
    launchSnowluma, stopSnowluma,
    qqPortableStatus, qqPortableLogs, launchPortableQQ, stopPortableQQ,
    visionScan,
    buildUsageStats, buildUsageBreakdown,
    reloadSkills
  } = deps;

  // 小工具：读请求体（容错：没 body 当空对象）。
  // 但 readBody 明确标记的可暴露错误（400 非法 JSON / 413 过大）必须透传，
  // 否则会从"应返回 400"退化成静默当成空 patch。
  const bodyOf = (req) => readBody(req).catch((e) => { if (e?.expose) throw e; return {}; });

  /**
   * Skill 可用性判断的运行期上下文。
   * 必须和 orchestrator 用同一份输入，否则会出现
   * "设置页说可用、运行时空工具列表"的口径分裂。
   */
  const skillRuntimeContext = () => {
    const cfg = getConfig();
    return {
      skills: skillManager,
      toolsCfg: cfg.tools || {},
      // 与 orchestrator 同款判定：vision 开关开着，且当前模型没有被
      // 视觉扫描判定为 no-vision（曾经只看前半项，模型不支持时
      // 设置页仍显示视觉工具可用，运行时却剔除）
      visionEnabled: cfg.api?.vision !== false
        && modelImageVerdict(cfg.api?.provider, cfg.api?.model) !== 'no-vision',
      searchEnabled: cfg.webSearch?.enabled !== false,
      runtimeContext: {
        model: cfg.api?.model || '',
        provider: cfg.api?.provider || '',
        source: 'api'
      }
    };
  };

  return [
    // ══ G1 只读运行（主进程）════════════════════════════════════════
    // 严格 token 头鉴权（不接受 URL token）；Origin 由 app 全局校验。
    {
      method: 'POST', pattern: '/api/g1/run',
      handler: async ({ req, res, json }) => {
        if (!g1 || !g1.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const nonce = String(req.headers['x-g1-nonce'] || '');
        const r = await g1.run({ nonce });
        return json(res, r.status || 200, r.ok ? { ok: true, result: r.result } : { ok: false, code: r.code });
      }
    },
    {
      method: 'POST', pattern: '/api/g1/pause',
      handler: async ({ req, res, json }) => {
        if (!g1 || !g1.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const body = await bodyOf(req);
        const paused = body?.paused !== false;
        const r = await g1.setPaused(paused);
        return json(res, r.status || 200, r);
      }
    },
    {
      method: 'GET', pattern: '/api/g1/status',
      handler: async ({ req, res, json }) => {
        if (!g1 || !g1.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        return json(res, 200, { ok: true, ...g1.status() });
      }
    },
    // ══ 5.0-E6：生产 Runtime（独立控制 token；G2/G3 默认 disabled）════
    {
      method: 'GET', pattern: '/api/5.0/status',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        return json(res, 200, { ok: true, ...runtime.status() });
      }
    },
    {
      method: 'POST', pattern: '/api/5.0/pause',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const body = await bodyOf(req);
        const r = await runtime.setPaused(body?.paused !== false);
        return json(res, r.ok === false ? 503 : 200, { ok: r.ok !== false, ...r });
      }
    },
    {
      method: 'POST', pattern: '/api/5.0/features',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const body = await bodyOf(req);
        if (typeof body?.g2 === 'boolean') { const r = runtime.setEnabled('g2', body.g2); if (r.ok === false) return json(res, 503, { ok: false, ...r }); }
        if (typeof body?.g3 === 'boolean') { const r = runtime.setEnabled('g3', body.g3); if (r.ok === false) return json(res, 503, { ok: false, ...r }); }
        if (typeof body?.readonly === 'boolean') { const r = runtime.setEnabled('readonly', body.readonly); if (r.ok === false) return json(res, 503, { ok: false, ...r }); }
        if (typeof body?.draw === 'boolean') { const r = runtime.setEnabled('draw', body.draw); if (r.ok === false) return json(res, 503, { ok: false, ...r }); }
        return json(res, 200, { ok: true, ...runtime.status() });
      }
    },
    {
      method: 'POST', pattern: '/api/5.0/run',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const body = await bodyOf(req);
        const r = await runtime.run(body || {});
        const code = r?.reason === 'PAUSED' ? 423 : (r?.reason === 'STATE_CORRUPT' ? 503 : (r?.ok === false ? 403 : 200));
        return json(res, code, { ok: r?.ok !== false, result: r });
      }
    },
    // 5.0 空闲活动注册：手动/未来调度共用；当前不启动定时器
    {
      method: 'GET', pattern: '/api/5.0/idle',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const st = idleScheduler?.status?.() || { enabled: false, scheduled: false, activities: listIdleActivities() };
        // 目标循环：最近几轮“醒来做了什么”，只读账本，不触发任何动作。
        let goalCycle = null;
        try {
          goalCycle = idleGoalLog
            ? { entries: idleGoalLog.status?.().entries ?? 0, last: idleGoalLog.last(), recent: idleGoalLog.recent({ limit: 8 }) }
            : null;
        } catch { goalCycle = null; }
        return json(res, 200, { ok: true, activities: listIdleActivities(), ...st, goalCycle, scheduled: Boolean(idleScheduler), paused: runtime.status().paused });
      }
    },
    {
      method: 'POST', pattern: '/api/5.0/idle/run',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        const body = await bodyOf(req);
        const id = String(body?.activity || '').trim();
        if (!listIdleActivities().some((a) => a.id === id)) return json(res, 200, { ok: false, code: 'UNKNOWN_ACTIVITY' });
        const r = await runIdleActivity(id, { days: Number(body?.days) || 7, limit: Number(body?.limit) || 8 });
        return json(res, r.ok ? 200 : 503, { ok: r.ok === true, result: r });
      }
    },
    // R10：近 7 天运行指标（只读）。不触发任何动作。
    {
      method: 'GET', pattern: '/api/5.0/metrics',
      handler: async ({ req, res, json }) => {
        if (!runtime || !runtime.authorize(req)) return json(res, 401, { ok: false, code: 'UNAUTHORIZED' });
        try {
          const pending = activePending();
          const m = buildIdleMetrics({
            entries: idleGoalLog ? idleGoalLog.recent({ limit: 300 }) : [],
            usageDays: readUsageDays(),
            now: Date.now(),
            windowDays: 7,
            pendingActive: pending.length,
            pendingAsked: pending.reduce((s, p) => s + (Number(p?.askCount) || 0), 0)
          });
          return json(res, 200, m);
        } catch (e) {
          return json(res, 200, { ok: false, error: String(e?.message ?? e) });
        }
      }
    },
    // ══ R7-C D5：图片管理的写操作（从 8899 迁移）══════════════════════

    // 同步 QQ 收藏的表情包
    {
      method: 'POST', pattern: '/api/stickers/sync',
      handler: async ({ json, res, req }) => {
        const g = guardWrite(req, 'stickers.sync');
        if (g) return json(res, 200, g);

        // 走 OneBot 的 fetch_custom_face_detail
        const cfg = getConfig();
        const sl = cfg.snowluma || {};
        const url = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const token = String(sl.httpAccessToken || '');

        let body = null;
        try {
          const r = await fetch(url + '/fetch_custom_face_detail', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
            body: JSON.stringify({ count: 200 }),
            signal: AbortSignal.timeout(15000)
          });
          body = await r.json().catch(() => null);
        } catch (e) {
          auditOps({ op: 'stickers.sync', result: 'failed', reason: 'ONEBOT_UNREACHABLE' });
          return json(res, 200, { ok: false, code: 'ONEBOT_UNREACHABLE', error: '连不上 NapCat：' + String(e?.message ?? e) });
        }

        const list = Array.isArray(body) ? body : (Array.isArray(body?.data) ? body.data : null);
        if (!list) {
          auditOps({ op: 'stickers.sync', result: 'failed', reason: 'NO_DATA' });
          return json(res, 200, { ok: false, code: 'NO_DATA', error: 'NapCat 没返回收藏列表' });
        }

        try {
          const before = loadStickerStore();
          const merged = mergeStickerLibrary(before, list);
          saveStickerStore(merged);
          auditOps({ op: 'stickers.sync', result: 'ok', before: before.length, after: merged.length });
          return json(res, 200, {
            ok: true,
            message: '同步完成：QQ 收藏 ' + list.length + ' 个，库里 ' + before.length + ' → ' + merged.length + ' 个',
            before: before.length,
            after: merged.length
          });
        } catch (e) {
          auditOps({ op: 'stickers.sync', result: 'failed', reason: 'SAVE_FAILED' });
          return json(res, 200, { ok: false, code: 'SAVE_FAILED', error: String(e?.message ?? e) });
        }
      }
    },

    // 改备注 / 描述 / 标签
    {
      method: 'POST', pattern: '/api/stickers/note',
      handler: async ({ json, res, req, body }) => {
        const id = String(body?.id || '').trim();
        const g = guardWrite(req, 'stickers.note', { id });
        if (g) return json(res, 200, g);
        if (!id) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 不能为空' });

        let list = [];
        try { list = loadStickerStore(); } catch (e) {
          return json(res, 200, { ok: false, code: 'LOAD_FAILED', error: String(e?.message ?? e) });
        }
        const i = list.findIndex((e) => String(e.id || e.resId) === id);
        if (i < 0) {
          auditOps({ op: 'stickers.note', result: 'failed', reason: 'NOT_FOUND', id });
          return json(res, 200, { ok: false, code: 'NOT_FOUND', error: '没找到这个表情' });
        }

        const e = { ...list[i] };
        if (body.localNote !== undefined) e.localNote = String(body.localNote).trim().slice(0, 500);
        if (body.desc !== undefined) e.desc = String(body.desc).trim().slice(0, 200);
        if (body.tags !== undefined) {
          e.tags = String(body.tags).split(/[,，、]/).map((x) => x.trim()).filter(Boolean).slice(0, 20);
        }
        e.updatedAt = new Date().toISOString();
        list[i] = e;
        try { saveStickerStore(list); } catch (err) {
          return json(res, 200, { ok: false, code: 'SAVE_FAILED', error: String(err?.message ?? err) });
        }
        auditOps({ op: 'stickers.note', result: 'ok', id });
        return json(res, 200, { ok: true, message: '已保存（她下次唤醒时就能看到）' });
      }
    },

    // 修复表情包：把"只有 http 直链"的下载成本地文件
    //
    // 2026-11-03 实测数据：33 个表情里
    //   · 21 个已有本地文件（file:///）—— 永久有效
    //   · **12 个只有 http 直链** —— QQ 图床的 rkey 大约 1 小时过期，之后 403/404
    // 这 12 个就是"表情经常发送失败"的来源。这条路由把它们转存到本地。
    {
      method: 'POST', pattern: '/api/stickers/repair',
      handler: async ({ json, res, req }) => {
        const g = guardWrite(req, 'stickers.repair');
        if (g) return json(res, 200, g);

        let list = [];
        try { list = loadStickerStore(); } catch (e) {
          return json(res, 200, { ok: false, code: 'LOAD_FAILED', error: String(e?.message ?? e) });
        }

        const dir = path.join(DATA_DIR, 'sticker-images');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }

        const need = list.filter((e) => {
          const lf = String(e.localFile || '');
          if (lf.startsWith('file:///')) {
            const name = lf.split('/').pop();
            return !fs.existsSync(path.join(dir, name));
          }
          return true;   // 没有本地文件 → 需要修
        });

        if (!need.length) {
          return json(res, 200, { ok: true, message: '所有表情都有本地文件，不用修', total: list.length, repaired: 0, failed: 0 });
        }

        let repaired = 0;
        let failed = 0;
        const errors = [];

        for (const e of need) {
          const url = String(e.url || e.localFile || '').trim();
          if (!url || !/^https?:/i.test(url)) { failed += 1; errors.push(String(e.id) + ': 没有可下载的 http 地址'); continue; }
          try {
            const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
            if (!r.ok) { failed += 1; errors.push(String(e.id) + ': HTTP ' + r.status); continue; }
            const buf = Buffer.from(await r.arrayBuffer());
            if (!buf.length) { failed += 1; errors.push(String(e.id) + ': 空文件'); continue; }

            const ct = String(r.headers.get('content-type') || '');
            const ext = ct.includes('png') ? '.png' : (ct.includes('gif') ? '.gif' : (ct.includes('webp') ? '.webp' : '.jpg'));
            const safeId = String(e.id || e.resId || 'sticker').replace(/[^a-zA-Z0-9_.-]/g, '_');
            const name = safeId + ext;
            fs.writeFileSync(path.join(dir, name), buf);

            e.localFile = 'file:///' + path.join(dir, name).replace(/\\/g, '/');
            e.url = e.localFile;
            e.persistFailed = false;
            e.updatedAt = new Date().toISOString();
            repaired += 1;
          } catch (err) {
            failed += 1;
            errors.push(String(e.id) + ': ' + String(err?.message ?? err).slice(0, 80));
          }
        }

        try { saveStickerStore(list); } catch (e) {
          return json(res, 200, { ok: false, code: 'SAVE_FAILED', error: String(e?.message ?? e), repaired, failed });
        }

        auditOps({ op: 'stickers.repair', result: 'ok', total: need.length, repaired, failed });
        return json(res, 200, {
          ok: true,
          message: `修好了 ${repaired} 个${failed ? '（' + failed + ' 个失败）' : ''}`,
          total: list.length,
          need: need.length,
          repaired,
          failed,
          errors: errors.slice(0, 5)
        });
      }
    },

    // 从库里移除（**不删本地图片，也不动 QQ 收藏**）
    {
      method: 'POST', pattern: '/api/stickers/delete',
      handler: async ({ json, res, req, body }) => {
        const id = String(body?.id || '').trim();
        const g = guardWrite(req, 'stickers.delete', { id });
        if (g) return json(res, 200, g);
        if (!id) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 不能为空' });
        if (body?.confirm !== true) {
          auditOps({ op: 'stickers.delete', result: 'denied', reason: 'NO_CONFIRM', id });
          return json(res, 200, { ok: false, code: 'NO_CONFIRM', error: '删除需要 confirm: true' });
        }

        let list = [];
        try { list = loadStickerStore(); } catch (e) {
          return json(res, 200, { ok: false, code: 'LOAD_FAILED', error: String(e?.message ?? e) });
        }
        const next = list.filter((e) => String(e.id || e.resId) !== id);
        if (next.length === list.length) {
          auditOps({ op: 'stickers.delete', result: 'failed', reason: 'NOT_FOUND', id });
          return json(res, 200, { ok: false, code: 'NOT_FOUND', error: '没找到这个表情' });
        }
        try { saveStickerStore(next); } catch (e) {
          return json(res, 200, { ok: false, code: 'SAVE_FAILED', error: String(e?.message ?? e) });
        }
        auditOps({ op: 'stickers.delete', result: 'ok', id });
        return json(res, 200, {
          ok: true,
          message: '已从她的库里移除（QQ 收藏和本地图片都没动）',
          before: list.length,
          after: next.length
        });
      }
    },

    // 删掉一张画（**真删文件**，必须 confirm）
    {
      method: 'POST', pattern: '/api/drawings/delete',
      handler: async ({ json, res, req, body }) => {
        const name = String(body?.name || '').trim();
        const g = guardWrite(req, 'drawings.delete', { name });
        if (g) return json(res, 200, g);
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          return json(res, 200, { ok: false, code: 'BAD_NAME', error: '文件名不合法' });
        }
        if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) {
          return json(res, 200, { ok: false, code: 'BAD_TYPE', error: '只支持图片' });
        }
        if (body?.confirm !== true) {
          auditOps({ op: 'drawings.delete', result: 'denied', reason: 'NO_CONFIRM', name });
          return json(res, 200, { ok: false, code: 'NO_CONFIRM', error: '删除需要 confirm: true' });
        }

        const full = path.join(DATA_DIR, 'drawings', name);
        if (!fs.existsSync(full)) {
          auditOps({ op: 'drawings.delete', result: 'failed', reason: 'NOT_FOUND', name });
          return json(res, 200, { ok: false, code: 'NOT_FOUND', error: '这张画不存在' });
        }
        try { fs.unlinkSync(full); } catch (e) {
          auditOps({ op: 'drawings.delete', result: 'failed', reason: 'UNLINK_FAILED', name });
          return json(res, 200, { ok: false, code: 'UNLINK_FAILED', error: String(e?.message ?? e) });
        }
        auditOps({ op: 'drawings.delete', result: 'ok', name });
        return json(res, 200, { ok: true, message: '已删除 ' + name });
      }
    },

    // ══ R7-C D/E/F：日记 / 图片管理 / 空闲时间（2026-11-03）══════════

    // 日记（只读）
    //
    // 数据：E:\dsh\本子\日记\每日\YYYY-MM-DD.md
    // 格式：第一行是 # 标题，每条是 "- 心情：xxx｜内容"，[重要] 前缀标记重要
    {
      method: 'GET', pattern: '/api/diary',
      handler: async ({ json, res, url }) => {
        const limit = Math.min(60, Math.max(1, Number(url.searchParams.get('days')) || 7));
        const cfg = getConfig();
        const rootDefault = 'E:\\dsh\\本子\\日记';
        const root = String(cfg?.skills?.diary?.root || rootDefault);
        const dir = path.join(root, '每日');

        const rd = readDiaryFiles({ dir });
        if (!rd.ok) {
          return json(res, 200, { ok: true, days: [], note: rd.error || ('日记目录还不存在：' + dir) });
        }
        // 与旧接口一致：最近 limit 天、日期倒序；正文截 800 字。
        const out = rd.days.slice(-limit).reverse().map((d) => ({
          day: d.day,
          title: d.title,
          entries: d.entries.map((e) => ({
            mood: e.mood,
            text: e.text.slice(0, 800),
            important: e.important,
            importance: e.importance
          }))
        }));
        return json(res, 200, { ok: true, days: out, root });
      }
    },
    // 日记新增（面板；只走统一 writer，不直接改 Markdown）
    {
      method: 'POST', pattern: '/api/diary/add',
      handler: async ({ json, res, req, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'diary.add');
        if (g) return json(res, 200, g);
        const day = String(body?.day || diaryDateKey()).trim();
        const content = String(body?.content || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 200, { ok: false, code: 'BAD_DAY', error: '日期必须是 YYYY-MM-DD' });
        if (!content.trim()) return json(res, 200, { ok: false, code: 'EMPTY_CONTENT', error: '内容不能为空' });
        if (content.length > 2000) return json(res, 200, { ok: false, code: 'TOO_LONG', error: '日记最多 2000 字' });
        const cfg = getConfig();
        const root = path.join(String(cfg?.skills?.diary?.root || 'E:\\dsh\\本子\\日记'), '每日');
        const r = diaryWrite({ content, source: 'panel', day, mood: String(body?.mood || ''), importance: String(body?.importance || ''), root });
        auditOps({ op: 'diary.add', result: r.ok ? 'ok' : 'failed', day, reason: r.error || '' });
        return json(res, 200, r.ok ? { ok: true, day, result: r } : { ok: false, code: 'DIARY_WRITE_FAILED', error: r.error || '写入失败' });
      }
    },
    // 日记修改（先移除唯一匹配行，再用统一 writer 写入；removeLine 会保留 trash 备份）
    {
      method: 'POST', pattern: '/api/diary/edit',
      handler: async ({ json, res, req, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'diary.edit');
        if (g) return json(res, 200, g);
        const day = String(body?.day || '').trim();
        const match = String(body?.match || '').trim();
        const content = String(body?.content || '');
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 200, { ok: false, code: 'BAD_DAY', error: '日期必须是 YYYY-MM-DD' });
        if (match.length < 2) return json(res, 200, { ok: false, code: 'BAD_MATCH', error: '原内容至少两个字' });
        if (!content.trim()) return json(res, 200, { ok: false, code: 'EMPTY_CONTENT', error: '新内容不能为空' });
        if (content.length > 2000) return json(res, 200, { ok: false, code: 'TOO_LONG', error: '日记最多 2000 字' });
        const cfg = getConfig();
        const root = path.join(String(cfg?.skills?.diary?.root || 'E:\\dsh\\本子\\日记'), '每日');
        const del = diaryRemoveLine({ match, day, root });
        if (!del.ok) return json(res, 200, { ok: false, code: 'NOT_FOUND_OR_AMBIGUOUS', error: del.reason || '删除旧行失败', candidates: del.candidates || [] });
        const old = /^-\s*心情：([^｜]*)｜(?:\[([^\]]+)\]\s*)?(.*)$/.exec(String(del.removed || '').trim());
        const w = diaryWrite({
          content, source: 'panel', day,
          mood: String(body?.mood || old?.[1] || ''), importance: String(body?.importance || old?.[2] || ''),
          root, idempotencyKey: `panel-edit:${day}:${Date.now()}`
        });
        if (!w.ok) {
          // 尽量恢复旧行，避免编辑失败导致丢失
          try { diaryWrite({ content: old?.[3] || match, source: 'panel', day, mood: old?.[1] || '', importance: old?.[2] || '', root, idempotencyKey: `panel-restore:${day}:${Date.now()}` }); } catch { /* ignore */ }
          return json(res, 200, { ok: false, code: 'DIARY_WRITE_FAILED', error: w.error || '写入新内容失败' });
        }
        auditOps({ op: 'diary.edit', result: 'ok', day });
        return json(res, 200, { ok: true, day, result: w });
      }
    },
    // 日记删除（唯一匹配；removeLine 有候选/歧义保护）
    {
      method: 'POST', pattern: '/api/diary/delete',
      handler: async ({ json, res, req, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'diary.delete');
        if (g) return json(res, 200, g);
        const day = String(body?.day || '').trim();
        const match = String(body?.match || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return json(res, 200, { ok: false, code: 'BAD_DAY', error: '日期必须是 YYYY-MM-DD' });
        if (match.length < 2) return json(res, 200, { ok: false, code: 'BAD_MATCH', error: '要删的内容至少两个字' });
        const cfg = getConfig();
        const root = path.join(String(cfg?.skills?.diary?.root || 'E:\\dsh\\本子\\日记'), '每日');
        const r = diaryRemoveLine({ match, day, root });
        auditOps({ op: 'diary.delete', result: r.ok ? 'ok' : 'failed', day, reason: r.reason || '' });
        return json(res, 200, r.ok ? { ok: true, day, removed: r.removed || '', pendingSync: r.pendingSync === true } : { ok: false, code: 'DELETE_FAILED', error: r.reason || '删除失败', candidates: r.candidates || [] });
      }
    },

    // 星图（5.0 P0：只读投影；不写日记、不写记忆）
    {
      method: 'GET', pattern: '/api/star-map/graph',
      handler: async ({ json, res, url }) => {
        const scope = String(url.searchParams.get('scope') || 'diary');
        if (scope !== 'diary' && scope !== 'all') {
          return json(res, 400, { ok: false, code: 'BAD_SCOPE', error: 'scope 只能是 diary / all' });
        }
        const days = String(url.searchParams.get('days') || 'all');
        if (days !== 'all') {
          return json(res, 400, { ok: false, code: 'BAD_DAYS', error: '星图目前只支持 days=all' });
        }
        return json(res, 200, starMapGraph({ scope }));
      }
    },
    {
      method: 'GET', pattern: '/api/star-map/node',
      handler: async ({ json, res, url }) => {
        const id = String(url.searchParams.get('id') || '');
        if (!id) return json(res, 400, { ok: false, code: 'BAD_ID', error: '缺 id' });
        return json(res, 200, starMapNode(id));
      }
    },
    {
      method: 'GET', pattern: '/api/star-map/stats',
      handler: async ({ json, res }) => json(res, 200, starMapStats())
    },
    {
      method: 'GET', pattern: '/api/star-map/overrides',
      handler: async ({ json, res }) => json(res, 200, { ok: true, ...readOverrides() })
    },
    {
      method: 'POST', pattern: '/api/star-map/override',
      handler: async ({ json, res, req, body: bodyArg }) => {
        const g = guardWrite(req, 'star-map.override');
        if (g) return json(res, 200, g);
        const body = bodyArg ?? await bodyOf(req);
        const action = String(body?.action || '');
        const ov = readOverrides();

        if (action === 'add-topic') {
          const name = String(body?.name || '').trim().slice(0, 20);
          if (!name) return json(res, 200, { ok: false, code: 'BAD_NAME', error: '话题名不能为空' });
          if (ov.customTopics.some((t) => t.name === name)) {
            return json(res, 200, { ok: false, code: 'DUP', error: '已经有同名旋臂' });
          }
          ov.customTopics.push({ name });
          ov.removedTopics = ov.removedTopics.filter((n) => n !== name);
          writeOverrides(ov);
          return json(res, 200, { ok: true, name });
        }

        if (action === 'remove-topic') {
          const name = String(body?.name || '').trim();
          if (!name) return json(res, 200, { ok: false, code: 'BAD_NAME', error: '缺话题名' });
          ov.customTopics = ov.customTopics.filter((t) => t.name !== name);
          if (!ov.removedTopics.includes(name)) ov.removedTopics.push(name);
          for (const [id, t] of Object.entries(ov.nodeTopics)) if (t === name) delete ov.nodeTopics[id];
          writeOverrides(ov);
          return json(res, 200, { ok: true, name });
        }

        if (action === 'move-topic') {
          const nodeId = String(body?.nodeId || '');
          const name = String(body?.topicName || '').trim();
          if (!nodeId || !name) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 nodeId / topicName' });
          ov.nodeTopics[nodeId] = name;
          writeOverrides(ov);
          return json(res, 200, { ok: true, nodeId, topicName: name });
        }

        if (action === 'set-topic-angle') {
          const name = String(body?.name || '').trim();
          const angle = Number(body?.angle);
          if (!name || !Number.isFinite(angle)) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 name / angle' });
          ov.topicAngles = ov.topicAngles && typeof ov.topicAngles === 'object' ? ov.topicAngles : {};
          ov.topicAngles[name] = Math.atan2(Math.sin(angle), Math.cos(angle));
          writeOverrides(ov);
          return json(res, 200, { ok: true, name, angle: ov.topicAngles[name] });
        }

        if (action === 'set-topic') {
          const name = String(body?.name || '').trim();
          const newName = String(body?.newName || '').trim().slice(0, 20);
          const tags = Array.isArray(body?.tags)
            ? body.tags.map((t) => String(t).trim().slice(0, 12)).filter(Boolean).slice(0, 8)
            : null;
          if (!name) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺话题名' });
          ov.topicTags = ov.topicTags && typeof ov.topicTags === 'object' ? ov.topicTags : {};
          ov.topicAngles = ov.topicAngles && typeof ov.topicAngles === 'object' ? ov.topicAngles : {};
          let target = name;
          if (newName && newName !== name) {
            target = newName;
            ov.customTopics = (ov.customTopics || []).map((t) => (t.name === name ? { ...t, name: newName } : t));
            if (!ov.customTopics.some((t) => t.name === newName)) ov.customTopics.push({ name: newName });
            ov.removedTopics = (ov.removedTopics || []).filter((n) => n !== newName && n !== name);
            ov.removedTopics.push(name);
            for (const [id, tn] of Object.entries(ov.nodeTopics || {})) if (tn === name) ov.nodeTopics[id] = newName;
            if (ov.topicAngles[name] != null) { ov.topicAngles[newName] = ov.topicAngles[name]; delete ov.topicAngles[name]; }
            if (ov.topicTags[name]) { ov.topicTags[newName] = ov.topicTags[name]; delete ov.topicTags[name]; }
          }
          if (tags) ov.topicTags[target] = tags;
          writeOverrides(ov);
          return json(res, 200, { ok: true, name: target, tags: ov.topicTags[target] || [] });
        }

        if (action === 'add-link') {
          const from = String(body?.from || '');
          const to = String(body?.to || '');
          if (!from || !to || from === to) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 from / to' });
          ov.links = Array.isArray(ov.links) ? ov.links : [];
          if (!ov.links.some((l) => (l.from === from && l.to === to) || (l.from === to && l.to === from))) {
            ov.links.push({ from, to });
          }
          writeOverrides(ov);
          return json(res, 200, { ok: true });
        }

        if (action === 'remove-link') {
          const from = String(body?.from || '');
          const to = String(body?.to || '');
          if (!from || !to) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 from / to' });
          ov.links = (Array.isArray(ov.links) ? ov.links : [])
            .filter((l) => !((l.from === from && l.to === to) || (l.from === to && l.to === from)));
          writeOverrides(ov);
          return json(res, 200, { ok: true });
        }

        if (action === 'set-node-position') {
          const nodeId = String(body?.nodeId || '');
          const angle = Number(body?.angle);
          const radius = Number(body?.radius);
          if (!nodeId || !Number.isFinite(angle) || !Number.isFinite(radius)) {
            return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 nodeId / angle / radius' });
          }
          ov.nodePositions = ov.nodePositions && typeof ov.nodePositions === 'object' ? ov.nodePositions : {};
          ov.nodePositions[nodeId] = {
            angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
            radius: Math.max(0.03, Math.min(1.05, radius))
          };
          writeOverrides(ov);
          return json(res, 200, { ok: true });
        }

        if (action === 'clear-node-position') {
          const nodeId = String(body?.nodeId || '');
          if (!nodeId) return json(res, 200, { ok: false, code: 'BAD_ARGS', error: '缺 nodeId' });
          if (ov.nodePositions) delete ov.nodePositions[nodeId];
          writeOverrides(ov);
          return json(res, 200, { ok: true });
        }

        if (action === 'set-importance') {
          const nodeId = String(body?.nodeId || '');
          const importance = String(body?.importance || '');
          if (!['一般', '重要', '非常重要'].includes(importance)) {
            return json(res, 200, { ok: false, code: 'BAD_IMPORTANCE', error: '等级只能是 一般 / 重要 / 非常重要' });
          }
          const m = /^diary:(\d{4}-\d{2}-\d{2}):([0-9a-f]{8})(?:-(\d+))?$/.exec(nodeId);
          if (!m) return json(res, 200, { ok: false, code: 'ONLY_DIARY', error: '只能改日记条目的重要级' });
          const day = m[1];
          const wantHash = m[2];
          const wantDup = m[3] ? Number(m[3]) : 1;
          const cfg = getConfig();
          const root = path.join(String(cfg?.skills?.diary?.root || 'E:\\dsh\\本子\\日记'), '每日');
          const rd = readDiaryFiles({ dir: root });
          const dayData = rd.ok ? rd.days.find((d) => d.day === day) : null;
          if (!dayData) return json(res, 200, { ok: false, code: 'NO_DIARY', error: '这一天没有日记' });
          const seen = new Map();
          let target = '';
          for (const e of dayData.entries) {
            const base = `diary:${day}:${sha8(e.text)}`;
            const n = (seen.get(base) || 0) + 1;
            seen.set(base, n);
            if (base === `diary:${day}:${wantHash}` && n === wantDup) { target = e.text; break; }
          }
          if (!target) return json(res, 200, { ok: false, code: 'NOT_FOUND', error: '这条日记已经不在了' });
          const r = diaryRelevel({ match: target, importance, day, root });
          return json(res, 200, r.ok
            ? { ok: true, nodeId, importance, changed: r.changed !== false }
            : { ok: false, code: 'RELEVEL_FAILED', error: r.reason || '改重要级失败' });
        }

        return json(res, 200, { ok: false, code: 'BAD_ACTION', error: 'action 只能是 add-topic / remove-topic / move-topic / set-importance' });
      }
    },

    // 表情包（只读列表）
    {
      method: 'GET', pattern: '/api/stickers',
      handler: async ({ json, res }) => {
        const file = path.join(DATA_DIR, 'stickers.json');
        let arr = [];
        try {
          const j = JSON.parse(fs.readFileSync(file, 'utf8'));
          arr = Array.isArray(j) ? j : (j.stickers || j.items || []);
        } catch {
          return json(res, 200, { ok: true, total: 0, items: [], note: '还没有表情包数据' });
        }
        const items = arr.map((x) => ({
          id: String(x.id || x.resId || ''),
          file: String(x.qqFile || ''),
          // ⚠️ 只返回相对文件名，不返回完整 file:// 路径（避免暴露绝对路径）
          localName: String(x.localFile || '').split('/').pop().split('\\').pop(),
          // 前端直接用这个 URL 显示图片
          imageUrl: (() => {
            const n = String(x.localFile || '').split('/').pop().split('\\').pop();
            return n ? ('/api/stickers/image?name=' + encodeURIComponent(n)) : '';
          })(),
          note: String(x.note || x.desc || '').slice(0, 120),
          broken: Boolean(x.persistFailed)
        }));
        return json(res, 200, { ok: true, total: items.length, items });
      }
    },

    // 单个表情包图片（只读，**文件名强校验**）
    //
    // 表情包的图片在 data/sticker-images/<id>.<ext>
    // ⚠️ 只接受纯文件名（不带路径），且必须是图片扩展名。
    {
      method: 'GET', pattern: '/api/stickers/image',
      handler: async ({ res, url }) => {
        const name = String(url.searchParams.get('name') || '');
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'BAD_NAME' }));
          return;
        }
        if (!/\.(png|jpg|jpeg|gif|webp)$/i.test(name)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'BAD_TYPE' }));
          return;
        }
        const full = path.join(DATA_DIR, 'sticker-images', name);
        let buf = null;
        try { buf = fs.readFileSync(full); } catch {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
          return;
        }
        const ext = name.toLowerCase().split('.').pop();
        const mime = ext === 'png' ? 'image/png'
          : ext === 'gif' ? 'image/gif'
          : ext === 'webp' ? 'image/webp'
          : 'image/jpeg';
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=86400' });
        res.end(buf);
      }
    },

    // 她的画（标题来自索引，文件以磁盘为准）
    {
      method: 'GET', pattern: '/api/drawings',
      handler: async ({ json, res, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
        try {
          const items = listDrawings({ limit }).map((x) => ({
            name: x.file,
            title: x.title || '',
            note: x.note || '',
            hasTitle: Boolean(x.hasTitle),
            style: x.style || '',
            size: Number(x.bytes) || 0,
            at: x.createdAt,
            url: '/api/drawings/file?name=' + encodeURIComponent(x.file)
          }));
          return json(res, 200, { ok: true, total: items.length, items });
        } catch (e) {
          return json(res, 200, { ok: false, code: 'LIST_FAILED', error: String(e?.message ?? e) });
        }
      }
    },
    // 改画作标题（用户/她共用；只改索引，不动图片）
    {
      method: 'POST', pattern: '/api/drawings/title',
      handler: async ({ json, res, req, body }) => {
        const name = String(body?.name || '').trim();
        const title = String(body?.title ?? '');
        const g = guardWrite(req, 'drawings.title', { name });
        if (g) return json(res, 200, g);
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          return json(res, 200, { ok: false, code: 'BAD_NAME', error: '文件名不合法' });
        }
        if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) return json(res, 200, { ok: false, code: 'BAD_TYPE', error: '只支持图片' });
        if (title.length > 60) return json(res, 200, { ok: false, code: 'TITLE_TOO_LONG', error: '标题最多 60 字' });
        const r = updateDrawingTitle(name, title);
        auditOps({ op: 'drawings.title', result: r.ok ? 'ok' : 'failed', name, titleLength: title.length, reason: r.error || '' });
        return json(res, 200, r.ok ? { ok: true, name, title: r.title } : { ok: false, code: 'TITLE_FAILED', error: r.error || '失败' });
      }
    },

    // 单张画（只读，**文件名强校验**，防路径穿越）
    {
      method: 'GET', pattern: '/api/drawings/file',
      handler: async ({ res, url }) => {
        const name = String(url.searchParams.get('name') || '');
        // ⚠️ 只允许纯文件名，不允许任何路径分隔符
        if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'BAD_NAME', error: '文件名不合法' }));
          return;
        }
        if (!/\.(png|jpg|jpeg|webp)$/i.test(name)) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'BAD_TYPE', error: '只支持图片' }));
          return;
        }
        const full = path.join(DATA_DIR, 'drawings', name);
        let buf = null;
        try { buf = fs.readFileSync(full); } catch {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, code: 'NOT_FOUND' }));
          return;
        }
        const ext = name.toLowerCase().split('.').pop();
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
        res.writeHead(200, { 'content-type': mime, 'cache-control': 'public, max-age=3600' });
        res.end(buf);
      }
    },

    // 空闲时间（她一个人时在做什么，只读）
    {
      method: 'GET', pattern: '/api/autonomous',
      handler: async ({ json, res }) => {
        const file = path.join(DATA_DIR, 'autonomous.json');
        let j = null;
        try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
          return json(res, 200, { ok: true, note: '还没有自主活动数据' });
        }
        const cfg = getConfig();
        // 5.0 空闲的真实状态：调度器（系统周期）+ 她自己设的醒来 + 5.0 Goal/Pending + 运行账本。
        // 旧 autonomous.json 只作为兼容/历史保留，不再是“当前目标/下次醒来”的来源。
        let v5 = null;
        try {
          const st = (typeof idleScheduler?.status === 'function' ? idleScheduler.status() : null) || {};
          const wake = readSelfWake(Date.now());
          const comp = readCompanion();
          const goal = activeGoal(comp);
          const pending = activePending();
          // 已到期但还没被 tick 消费的约醒来，不算“下次”；下一轮就会执行。
          const selfWakeAt = wake?.enabled && wake.due !== true ? Number(wake.wakeAt) || 0 : 0;
          const systemAt = st.nextAt ? Date.parse(String(st.nextAt)) || 0 : 0;
          const candidates = [systemAt, selfWakeAt].filter((x) => x > 0);
          const nextAt = candidates.length ? Math.min(...candidates) : 0;
          const nextWakeSource = !nextAt ? '' : (selfWakeAt && nextAt === selfWakeAt ? 'self' : 'system');
          v5 = {
            enabled: st.enabled === true,
            running: st.running === true,
            status: st.running ? 'RUNNING' : (st.enabled ? 'IDLE' : 'OFF'),
            intervalMinutes: Number(st.intervalMinutes) || 0,
            windowMinutes: Number(st.windowMinutes) || 0,
            activities: Array.isArray(st.activities) ? st.activities : [],
            quietHours: String(st.quietHours || ''),
            // 2026-11-06：应用重启后内存里的 lastStartedAt 会清空，面板“上次醒来”变成 —；
            // 用 5.0 运行账本的最近一条补上（只读，不改调度）。
            lastWakeAt: st.lastStartedAt
              ? new Date(st.lastStartedAt).toISOString()
              : (idleGoalLog?.last?.()?.at ? new Date(Number(idleGoalLog.last().at)).toISOString() : null),
            nextWakeAt: nextAt ? new Date(nextAt).toISOString() : null,
            nextWakeSource,
            selfWake: wake?.enabled ? { wakeAt: new Date(Number(wake.wakeAt)).toISOString(), reason: String(wake.reason || '').slice(0, 120), due: wake.due === true } : null,
            goal: goal ? { text: String(goal.text || '').slice(0, 200), source: String(goal.source || ''), since: goal.since || '' } : null,
            pending: pending.slice(0, 5).map((p) => ({ id: String(p.id || ''), text: String(p.text || '').slice(0, 120), status: String(p.status || ''), at: p.at || '' })),
            // R10：近 7 天运行指标（只读聚合；面板和 API 共用）。
            metrics: (() => {
              try {
                return buildIdleMetrics({
                  entries: idleGoalLog ? idleGoalLog.recent({ limit: 300 }) : [],
                  usageDays: readUsageDays(),
                  now: Date.now(),
                  windowDays: 7,
                  pendingActive: pending.length,
                  pendingAsked: pending.reduce((s, p) => s + (Number(p?.askCount) || 0), 0)
                });
              } catch { return null; }
            })(),
            recent: idleGoalLog ? idleGoalLog.recent({ limit: 12 }).slice().reverse().map((e) => ({
              at: e.at, type: e.type, title: e.title, action: e.action,
              ok: e.ok === true, done: e.done === true, reason: e.reason, summary: e.summary, next: e.next
            })) : []
          };
        } catch { v5 = null; }
        return json(res, 200, {
          ok: true,
          v5,
          legacy: true,
          status: v5?.status || String(j.status || ''),
          lastWakeAt: v5?.lastWakeAt || j.lastWakeAt || null,
          nextWakeAt: v5?.nextWakeAt || j.nextWakeAt || null,
          nextWakeSource: v5?.nextWakeSource || '',
          currentGoal: v5?.goal?.text || '',
          currentTopic: String(j.currentTopic || '').slice(0, 200),
          modelCallsUsed: Number(j.modelCallsUsed) || 0,
          itemsExamined: Number(j.itemsExamined) || 0,
          consecutiveFailures: Number(j.consecutiveFailures) || 0,
          // ⚠️ 只给最近 20 条，不全量传
          // ⚠️ history 的字段是 startedAt/endedAt，不是 at/ts ——
          //    之前读错了，导致时间全部显示「—」，看起来"没有记录"。
          history: (Array.isArray(j.history) ? j.history.slice(-40) : []).map((h) => ({
            roundId: String(h.roundId || ''),
            startedAt: h.startedAt || null,
            endedAt: h.endedAt || null,
            status: String(h.status || '').slice(0, 40),
            modelCalls: Number(h.modelCalls) || 0,
            inputTokens: Number(h.inputTokens) || 0,
            outputTokens: Number(h.outputTokens) || 0,
            candidates: Number(h.candidates) || 0,
            goal: String(h.goal || '').slice(0, 200),
            why: String(h.why || '').slice(0, 300),
            next: String(h.next || '').slice(0, 200),
            stopReason: String(h.stopReason || '').slice(0, 200),
            error: String(h.error || '').slice(0, 200),
            action: String(h.action || '').slice(0, 60)
          })).reverse(),   // 最新的在前
          shares: (Array.isArray(j.shares) ? j.shares.slice(-10) : []).map((x) => ({
            at: x.at || null,
            title: String(x.title || x.name || '').slice(0, 120)
          })),
          digests: (Array.isArray(j.digests) ? j.digests.slice(-7) : []).map((x) => ({
            at: x.at || null,
            text: String(x.text || x.summary || '').slice(0, 300)
          })),
          // 空闲阈值（配置里的）
          idleThresholdMs: Number(cfg?.proactive?.idleThresholdMs) || 1800000
        });
      }
    },

    // 删除一条空闲时间记录（按 roundId）
    //
    // 机主：「让我可以删除，像之前 dryrun 出来的记录之类的」。
    // 这是**真删 autonomous.json 里的 history 条目**，必须 confirm。
    {
      method: 'POST', pattern: '/api/autonomous/delete',
      handler: async ({ json, res, req, body }) => {
        const roundId = String(body?.roundId || '').trim();
        const g = guardWrite(req, 'autonomous.delete', { roundId });
        if (g) return json(res, 200, g);
        if (!roundId) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'roundId 不能为空' });
        if (body?.confirm !== true) {
          auditOps({ op: 'autonomous.delete', result: 'denied', reason: 'NO_CONFIRM', roundId });
          return json(res, 200, { ok: false, code: 'NO_CONFIRM', error: '删除需要 confirm: true' });
        }

        const file = path.join(DATA_DIR, 'autonomous.json');
        // D1-3b B2：不再直接 readFileSync/writeFileSync —— 走唯一领域入口（锁 + 原子写）
        const { deleteHistoryRound } = await import('../../plugins/autonomous/lib/state.js');
        let r;
        try {
          r = deleteHistoryRound(file, roundId);
        } catch (e) {
          auditOps({ op: 'autonomous.delete', result: 'failed', reason: 'WRITE_FAILED', roundId, detail: String(e?.message ?? e).slice(0, 120) });
          return json(res, 200, { ok: false, code: 'WRITE_FAILED', error: String(e?.message ?? e) });
        }
        if (!r.ok) {
          auditOps({ op: 'autonomous.delete', result: 'failed', reason: 'NOT_FOUND', roundId });
          return json(res, 200, { ok: false, code: 'NOT_FOUND', error: r.error });
        }
        auditOps({ op: 'autonomous.delete', result: 'ok', roundId });
        return json(res, 200, { ok: true, message: '已删除', removed: r.removed });
      }
    },

    // 关闭 NapCat（2026-11-03 新增）
    //
    // 之前不提供这条，理由写的是"NapCat 是提权进程，没有可靠的 PID 归属"。
    // 现在 /api/ops/napcat/start 用 -PassThru 把外层 cmd.exe 的 PID 写进
    // data/napcat.pid，关闭时 taskkill /T /F 杀整棵进程树 —— 归属就明确了。
    //
    // ⚠️ 仍然**不按进程名找**。pid 文件不存在或进程已死就明确报错，不猜。
    {
      // 关闭 NapCat（2026-11-03 重做：带四条安全校验）
      //
      // 上一版（6762f33）因为"PID 归属不可靠"被禁用（42f54f9）。
      // 这一版补上校验，重新开放：
      //
      //   ① 防自杀：pid === process.pid → 拒绝
      //      实测 pidAlive(process.pid) 返回 true，如果 pid 文件被写成自己的 PID，
      //      taskkill /F 会直接自杀。
      //
      //   ② **进程名白名单**：必须是 cmd.exe / NapCatWinBootMain.exe / QQ.exe
      //      这是最关键的一条 —— 只要进程名对得上，误杀别人的概率极低。
      //      用 PowerShell 的 Get-Process 拿 ProcessName，不遍历找 PID（只校验，不搜索）。
      //
      //   ③ 系统关键 PID 保护：pid < 100 一律拒绝
      //      Windows 的系统进程都在低 PID 段。
      //
      //   ④ 如果是 cmd.exe，它必须有子进程
      //      空壳 cmd 说明 NapCat 其实已经退了，没必要再杀。
      //
      // **仍然不做**：不按进程名遍历找 PID、不碰 panel.stopAll、不改提权方式。
      method: 'POST', pattern: '/api/ops/napcat/stop',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'ops.napcat.stop');
        if (g) return json(res, 200, g);

        const pidFile = path.join(DATA_DIR, 'napcat.pid');
        let pid = null;
        try {
          const v = fs.readFileSync(pidFile, 'utf8').trim();
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) pid = n;
        } catch { /* 没有 pid 文件 */ }

        if (!pid) {
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'NO_PID_FILE' });
          return json(res, 200, {
            ok: false,
            code: 'NO_PID_FILE',
            error: '没有 NapCat 的 PID 记录（可能是用旧版启动的，或者已经关了）。请先用本页的「启动 NapCat」重新拉一次，之后就能关。'
          });
        }

        // ① 防自杀
        if (pid === process.pid) {
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'SELF_PID', pid });
          return json(res, 200, {
            ok: false,
            code: 'SELF_PID',
            error: 'napcat.pid 里记录的是面板自己的 PID —— 拒绝执行（否则会把面板杀了）。这个文件可能被误写过，请先删掉 data/napcat.pid。'
          });
        }

        // ③ 系统关键 PID 保护
        if (pid < 100) {
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'LOW_PID', pid });
          return json(res, 200, {
            ok: false,
            code: 'LOW_PID',
            error: 'PID ' + pid + ' 在系统关键进程区间（< 100），拒绝执行。'
          });
        }

        if (!pidAlive(pid)) {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'ALREADY_DEAD', pid });
          return json(res, 200, { ok: false, code: 'ALREADY_DEAD', error: 'NapCat 进程已经不在了（PID ' + pid + '），已清理 PID 记录' });
        }

        // ② 进程名白名单（用 PowerShell -NoProfile 查，不遍历 PID）
        const ALLOWED = ['cmd', 'napcatwinbootmain', 'qq'];
        let procName = '';
        let childCount = -1;
        try {
          // 用 spawnSync 捕获输出。PowerShell 命令用**单引号包**，避免和 JS 的双引号打架。
          const psScript = [
            "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
            "$p = Get-Process -Id " + pid + " -ErrorAction SilentlyContinue",
            "if (-not $p) { 'NOTFOUND|0'; exit 0 }",
            "$kids = @(Get-CimInstance Win32_Process -Filter ('ParentProcessId=' + " + pid + ") -ErrorAction SilentlyContinue).Count",
            "$p.ProcessName + '|' + $kids"
          ].join("; ");
          const r2 = childProcessSpawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", psScript],
            { windowsHide: true, timeout: 8000, encoding: "utf8" });
          const out = String(r2.stdout || "").trim();
          const parts = out.split("|");
          procName = String(parts[0] || "").toLowerCase();
          childCount = Number(parts[1]);
          if (!Number.isFinite(childCount)) childCount = 0;
        } catch (e) {
          auditOps({ op: 'ops.napcat.stop', result: 'failed', reason: 'PROBE_FAILED', pid, detail: String(e?.message ?? e).slice(0, 120) });
          return json(res, 200, {
            ok: false,
            code: 'PROBE_FAILED',
            error: '查不到 PID ' + pid + ' 的进程信息，拒绝执行（不确定就不杀）：' + String(e?.message ?? e).slice(0, 120)
          });
        }

        if (!procName || procName === 'notfound') {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'PROC_NOT_FOUND', pid });
          return json(res, 200, { ok: false, code: 'PROC_NOT_FOUND', error: 'PID ' + pid + ' 的进程不存在，已清理 PID 记录' });
        }

        if (!ALLOWED.includes(procName)) {
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'PROC_NOT_ALLOWED', pid, procName });
          return json(res, 200, {
            ok: false,
            code: 'PROC_NOT_ALLOWED',
            error: 'PID ' + pid + ' 是「' + procName + '」，不是 NapCat 相关进程（只允许 ' + ALLOWED.join(' / ') + '）。拒绝执行。'
          });
        }

        // ④ cmd.exe 必须有子进程，否则是空壳
        if (procName === 'cmd' && childCount === 0) {
          try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
          auditOps({ op: 'ops.napcat.stop', result: 'denied', reason: 'EMPTY_CMD', pid });
          return json(res, 200, {
            ok: false,
            code: 'EMPTY_CMD',
            error: 'PID ' + pid + ' 是个没有子进程的 cmd（NapCat 可能已经退了），已清理 PID 记录。'
          });
        }

        // 四条校验全过 → 执行
        let killed = false;
        let err = '';
        try {
          const r = childProcessSpawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
            windowsHide: true, stdio: 'ignore', timeout: 10000
          });
          killed = r.status === 0;
          if (!killed) err = 'taskkill 返回 ' + r.status;
        } catch (e) {
          err = String(e?.message ?? e);
        }

        if (!killed) {
          auditOps({ op: 'ops.napcat.stop', result: 'failed', reason: 'KILL_FAILED', pid, detail: err.slice(0, 120) });
          return json(res, 200, { ok: false, code: 'KILL_FAILED', error: '关闭失败：' + err, pid });
        }

        try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
        auditOps({ op: 'ops.napcat.stop', result: 'ok', pid, procName });
        return json(res, 200, {
          ok: true,
          message: '已关闭 NapCat（PID ' + pid + ' / ' + procName + ' 及子进程树）',
          pid,
          procName
        });
      }
    },

    // 她自己写的工具（从 8899 的 herTools() 迁移，2026-11-03）
    //
    // 只认 `her-` 前缀的目录：skills/her-* 和 plugins/her-*。
    // 读不出清单的**标红而不是隐藏**（8899 的注释原话："读不出清单的会标红，不隐藏"）。
    {
      method: 'GET', pattern: '/api/her-tools',
      handler: async ({ json, res }) => {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const out = [];
        for (const [base, kind] of [['skills', '技能'], ['plugins', '插件']]) {
          const dirRoot = path.join(root, base);
          let dirs = [];
          try {
            dirs = fs.readdirSync(dirRoot, { withFileTypes: true })
              .filter((e) => e.isDirectory() && e.name.startsWith('her-'))
              .map((e) => e.name);
          } catch { continue; }

          for (const name of dirs) {
            const dir = path.join(dirRoot, name);
            let manifest = null;
            for (const f of ['skill.json', 'plugin.json']) {
              try {
                manifest = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
                break;
              } catch { /* 试下一个 */ }
            }
            let mtime = 0;
            try { mtime = fs.statSync(dir).mtimeMs; } catch { /* ignore */ }
            out.push({
              dir: base + '/' + name,
              kind,
              where: base + '/' + name,   // name 本身已含 her- 前缀，别再拼一次
              id: manifest?.id || name,
              name: manifest?.name || name,
              description: String(manifest?.description || '').slice(0, 300),
              version: manifest?.version || '',
              // ⚠️ 读不出清单**不隐藏**，标出来让人知道它坏了
              broken: !manifest,
              at: mtime
            });
          }
        }
        out.sort((a, b) => b.at - a.at);
        return json(res, 200, { ok: true, total: out.length, items: out });
      }
    },

    // ══ R7-B 运维接口（从 8899 迁移，2026-11-03）══════════════════════
    //
    // **固定动作白名单**：这里只有 5 个固定动作，**没有任何"执行任意命令"的入口**。
    // 每个动作的参数都是固定的或强校验的，不接受路径、命令行、进程名。

    // 机器人状态（只读）
    {
      method: 'GET', pattern: '/api/ops/bot/status',
      handler: async ({ json, res }) => {
        const pid = botPid();
        const alive = pidAlive(pid);
        return json(res, 200, {
          ok: true,
          running: alive,
          pid: alive ? pid : null,
          // ⚠️ 明确说明归属来源，避免被误认为"扫进程名找到的"
          pidSource: 'data/qq-agent.lock'
        });
      }
    },

    // 启动机器人
    //
    // ⚠️ **保留 8899 的原有做法**：借 explorer.exe 代启（降权标准做法）。
    //    3210 和 8899 一样可能以更高权限运行，直接 spawn 会让机器人也变成高权限。
    {
      method: 'POST', pattern: '/api/ops/bot/start',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'ops.bot.start');
        if (g) return json(res, 200, g);

        const pid = botPid();
        if (pidAlive(pid)) {
          auditOps({ op: 'ops.bot.start', result: 'denied', reason: 'ALREADY_RUNNING', pid });
          return json(res, 200, { ok: false, code: 'ALREADY_RUNNING', error: `机器人已经在运行（PID ${pid}）` });
        }

        const bat = botBatPath();
        if (!fs.existsSync(bat)) {
          auditOps({ op: 'ops.bot.start', result: 'failed', reason: 'BAT_NOT_FOUND' });
          return json(res, 200, { ok: false, code: 'BAT_NOT_FOUND', error: '找不到 启动QQ机器人.bat' });
        }

        try {
          spawn('explorer.exe', [bat], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {
          auditOps({ op: 'ops.bot.start', result: 'failed', reason: 'SPAWN_FAILED', detail: String(e?.message ?? e).slice(0, 120) });
          return json(res, 200, { ok: false, code: 'SPAWN_FAILED', error: `启动失败：${e?.message ?? e}` });
        }

        auditOps({ op: 'ops.bot.start', result: 'ok' });
        return json(res, 200, { ok: true, message: '已发起启动（若没起来，看一眼机器人日志）' });
      }
    },

    // 停止机器人
    //
    // ⚠️ **只杀 lock 文件里的那个 PID**，不按进程名找。
    //
    // ══ 2026-11-03（关键修复）：先检查"这个 PID 是不是我自己" ════════
    //
    // `data/qq-agent.lock` 里写的是 **Electron 主进程的 PID**
    // （src/instance-lock.js 行 77：`fs.writeFileSync(LOCK_FILE, String(process.pid))`）。
    //
    // 而 3210 和机器人**跑在同一个 Electron 进程里**（electron/main.js 里 createApp）。
    // 所以这里的 pid **就是 3210 自己** —— `process.kill(pid)` 是自杀。
    //
    // 机主 2026-11-03 实测：「我点重启机器人，3210 整个退掉了，也没有重启起来」。
    // 就是这个原因。R7-B 当初照搬 8899 的逻辑错了：
    // **8899 是独立进程、和机器人不同进程；3210 和机器人是同一个进程。**
    {
      method: 'POST', pattern: '/api/ops/bot/stop',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'ops.bot.stop');
        if (g) return json(res, 200, g);

        const pid = botPid();
        if (!pidAlive(pid)) {
          auditOps({ op: 'ops.bot.stop', result: 'denied', reason: 'NOT_RUNNING' });
          return json(res, 200, { ok: false, code: 'NOT_RUNNING', error: '机器人没在运行' });
        }

        // ⚠️ 自杀保护：不能杀自己
        if (pid === process.pid) {
          auditOps({ op: 'ops.bot.stop', result: 'denied', reason: 'SELF_KILL', pid });
          return json(res, 200, {
            ok: false,
            code: 'SELF_KILL',
            error: '机器人和面板跑在同一个进程里，停止它等于关掉面板。要重启请用「重启机器人」（它会走应用重启流程）。'
          });
        }

        try {
          process.kill(pid, 'SIGTERM');
        } catch (e) {
          auditOps({ op: 'ops.bot.stop', result: 'failed', reason: 'KILL_FAILED', pid, detail: String(e?.message ?? e).slice(0, 120) });
          return json(res, 200, { ok: false, code: 'KILL_FAILED', error: `停止失败：${e?.message ?? e}` });
        }

        auditOps({ op: 'ops.bot.stop', result: 'ok', pid });
        return json(res, 200, { ok: true, message: `已停止（PID ${pid}）`, pid });
      }
    },

    // **关闭应用**（2026-11-03，替换掉失败的"重启"）
    //
    // ── 为什么不做自动拉起了 ────────────────────────────────────
    //
    // 机主 2026-11-03 实测三轮，全部失败：
    //   ① 写 restart-helper.bat + 'ascii' 编码 → 中文文件名变乱码
    //   ② 直接 spawn('cmd', ['/c', bat]) → 3210 退了但没回来
    //   ③ PowerShell Start-Process → 还是没回来
    //
    // 根因没完全查清，但继续试下去成本已经超过收益：
    // **一个"能可靠关掉、但需要人手点一下再开"的按钮，比一个"点了会把自己弄死"
    //   的自动重启按钮好得多。**
    //
    // 所以这条路由只做一件事：**让进程干净退出**。不假装能自己回来。
    // 机主关掉之后从桌面快捷方式重新打开即可。
    {
      method: 'POST', pattern: '/api/app/quit',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'app.quit');
        if (g) return json(res, 200, g);

        auditOps({ op: 'app.quit', result: 'ok', pid: process.pid });

        const respond = json(res, 200, {
          ok: true,
          message: '正在关闭 QQ Agent（不会自动重启，需要手动点桌面快捷方式重新打开）',
          pid: process.pid
        });

        // 给 HTTP 响应一点时间写出去，然后退出
        setTimeout(() => { process.exit(0); }, 500);
        return respond;
      }
    },

    // 兼容旧入口：/api/app/restart 现在等同于"关闭"
    //
    // 前端已经改成调 /api/app/quit，但保留这条以免有别的调用方还在调旧地址。
    // **行为明确降级为"只关不启"** —— 不再尝试任何自动拉起。
    {
      method: 'POST', pattern: '/api/app/restart',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'app.restart');
        if (g) return json(res, 200, g);

        auditOps({ op: 'app.restart', result: 'redirect_to_quit', pid: process.pid });

        const respond = json(res, 200, {
          ok: true,
          message: '自动重启已停用（试过三种方案都拉不起来）。现在只关闭，请手动重新打开。',
          pid: process.pid
        });

        setTimeout(() => { process.exit(0); }, 500);
        return respond;
      }
    },

    // 重启机器人
    {
      method: 'POST', pattern: '/api/ops/bot/restart',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'ops.bot.restart');
        if (g) return json(res, 200, g);

        const pid = botPid();

        // ⚠️ 自杀保护：3210 和机器人同进程时，转去走 /api/app/restart 的流程
        if (pid === process.pid) {
          auditOps({ op: 'ops.bot.restart', result: 'redirect', reason: 'SELF_PID', pid });
          return json(res, 200, {
            ok: false,
            code: 'SAME_PROCESS',
            error: '机器人和面板跑在同一个进程里，请改用「重启应用」（/api/app/restart）。'
          });
        }

        let stopMsg = '本来就没在运行';
        if (pidAlive(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            stopMsg = `已停止 PID ${pid}`;
            await new Promise((r) => setTimeout(r, 3000));
          } catch (e) {
            auditOps({ op: 'ops.bot.restart', result: 'failed', reason: 'KILL_FAILED', pid });
            return json(res, 200, { ok: false, code: 'KILL_FAILED', error: `停止失败：${e?.message ?? e}` });
          }
        }

        const bat = botBatPath();
        if (!fs.existsSync(bat)) {
          auditOps({ op: 'ops.bot.restart', result: 'failed', reason: 'BAT_NOT_FOUND' });
          return json(res, 200, { ok: false, code: 'BAT_NOT_FOUND', error: '找不到 启动QQ机器人.bat' });
        }
        try {
          spawn('explorer.exe', [bat], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {
          auditOps({ op: 'ops.bot.restart', result: 'failed', reason: 'SPAWN_FAILED' });
          return json(res, 200, { ok: false, code: 'SPAWN_FAILED', error: `启动失败：${e?.message ?? e}` });
        }

        auditOps({ op: 'ops.bot.restart', result: 'ok' });
        return json(res, 200, { ok: true, message: `${stopMsg}；已发起启动` });
      }
    },

    // NapCat 状态（只读）
    {
      method: 'GET', pattern: '/api/ops/napcat/status',
      handler: async ({ json, res }) => {
        try {
          const cfg = getConfig();
          const sl = cfg.snowluma || {};
          const url = String(sl.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
          const token = String(sl.httpAccessToken || '');
          const r = await fetch(`${url}/get_status`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            body: '{}',
            signal: AbortSignal.timeout(6000)
          });
          const j = await r.json().catch(() => null);
          return json(res, 200, {
            ok: Boolean(j?.data),
            online: Boolean(j?.data),
            // ⚠️ 不返回 token，也不返回账号信息
            message: j?.data ? 'NapCat 已就绪' : ('未就绪：' + (j?.error || '无响应'))
          });
        } catch (e) {
          return json(res, 200, { ok: false, online: false, message: '连不上 NapCat：' + String(e?.message ?? e) });
        }
      }
    },

    // 启动 NapCat
    //
    // ⚠️ **保留原有提权方式**（Start-Process -Verb RunAs），不改。
    //    也不提供 napcat.stop —— NapCat 是提权进程，没有可靠的 PID 归属，
    //    按进程名杀 QQ 是 8899"一键全关"里的有意行为，**不搬到 3210**。
    {
      method: 'POST', pattern: '/api/ops/napcat/start',
      handler: async ({ json, req, res }) => {
        const g = guardWrite(req, 'ops.napcat.start');
        if (g) return json(res, 200, g);

        const bat = napcatBatPath();
        if (!fs.existsSync(bat)) {
          auditOps({ op: 'ops.napcat.start', result: 'failed', reason: 'BAT_NOT_FOUND' });
          return json(res, 200, { ok: false, code: 'BAT_NOT_FOUND', error: '找不到 napcat/启动NapCat-QQ.bat' });
        }

        // 和 8899 完全一致的做法：PowerShell 的 Start-Process -Verb RunAs
        // 用数组 + 换行拼命令，避免多层引号转义出错
        //
        // 2026-11-03：加 -WindowStyle Minimized —— 机主要求黑窗别占桌面。
        // 用 Minimized 不用 Hidden：NapCat 的 fileLog 是关的，日志只走那个控制台，
        // 完全隐藏等于把出错时唯一的线索也关掉。最小化后点任务栏还能看。
        // 2026-11-03：加 -PassThru 把 PID 写盘 ——
        // 否则没法安全关闭（之前说"没有可靠 PID 归属"就是因为这个）。
        // 记的是外层 cmd.exe 的 pid，关闭时用 taskkill /T 杀整棵树。
        const pidFile = path.join(DATA_DIR, 'napcat.pid');
        const psCommand = [
          `$p = '${bat.replace(/'/g, "''")}'`,
          `$pidFile = '${pidFile.replace(/'/g, "''")}'`,
          `$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', ('"' + $p + '"')) -Verb RunAs -WindowStyle Minimized -PassThru`,
          `if ($proc) { $proc.Id | Out-File -FilePath $pidFile -Encoding ascii -Force }`
        ].join('\n');

        const psArgs = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psCommand];

        try {
          execFile('powershell', psArgs, { windowsHide: true }, () => { /* 异步，不等 UAC */ });
        } catch (e) {
          auditOps({ op: 'ops.napcat.start', result: 'failed', reason: 'SPAWN_FAILED' });
          return json(res, 200, { ok: false, code: 'SPAWN_FAILED', error: `拉起失败：${e?.message ?? e}` });
        }

        auditOps({ op: 'ops.napcat.start', result: 'ok' });
        return json(res, 200, {
          ok: true,
          message: '已提权拉起 NapCat（会弹一次 UAC，请点「是」）',
          note: '不改提权方式：仍然走 Start-Process -Verb RunAs'
        });
      }
    },

    // 运维日志（只读，**脱敏**）
    //
    // ⚠️ 只读两个固定文件，不接受 path 参数：
    //      · data/logs/qq-agent-<今天>.log   机器人日志
    //      · data/dsh-gateway.log            DSH 网关日志
    //
    // ⚠️ 脱敏：命中凭据模式的值替换成 ***，整行是凭据的直接丢弃。
    {
      method: 'GET', pattern: '/api/ops/logs',
      handler: async ({ json, url, res }) => {
        const which = String(url.searchParams.get('which') || 'bot').trim();
        const limit = Math.min(400, Math.max(10, Number(url.searchParams.get('limit')) || 120));

        // 固定白名单，只有这两个
        const files = {
          bot: path.join(DATA_DIR, 'logs', `qq-agent-${new Date().toISOString().slice(0, 10)}.log`),
          gateway: path.join(DATA_DIR, 'dsh-gateway.log')
        };
        const file = files[which];
        if (!file) return json(res, 200, { ok: false, code: 'BAD_WHICH', error: 'which 只能是 bot 或 gateway' });

        let raw = '';
        try {
          const st = fs.statSync(file);
          // 只读尾部 256KB，避免把整个大文件读进内存
          const start = Math.max(0, st.size - 256 * 1024);
          const fd = fs.openSync(file, 'r');
          try {
            const len = st.size - start;
            const buf = Buffer.alloc(len);
            fs.readSync(fd, buf, 0, len, start);
            raw = buf.toString('utf8');
          } finally { fs.closeSync(fd); }
        } catch {
          return json(res, 200, { ok: true, lines: [], note: '日志文件还不存在（可能今天的机器人还没启动过）', which });
        }

        const SECRET = /(token|apikey|api_key|access_token|accesstoken|secret|password|passwd|authorization|bearer|cookie|privatekey)/i;
        const lines = raw.split(/\r?\n/).filter(Boolean).slice(-limit).map((line) => {
          // 整行是凭据形态（如 "token=abc" / "Authorization: Bearer x"）→ 丢弃
          if (/^\s*(token|apikey|api_key|access_token|authorization|cookie|password)\s*[:=]/i.test(line)) {
            return '[已隐藏：疑似凭据行]';
          }
          // 其他行：把值替换掉
          return line.replace(
            /((?:token|apikey|api_key|access_token|accesstoken|secret|password|passwd|authorization|cookie)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&]+)/gi,
            '$1***'
          ).replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
        });

        return json(res, 200, { ok: true, which, lines, count: lines.length, masked: true });
      }
    },

    // ══ R7-A 记忆管理（从 8899 迁移，2026-11-03）══════════════════════
    //
    // 背景：8899 面板的四个记忆写操作在 1.5.6（cec9e7c）被"退役"，
    //       返回 403 MEMORY_WRITE_RETIRED，注释写着"后续在记忆管理面板里操作"，
    //       但那个面板一直没做。这里就是那个面板的后端。
    //
    // ⚠️ 8899 的四个 403 **保持不变** —— 不解除，避免两套入口并存。

    // 记忆列表（只读）
    {
      method: 'GET', pattern: '/api/learned/list',
      handler: async ({ json, url, res }) => {
        try {
          const all = learnedListAll();
          const status = String(url.searchParams.get('status') || '').trim();
          const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
          let items = Array.isArray(all) ? all : [];
          if (status) items = items.filter((x) => String(x.status) === status);
          if (q) items = items.filter((x) => String(x.text || '').toLowerCase().includes(q));
          return json(res, 200, { ok: true, total: items.length, items });
        } catch (e) {
          return json(res, 200, { ok: false, code: 'LIST_FAILED', error: String(e?.message ?? e) });
        }
      }
    },
    // R9：记忆治理只读视图（状态/纠正/来源/待办），不返回正文、不写入。
    {
      method: 'GET', pattern: '/api/memory/governance',
      handler: async ({ json, res }) => {
        try {
          let hub = null;
          try { hub = memoryHubStats(); } catch { hub = null; }
          return json(res, 200, buildGovernanceView({
            learned: learnedListAll(), pending: activePending(), hubStats: hub, now: Date.now()
          }));
        } catch (e) {
          return json(res, 200, { ok: false, code: 'GOVERNANCE_FAILED', error: String(e?.message ?? e) });
        }
      }
    },

    // 改状态（write）
    {
      method: 'POST', pattern: '/api/learned/status',
      handler: async ({ json, req, res, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'learned.status');
        if (g) return json(res, 200, g);

        const id = String(body?.id || '').trim();
        const status = String(body?.status || '').trim();
        if (!id) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 不能为空' });
        if (id.length > 80) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 过长' });

        const ALLOWED = ['pending', 'verified', 'stable', 'archived'];
        if (!ALLOWED.includes(status)) {
          auditMemoryWrite({ op: 'learned.status', result: 'denied', reason: 'BAD_STATUS', id });
          return json(res, 200, { ok: false, code: 'BAD_STATUS', error: 'status 必须是 ' + ALLOWED.join('/') });
        }

        // ⚠️ source 固定 owner：UI 上点一下 = 机主确认，这是唯一能升级状态的入口
        const r = learnedSetStatus(id, status, { source: 'owner' });
        auditMemoryWrite({
          op: 'learned.status', result: r.ok ? 'ok' : 'failed', id, status,
          reason: r.ok ? '' : String(r.reason || '')
        });
        return json(res, 200, r.ok
          ? { ok: true, id, status }
          : { ok: false, code: 'SET_STATUS_FAILED', error: r.reason || '失败' });
      }
    },

    // 归档过期（write，**批量**）
    {
      method: 'POST', pattern: '/api/learned/archive',
      handler: async ({ json, req, res, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'learned.archive');
        if (g) return json(res, 200, g);

        // ⚠️ archiveStale 是**批量**的：遍历所有 stable 且超过 days 的记录。
        //    所以 days 必须校验范围，不能让调用方传个巨大值把全部归档。
        const daysRaw = body?.days;
        const days = (daysRaw === undefined || daysRaw === null) ? 30 : Number(daysRaw);
        if (!Number.isFinite(days) || days < 1 || days > 3650) {
          auditMemoryWrite({ op: 'learned.archive', result: 'denied', reason: 'BAD_DAYS' });
          return json(res, 200, { ok: false, code: 'BAD_DAYS', error: 'days 必须在 1~3650 之间' });
        }

        const r = learnedArchiveStale({ days });
        const n = Number(r?.archived) || 0;
        auditMemoryWrite({ op: 'learned.archive', result: 'ok', days, archived: n });
        return json(res, 200, {
          ok: true,
          archived: n,
          days,
          note: n > 0
            ? '已把 ' + n + ' 条「超过 ' + days + ' 天没用到」的 stable 经验归档（不是删除）'
            : '没有符合条件的经验（只有 stable 且超过 ' + days + ' 天没用的才会被归档）'
        });
      }
    },

    // 改内容（write，**可能新建多条**）
    {
      method: 'POST', pattern: '/api/learned/save',
      handler: async ({ json, req, res, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const g = guardWrite(req, 'learned.save');
        if (g) return json(res, 200, g);

        const id = String(body?.id || '').trim();
        const text = String(body?.text || '');
        if (!id) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 不能为空' });
        if (id.length > 80) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 过长' });
        if (!text.trim()) {
          auditMemoryWrite({ op: 'learned.save', result: 'denied', reason: 'EMPTY_TEXT', id });
          return json(res, 200, { ok: false, code: 'EMPTY_TEXT', error: '内容不能为空' });
        }
        if (text.length > 4000) {
          auditMemoryWrite({ op: 'learned.save', result: 'denied', reason: 'TEXT_TOO_LONG', id });
          return json(res, 200, { ok: false, code: 'TEXT_TOO_LONG', error: '内容过长（上限 4000 字）' });
        }

        // ⚠️ saveItem 的真实语义：第一行改原条目，**其余行会新建条目**，
        //    而且多行时会把原条目 status 设回 pending。前端必须把这个后果告诉用户。
        const r = learnedSaveItem(id, text);
        auditMemoryWrite({
          op: 'learned.save', result: r.ok ? 'ok' : 'failed', id,
          created: r.created || 0,
          reason: r.ok ? '' : String(r.reason || '')
        });
        return json(res, 200, r.ok
          ? { ok: true, updated: r.updated, created: r.created, total: r.total }
          : { ok: false, code: 'SAVE_FAILED', error: r.reason || '失败' });
      }
    },

    // 删除（destructive，**必须 confirm + 前端二次确认**）
    {
      method: 'POST', pattern: '/api/learned/delete',
      handler: async ({ json, req, res, body: bodyArg }) => {
        const body = bodyArg ?? await bodyOf(req);
        const id = String(body?.id || '').trim();
        const g = guardWrite(req, 'learned.delete', { id });
        if (g) return json(res, 200, g);

        if (!id) return json(res, 200, { ok: false, code: 'BAD_ID', error: 'id 不能为空' });

        // ⚠️ confirm 不是"权限认证"，只是防误触。
        //    真正的边界是"前端必须先展示目标身份和内容摘要，用户确认后才发"。
        //    后端这里还要**再验证目标存在**，不能只凭 confirm 就删。
        if (body?.confirm !== true) {
          auditMemoryWrite({ op: 'learned.delete', result: 'denied', reason: 'NO_CONFIRM', id });
          return json(res, 200, { ok: false, code: 'NO_CONFIRM', error: '删除需要 confirm: true' });
        }

        // 先确认目标存在（避免"删了个不存在的"被当成成功）
        let exists = false;
        let preview = '';
        try {
          const all = learnedListAll();
          const hit = (Array.isArray(all) ? all : []).find((x) => String(x.id) === id);
          if (hit) { exists = true; preview = String(hit.text || '').slice(0, 60); }
        } catch { /* 读失败就当作不存在 */ }

        if (!exists) {
          auditMemoryWrite({ op: 'learned.delete', result: 'failed', reason: 'NOT_FOUND', id });
          return json(res, 200, { ok: false, code: 'NOT_FOUND', error: '没有这条经验（可能已被删除）' });
        }

        const r = learnedRemoveItem(id);
        auditMemoryWrite({
          op: 'learned.delete', result: r.ok ? 'ok' : 'failed', id,
          preview,   // ⚠️ 只记前 60 字摘要，不记全文
          backupDir: r.backupDir || '',
          reason: r.ok ? '' : String(r.reason || '')
        });
        return json(res, 200, r.ok
          ? { ok: true, id, removedPreview: String(r.removed || '').slice(0, 60), backupDir: r.backupDir || '' }
          : { ok: false, code: 'DELETE_FAILED', error: r.reason || '失败', backupDir: r.backupDir || '' });
      }
    },

    // ── NapCat 二维码（R7 扫码页骨架，2026-11-03）──────────────────
    //
    // ⚠️ **只读**，而且**路径写死**：
    //   · 固定读 NapCat 的 cache/qrcode.png
    //   · **不接受任何参数**指定路径（防止变成任意文件读取）
    //   · 不读、不返回 WebUI Token
    //   · 不改 NapCat 的任何东西
    //
    // ⚠️ 这张图会不会在每次扫码时更新，**尚未验证**。
    //    所以响应里带 updateVerified: false，前端据此显示警告。
    {
      method: 'GET', pattern: '/api/napcat/qrcode',
      handler: async ({ json, res }) => {
        const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
        const file = path.join(root, 'napcat', 'shell', 'napcat', 'cache', 'qrcode.png');
        const expectDir = path.join(root, 'napcat', 'shell', 'napcat', 'cache');
        const realDir = (() => { try { return fs.realpathSync(expectDir); } catch { return expectDir; } })();
        const realFile = (() => { try { return fs.realpathSync(file); } catch { return file; } })();
        if (realDir !== realFile && !realFile.startsWith(realDir + path.sep)) {
          return json(res, 200, { ok: false, code: 'QR_PATH_REJECTED', error: '二维码路径异常' });
        }
        let st = null;
        try { st = fs.statSync(file); } catch { /* 不存在 */ }
        if (!st || !st.isFile()) {
          return json(res, 200, {
            ok: false,
            code: 'QR_NOT_FOUND',
            error: '还没有二维码图片（NapCat 可能尚未进入登录流程）',
            updateVerified: false
          });
        }
        let buf = null;
        try { buf = fs.readFileSync(file); } catch (e) {
          return json(res, 200, { ok: false, code: 'QR_READ_FAILED', error: String(e?.message ?? e) });
        }
        const isPng = buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
        if (!isPng) {
          return json(res, 200, {
            ok: false,
            code: 'QR_NOT_PNG',
            error: '文件存在但不是 PNG',
            size: st.size,
            mtime: new Date(st.mtimeMs).toISOString(),
            updateVerified: false
          });
        }
        return json(res, 200, {
          ok: true,
          dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
          size: st.size,
          mtime: new Date(st.mtimeMs).toISOString(),
          updateVerified: false,
          note: '二维码有效性尚未验证：文件存在且可读已确认，但会不会随扫码更新还未验证。请勿据此判断扫码是否有效。'
        });
      }
    },

    // ── 对话收尾状态（R7 预留）──────────────────────────────────────
    {
      method: 'GET', pattern: '/api/conversation-closure',
      handler: async ({ json, res }) => {
        return json(res, 200, {
          ok: true,
          enabled: false,
          note: '对话收尾（沉默权）尚未接入；SurfCore 的 conversation-closure.js 只作为设计参考，未引入代码。'
        });
      }
    },

    {
    method: 'GET', pattern: '/api/status',
      handler: async ({ res, json }) => {
        const dayKey = todayKey();
        const usage = sessions.todayUsage(dayKey);
        const cfgNow = getConfig();
        const cost = estimateCost(usage, { model: cfgNow.api?.model });
        // ┚ SnowLuma 运行判定用 WebUI 端口（进程即起即听）。
        // WS 3001 要等账号登录后才监听，用它判"运行中"会把"起了但未登录"
        // 误报成"未运行"（进而触发二次拉起 → 双实例管道冲突）。
        const webuiPort = deps.snowlumaWebuiPort();
        // 两个端口探测并行：串行时最坏 1.6s（各 800ms 超时），/api/status 每次都卡这么久
        const [slRunning, obPortOpen] = await Promise.all([
          deps.isPortOpen('127.0.0.1', webuiPort),
          deps.isPortOpen('127.0.0.1', snowlumaWsPort())
        ]);
        // 诊断：把"连不上"拆成三种用户能看懂的原因（给 UI 就绪度体检用）。
        let onebotDiagnosis = '';
        if (!onebot.connected) {
          if (!slRunning) onebotDiagnosis = 'SnowLuma 未运行：请到 SnowLuma 页签启动';
          else if (!obPortOpen) onebotDiagnosis = 'SnowLuma 已运行但无账号登录：请在 QQ 里完成登录（登录后数秒内会自动连上）';
          else if (String(onebot.lastConnectError || '').includes('401')) onebotDiagnosis = '访问令牌不匹配：正在自动轮换重试，若持续出现请在设置里核对 OneBot 令牌';
          else onebotDiagnosis = onebot.lastConnectError ? `连接失败：${String(onebot.lastConnectError).slice(0, 120)}` : '连接中…';
        }
        return json(res, 200, {
          onebot: {
            connected: onebot.connected,
            everConnected: onebot.everConnected,
            error: onebot.lastConnectError,
            diagnosis: onebotDiagnosis,
            self: onebot.selfInfo ? { userId: onebot.selfId, nickname: onebot.selfNickname } : null
          },
          snowluma: {
            dir: snowlumaDir(),
            running: slRunning,
            webuiUrl: snowlumaWebuiUrl(),
            ...snowlumaStatus()
          },
          qqPortable: await qqPortableStatus(),
          orchestrator: orchestrator.statusSummary(),
          usage,
          cost,
          cacheHitRate: cacheHitRate(usage),
          webSearchCount: usage.webSearchCount || 0,
          paused: orchestrator.paused,
          pauseReason: orchestrator.pauseReason ?? null,
          dataDir: DATA_DIR
        });
      }
    },
    {
      method: 'POST', pattern: '/api/open-data-dir',
      handler: async ({ res, json }) => {
        try {
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return json(res, 200, { ok: true, dir: DATA_DIR });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 重置预检（D1-3b-B4）：只读。返回会删什么、备份到哪、以及拒绝原因。
      // 面板先调它生成确认文案；被拒绝时不再让用户点第二次才失败。
      method: 'GET', pattern: '/api/reset-data/preflight',
      handler: async ({ res, json }) => {
        try {
          const { preflightReset } = await import('./reset-data.js');
          const { diaryRoot } = await import('./diary/index.js');
          const r = await preflightReset({ dataDir: DATA_DIR, diaryRoot: diaryRoot() });
          return json(res, 200, r);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/reset-data',
      handler: async ({ res, json }) => {
        try {
          // 安全闸：只允许重置"看起来确实是数据目录"的路径。
          // QQ_AGENT_DATA_DIR 被误设成 C:\ 或用户目录时，无闸直接 rmSync 就是删盘。
          const resolved = path.resolve(DATA_DIR);
          const looksLikeDataDir = path.basename(resolved).toLowerCase().startsWith('data')
            || fs.existsSync(path.join(resolved, 'config.json'));
          if (!looksLikeDataDir || resolved === path.parse(resolved).root) {
            return json(res, 400, { ok: false, error: `数据目录不像 QQ Agent 数据目录，已拒绝重置：${resolved}` });
          }

          // B4：先预检（未完成 pending / 损坏 pending / 未完成 reset → 拒绝），
          // 再停业务、做「data + 日记」双目录备份与校验，最后才删除 data。
          const { preflightReset, resetData } = await import('./reset-data.js');
          const { diaryRoot } = await import('./diary/index.js');
          const root = diaryRoot();
          const pre = await preflightReset({ dataDir: DATA_DIR, diaryRoot: root });
          if (!pre.canReset) {
            return json(res, 409, {
              ok: false,
              refused: true,
              error: `已拒绝重置：${pre.refusals.join('；')}`,
              refusals: pre.refusals,
              pending: pre.pending,
              idem: pre.idem,
              unfinishedResets: pre.unfinishedResets
            });
          }

          // B4：先静默（停业务、等待在跑会话收尾、停定时器/插件循环），再开始备份+删除。
          // 静默不成功（仍有会话在跑）→ 拒绝，绝不在并发写入时删除。
          const quiesce = typeof deps.quiesceForReset === 'function'
            ? await deps.quiesceForReset()
            : (await orchestrator.abortAll(), onebot.close(), { drained: true, running: [] });
          if (!quiesce || quiesce.drained !== true) {
            return json(res, 409, {
              ok: false,
              refused: true,
              error: `仍有 ${quiesce?.running?.length ?? '?'} 个会话未收尾，已拒绝重置（避免并发删除）。请稍后重启应用再试。`,
              running: quiesce?.running || [],
              requiresRestart: true
            });
          }

          const result = await resetData({ dataDir: DATA_DIR, diaryRoot: root });
          if (!result.ok) {
            return json(res, 500, {
              ok: false,
              error: result.error || (result.refusals || []).join('；') || '重置失败',
              opId: result.opId || '',
              status: result.status || '',
              backupDir: result.backupDir || '',
              manifestPath: result.manifestPath || '',
              stages: result.stages || null
            });
          }
          const { loadConfig } = await import('./config.js');
          updateConfig(loadConfig());
          return json(res, 200, {
            ok: true,
            opId: result.opId,
            backupId: result.backupId,
            status: result.status,
            backupDir: result.backupDir,
            manifestPath: result.manifestPath,
            result: result.result,
            totals: result.totals,
            // 明确告诉前端/调用方：两个目录是分别分阶段执行的，不是原子事务。
            atomic: false,
            stages: result.stages,
            diaryCheck: result.diaryCheck,
            diaryKept: root,
            message: `已重置 data（备份：${result.backupDir}）；日记正文保留在 ${root || '（未配置）'}，请重启应用`
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 成本看板 ─────────────────────────────────────────────────────
    {
      // 账本健康检查（4.0 / 1.2）：只读。最后更新、缺失日期、重复、两边成本、
      // 成本准确性、未完成的重算任务 —— 机主要求"结果写日志并在面板展示"。
      method: 'GET', pattern: '/api/usage/health',
      handler: async ({ res, json, url }) => {
        try {
          const days = Number(url.searchParams.get('days')) || 14;
          const { health } = await import('./token-ledger.js');
          const h = health({ days });
          if (h.issues.some((i) => i.level !== 'info')) {
            console.warn('[usage] 账本健康：' + h.issues.map((i) => `${i.level}:${i.code}`).join(','));
          }
          return json(res, 200, { ok: true, ...h });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/stats',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || url.searchParams.get('days') || '7');
          const stats = await buildUsageStats({ range: raw });
          return json(res, 200, { ok: true, range: raw, ...stats });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/usage/breakdown',
      handler: async ({ res, json, url }) => {
        try {
          const raw = String(url.searchParams.get('range') || '7');
          const dim = String(url.searchParams.get('dim') || '');
          const key = String(url.searchParams.get('key') || '');
          const by = String(url.searchParams.get('by') || '');
          const r = await buildUsageBreakdown({ range: raw, dim, key, by });
          return json(res, 200, { ok: true, ...r });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 价格表 ───────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/model-prices',
      handler: async ({ res, json, url }) => json(res, 200, {
        prices: listOfficialPrices(),
        current: resolveOfficialPrice(String(url.searchParams.get('model') || getConfig().api?.model || '')),
        remote: { ...priceFeedStatus(), url: FIXED_PRICE_FEED_URL }
      })
    },
    {
      method: 'POST', pattern: '/api/model-prices/refresh',
      handler: async ({ res, json }) => {
        const st = await refreshPriceFeed(FIXED_PRICE_FEED_URL);
        return json(res, 200, {
          ok: st.ok, remote: st,
          prices: listOfficialPrices(),
          current: resolveOfficialPrice(getConfig().api?.model || '')
        });
      }
    },

    // ── SnowLuma 进程管理 ────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/snowluma/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchSnowluma();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/snowluma/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: snowlumaLogs.slice(-200) })
    },
    {
      method: 'POST', pattern: '/api/snowluma/stop',
      handler: async ({ res, json }) => {
        try {
          // 2026-11-05：stopSnowluma 是 async，之前没 await —— 返回的是 Promise，
          // 前端拿不到真实结果，表现就是“点了关闭没反应/很快又显示在运行”。
          const r = await stopSnowluma();
          return json(res, 200, { ok: true, ...(r && typeof r === 'object' ? r : { stopped: r === true }) });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-folder',
      handler: async ({ res, json }) => {
        const dir = snowlumaDir();
        if (!dir) return json(res, 400, { ok: false, error: '找不到 SnowLuma 目录' });
        spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'POST', pattern: '/api/snowluma/open-webui',
      handler: async ({ res, json }) => {
        const webuiUrl = snowlumaWebuiUrl();
        if (!webuiUrl) return json(res, 400, { ok: false, error: '没有找到 SnowLuma WebUI 地址（等日志出现 listening 后再试）' });
        spawn('cmd.exe', ['/c', 'start', '', webuiUrl], { detached: true, stdio: 'ignore' }).unref();
        return json(res, 200, { ok: true, webuiUrl });
      }
    },

    // ── 便携 QQ 进程管理 ─────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/qq-portable/launch',
      handler: async ({ res, json }) => {
        try {
          const result = await launchPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/qq-portable/stop',
      handler: async ({ res, json }) => {
        try {
          const result = await stopPortableQQ();
          return json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/qq-portable/logs',
      handler: async ({ res, json }) => json(res, 200, { logs: qqPortableLogs.slice(-200) })
    },
    {
      method: 'GET', pattern: '/api/qq-portable/status',
      handler: async ({ res, json }) => json(res, 200, await qqPortableStatus())
    },

    // ── 体检 / 引导 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/onebot/groups',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_group_list');
          const groups = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((g) => ({ id: String(g.group_id), name: String(g.group_name ?? g.group_id) }));
          return json(res, 200, { groups });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/onebot/friends',
      handler: async ({ res, json }) => {
        try {
          const list = await onebot.call('get_friend_list');
          const friends = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((f) => ({ id: String(f.user_id), name: String(f.remark || f.nickname || f.user_id) }));
          return json(res, 200, { friends });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },

    // ── 人设模板 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/persona-templates',
      handler: async ({ res, json }) => {
        const { PERSONAS } = await import('./personas.js');
        const builtins = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name, text: p.text, builtin: true }));
        const customs = (getConfig().customPersonas || []).map((p, i) => ({
          id: `custom_${i}`, name: p.name, text: p.text, customRules: p.customRules || '', builtin: false
        }));
        return json(res, 200, { templates: [...builtins, ...customs] });
      }
    },
    {
      method: 'POST', pattern: '/api/persona-templates',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const name = String(body.name ?? '').trim().slice(0, 50);
        const text = String(body.text ?? '').trim();
        if (!name || !text) return json(res, 400, { ok: false, error: '人设名称和角色设定都不能为空' });
        const entry = { name, text };
        if (String(body.customRules ?? '').trim()) entry.customRules = String(body.customRules).trim();
        const next = [...(getConfig().customPersonas || []), entry];
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true, templates: next });
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/persona-templates\/(custom_\d+)$/,
      handler: async ({ res, json, match }) => {
        const idx = Number(match[1].replace('custom_', ''));
        const next = (getConfig().customPersonas || []).filter((_, i) => i !== idx);
        updateConfig({ customPersonas: next });
        return json(res, 200, { ok: true });
      }
    },

    // ── 多提供商模型目录 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/providers',
      handler: async ({ res, json }) => {
        const providers = currentProviders().map((p) => ({
          id: p.id, displayName: p.displayName, baseURL: p.baseURL,
          apiKey: '', apiKeyFrom: p.apiKeyFrom || '', needsBaseUrl: p.needsBaseUrl === true,
          hasKey: !!p.apiKey, anthropicOrigin: p.anthropicOrigin === true,
          models: p.models, modelNames: p.modelNames || {}
        }));
        return json(res, 200, { providers, source: getConfig().providersSourceYaml });
      }
    },
    {
      method: 'GET', pattern: '/api/providers/key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const pid = String(url.searchParams.get('providerId') || '');
        const p = currentProviders().find((x) => x.id === pid);
        return json(res, 200, { apiKey: p?.apiKey || '' });
      }
    },
    {
      method: 'GET', pattern: '/api/api-key',
      handler: async ({ req, res, json }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        return json(res, 200, { apiKey: String(getConfig().api.apiKey || '') });
      }
    },
    {
      method: 'GET', pattern: '/api/search-key',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const field = String(url.searchParams.get('field') || '');
        const allowed = ['deepseek', 'zhipu', 'bocha', 'baidu', 'metaso'];
        // 各家对应的环境变量名：Key 没存进配置但环境里有时，也算"有 Key"
        //（web-search.js 的取值优先级就是 cfg.apiKey > env），UI 的掩码/显示
        // 口径必须与之一致，否则会出现"明明能搜，Key 框却显示空"的错觉。
        const ENV_OF = {
          deepseek: 'DEEPSEEK_API_KEY',
          zhipu: 'ZHIPU_API_KEY',
          bocha: 'BOCHA_API_KEY',
          baidu: 'BAIDU_SEARCH_API_KEY',
          metaso: 'METASO_API_KEY'
        };
        if (allowed.includes(field)) {
          const fromCfg = String(getConfig().webSearch?.[field]?.apiKey || '');
          return json(res, 200, { apiKey: fromCfg, hasApiKey: Boolean(fromCfg || (ENV_OF[field] && process.env[ENV_OF[field]])) });
        }
        // 自定义搜索服务：field 形如 custom:<id>，按 id 在 providers 数组里找
        if (field.startsWith('custom:')) {
          const id = field.slice('custom:'.length);
          const entry = (getConfig().webSearch?.providers || []).find((p) => String(p.id) === id);
          const k = String(entry?.apiKey || '');
          return json(res, 200, { apiKey: k, hasApiKey: Boolean(k) });
        }
        return json(res, 400, { error: `未知搜索服务：${field}` });
      }
    },
    {
      // OneBot 令牌明文读取：控制台「显示」按钮专用（与 /api/search-key 同一套来源校验）。
      // 必须有这个端点：配置经 sanitizeConfig 脱敏后前端只拿得到掩码，
      // 用户想"看一眼现有令牌"只能走这里。
      method: 'GET', pattern: '/api/onebot-token',
      handler: async ({ req, res, json, url }) => {
        if (!keyEndpointAllowed(req)) return json(res, 403, { error: '请求来源不被信任，已拒绝读取明文密钥。' });
        const which = String(url.searchParams.get('which') || '');
        const snow = getConfig().snowluma || {};
        if (which === 'ws') return json(res, 200, { token: String(snow.accessToken || '') });
        if (which === 'http') return json(res, 200, { token: String(snow.httpAccessToken || snow.accessToken || '') });
        return json(res, 400, { error: `未知令牌类型：${which}` });
      }
    },
    {
      method: 'POST', pattern: '/api/providers/fetch-models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const cfgNow = getConfig();
          const baseUrl = String(body.baseUrl || cfgNow.api.baseUrl || '');
          // Key 解析顺序（2026-09-20 修 401 高发）：显式明文 > 按 providerId 查该提供商
          // 保存的 Key（dshProviderKeys / providers[].apiKey）> 顶层 api.apiKey。
          // 旧实现只看顶层 Key —— 多提供商场景下顶层只存"当前选中那个"的 Key，
          // 从其它提供商拉列表就会拿错 Key，全部 401。
          let apiKey = '';
          if (body.apiKey !== undefined && String(body.apiKey ?? '').trim() && body.apiKey !== '******') {
            apiKey = String(body.apiKey).trim();
          } else {
            const pid = String(body.providerId ?? '').trim();
            const p = pid ? currentProviders().find((x) => x.id === pid) : null;
            apiKey = String(p?.apiKey ?? '').trim();
            if (!apiKey) apiKey = String(cfgNow.api.apiKey || '').trim();
            if (apiKey === '******') apiKey = '';
          }
          const models = await fetchModelsFrom(baseUrl, apiKey);
          return json(res, 200, { ok: true, models });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-one',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const result = await testOneProvider({
            providerId: String(body.providerId ?? ''),
            baseUrl: String(body.baseUrl ?? ''),
            apiKey: String(body.apiKey ?? '')
          });
          return json(res, 200, { ok: true, result });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-chat',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const submitted = String(body.apiKey ?? '').trim();
          const apiKey = (submitted && submitted !== '******') ? submitted : resolveApiKey(getConfig());
          const baseUrl = String(body.baseUrl ?? '');
          const model = String(body.model ?? '');
          const result = await testModelChat({ baseUrl, apiKey, model });
          // 「思考方言」由内置方言表识别（原 thinking-adapters 插件收编进核心）。
          // 接在这里是为了让用户在"测试连通性"时就能看到这个模型会走哪套思考参数，
          // 而不是开了思考模式后默默不生效、只能去翻日志。
          let thinking = null;
          try {
            thinking = detectThinkingDialect({ baseUrl, model }) || null;
          } catch { /* 识别失败不影响连通性测试结论 */ }
          return json(res, 200, { ok: true, result: { ...result, thinking } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const r = upsertProvider({
            baseUrl: String(body.baseUrl ?? ''), apiKey: String(body.apiKey ?? ''), models: body.models || []
          });
          return json(res, 200, { ok: true, ...r, provider: sanitizeProvider(r.provider) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = addModelsToProvider(String(body.providerId ?? ''), body.models || []);
          if (!p) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/providers/models',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const p = removeModelFromProvider(String(body.providerId ?? ''), String(body.modelId ?? ''));
          if (!p) return json(res, 404, { ok: false, error: '提供商或模型不存在' });
          return json(res, 200, { ok: true, provider: sanitizeProvider(p) });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/set-key',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const updated = setProviderKey(String(body.providerId ?? ''), String(body.apiKey ?? ''));
        if (!updated) return json(res, 404, { ok: false, error: '提供商不存在' });
        return json(res, 200, { ok: true, hasKey: !!updated.apiKey });
      }
    },
    {
      // 删除整个提供商（含 Key 与模型目录；当前选中它时一并清空选中态）
      method: 'DELETE', pattern: '/api/providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const removed = removeProvider(String(body.providerId ?? ''));
          if (!removed) return json(res, 404, { ok: false, error: '提供商不存在' });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/providers/test-all',
      handler: async ({ res, json }) => {
        const results = await testAllProviders(currentProviders());
        const okCount = Object.values(results).filter((r) => r.ok).length;
        return json(res, 200, { ok: true, results, okCount, total: Object.keys(results).length });
      }
    },

    // ── 视觉能力 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/vision/results',
      handler: async ({ res, json }) => json(res, 200, {
        results: { ...builtinVisionResults(currentProviders()), ...visionResults() },
        scanning: visionScan.running
      })
    },
    {
      method: 'POST', pattern: '/api/vision/scan',
      handler: async ({ req, res, json }) => {
        if (visionScan.running) return json(res, 409, { ok: false, error: '已有一次扫描正在进行' });
        const body = await bodyOf(req);
        const onlyProviderIds = Array.isArray(body?.providerIds) ? body.providerIds.map(String) : null;
        visionScan.running = true;
        emit('vision-scan', { phase: 'start' });
        scanModelsVision({ providers: currentProviders(), emit, onlyProviderIds, timeoutMs: 25000, limit: 3 })
          .then(({ total }) => emit('vision-scan', { phase: 'done', total }))
          .catch((error) => emit('vision-scan', { phase: 'error', error: String(error?.message ?? error) }))
          .finally(() => { visionScan.running = false; });
        return json(res, 202, { ok: true, started: true });
      }
    },

    // ── 自定义搜索提供商 ─────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/search-providers',
      handler: async ({ res, json }) => {
        const list = (getConfig().webSearch?.providers || []).map((p) => ({
          id: p.id, name: p.name, type: p.type, baseUrl: p.baseUrl, model: p.model,
          count: p.count, timeoutMs: p.timeoutMs, hasApiKey: Boolean(String(p.apiKey || '').trim())
        }));
        return json(res, 200, { providers: list });
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const baseUrl = String(body.baseUrl ?? '').trim();
          const type = String(body.type ?? 'openai').trim() === 'bing' ? 'bing' : 'openai';
          if (!baseUrl) return json(res, 400, { ok: false, error: '接口地址不能为空' });
          const list = [...(getConfig().webSearch?.providers || [])];
          const existing = list.find((p) => p.baseUrl === baseUrl && p.type === type);
          let entry;
          if (existing) {
            existing.name = String(body.name ?? existing.name ?? '').trim() || existing.name;
            existing.baseUrl = baseUrl;
            existing.type = type;
            existing.model = String(body.model ?? existing.model ?? '').trim();
            existing.count = Math.min(20, Math.max(1, Number(body.count) || existing.count || 6));
            existing.timeoutMs = Math.max(5000, Number(body.timeoutMs) || existing.timeoutMs || 20000);
            // apiKey 语义（与「清除密钥」按钮配套）：
            //   undefined / '******' → 不动（保持原 Key）
            //   非空字符串           → 覆盖为新 Key
            //   ''（显式空串）        → 清除
            if (body.apiKey === undefined) {
              /* 未提交：保持原值 */
            } else if (String(body.apiKey) === '******') {
              /* 掩码回传：保持原值 */
            } else {
              existing.apiKey = String(body.apiKey).trim();
            }
            entry = existing;
          } else {
            entry = {
              id: `sp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
              name: String(body.name ?? '').trim() || baseUrl,
              type, baseUrl,
              apiKey: String(body.apiKey ?? '').trim() === '******' ? '' : String(body.apiKey ?? '').trim(),
              model: String(body.model ?? '').trim(),
              count: Math.min(20, Math.max(1, Number(body.count) || 6)),
              timeoutMs: Math.max(5000, Number(body.timeoutMs) || 20000)
            };
            list.push(entry);
          }
          updateConfig({ webSearch: { providers: list } });
          return json(res, 200, { ok: true, provider: { ...entry, apiKey: '', hasApiKey: Boolean(String(entry.apiKey || '').trim()) } });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: '/api/search-providers',
      handler: async ({ req, res, json }) => {
        try {
          const body = await bodyOf(req);
          const id = String(body.id ?? '').trim();
          if (!id) return json(res, 400, { ok: false, error: '缺少 id' });
          const list = (getConfig().webSearch?.providers || []).filter((p) => String(p.id) !== id);
          updateConfig({ webSearch: { providers: list } });
          const cur = String(getConfig().webSearch?.provider || '');
          if (cur === `custom:${id}`) updateConfig({ webSearch: { provider: 'bing' } });
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/search-providers/test',
      handler: async ({ req, res, json }) => {
        const startedAt = Date.now();
        try {
          const body = await bodyOf(req);
          const provId = String(body.providerId ?? '').trim();
          const r = await customSearch('qq agent 测试', provId || null);
          return json(res, 200, { ok: true, result: { ok: true, count: r.results.length, sample: r.results[0]?.title || '', latencyMs: Date.now() - startedAt } });
        } catch (error) {
          return json(res, 200, { ok: true, result: { ok: false, note: String(error?.message ?? error), latencyMs: Date.now() - startedAt } });
        }
      }
    },

    // ── 连通性测试 ───────────────────────────────────────────────────
    {
      method: 'POST', pattern: '/api/test/api',
      handler: async ({ res, json }) => {
        const startedAt = Date.now();
        try {
          const r = await chatCompletionObserved('diagnostic.route_test', { messages: [{ role: 'user', content: '请只回复两个字符：pong' }], tools: null, temperature: 0 });
          const reply = typeof r.message.content === 'string' ? r.message.content.slice(0, 100) : '';
          return json(res, 200, { ok: true, model: r.model, reply, latencyMs: Date.now() - startedAt });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), latencyMs: Date.now() - startedAt });
        }
      }
    },

    // ── 配置 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/config',
      handler: async ({ res, json }) => json(res, 200, sanitizeConfig(getConfig()))
    },
    {
      // 完整系统提示词预览：按**当前**插件/技能/工具启用状态组装（没开的不出现），
      // 供设置-工具与技能页和技能页右侧预览共用。走后端而不是前端拼：组装逻辑
      // 就是运行时的 buildSystemPrompt + getToolAvailability，前端另写一份迟早漂移。
      // 注意 skillContext 与 orchestrator 同构（visionEnabled/searchEnabled/toolsCfg），
      // 否则预览和实际运行的口径会分裂。
      //
      // POST + 可选 overrides：前端自动保存有 600ms 防抖，用户刚点的开关还没落盘；
      // 调用方把"当前工具面板状态"随请求发来，这里先 deepMerge 到临时副本上组装
      // （绝不写回 currentConfig），预览就能立即反映未保存的开关。
      method: '*', pattern: '/api/prompt-preview',
      handler: async ({ req, res, json }) => {
        const cfg = getConfig();
        let overrides = {};
        try {
          if (req.method === 'POST') overrides = (await bodyOf(req)) || {};
        } catch { overrides = {}; }
        const effective = Object.keys(overrides).length
          ? deepMergeConfig(structuredClone(cfg), structuredClone(overrides))
          : cfg;
        const skillContext = {
          skills: skillManager,
          toolsCfg: effective.tools || {},
          visionEnabled: effective.api?.vision !== false
            && modelImageVerdict(effective.api?.provider, effective.api?.model) !== 'no-vision',
          searchEnabled: effective.webSearch?.enabled !== false,
          runtimeContext: { model: effective.api?.model || '', provider: effective.api?.provider || '', source: 'api' }
        };
        const { buildSystemPrompt } = await import('./prompt.js');
        const { buildToolDefs } = await import('./tools.js');
        const { getToolAvailability } = await import('./tool-registry.js');
        // 可用工具清单与 orchestrator 同一口径（tools.js 的 def → OpenAI 函数名）
        const tools = buildToolDefs()
          .filter((d) => getToolAvailability(d.id, skillContext).enabled)
          .map((d) => ({ id: d.id, name: d.name, description: d.description, category: d.category }));
        return json(res, 200, {
          systemPrompt: buildSystemPrompt({ skillContext }),
          tools
        });
      }
    },
    {
      method: 'GET', pattern: '/api/community/blocklist',
      handler: async ({ res, json }) => json(res, 200, { ok: true, ids: getGlobalBlocklist() })
    },
    {
      method: 'POST', pattern: '/api/community/blocklist',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids : [];
        try {
          const { ids: actual, warning } = await updateGlobalBlocklist(ids, { mode: String(body?.mode || 'replace') });
          emit('status', { communityBlocklistUpdated: true });
          return json(res, 200, { ok: true, ids: actual, warning: warning || '' });
        } catch (error) {
          return json(res, 502, { ok: false, error: `云端屏蔽名单更新失败：${String(error?.message ?? error)}` });
        }
      }
    },

    // ── 社区市场：账号 + 发布 + 口令安装（全部代理官网，浏览器不直连）──────
    // 凭据存 data/account.json（不走 config：GET /api/config 会脱敏回传整个配置，
    // 塞进 config 等于自造泄露面）。所有端点失败都返回 502 + 服务器原始文案。
    {
      method: 'GET', pattern: '/api/market/accounts',
      handler: async ({ res, json }) => {
        const accounts = listAccounts().map((a) => ({ username: a.username, savedAt: a.savedAt }));
        return json(res, 200, { ok: true, accounts });
      }
    },
    {
      // 登录 / 注册。mode: login | register。注册三要素：登录 ID + 展示用户名 + 密码。
      // 成功后凭据自动落盘。
      method: 'POST', pattern: '/api/market/login',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        try {
          const r = await loginAccount({
            loginId: String(body?.loginId || ''),
            displayName: String(body?.displayName || ''),
            password: String(body?.password || ''),
            mode: body?.mode === 'register' ? 'register' : 'login'
          });
          return json(res, 200, { ok: true, account: r.account, accounts: r.accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 登出（删本地凭据 + 吊销远端 token）
      method: 'POST', pattern: '/api/market/logout',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const username = String(body?.username || '');
        if (!username) return json(res, 400, { ok: false, error: '缺少 username' });
        const accounts = await removeAccount(username);
        return json(res, 200, { ok: true, accounts: accounts.map((a) => ({ username: a.username, savedAt: a.savedAt })) });
      }
    },
    {
      // 发布一个已安装的 skill/plugin 到市场（待审核）。
      // body: { kind: 'skill'|'plugin', id, displayName, description, accountUsername }
      method: 'POST', pattern: '/api/market/publish',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const kind = body?.kind === 'plugin' ? 'plugin' : 'skill';
        const id = String(body?.id || '');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
          return json(res, 400, { ok: false, error: `无效的 ${kind} id：${id}` });
        }
        const acc = listAccounts().find((a) => a.username === String(body?.accountUsername || ''));
        if (!acc) return json(res, 401, { ok: false, error: '请先选择一个已登录的账号' });
        try {
          const r = await publishModule({
            kind, id,
            displayName: String(body?.displayName || ''),
            description: String(body?.description || ''),
            token: acc.token,
            // 阿里云验证码验签参数：远端市场对发布强制要求（一次性，前端弹出验证后拿到）
            captchaVerifyParam: String(body?.captchaVerifyParam || '')
          });
          return json(res, 200, {
            ok: true, item: r.item || null,
            renamedTo: r.renamedTo || null,
            note: r.note || ''
          });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令批量校验：body { codes: [...] } → 每个口令的条目摘要
      method: 'POST', pattern: '/api/market/verify',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const codes = (Array.isArray(body?.codes) ? body.codes : [body?.code])
          .map((c) => String(c ?? '').trim().toUpperCase())
          .filter((c) => /^[A-Z0-9]{1,32}$/.test(c))
          .slice(0, 30);
        if (!codes.length) return json(res, 400, { ok: false, error: '没有有效的口令' });
        try {
          const results = await verifyInstallCodes(codes);
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      // 口令安装：body { code, entry }（entry = verify 阶段拿到的条目，含服务器判定的 type）。
      // 类型路由由服务器 entry.type 决定：技能页输插件口令也会装进 plugins/。
      method: 'POST', pattern: '/api/market/install',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const code = String(body?.code || '').trim().toUpperCase();
        if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(res, 400, { ok: false, error: '口令格式无效' });
        try {
          const r = await installByCode({ code, verified: body?.entry || null });
          // 安装完立即重扫，让新模块马上出现在页签里（热重载 watcher 也行，
          // 但目录删除重建的场景 watcher 会丢事件 —— reload 是唯一可靠路径）
          try { await reloadSkills({ reason: 'market-install' }); } catch { /* 重扫失败不影响安装结果 */ }
          return json(res, 200, { ok: true, kind: r.kind, id: r.id, dir: r.dir });
        } catch (error) {
          return json(res, 502, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── Skill 管理 ─────────────────────────────────────────────────────
    // 统一开关入口：前端只改这里，模块内部一律读 skillManager。
    {
      method: 'GET', pattern: '/api/skills',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        // uninstalled：配置里还有 skills.<id> 段、但磁盘上已经没有这个条目
        // （删目录后的配置残留）。UI 显示成"已配置但未安装"，并提供一键清理。
        const installedIds = new Set(skillManager.list(context).map((s) => s.id));
        const uninstalled = listConfiguredSkillIds()
          .filter((id) => !installedIds.has(id))
          .map((id) => {
            const c = getConfig()?.skills?.[id] || {};
            return {
              id,
              enabled: c.enabled !== false,
              hasSettings: Object.keys(c).some((k) => k !== 'enabled')
            };
          });
        return json(res, 200, {
          skills: skillManager.list(context),
          summary: skillManager.summary(context),
          capabilities: skillManager.capabilities.list().sort(),
          uninstalled
        });
      }
    },
    {
      // 手动重扫磁盘：UI「刷新」按钮的后端动作。
      // 之前刷新只读内存注册表，watcher 丢事件（目录删除重建 / 网络盘 / 杀软）
      // 时新插件永远进不来。这里走 app.reloadSkills()：重扫 + 激活 + 刷工具 + 重建 watcher。
      method: 'POST', pattern: '/api/skills/reload',
      handler: async ({ res, json }) => {
        if (typeof reloadSkills !== 'function') {
          return json(res, 500, { ok: false, error: '核心未提供 reloadSkills（请升级或检查启动方式）' });
        }
        try {
          const result = await reloadSkills({ reason: 'manual' });
          const context = skillRuntimeContext();
          return json(res, 200, {
            ok: true,
            loaded: result.loaded.map((r) => r.id),
            failed: result.failed.map((r) => ({ id: r.id, error: r.error })),
            pruned: result.pruned,
            skills: skillManager.list(context),
            summary: skillManager.summary(context),
            capabilities: skillManager.capabilities.list().sort()
          });
        } catch (error) {
          return json(res, 500, { ok: false, error: `重扫失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 清理"已配置但未安装"的残留配置段：删掉 config.skills.<id>。
      // body: { ids: [id...] }，只删传入的 id，且要求该 id 当前确实不在注册表里
      //（防止把正在运行的 Skill 配置误删）。
      method: 'POST', pattern: '/api/skills/cleanup',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(String).filter(Boolean) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少 ids' });
        const installed = new Set(skillManager.list().map((s) => s.id));
        const removable = ids.filter((id) => !installed.has(id));
        if (!removable.length) {
          return json(res, 400, { ok: false, error: '没有可清理的条目（都处于已安装状态）' });
        }
        const skillsCfg = getConfig()?.skills || {};
        const next = { ...skillsCfg };
        for (const id of removable) delete next[id];
        // deepMerge 传 {} 删不掉已有键，必须用 __replace__ 整体替换
        updateConfig({ skills: { __replace__: next } });
        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          removed: removable,
          skipped: ids.filter((id) => installed.has(id)),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 单个 Skill：切开关 / 改设置。两个动作分开处理，避免"改了设置顺手把我开着的关了"。
      method: 'POST', pattern: /^\/api\/skills\/([^/]+)$/,
      handler: async ({ req, res, json, match }) => {
        const id = decodeURIComponent(match[1]);
        const body = await bodyOf(req);
        const context = skillRuntimeContext();
        const skill = skillManager.registry.get(id);
        if (!skill) return json(res, 404, { ok: false, error: `Skill 不存在：${id}` });

        // 1) 开关（先写配置，再跑生命周期；顺序不能反 ——
        //    activate 里读配置必须已经生效，否则 Skill 会以为自己是关闭的）
        if (body.enabled !== undefined) {
          setSkillEnabled(id, !!body.enabled);
          if (body.enabled) skillManager.activate(id, context);
          else skillManager.deactivate(id, context);
        }

        // 2) 设置（只允许改 manifest 声明过的键，防止前端塞垃圾字段进配置）
        if (body.settings && typeof body.settings === 'object') {
          const allowed = new Set([
            ...Object.keys(skill.manifest.settings || {}),
            ...Object.keys(skill.manifest.configSchema || {})
          ]);
          const schema = skill.manifest.configSchema || {};
          const current = getSkillConfig(id, skill.manifest.settings || {});
          const patch = {};
          // ⚠️ 与 settingsView 同一套口径（2026-09-26 审查二轮）：
          //    ① secret 标记；② 字段名命中 /key|token|secret|password|cookie/i 的
          //    字符串字段（web-fetch 的 cookie 没有 secret 标记也属密文）。
          //    收到掩码 '******' 或空串 = "不修改" —— 否则用户只是打开表单点了
          //    保存，Cookie/Key 就被覆盖成六个星号。
          const SECRET_NAME_RE = /key|token|secret|password|cookie/i;
          const isSecretField = (k) => Boolean(schema[k]?.secret)
            || (SECRET_NAME_RE.test(k) && typeof current[k] === 'string');
          for (const [k, v] of Object.entries(body.settings)) {
            if (!allowed.has(k)) continue;
            if (isSecretField(k) && (v === '******' || String(v ?? '').trim() === '')) continue;
            patch[k] = v;
          }
          if (Object.keys(patch).length) setSkillConfig(id, patch);
        }

        emit('status', { configUpdated: true });
        return json(res, 200, {
          ok: true,
          skill: skillManager.status(id, context),
          // ⚠️ 响应里的 settings 必须用脱敏视图（settingsView）：
          //    曾经直接回 getSkillConfig（明文），保存一次设置就把
          //    apiKey / Cookie 原文发回浏览器，与 GET 列表的脱敏口径相反。
          settings: skillManager.settingsView(id),
          config: sanitizeConfig(getConfig())
        });
      }
    },
    {
      // 开关配置总览：给设置页渲染"技能"区块
      method: 'GET', pattern: '/api/skills/capabilities',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const caps = skillManager.capabilities.list().sort();
        return json(res, 200, {
          capabilities: caps.map((c) => ({
            name: c,
            ...skillManager.explainCapability(c, context)
          }))
        });
      }
    },
    {
      // 工具可用性总览：明确告诉 UI "这个工具为什么没生效"
      method: 'GET', pattern: '/api/tools/availability',
      handler: async ({ res, json }) => {
        const context = skillRuntimeContext();
        const availability = availabilityOf(context);
        const defs = new Map(listTools().map((t) => [t.id, t]));
        return json(res, 200, {
          categories: CATEGORY_META,
          tools: availability.map((a) => ({
            id: a.id,
            category: defs.get(a.id)?.category || 'system',
            skillId: a.skillId,
            enabled: a.enabled,
            code: a.code,
            reason: a.reason
          }))
        });
      }
    },


    {
      method: 'POST', pattern: '/api/config',
      handler: async ({ req, res, json }) => {
        const patch = await readBody(req);
        const next = updateConfig(patch);
        store.setMaxPerChat(next.store?.maxMessagesPerChat ?? 0);
        sessions?.setKeepFiles?.(next.store?.keepSessionFiles ?? 0);
        if (next.proactive?.enabled) orchestrator.startProactiveLoop(); else orchestrator.stopProactiveLoop();
        initPriceFeed(FIXED_PRICE_FEED_URL);
        emit('status', { configUpdated: true });
        // ⚠️ 必须脱敏：updateConfig 返回的是内存里的活配置对象，含明文 apiKey /
        //    accessToken / dshProviderKeys。GET /api/config 一直是脱敏的，
        //    这里漏掉会让"任何一次保存设置"把全部明文密钥回传给浏览器。
        return json(res, 200, { ok: true, config: sanitizeConfig(next) });
      }
    },
    {
      method: 'GET', pattern: '/api/tools',
      handler: async ({ res, json }) => {
        const { listTools } = await import('./tool-registry.js');
        const tools = listTools().map((t) => ({
          id: t.id, name: t.name, description: t.description, category: t.category,
          icon: t.icon, defaultEnabled: t.defaultEnabled, requiresVision: t.requiresVision, requiresSearch: t.requiresSearch,
          // 来源标记：属于哪个 Skill（内置工具为 null）—— UI 据此打「skill」标识，
          // 并在所属技能失活时把工具整组隐藏（与提示词口径一致）。
          skillId: t.skillId ?? null
        }));
        return json(res, 200, { tools });
      }
    },

    // ── 存储容量（4.0 / 1.5.7.6）──────────────────────────────────────
    {
      // < 500MB 正常 / ≥500MB 预警 / ≥1GB 暂停自动归档（不删文件、不停机器人）
      method: 'GET', pattern: '/api/storage/health',
      handler: async ({ res, json }) => {
        try {
          const { storageHealth } = await import('./storage-health.js');
          return json(res, 200, { ok: true, ...storageHealth() });
        } catch (error) {
          return json(res, 500, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    // ── 版本 / 更新 ──────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/version',
      handler: async ({ res, json }) => json(res, 200, { version: localVersion() })
    },

    // ── 数据管理（D1-5D，只读）────────────────────────────────────────────
    // 只暴露汇总/清单/计划；不接收路径/PID/命令参数，不提供生产删除/隔离/执行入口。
    {
      method: 'GET', pattern: '/api/data-management/idempotency',
      handler: async ({ res, json }) => {
        try {
          const { diaryRoot } = await import('./diary/index.js');
          const { auditConsistency } = await import('../scripts/data-consistency-audit.mjs');
          const r = auditConsistency({ dataDir: DATA_DIR, diaryRoot: diaryRoot() });
          json(res, 200, { ok: true, counts: r.counts, findings: r.findings.filter((f) => String(f.code || '').startsWith('idem')) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/data-management/trash',
      handler: async ({ res, json }) => {
        try {
          const { diaryRoot } = await import('./diary/index.js');
          const { inspectTrash } = await import('../scripts/legacy-backup-recovery.mjs');
          json(res, 200, { ok: true, ...inspectTrash({ diaryRoot: diaryRoot() }) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/data-management/sessions',
      handler: async ({ res, json }) => {
        try {
          const { inventorySessions, planSessionQuarantine } = await import('../scripts/session-inventory.mjs');
          const inventory = inventorySessions({ dataDir: DATA_DIR });
          json(res, 200, { ok: true, inventory, plan: planSessionQuarantine({ inventory }) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/data-management/reset-backups',
      handler: async ({ res, json }) => {
        try {
          const { diaryRoot } = await import('./diary/index.js');
          const { inspectBackups } = await import('../scripts/backup-retention.mjs');
          json(res, 200, { ok: true, ...inspectBackups({ dataDir: DATA_DIR, diaryRoot: diaryRoot() }) });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/data-management/lifecycle',
      handler: async ({ res, json }) => {
        try {
          const { diaryRoot } = await import('./diary/index.js');
          const { auditConsistency } = await import('../scripts/data-consistency-audit.mjs');
          const r = auditConsistency({ dataDir: DATA_DIR, diaryRoot: diaryRoot() });
          const codes = r.findings.reduce((a, f) => { a[f.code] = (a[f.code] || 0) + 1; return a; }, {});
          json(res, 200, { ok: true, counts: r.counts, codes });
        } catch (e) { json(res, 500, { ok: false, error: String(e?.message ?? e) }); }
      }
    },
    {
      method: 'GET', pattern: '/api/update-check',
      handler: async ({ res, json }) => {
        const current = localVersion();
        try {
          const r = await fetch(UPDATE_INFO_URL, { signal: AbortSignal.timeout(8000), cache: 'no-store' });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const info = await r.json();
          const latest = String(info.version || '');
          if (!latest) throw new Error('version.json 缺少 version 字段');
          return json(res, 200, {
            ok: true, current, latest,
            hasUpdate: compareSemver(latest, current) > 0,
            url: String(info.url || 'https://kondius.cn/qq-agent'),
            notes: String(info.notes || '')
          });
        } catch (error) {
          return json(res, 200, { ok: false, current, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 模型 / 会话 / 存档 ───────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/models',
      handler: async ({ res, json }) => {
        try {
          const models = await listModels();
          return json(res, 200, { models });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'GET', pattern: '/api/sessions',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        return json(res, 200, { sessions: sessions.listSummaries(limit) });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const s = sessions.get(match[1]);
        if (!s) return json(res, 404, { error: '会话不存在' });
        return json(res, 200, s);
      }
    },
    {
      // 主动删除一条会话记录（正在运行的不能删）
      method: 'DELETE', pattern: /^\/api\/sessions\/([\w-]+)$/,
      handler: async ({ res, json, match }) => {
        const removed = sessions.remove(match[1]);
        if (!removed) return json(res, 409, { ok: false, error: '会话不存在或正在运行（运行中的会话不能删除）' });
        emit('session-end', { sessionId: match[1], status: 'deleted' });
        return json(res, 200, { ok: true });
      }
    },
    {
      // 清空全部已结束的会话记录（保留运行中/等待中的）
      method: 'POST', pattern: '/api/sessions/clear-finished',
      handler: async ({ res, json }) => {
        const r = sessions.clearFinished();
        if (!r.ok) return json(res, 500, { ok: false, error: r.error });
        emit('session-end', { status: 'cleared', removed: r.removed });
        return json(res, 200, { ok: true, removed: r.removed, kept: r.kept, backupDir: r.backupDir });
      }
    },
    {
      // 手动重试一条失败的会话：把触发批翻回未读并立即唤醒（会话页「重试」按钮）。
      // 只有 error 状态且未发出过消息的会话允许重试（已发言的重试 = 群里看到两遍）。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/retry$/,
      handler: async ({ res, json, match }) => {
        const r = await orchestrator.retrySession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true, restored: r.restored });
      }
    },
    {
      // 中止一个运行中/等待中的会话（会话页「中止」按钮）。
      // 运行中的会话在下一轮 LLM 请求前安全收尾（不截断途中的请求/发送）；
      // 等待中的会话直接干净消失。不在两种状态之一（如已结束）则拒绝。
      method: 'POST', pattern: /^\/api\/sessions\/([\w-]+)\/abort$/,
      handler: async ({ res, json, match }) => {
        const r = orchestrator.abortSession(match[1]);
        if (!r.ok) return json(res, 409, { ok: false, error: r.reason });
        return json(res, 200, { ok: true });
      }
    },
    {
      method: 'GET', pattern: '/api/chats',
      handler: async ({ res, json }) => {
        const chats = store.listChats().map((key) => ({ key, ...store.getChatMeta(key) }))
          .sort((a, b) => b.lastTs - a.lastTs);
        await Promise.allSettled(chats.map(async (c) => {
          const m = /^group:(\d+)$/.exec(String(c.key || ''));
          if (!m) { c.chatName = ''; return; }
          try {
            c.chatName = await Promise.race([
              orchestrator.getChatName(m[1]),
              new Promise((r) => setTimeout(() => r(''), 3000))
            ]) || '';
          } catch { c.chatName = ''; }
        }));
        return json(res, 200, { chats });
      }
    },

    // ── 记忆 ─────────────────────────────────────────────────────────
    {
      method: 'GET', pattern: '/api/memory-files',
      handler: async ({ res, json }) => {
        const files = memory.listChats().map((chatKey) => {
          const members = memory.members(chatKey);
          const impressionCount = members.reduce((n, m) => n + m.impressions.length, 0);
          return {
            chatKey, impressionCount, memberCount: members.length,
            updatedAt: Math.max(0, ...members.map((m) => Number(m.updatedAt) || 0))
          };
        });
        const seen = new Set(files.map((f) => f.chatKey));
        for (const gid of (getConfig().allow?.groups || [])) {
          const key = `group:${String(gid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        for (const uid of (getConfig().allow?.private || [])) {
          const key = `private:${String(uid)}`;
          if (!seen.has(key)) files.push({ chatKey: key, impressionCount: 0, memberCount: 0, updatedAt: 0, consolidating: false });
        }
        const busy = orchestrator.consolidating;
        for (const f of files) f.consolidating = busy.has(f.chatKey);
        files.sort((a, b) => b.updatedAt - a.updatedAt);
        return json(res, 200, { files, consolidating: [...busy] });
      }
    },
    {
      method: 'GET', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        return json(res, 200, { ...memory.query(chatKey), members: memory.members(chatKey) });
      }
    },
    {
      method: 'PUT', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const body = await bodyOf(req);
        try {
          const member = await memory.editMemberImpression(chatKey, {
            userId: match[3],
            name: String(body.name ?? ''),
            note: body.note ?? '',
            impressions: body.impressions ?? []
          });
          emit('memory-update', { chatKey });
          return json(res, 200, { ok: true, member });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)\/members\/(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const mr = await memory.removeMember(chatKey, match[3]);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: mr.ok !== false, result: mr });
      }
    },
    {
      // 删除整个会话的记忆（记忆页「删除本会话记忆」按钮）
      method: 'DELETE', pattern: /^\/api\/memory-files\/(group|private)_(\d+)$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const cr = await memory.removeChat(chatKey);
        emit('memory-update', { chatKey });
        return json(res, 200, { ok: cr.ok !== false, result: cr });
      }
    },
    {
      method: 'POST', pattern: '/api/memory-files/consolidate',
      handler: async ({ req, res, json }) => {
        // 4.0 / 1.5.6：群友印象属于记忆，面板不再直接写。
        // 统一入口在阶段 2 的 Memory Hub；这里和其它记忆写入口一起拒。
        console.warn('[acl] 拒绝面板写群友印象：/api/memory-files/consolidate');
        return json(res, 403, {
          ok: false,
          code: 'MEMORY_WRITE_RETIRED',
          error: '面板不再直接整理群友印象',
          hint: '记忆写入已收回到统一入口，后续在记忆管理面板里操作'
        });

        // 下面是原实现，保留作对照；1.5.6 起不会执行到。
        try {
          const body = await bodyOf(req);
          const chatKey = String(body.chatKey || '');
          if (!/^(group|private):\d+$/.test(chatKey)) return json(res, 400, { ok: false, error: 'chatKey 格式错误' });
          let userIds = null;
          if (body.userIds != null) {
            const arr = Array.isArray(body.userIds) ? body.userIds : [body.userIds];
            userIds = arr.map((u) => String(u ?? '').trim()).filter((u) => /^\d{1,15}$/.test(u));
            if (!userIds.length) return json(res, 400, { ok: false, error: 'userIds 需为 QQ 号数组' });
          }
          const force = body.force !== false;
          if (orchestrator.consolidating.has(chatKey)) return json(res, 409, { ok: false, error: '该群已在整理中' });
          orchestrator.consolidating.add(chatKey);
          emit('memory-update', { chatKey, phase: 'consolidate-start', userIds });
          orchestrator.consolidateMemoryForChat(chatKey, { userIds, force })
            .then((result) => emit('memory-update', { chatKey, phase: 'consolidate-done', ...(result || {}) }))
            .catch((error) => emit('memory-update', { chatKey, phase: 'consolidate-error', error: String(error?.message ?? error) }))
            .finally(() => orchestrator.consolidating.delete(chatKey));
          return json(res, 202, { ok: true, started: true });
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) });
        }
      }
    },

    // ── 存档消息 ─────────────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/chats\/(group|private)_(\d+)\/messages$/,
      handler: async ({ res, json, url, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const limit = Math.min(1048576, Math.max(1, Number(url.searchParams.get('limit')) || 1048576));
        const messages = store.recent(chatKey, { limit }).map((m) => ({
          id: m.id, mid: m.mid, ts: m.ts, senderId: m.senderId, senderName: m.senderName,
          text: m.text, self: m.self, read: m.read, reply: m.reply, media: m.media || []
        }));
        return json(res, 200, { chatKey, messages });
      }
    },
    {
      method: 'POST', pattern: '/api/media-data',
      handler: async ({ req, res, json }) => {
        try {
          const body = await readBody(req);
          const items = Array.isArray(body?.items) ? body.items.slice(0, 20) : [];
          const mimeOf = (p) => /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp' : 'image/jpeg';
          const fileToDataUrl = (fp) => {
            const st = fs.statSync(fp);
            if (st.size > 15 * 1024 * 1024) return null;
            return `data:${mimeOf(fp)};base64,${fs.readFileSync(fp).toString('base64')}`;
          };
          // 下载一律走 safe-fetch：这里的 url 来自请求体（前端/任何本机进程都能构造），
          // 直接 fetch 等于给了一个"让本机去抓内网"的 SSRF 入口。
          const safeToDataUrl = async (rawUrl) => {
            const { buffer, contentType } = await safeFetchBinary(String(rawUrl), 15 * 1024 * 1024, { browseLocked: browseLockState().enabled });
            if (!buffer?.length || buffer.length > 15 * 1024 * 1024) return null;
            const type = String(contentType || 'image/jpeg').split(';')[0].trim();
            if (!/^image\//i.test(type)) return null;
            return `data:${type};base64,${buffer.toString('base64')}`;
          };
          const results = [];
          for (const it of items) {
            let dataUrl = null;
            try {
              const ret = await onebot.call('get_image', { file: String(it?.file || '') });
              if (ret?.file && fs.existsSync(String(ret.file))) dataUrl = fileToDataUrl(String(ret.file));
              if (!dataUrl && ret?.url) dataUrl = await safeToDataUrl(ret.url);
            } catch { /* 缓存没有 / 地址不可信就走下一条 */ }
            if (!dataUrl && it?.url) {
              try { dataUrl = await safeToDataUrl(it.url); } catch { /* 过期或不可信就放弃 */ }
            }
            results.push(dataUrl ? { dataUrl } : null);
          }
          return json(res, 200, { ok: true, results });
        } catch (error) {
          return json(res, 200, { ok: false, error: String(error?.message ?? error), results: [] });
        }
      }
    },

    // ── 群成员 / 会话控制 ────────────────────────────────────────────
    {
      method: 'GET', pattern: /^\/api\/groups\/(\d+)\/members$/,
      handler: async ({ res, json, match }) => {
        try {
          const list = await onebot.call('get_group_member_list', { group_id: Number(match[1]) });
          const members = (Array.isArray(list) ? list : (list?.data ?? []))
            .map((m) => ({ userId: String(m.user_id), nickname: String(m.nickname || ''), card: String(m.card || '') }))
            .sort((a, b) => String(a.card || a.nickname).localeCompare(String(b.card || b.nickname), 'zh-CN'));
          return json(res, 200, { members });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/wake$/,
      handler: async ({ res, json }) => json(res, 410, { error: '已移除：不触发的消息现在会立即标为已读，无需手动唤醒' })
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/test-send$/,
      handler: async ({ req, res, json, match }) => {
        const body = await readBody(req);
        const text = String(body.text ?? '').trim();
        if (!text) return json(res, 400, { error: '消息内容为空' });
        // ⚠️ 白名单闸（2026-09-26 审查二轮）：本端点曾接受任意 group/private id ——
        //   任何通过来源校验的本地进程都能借它向**白名单外**的群/私聊发消息
        //   （绕过 send_to 工具的硬校验，等于给管理端开了一条无白名单的发送通道）。
        //   现在与 app.allowed() 同口径：deny 优先；allow 非空时必须在名单内；
        //   全空时必须显式开 allowAllWhenEmpty。
        const kind = match[1];
        const id = match[2];
        const cfgNow = getConfig();
        const denyList = cfgNow.deny?.[kind] ?? cfgNow.deny?.[`${kind}s`] ?? [];
        if (denyList.map(String).includes(String(id))) {
          return json(res, 403, { error: '该会话在黑名单内，不能发送' });
        }
        const allowList = cfgNow.allow?.[kind] ?? cfgNow.allow?.[`${kind}s`] ?? [];
        const allowed = allowList.length > 0
          ? allowList.map(String).includes(String(id))
          : cfgNow.allowAllWhenEmpty === true;
        if (!allowed) {
          return json(res, 403, { error: '该会话不在白名单内，不能发送（先在设置里加白名单，或开启空白名单放行）' });
        }
        try {
          const chatKey = `${kind}:${id}`;
          const data = await onebot.sendText(kind, id, text);
          // 带上 OneBot 返回的 message_id：面板发送的消息也要有 mid，
          // 否则它永远无法参与"同 mid 幂等"（与 sender 的 appendSelf 同口径）。
          await store.appendSelf(chatKey, { text, ts: Date.now(), mid: data?.message_id ?? null });
          emit('chat-update', chatKey);
          return json(res, 200, { ok: true, messageId: data?.message_id ?? null });
        } catch (error) {
          return json(res, 502, { error: String(error?.message ?? error) });
        }
      }
    },
    {
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mark-read$/,
      handler: async ({ res, json, match }) => {
        const marked = await store.drainUnread(`${match[1]}:${match[2]}`);
        return json(res, 200, { ok: true, marked: marked.length });
      }
    },
    {
      // 清空某会话的全部消息（整体清除存档）
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/clear$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const blocked = guardWrite(req, 'chat.clear', { chatKey });
        if (blocked) return json(res, 403, { ok: false, ...blocked });
        const info = {};
        try {
          const removed = await store.clearChat(chatKey, info);
          emit('chat-update', chatKey);
          auditMemoryWrite({ op: 'chat.clear', result: 'ok', chatKey, removed, backupDir: info.backupDir || '' });
          return json(res, 200, { ok: true, removed, backupDir: info.backupDir || '', backedUp: info.backedUp === true });
        } catch (error) {
          auditMemoryWrite({ op: 'chat.clear', result: 'error', chatKey, error: String(error?.message ?? error) });
          return json(res, 500, { ok: false, error: `清空失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      // 仅屏蔽（不删除）：把某会话全部未读标记为已读，不再触发回复
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/mute$/,
      handler: async ({ res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const marked = await store.muteUnread(chatKey);
        emit('chat-update', chatKey);
        return json(res, 200, { ok: true, marked });
      }
    },
    {
      // 部分清除：删除指定本地 id 的消息
      method: 'POST', pattern: /^\/api\/chats\/(group|private)_(\d+)\/delete-messages$/,
      handler: async ({ req, res, json, match }) => {
        const chatKey = `${match[1]}:${match[2]}`;
        const blocked = guardWrite(req, 'chat.deleteMessages', { chatKey });
        if (blocked) return json(res, 403, { ok: false, ...blocked });
        const body = await bodyOf(req);
        const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter((n) => Number.isFinite(n)) : [];
        if (!ids.length) return json(res, 400, { ok: false, error: '缺少要删除的消息 id 列表（ids）' });
        const info = {};
        try {
          const removed = await store.removeByLocalIds(chatKey, ids, info);
          emit('chat-update', chatKey);
          auditMemoryWrite({ op: 'chat.deleteMessages', result: 'ok', chatKey, removed, backupDir: info.backupDir || '' });
          return json(res, 200, { ok: true, removed, backupDir: info.backupDir || '', backedUp: info.backedUp === true });
        } catch (error) {
          auditMemoryWrite({ op: 'chat.deleteMessages', result: 'error', chatKey, error: String(error?.message ?? error) });
          return json(res, 500, { ok: false, error: `删除失败：${String(error?.message ?? error)}` });
        }
      }
    },
    {
      method: 'POST', pattern: '/api/pause',
      handler: async ({ req, res, json }) => {
        const body = await readBody(req);
        const wasPaused = orchestrator.paused;
        orchestrator.setPaused(!!body.paused);
        if (wasPaused && !orchestrator.paused && !body.skipBacklog) orchestrator.drainBacklogAfterResume();
        return json(res, 200, { ok: true, paused: orchestrator.paused });
      }
    },
    {
      method: 'DELETE', pattern: '/api/pause',
      handler: async ({ res, json }) => {
        orchestrator.setPaused(false);
        const marked = {};
        for (const chatKey of store.listChats()) {
          const n = (await store.drainUnread(chatKey)).length;
          if (n > 0) marked[chatKey] = n;
        }
        emit('chat-update', '*');
        return json(res, 200, { ok: true, paused: false, marked });
      }
    },

    // ── 日志系统 ─────────────────────────────────────────────────────
    {
      // 最近的日志（UI 日志页签首次加载）
      method: 'GET', pattern: '/api/logs',
      handler: async ({ res, json, url }) => {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
        return json(res, 200, { logs: logger.recent(limit), level: logger.getLevel() });
      }
    },
    {
      // 调整最低落盘级别（debug/info/warn/error）
      method: 'POST', pattern: '/api/logs/level',
      handler: async ({ req, res, json }) => {
        const body = await bodyOf(req);
        const level = String(body.level || 'info');
        logger.setLevel(level);
        return json(res, 200, { ok: true, level: logger.getLevel() });
      }
    },

    // ── 验证码请求转发（2026-09-26）────────────────────────────────
    // 部分用户机器上 Chromium 渲染层对 *.aliyuncs.com / *.alicdn.com 的请求被
    // 本机安全软件按进程+域名压制（同机 Node 层、系统 curl 均正常），SDK 走不通。
    // 由主进程 Node 层（undici，网络栈独立且实测可达）代为转发。
    // 安全边界（防 SSRF）：目标仅允许 https + aliyuncs/alicdn 两族域名后缀；
    // 不跟随重定向；body 上限 8MB；响应上限 16MB；超时 15s。
    {
      method: '*', pattern: /^\/api\/captcha-forward\/?$/,
      handler: async ({ req, res, json, url }) => {
        const target = String((url && url.searchParams.get('u')) || '');
        let parsed;
        try { parsed = new URL(target); } catch {
          return json(res, 400, { ok: false, error: '缺少或非法的 u 参数' });
        }
        if (parsed.protocol !== 'https:' ||
            !/^[a-zA-Z0-9.-]+\.(aliyuncs\.com|alicdn\.com)$/.test(parsed.hostname)) {
          return json(res, 403, { ok: false, error: `目标不在转发白名单（仅 https 的 aliyuncs/alicdn 域）：${parsed.hostname}` });
        }
        // 读原始 body（POST 等需要；上限 8MB）
        const chunks = [];
        let size = 0;
        try {
          await new Promise((resolve, reject) => {
            req.on('data', (c) => {
              size += c.length;
              if (size > 8 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
              chunks.push(c);
            });
            req.on('end', resolve);
            req.on('error', reject);
          });
        } catch { /* 读失败按空 body 处理 */ }
        const reqBody = Buffer.concat(chunks);

        // 复制请求头（剥掉 hop-by-hop 与本机信息头）
        const fwdHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          const kl = k.toLowerCase();
          if (['host', 'cookie', 'connection', 'content-length', 'origin', 'referer',
               'accept-encoding', 'transfer-encoding', 'upgrade', 'expect'].includes(kl)) continue;
          fwdHeaders[k] = v;
        }
        if (reqBody.length && !fwdHeaders['content-type']) fwdHeaders['content-type'] = 'application/octet-stream';

        try {
          const up = await fetch(parsed.href, {
            method: req.method,
            headers: fwdHeaders,
            body: (req.method === 'GET' || req.method === 'HEAD' || reqBody.length === 0) ? undefined : reqBody,
            redirect: 'manual',
            signal: AbortSignal.timeout(15000),
          });
          const buf = Buffer.from(await up.arrayBuffer());
          if (buf.length > 16 * 1024 * 1024) {
            return json(res, 502, { ok: false, error: '转发响应过大（>16MB）' });
          }
          const resHeaders = {};
          up.headers.forEach((v, k) => {
            const kl = k.toLowerCase();
            if (['transfer-encoding', 'content-encoding', 'content-length', 'connection', 'keep-alive'].includes(kl)) return;
            resHeaders[k] = v;
          });
          resHeaders['access-control-allow-origin'] = '*';   // 同源请求用不到，留作兜底
          res.writeHead(up.status, resHeaders);
          res.end(buf);
        } catch (e) {
          return json(res, 502, { ok: false, error: `转发失败：${String(e?.cause?.code || e?.message || e).slice(0, 120)}` });
        }
        return undefined;   // 已自行写响应
      }
    },
  ];
}
