// 运维页（R7-B B3，2026-11-03）。
//
// 从 8899 迁移过来的运维能力：机器人状态/启停/重启、NapCat 状态/启动、日志查看。
//
// ── 与 8899 的差异（有意为之）──
//   · **没有 panel.***（8899 自己不用 3210 管）
//   · **没有 napcat.stop**（提权进程没有可靠 PID 归属）
//   · **没有"一键全关"**（那里按进程名杀 QQ，违反"禁止宽泛进程名"约束）
//
// ⚠️ 3210 没有认证（server.token 未配置），这些按钮靠三道前端+后端防护兜底：
//    来源检查 / JSON 校验 / 明确的操作提示。
(function () {
  const $ = (id) => document.getElementById(id);

  let logTimer = null;
  let loaded = false;
  let whichLog = 'bot';

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, body) {
    const opt = body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined;
    const r = await fetch(path, opt);
    return r.json();
  }

  function toast(msg, kind = 'ok') {
    const box = $('ops-toast');
    if (!box) return;
    box.textContent = msg;
    box.style.display = '';
    box.style.borderColor = kind === 'err' ? '#a33' : 'var(--bd)';
    clearTimeout(box._t);
    box._t = setTimeout(() => { box.style.display = 'none'; }, 5000);
  }

  // ── 状态 ────────────────────────────────────────────────────
  async function refreshBot() {
    try {
      const r = await api('/api/ops/bot/status');
      const dot = $('ops-bot-dot');
      const txt = $('ops-bot-text');
      if (dot) dot.style.background = r.running ? '#3c3' : '#888';
      if (txt) txt.textContent = r.running ? `运行中（PID ${r.pid}）` : '未运行';
    } catch (e) { toast('读取机器人状态失败：' + String(e?.message || e), 'err'); }
  }

  async function refreshNapcat() {
    try {
      const r = await api('/api/ops/napcat/status');
      const dot = $('ops-napcat-dot');
      const txt = $('ops-napcat-text');
      if (dot) dot.style.background = r.online ? '#3c3' : '#888';
      if (txt) txt.textContent = r.message || (r.online ? '已就绪' : '未就绪');
    } catch (e) { toast('读取 NapCat 状态失败：' + String(e?.message || e), 'err'); }
  }

  // ── 动作（每个都要明确确认）─────────────────────────────────
  async function doStart() {
    if (!confirm('启动机器人？\n\n会用 explorer.exe 以普通权限启动「启动QQ机器人.bat」。')) return;
    const r = await api('/api/ops/bot/start', {});
    toast(r.ok ? r.message : ('失败：' + (r.error || r.code)), r.ok ? 'ok' : 'err');
    refreshBot();
  }

  async function doStop() {
    if (!confirm('停止机器人？\n\n只会杀掉 data/qq-agent.lock 里记录的那个 PID，不按进程名找。')) return;
    const r = await api('/api/ops/bot/stop', {});
    toast(r.ok ? r.message : ('失败：' + (r.error || r.code)), r.ok ? 'ok' : 'err');
    refreshBot();
  }

  async function doRestart() {
    if (!confirm('重启机器人？\n\n先停（最多等 3 秒）再启动。')) return;
    const r = await api('/api/ops/bot/restart', {});
    toast(r.ok ? r.message : ('失败：' + (r.error || r.code)), r.ok ? 'ok' : 'err');
    refreshBot();
  }




  async function doNapcatStop() {
    if (!confirm("关闭 NapCat？\n\n会先校验：\n· 不是面板自己的 PID\n· 进程名是 cmd / NapCatWinBootMain / QQ\n· 不在系统关键 PID 段\n· cmd 必须有子进程\n\n四条全过才执行 taskkill /T。")) return;
    const r = await api("/api/ops/napcat/stop", {});
    toast(r.ok ? r.message : ("失败：" + (r.error || r.code)), r.ok ? "ok" : "err");
    refreshNapcat();
  }

  async function doNapcatStart() {
    if (!confirm('启动 NapCat？\n\n⚠️ 会弹一次 UAC，请点「是」。\n提权方式与原来一致（Start-Process -Verb RunAs）。')) return;
    const r = await api('/api/ops/napcat/start', {});
    toast(r.ok ? r.message : ('失败：' + (r.error || r.code)), r.ok ? 'ok' : 'err');
  }

  // ── 日志 ────────────────────────────────────────────────────
  async function loadLog() {
    const box = $('ops-log');
    if (!box) return;
    try {
      const r = await api(`/api/ops/logs?which=${encodeURIComponent(whichLog)}&limit=120`);
      if (!r.ok) { box.textContent = '读取失败：' + (r.error || r.code); return; }
      if (!r.lines || !r.lines.length) {
        box.textContent = r.note || '（没有日志）';
        return;
      }
      box.textContent = r.lines.join('\n');
      box.scrollTop = box.scrollHeight;
    } catch (e) {
      box.textContent = '读取异常：' + String(e?.message || e);
    }
  }

  function startLogPoll() {
    stopLogPoll();
    loadLog();
    // 5 秒轮询（够用，不用 WebSocket）
    logTimer = setInterval(loadLog, 5000);
  }

  function stopLogPoll() {
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
  }

  // ── 事件 ────────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'ops-refresh') { refreshBot(); refreshNapcat(); loadLog(); }
    if (t.id === 'ops-bot-start') doStart();
    if (t.id === 'ops-bot-stop') doStop();
    if (t.id === 'ops-bot-restart') doRestart();
    if (t.id === 'ops-napcat-start') doNapcatStart();
    if (t.id === 'ops-napcat-stop') doNapcatStop();
    if (t.id === 'ops-log-reload') loadLog();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t && t.id === 'ops-log-which') { whichLog = t.value; loadLog(); }
  });

  window.__ops = {
    onEnter() {
      if (!loaded) { loaded = true; refreshBot(); refreshNapcat(); }
            startLogPoll();
    },
    onLeave() { stopLogPoll(); },
    reload: () => { refreshBot(); refreshNapcat(); loadLog(); }
  };

  // tab 切换：进入时启动轮询，离开时停（避免后台一直请求）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.dataset) return;
    if (t.dataset.tab === 'ops') setTimeout(() => window.__ops.onEnter(), 50);
    else if (window.__ops && t.classList && t.classList.contains('tab')) window.__ops.onLeave();
  });
})();
