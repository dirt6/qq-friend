// R7-C 批次 B：导航合并后的模式切换（2026-11-03）。
//
// 这个文件处理三件事：
//   ① 会话页的「过程 / 内容」切换（吸收原「存档」页）
//   ② 设置页的「用量」子页签（吸收原「用量」页）
//   ③ 经验管理页的「记忆分层」视图（吸收原「记忆」页）
//
// ⚠️ 为什么能直接调 loadChats / loadUsageView / loadMemoryView：
//    ui/app/*.js 都是普通 script（defer），共享同一个全局词法作用域，
//    不是 ESM。所以这些函数在本文件里直接可见。
(function () {
  const $ = (id) => document.getElementById(id);

  // ══════════════════════════════════════════════════════════
  // ① 会话页：过程 / 内容
  // ══════════════════════════════════════════════════════════
  let sessionMode = 'process';

  function setSessionMode(mode) {
    if (mode !== 'process' && mode !== 'content') return;
    sessionMode = mode;

    // 按钮态
    document.querySelectorAll('#sessions-mode-bar .mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === mode);
    });
    // 面板显隐
    const p = $('pane-process');
    const c = $('pane-content');
    if (p) p.style.display = (mode === 'process' ? '' : 'none');
    if (c) c.style.display = (mode === 'content' ? '' : 'none');

    // 首次切到内容模式时拉数据（之后靠 SSE / 轮询更新）
    if (mode === 'content') {
      try { loadChats({ quiet: true }); } catch (e) { console.warn('[nav] loadChats 失败', e); }
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target;
    if (b && b.classList && b.classList.contains('mode-btn') && b.dataset.mode) {
      setSessionMode(b.dataset.mode);
    }
  });

  // ══════════════════════════════════════════════════════════
  // ② 用量（R7-C D4：从设置里拿出来，改成独立 tab）
  // ══════════════════════════════════════════════════════════
  //
  // 机主原话：「设置里依旧没有用量，实在不行别放设置里了，放外面设置和工具中间」
  //
  // 之前三版都失败了：
  //   ① setTimeout 60ms 注入 → loadSettings 重建 sidebar 后消失
  //   ② MutationObserver → 死循环卡死
  //   ③ 多次尝试 0/100/300/800ms → 还是没出现
  //
  // 结论：**不该往一个会重建的容器里注入**。改成正常的 tab。

  function initUsageTab() {
    // #usage-page 如果被之前版本搬到设置里了，搬回来
    const moved = document.getElementById('settings-usage-pane');
    if (moved) {
      const src = moved.querySelector('#usage-page');
      if (src) {
        const host = document.getElementById('view-usage');
        if (host) { src.style.display = ''; host.appendChild(src); }
      }
      moved.remove();
    }
    // 清掉残留的菜单项
    const leftover = document.getElementById('settings-menu-usage');
    if (leftover) leftover.remove();
    // 清掉残留的隐藏标记
    const form = document.getElementById('settings-form');
    if (form) {
      [...form.children].forEach((el) => {
        if (el.dataset && el.dataset._prevDisplay !== undefined) {
          el.style.display = el.dataset._prevDisplay;
          delete el.dataset._prevDisplay;
        }
      });
    }
  }

  // ══════════════════════════════════════════════════════════
  // ③ 经验管理：记忆分层视图
  // ══════════════════════════════════════════════════════════
  function ensureMemoryLayerInAdmin() {
    const host = $('view-memoryadmin')?.querySelector('.detail-pane');
    if (!host) return null;

    let pane = $('mem-layers-pane');
    if (pane) return pane;

    pane = document.createElement('div');
    pane.id = 'mem-layers-pane';
    pane.style.display = 'none';

    const title = document.createElement('div');
    title.style.cssText = 'font-size:13px;font-weight:600;margin-bottom:10px';
    title.textContent = '记忆分层（只读）';
    pane.appendChild(title);

    const tip = document.createElement('div');
    tip.className = 'muted';
    tip.style.cssText = 'font-size:12px;margin-bottom:12px;line-height:1.8';
    tip.innerHTML = '五层记忆的文件视图。增删改在「经验」页做，这里只看家底。';
    pane.appendChild(tip);

    // 把原来的 #memory-items / #memory-detail 搬进来
    const items = $('memory-items');
    const detail = $('memory-detail');
    if (items) { items.style.display = ''; pane.appendChild(items); }
    if (detail) { detail.style.display = ''; pane.appendChild(detail); }

    host.appendChild(pane);
    return pane;
  }

  function toggleMemoryLayers(show) {
    const pane = ensureMemoryLayerInAdmin();
    if (!pane) return;
    pane.style.display = show ? '' : 'none';
    // 隐藏/恢复经验页自身的列表和工具栏
    const host = $('view-memoryadmin')?.querySelector('.detail-pane');
    if (host) {
      [...host.children].forEach((el) => {
        if (el === pane) return;
        if (show) {
          if (el.dataset._prevDisplay === undefined) el.dataset._prevDisplay = el.style.display || '';
          el.style.display = 'none';
        } else if (el.dataset._prevDisplay !== undefined) {
          el.style.display = el.dataset._prevDisplay;
          delete el.dataset._prevDisplay;
        }
      });
    }
    if (show) {
      try { loadMemoryView(); } catch (e) { console.warn('[nav] loadMemoryView 失败', e); }
    }
  }

  // ══════════════════════════════════════════════════════════
  // tab 切换：进入设置页时注入用量项；进入经验管理时注入分层按钮
  // ══════════════════════════════════════════════════════════
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.classList || !t.classList.contains('tab')) return;

    if (t.dataset.tab === 'usage') {
      // 独立 tab：直接触发渲染（04-archive-usage.js 里按可见性判断）
      setTimeout(() => { try { loadUsageView({ force: true }); } catch (e) { console.warn('[nav] loadUsageView', e); } }, 50);
    }
    if (t.dataset.tab === 'settings') {
      // 进设置页时把可能残留的用量面板搬回 view-usage
      setTimeout(initUsageTab, 30);
    }
    if (t.dataset.tab === 'memoryadmin') {
      setTimeout(() => { injectMemoryLayerBtn(); toggleMemoryLayers(false); }, 60);
    }
  });

  // 经验管理页注入「记忆分层」按钮
  function injectMemoryLayerBtn() {
    const host = $('view-memoryadmin')?.querySelector('.detail-pane');
    if (!host) return;
    if (host.querySelector('#mem-layers-btn')) return;

    // ⚠️ 2026-11-03：原来用 'div[style*="display:flex"]' 找工具栏 ——
    // 那是内联 style 字符串匹配，只要格式化时多一个空格就失效。
    // 改成按**语义**找：先看有没有 id，再退回"包含按钮的 div"。
    let bar = host.querySelector('#mem-toolbar');
    if (!bar) {
      // 退回：找第一个包含 input/select/button 的 div（工具栏的特征）
      bar = [...host.querySelectorAll('div')].find((d) =>
        d !== host && d.querySelector('input, select, button') && !d.querySelector('div')
      );
    }
    if (!bar) {
      // 最后兜底：自己造一个工具栏插到最前面
      bar = document.createElement('div');
      bar.id = 'mem-toolbar';
      bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:12px';
      host.insertBefore(bar, host.firstChild);
    }

    const btn = document.createElement('button');
    btn.id = 'mem-layers-btn';
    btn.className = 'nav-btn';
    btn.textContent = '记忆分层';
    btn.title = '看五层记忆的文件视图（只读）';
    btn.addEventListener('click', () => {
      const pane = $('mem-layers-pane');
      const showing = pane && pane.style.display !== 'none';
      toggleMemoryLayers(!showing);
      btn.textContent = showing ? '记忆分层' : '返回经验列表';
    });
    bar.appendChild(btn);
  }


  // ══════════════════════════════════════════════════════════
  // ④ 技能 / 插件 / 她的工具（R7-C C：三合一）
  // ══════════════════════════════════════════════════════════
  //
  // 三个切换对应三个容器：
  //   skill  → #skills-page   （loadModulePage('skill')）
  //   plugin → #plugins-page  （loadModulePage('plugin')）
  //   her    → #her-tools-page（/api/her-tools，8899 的「她自己写的功能」）
  let moduleMode = 'skill';

  function setModuleMode(mode) {
    if (!['skill', 'plugin', 'her'].includes(mode)) return;
    moduleMode = mode;

    document.querySelectorAll('#modules-sidebar .module-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.module === mode);
    });

    const map = { skill: 'skills-page', plugin: 'plugins-page', her: 'her-tools-page' };
    for (const [k, id] of Object.entries(map)) {
      const el = document.getElementById(id);
      if (el) el.style.display = (k === mode ? '' : 'none');
    }

    if (mode === 'skill' || mode === 'plugin') {
      try { loadModulePage(mode); } catch (e) { console.warn('[nav] loadModulePage 失败', e); }
    } else if (mode === 'her') {
      loadHerTools();
    }
  }

  /** 她写的工具：8899 的「她自己写的功能」（js/her-tools.js）。 */
  async function loadHerTools() {
    const box = document.getElementById('her-tools-page');
    if (!box || box.dataset.loaded === '1') return;
    box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
    try {
      const r = await fetch('/api/her-tools', { cache: 'no-store' });
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j.items || j.tools || []);
      if (!list.length) {
        box.innerHTML = '<div class="muted" style="padding:20px">她还没有自己写过工具。</div>';
        box.dataset.loaded = '1';
        return;
      }
      box.innerHTML = list.map((x) => {
        const name = String(x.name || x.id || x.title || '');
        const desc = String(x.description || x.desc || x.note || '');
        const enabled = x.enabled !== false;
        return `<div style="padding:12px;border-bottom:1px solid var(--bd)">
          <div style="display:flex;gap:8px;align-items:baseline">
            <strong style="font-size:13px">${escapeHtml(name)}</strong>
            <span class="muted" style="font-size:11px">${enabled ? '已启用' : '已停用'}</span>
          </div>
          <div class="muted" style="font-size:12px;margin-top:4px;line-height:1.7">${escapeHtml(desc)}</div>
        </div>`;
      }).join('');
      box.dataset.loaded = '1';
    } catch (e) {
      box.innerHTML = '<div class="muted" style="padding:20px">读取失败：' + escapeHtml(String(e?.message || e)) + '</div>';
    }
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // 点模块切换按钮
  document.addEventListener('click', (e) => {
    const b = e.target;
    if (b && b.classList && b.classList.contains('module-item') && b.dataset && b.dataset.module) {
      setModuleMode(b.dataset.module);
    }
  });

  // 进 tab 时初始化
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.classList || !t.classList.contains('tab')) return;
    if (t.dataset.tab === 'modules') {
      setTimeout(() => setModuleMode(moduleMode), 50);
    }
  });

  // 暴露给调试（setModuleMode 必须在对象创建后再挂，不能提前赋值）
  window.__navModes = {
    setSessionMode,
    setModuleMode,
    initUsageTab,
    toggleMemoryLayers,
    get sessionMode() { return sessionMode; }
  };
})();
