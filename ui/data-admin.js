// 数据管理只读页面（D1-5D）。无写操作、无任意路径/PID/命令输入。
(function () {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtBytes = (n) => { const v = Number(n || 0); if (v < 1024) return v + 'B'; if (v < 1024 ** 2) return (v / 1024).toFixed(1) + 'KB'; if (v < 1024 ** 3) return (v / 1024 ** 2).toFixed(1) + 'MB'; return (v / 1024 ** 3).toFixed(2) + 'GB'; };
  const badge = (text, color) => `<span class="badge" style="background:${color}22;color:${color};font-size:11px;padding:2px 7px;border-radius:999px">${esc(text)}</span>`;
  const verdictBadge = (v) => v === 'confirmed_anomaly' ? badge('ANOMALY', '#f85149') : v === 'historical_unverifiable' ? badge('HISTORICAL', '#d29922') : v === 'confirmed_consistent' ? badge('CONSISTENT', '#3fb950') : badge('UNKNOWN', '#8b949e');

  async function api(path) {
    const r = await fetch(path, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ ok: false, error: 'invalid json' }));
    if (!r.ok || j.ok === false) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  function renderIdem(j) {
    const fs = j.findings || [];
    const warn = fs.filter((f) => f.level === 'warn').length;
    const hist = fs.filter((f) => f.verdict === 'historical_unverifiable').length;
    const anomaly = fs.filter((f) => f.verdict === 'confirmed_anomaly').length;
    $('idem-summary').innerHTML = `critical=${j.counts?.critical || 0} · warn=${warn} · historical=${hist} · anomaly=${anomaly} · 明细 ${fs.length} 条`;
    $('idem-table').innerHTML = fs.length ? `<table><thead><tr><th>级别</th><th>判定</th><th>代码</th><th>键 / 日期</th></tr></thead><tbody>${fs.map((f) => `<tr><td>${esc(f.level)}</td><td>${verdictBadge(f.verdict)}</td><td>${esc(f.code)}</td><td style="font-size:11.5px">${esc(f.key || '')}<br><span class="muted">${esc(f.day || '')}</span></td></tr>`).join('')}</tbody></table>` : '<div class="muted">无幂等异常</div>';
    if (hist || anomaly) {
      $('risk-banner').style.display = 'block';
      $('risk-banner').innerHTML = `<b>风险提示：</b>${hist ? `存在 ${hist} 条 historical_unverifiable（历史无法证明，不得按相似文本认定一致）；` : ''}${anomaly ? `存在 ${anomaly} 条 confirmed_anomaly（需人工检查）；` : ''}本页不提供修复/删除。`;
    }
  }

  function renderTrash(j) {
    const fs = j.files || [];
    const c = j.counts || {};
    const unknown = (c.historical_unknown || 0);
    $('trash-summary').innerHTML = `共 ${fs.length} 个 · recoverable=${c.verified_recoverable || 0} · superseded=${c.verified_superseded || 0} · historical_unknown=${unknown} · corrupted=${c.corrupted || 0}`;
    $('trash-table').innerHTML = fs.length ? `<table><thead><tr><th>文件</th><th>日期</th><th>大小</th><th>分类</th><th>SHA256（前 16）</th></tr></thead><tbody>${fs.map((x) => `<tr><td style="font-size:11.5px">${esc(x.file)}</td><td>${esc(x.dateKey)}</td><td>${fmtBytes(x.size)}</td><td>${badge(x.classification, x.classification === 'verified_recoverable' ? '#58a6ff' : x.classification === 'corrupted' ? '#f85149' : '#d29922')}</td><td class="muted" style="font-size:11px">${esc(String(x.sha256 || '').slice(0, 16))}…</td></tr>`).join('')}</tbody></table>` : '<div class="muted">无 .trash 备份</div>';
    if (unknown) {
      $('risk-banner').style.display = 'block';
      $('risk-banner').innerHTML = ($('risk-banner').innerHTML || '') + `<br><b>Trash：</b>${unknown} 个 historical_unknown（无 manifest/无正文对照），永久保护，不自动清理。`;
    }
  }

  function renderSessions(j) {
    const inv = j.inventory || {};
    const ss = inv.sessions || [];
    const plan = j.plan || {};
    const unknownProc = ss.filter((s) => s.process === 'unknown').length;
    $('session-summary').innerHTML = `项目 ${esc(inv.project || '')} · 共 ${ss.length} · ${Object.entries(inv.counts || {}).map(([k, v]) => `${esc(k)}=${v}`).join(' · ')} · 计划 quarantine=${plan.counts?.quarantine || 0} manual=${plan.counts?.manual || 0}`;
    $('session-table').innerHTML = ss.length ? `<table><thead><tr><th>Session</th><th>状态</th><th>年龄</th><th>大小</th><th>阻塞项</th></tr></thead><tbody>${ss.map((s) => `<tr><td style="font-size:11px">${esc(s.sid)}</td><td>${badge(s.classification, s.classification === 'external' ? '#8b949e' : s.classification === 'quarantine_candidate' ? '#d29922' : '#58a6ff')}</td><td>${esc(String(s.ageDays))}d</td><td>${fmtBytes(s.bytes)}</td><td class="muted" style="font-size:11px">${esc((s.blockers || []).join(', '))}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">无 Session</div>';
    if (unknownProc) {
      $('risk-banner').style.display = 'block';
      $('risk-banner').innerHTML = ($('risk-banner').innerHTML || '') + `<br><b>Session：</b>${unknownProc} 个 process_unknown（无持久进程注册表，不能仅凭 PID 判断，不终止进程）。`;
    }
  }

  function renderBackups(j) {
    const items = j.items || [];
    const c = j.counts || {};
    $('backup-summary').innerHTML = `共 ${items.length} 个 · ${Object.entries(c).map(([k, v]) => `${esc(k)}=${v}`).join(' · ') || '无备份'} · restoreLock=${j.restoreLock ? '是' : '否'}`;
    $('backup-table').innerHTML = items.length ? `<table><thead><tr><th>类型</th><th>ID</th><th>状态</th><th>大小</th></tr></thead><tbody>${items.slice(0, 100).map((x) => `<tr><td>${esc(x.type)}</td><td style="font-size:11px">${esc(x.id)}</td><td>${badge(x.status, x.status === 'verified' ? '#3fb950' : x.status === 'corrupted' ? '#f85149' : '#d29922')}</td><td>${fmtBytes(x.bytes)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted">当前无 reset/memory/chat/learned/sessions 备份（diary .trash 见上一节）</div>';
  }

  function renderLifecycle(j) {
    $('lifecycle-summary').innerHTML = `critical=${j.counts?.critical || 0} · warn=${j.counts?.warn || 0} · info=${j.counts?.info || 0}<br><span style="font-size:11.5px">${Object.entries(j.codes || {}).map(([k, v]) => `${esc(k)}=${v}`).join(' · ')}</span>`;
  }

  async function load(name, path, fn) {
    try { fn(await api(path)); }
    catch (e) { const el = $(name); if (el) el.textContent = '读取失败：' + String(e?.message || e); }
  }

  load('idem-summary', '/api/data-management/idempotency', renderIdem);
  load('trash-summary', '/api/data-management/trash', renderTrash);
  load('session-summary', '/api/data-management/sessions', renderSessions);
  load('backup-summary', '/api/data-management/reset-backups', renderBackups);
  load('lifecycle-summary', '/api/data-management/lifecycle', renderLifecycle);
})();
