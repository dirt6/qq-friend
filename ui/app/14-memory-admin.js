// 记忆管理（R7-A，2026-11-03）。
//
// 从 8899 面板迁移过来的四个操作：改状态 / 归档 / 改内容 / 删除。
//
// ── 设计要点（对应机主的四项额外要求）──────────────────────────
//   ① 审计日志由后端记录**结果**（成功/拒绝/失败），前端只负责提示
//   ② 前端也做一层参数校验（尽早拦住明显错误，减少无效请求）
//   ③ 删除前**必须展示目标身份和内容摘要**，用户确认后才发 confirm: true
//   ④ 界面上明确标注 archiveStale 是**批量**、saveItem 多行会**新建**条目
//
// ⚠️ 这里**不是**权限系统：3210 目前没有认证（server.token 未配置）。
//    前端只是"减少误操作"，真正的边界在后端。
(function () {
  const $ = (id) => document.getElementById(id);

  let items = [];
  let loaded = false;
  let filterStatus = '';
  let filterQuery = '';

  const STATUS_LABEL = {
    pending: '待验证',
    verified: '已验证',
    stable: '稳定',
    archived: '已归档'
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, body) {
    const opt = body
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body)
        }
      : undefined;
    const r = await fetch(path, opt);
    return r.json();
  }

  function toast(msg, kind = 'ok') {
    // 复用项目已有的 toast（如果有）；否则用 alert 兜底
    if (typeof window.toast === 'function') { window.toast(msg); return; }
    if (kind === 'err') console.warn('[记忆管理]', msg);
    else console.log('[记忆管理]', msg);
    // 页面上给一个轻提示
    const box = $('mem-toast');
    if (box) {
      box.textContent = msg;
      box.style.display = '';
      clearTimeout(box._t);
      box._t = setTimeout(() => { box.style.display = 'none'; }, 4000);
    }
  }

  function renderList() {
    const box = $('mem-list');
    if (!box) return;

    let list = items;
    if (filterStatus) list = list.filter((x) => String(x.status) === filterStatus);
    if (filterQuery) {
      const q = filterQuery.toLowerCase();
      list = list.filter((x) => String(x.text || '').toLowerCase().includes(q));
    }

    const cnt = $('mem-count');
    if (cnt) cnt.textContent = `${list.length} / ${items.length} 条`;

    if (!list.length) {
      box.innerHTML = '<div class="muted" style="padding:20px;text-align:center">没有符合条件的经验</div>';
      return;
    }

    box.innerHTML = list.map((it) => {
      const st = String(it.status || 'pending');
      return `
        <div class="mem-item" data-id="${esc(it.id)}" style="padding:12px;border-bottom:1px solid var(--bd)">
          <div style="display:flex;gap:8px;align-items:flex-start">
            <div style="flex:1;min-width:0">
              <div style="font-size:13px;line-height:1.6;word-break:break-word">${esc(it.text)}</div>
              <div class="muted" style="font-size:11px;margin-top:4px">
                ${esc(it.id)} · ${esc(STATUS_LABEL[st] || st)} · 命中 ${esc(it.hits ?? 0)} 次
              </div>
            </div>
            <div style="display:flex;gap:4px;flex-shrink:0">
              <button class="nav-btn mem-act" data-act="status" data-id="${esc(it.id)}">改状态</button>
              <button class="nav-btn mem-act" data-act="save" data-id="${esc(it.id)}">改内容</button>
              <button class="nav-btn mem-act" data-act="delete" data-id="${esc(it.id)}" style="color:#c55">删除</button>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  async function load() {
    try {
      const q = new URLSearchParams();
      if (filterStatus) q.set('status', filterStatus);
      if (filterQuery) q.set('q', filterQuery);
      const r = await api('/api/learned/list' + (q.toString() ? '?' + q.toString() : ''));
      if (!r.ok) { toast('读取失败：' + (r.error || r.code), 'err'); return; }
      items = Array.isArray(r.items) ? r.items : [];
      loaded = true;
      renderList();
      // R9：治理概览（只读统计，不返回正文）。
      try {
        const g = await api('/api/memory/governance');
        const box = $('mem-governance');
        if (g?.ok && box) {
          const L = g.learned || {};
          const P = g.pending || {};
          const by = L.byStatus || {};
          box.textContent = `治理：共 ${L.total || 0} 条（待验证 ${by.pending || 0} / 已验证 ${by.verified || 0} / 稳定 ${by.stable || 0} / 归档 ${by.archived || 0}）`
            + ` · 被纠正过 ${L.corrections || 0} 条 · 来源 ${L.sourceDays || 0} 天`
            + ` · 待办 ${P.total || 0} 条（过期 ${P.expired || 0}）`;
        }
      } catch { /* 治理概览失败不影响列表 */ }
    } catch (e) {
      toast('读取异常：' + String(e?.message || e), 'err');
    }
  }

  // ── 操作 ────────────────────────────────────────────────────
  async function actStatus(id) {
    const item = items.find((x) => String(x.id) === id);
    if (!item) return;
    const cur = String(item.status || 'pending');
    const next = await uiPrompt(
      `把这条经验的状态改成什么？\n\n当前：${cur}\n可选：pending / verified / stable / archived\n\n（改状态会记入审计日志）`,
      cur
    );
    if (!next) return;
    const allowed = ['pending', 'verified', 'stable', 'archived'];
    if (!allowed.includes(next.trim())) { toast('状态不合法：' + next, 'err'); return; }
    const r = await api('/api/learned/status', { id, status: next.trim() });
    if (r.ok) { toast('状态已改为 ' + next.trim()); load(); }
    else toast('失败：' + (r.error || r.code), 'err');
  }

  async function actSave(id) {
    const item = items.find((x) => String(x.id) === id);
    if (!item) return;
    const text = await uiPrompt(
      `修改这条经验的内容。\n\n⚠️ 注意：\n· 第一行会替换原内容\n· 其余行会**新建**为独立经验条目\n· 多行时这条会被设回「待验证」\n\n当前内容：\n${item.text}`,
      item.text
    );
    if (text === null) return;
    if (!text.trim()) { toast('内容不能为空', 'err'); return; }
    const r = await api('/api/learned/save', { id, text });
    if (r.ok) {
      toast(`已保存（更新 ${r.updated} 条，新建 ${r.created} 条）`);
      load();
    } else toast('失败：' + (r.error || r.code), 'err');
  }

  async function actDelete(id) {
    const item = items.find((x) => String(x.id) === id);
    if (!item) return;

    // ⚠️ 删除必须展示**目标身份和内容摘要**，不能只弹一句"确定吗"
    const preview = String(item.text || '').slice(0, 80);
    const okDel = await uiConfirm(
      `确认删除这条经验？\n\nID：${id}\n状态：${STATUS_LABEL[item.status] || item.status}\n内容：${preview}${String(item.text || '').length > 80 ? '…' : ''}\n\n⚠️ 这个操作**不可恢复**，且会记入审计日志。`
    );
    if (!okDel) return;

    const r = await api('/api/learned/delete', { id, confirm: true });
    if (r.ok) { toast('已删除'); load(); }
    else toast('删除失败：' + (r.error || r.code), 'err');
  }

  async function actArchive() {
    const daysStr = await uiPrompt(
      '归档多少天没用到的「稳定」经验？\n\n⚠️ 这是**批量操作**：会归档**所有** stable 且超过 N 天没被用到的经验。\n（归档不是删除，可以改成其他状态恢复）',
      '30'
    );
    if (daysStr === null) return;
    const days = Number(daysStr);
    if (!Number.isFinite(days) || days < 1 || days > 3650) { toast('天数必须在 1~3650 之间', 'err'); return; }

    const okGo = await uiConfirm(`确认归档「超过 ${days} 天没用到」的稳定经验？\n\n这是批量操作，会影响到所有符合条件的条目。`);
    if (!okGo) return;

    const r = await api('/api/learned/archive', { days });
    if (r.ok) { toast(r.note || `已归档 ${r.archived} 条`); load(); }
    else toast('失败：' + (r.error || r.code), 'err');
  }

  // ── 事件绑定 ─────────────────────────────────────────────────
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;

    if (t.classList && t.classList.contains('mem-act')) {
      const act = t.dataset.act;
      const id = t.dataset.id;
      if (act === 'status') actStatus(id);
      else if (act === 'save') actSave(id);
      else if (act === 'delete') actDelete(id);
      return;
    }

    if (t.id === 'mem-refresh') load();
    if (t.id === 'mem-archive-btn') actArchive();
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'mem-filter-status') { filterStatus = t.value; load(); }
  });

  document.addEventListener('input', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === 'mem-filter-q') {
      filterQuery = t.value;
      // 本地过滤（不用每次都打后端）
      renderList();
    }
  });

  window.__memoryAdmin = {
    onEnter() { if (!loaded) load(); },
    reload: load
  };

  // tab 切换时触发
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.tab === 'memoryadmin') {
      setTimeout(() => window.__memoryAdmin.onEnter(), 50);
    }
  });
})();
