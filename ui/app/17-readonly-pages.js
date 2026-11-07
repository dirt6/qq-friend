// 日记 / 图片管理 / 空闲时间（R7-C D/E/F，2026-11-03）。
//
// 三个页面在同一个文件里，因为它们都属于"只读展示"，模式一致：
// 进入时拉一次，不轮询（日记和画不会秒级变化）。
(function () {
  const $ = (id) => document.getElementById(id);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path) {
    const r = await fetch(path, { cache: 'no-store' });
    return r.json();
  }

  function fmtTime(ts) {
    if (!ts) return '—';
    try {
      const d = new Date(typeof ts === 'number' ? ts : String(ts));
      if (Number.isNaN(d.getTime())) return String(ts);
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    } catch { return String(ts); }
  }

  // ══════════════════════════════════════════════════════════
  // ① 日记
  // ══════════════════════════════════════════════════════════
  let diaryLoaded = false;

  async function loadDiary() {
    const box = $('diary-body');
    if (!box || diaryLoaded) return;
    box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
    try {
      const j = await api('/api/diary?days=14');
      const head = `<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <button class="nav-btn" id="diary-add-btn" style="padding:4px 10px;font-size:11.5px">新增日记</button>
        <button class="nav-btn" id="diary-refresh" style="padding:4px 10px;font-size:11.5px">刷新</button>
      </div>`;
      if (!j.ok) { box.innerHTML = head + '<div class="muted" style="padding:20px">读取失败：' + esc(j.error || j.code) + '</div>'; return; }
      if (!j.days || !j.days.length) {
        box.innerHTML = head + '<div class="muted" style="padding:20px">' + esc(j.note || '还没有日记。') + '</div>';
        diaryLoaded = true;
        return;
      }

      box.innerHTML = head + j.days.map((day) => {
        const entries = (day.entries || []).map((e, idx) => `
          <div class="diary-entry" data-day="${esc(day.day)}" data-entry-index="${idx}" style="padding:10px 0;border-bottom:1px solid var(--bd)">
            <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
              <span style="font-size:11px;padding:1px 7px;border-radius:999px;background:var(--bg2);color:var(--tx2)">${esc(e.mood)}</span>
              ${e.importance === '非常重要' ? '<span style="font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(184,134,11,.28);color:#ffd479">非常重要</span>' : (e.important ? '<span style="font-size:11px;padding:1px 7px;border-radius:999px;background:rgba(184,134,11,.18);color:#dd9f3f">重要</span>' : '')}
              <button class="nav-btn diary-edit" data-day="${esc(day.day)}" data-text="${esc(e.text)}"
                      style="margin-left:auto;padding:2px 7px;font-size:10.5px">改</button>
              <button class="nav-btn diary-del" data-day="${esc(day.day)}" data-text="${esc(e.text)}"
                      style="padding:2px 7px;font-size:10.5px;color:#c55">删</button>
            </div>
            <div style="font-size:13px;line-height:1.8;margin-top:6px;word-break:break-word">${esc(e.text)}</div>
          </div>`).join('');

        return `
          <details style="margin-bottom:10px;border:1px solid var(--bd);border-radius:10px;padding:0 14px" ${day === j.days[0] ? 'open' : ''}>
            <summary style="cursor:pointer;padding:12px 0;font-size:13px;font-weight:600">
              ${esc(day.day)}${day.title ? ' · ' + esc(day.title) : ''}
              <span class="muted" style="font-weight:400;font-size:11.5px;margin-left:8px">${(day.entries || []).length} 条</span>
            </summary>
            <div style="padding-bottom:8px">${entries || '<div class="muted" style="font-size:12px;padding:8px 0">这天没有条目</div>'}</div>
          </details>`;
      }).join('');
      diaryLoaded = true;
    } catch (e) {
      box.innerHTML = '<div class="muted" style="padding:20px">读取异常：' + esc(String(e?.message || e)) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════
  // ② 图片管理（表情包 / 她的画）
  // ══════════════════════════════════════════════════════════
  let galleryMode = 'sticker';
  let stickerLoaded = false;
  let drawingLoaded = false;

  function setGalleryMode(mode) {
    if (mode !== 'sticker' && mode !== 'drawing') return;
    galleryMode = mode;
    document.querySelectorAll('#gallery-sidebar .module-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.gallery === mode);
    });
    const sBox = $('gallery-stickers');
    const dBox = $('gallery-drawings');
    if (sBox) sBox.style.display = (mode === 'sticker' ? '' : 'none');
    if (dBox) dBox.style.display = (mode === 'drawing' ? '' : 'none');
    if (mode === 'sticker') loadStickers();
    else loadDrawings();
  }

  async function loadStickers() {
    const box = $('gallery-stickers');
    if (!box || stickerLoaded) return;
    box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
    try {
      const j = await api('/api/stickers');
      if (!j.ok) { box.innerHTML = '<div class="muted" style="padding:20px">读取失败</div>'; return; }
      if (!j.items || !j.items.length) {
        box.innerHTML = '<div class="muted" style="padding:20px">' + esc(j.note || '还没有表情包。') + '</div>';
        stickerLoaded = true;
        return;
      }
      box.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
          <span class="muted" style="font-size:12px">共 ${j.total} 个表情包</span>
          <button class="nav-btn" id="sticker-sync-btn" style="margin-left:auto;padding:4px 10px;font-size:11.5px" title="从 QQ 收藏拉取最新列表">同步</button>
          <button class="nav-btn" id="sticker-repair-btn" style="padding:4px 10px;font-size:11.5px" title="把只有网络链接的表情下载到本地（链接会过期）">修复本地文件</button>
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
          ${j.items.map((x) => `
            <div style="padding:8px;border:1px solid var(--bd);border-radius:8px;font-size:12px;display:flex;flex-direction:column">
              ${x.imageUrl
                ? `<img src="${esc(x.imageUrl)}" alt="${esc(x.id)}" loading="lazy"
                       style="width:100%;height:140px;object-fit:contain;background:var(--bg2);border-radius:6px;margin-bottom:8px">`
                : '<div class="muted" style="height:140px;display:flex;align-items:center;justify-content:center;background:var(--bg2);border-radius:6px;margin-bottom:8px;font-size:11px">没有图片文件</div>'}
              <div style="font-weight:600;word-break:break-all;font-size:11.5px">${esc(x.id)}</div>
              ${x.broken ? '<div style="margin-top:4px;font-size:11px;color:#d67a7f">持久化失败</div>' : ''}
              ${x.note ? '<div class="muted" style="margin-top:6px;font-size:11.5px;line-height:1.6">' + esc(x.note) + '</div>' : ''}
              <div style="display:flex;gap:4px;margin-top:8px">
                <button class="nav-btn sticker-note" data-id="${esc(x.id)}" style="padding:3px 8px;font-size:11px">备注</button>
                <button class="nav-btn sticker-del" data-id="${esc(x.id)}" style="padding:3px 8px;font-size:11px;color:#c55">移除</button>
              </div>
            </div>`).join('')}
        </div>`;
      stickerLoaded = true;
    } catch (e) {
      box.innerHTML = '<div class="muted" style="padding:20px">读取异常：' + esc(String(e?.message || e)) + '</div>';
    }
  }

  async function loadDrawings() {
    const box = $('gallery-drawings');
    if (!box || drawingLoaded) return;
    box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
    try {
      const j = await api('/api/drawings?limit=200');
      if (!j.ok) { box.innerHTML = '<div class="muted" style="padding:20px">读取失败</div>'; return; }
      if (!j.items || !j.items.length) {
        box.innerHTML = '<div class="muted" style="padding:20px">' + esc(j.note || '还没有画。') + '</div>';
        drawingLoaded = true;
        return;
      }
      box.innerHTML = `
        <div class="muted" style="font-size:12px;margin-bottom:10px">共 ${j.total} 张</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px">
          ${j.items.map((x) => `
            <figure style="margin:0;border:1px solid var(--bd);border-radius:8px;overflow:hidden">
              <img src="${esc(x.url)}" alt="${esc(x.name)}" loading="lazy"
                   style="width:100%;height:auto;display:block;background:var(--bg2)">
              <figcaption class="muted" style="font-size:11px;padding:6px 8px">
                <div style="font-size:13px;color:var(--fg);font-weight:600;line-height:1.3;margin-bottom:4px">${esc(x.title || '未命名')}</div>
                <div style="display:flex;align-items:center;gap:6px">
                  <span>${esc(fmtTime(x.at))} · ${Math.round(x.size / 1024)}KB</span>
                  <button class="nav-btn drawing-title" data-name="${esc(x.name)}" data-title="${esc(x.title || '')}"
                          style="margin-left:auto;padding:2px 7px;font-size:10.5px"
                          title="修改这张画的标题">改标题</button>
                  <button class="nav-btn drawing-del" data-name="${esc(x.name)}"
                          style="padding:2px 7px;font-size:10.5px;color:#c55"
                          title="删掉这张画的文件（不可恢复）">删除</button>
                </div>
              </figcaption>
            </figure>`).join('')}
        </div>`;
      drawingLoaded = true;
    } catch (e) {
      box.innerHTML = '<div class="muted" style="padding:20px">读取异常：' + esc(String(e?.message || e)) + '</div>';
    }
  }

  // ══════════════════════════════════════════════════════════
  // ③ 空闲时间
  // ══════════════════════════════════════════════════════════
  let idleLoaded = false;

  async function loadIdle() {
    const box = $('idle-body');
    if (!box || idleLoaded) return;
    box.innerHTML = '<div class="muted" style="padding:20px">加载中…</div>';
    try {
      const j = await api('/api/autonomous');
      if (!j.ok) { box.innerHTML = '<div class="muted" style="padding:20px">' + esc(j.note || '读取失败') + '</div>'; return; }

      const stat = (label, value) => `
        <div style="padding:10px 12px;border:1px solid var(--bd);border-radius:8px">
          <div class="muted" style="font-size:11px">${esc(label)}</div>
          <div style="font-size:13px;font-weight:600;margin-top:4px">${esc(value)}</div>
        </div>`;

      // 5.0 是真实来源；旧 autonomous.json 只留作历史
      const v5 = j.v5 || null;
      const wakeLabel = (ts, src) => {
        if (!ts) return '—';
        const t = fmtTime(ts);
        if (src === 'self') return `${t}（她自己设的）`;
        if (src === 'system') return `${t}（系统周期）`;
        return t;
      };
      const actText = {
        browse: '逛小黑盒', diary: '整理日记', write_diary: '写日记', write_notebook: '写本子',
        share: '分享', chat: '找老大', comment: 'B站评论', reply: 'B站回复',
        sleep: '睡觉', none: '没做', skip: '跳过'
      };
      const v5recent = v5 ? (v5.recent || []).map((x) => {
        const act = actText[x.action] || x.action || x.type || '—';
        const outcome = x.ok === false ? '失败' : (x.done ? '已做' : '未推进');
        return `
        <div style="padding:10px 0;border-bottom:1px solid var(--bd);font-size:12px">
          <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
            <span class="muted">${esc(fmtTime(x.at))}</span>
            <span style="padding:1px 6px;border-radius:4px;background:var(--bg2)">${esc(outcome)}</span>
            <span style="font-weight:600">${esc(act)}</span>
            ${x.title ? '<span class="muted">· ' + esc(x.title) + '</span>' : ''}
          </div>
          ${x.summary ? '<div style="margin-top:4px;line-height:1.7">' + esc(x.summary) + '</div>' : ''}
          ${x.reason ? '<div class="muted" style="margin-top:2px;line-height:1.6;font-size:11.5px">' + esc(x.reason) + '</div>' : ''}
          ${x.next ? '<div class="muted" style="margin-top:2px;line-height:1.6;font-size:11.5px">下一步：' + esc(x.next) + '</div>' : ''}
        </div>`;
      }).join('') : '';

      const v5pending = v5 && (v5.pending || []).length
        ? v5.pending.map((p) => `<div style="padding:6px 0;font-size:12px"><span class="muted">${esc(p.status || '')}</span> · ${esc(p.text)}</div>`).join('')
        : '';

      const hist = (j.history || []).map((h) => `
        <div style="padding:10px 0;border-bottom:1px solid var(--bd);font-size:12px">
          <div style="display:flex;gap:8px;align-items:baseline;flex-wrap:wrap">
            <span class="muted">${esc(fmtTime(h.startedAt))}</span>
            ${h.status ? '<span style="padding:1px 6px;border-radius:4px;background:var(--bg2)">' + esc(h.status) + '</span>' : ''}
            ${h.modelCalls ? '<span class="muted">' + h.modelCalls + ' 次模型</span>' : ''}
            ${(h.inputTokens || h.outputTokens) ? '<span class="muted">' + (h.inputTokens + h.outputTokens) + ' tok</span>' : ''}
            ${h.action ? '<span class="muted">' + esc(h.action) + '</span>' : ''}
            <button class="nav-btn idle-del" data-round="${esc(h.roundId)}" style="margin-left:auto;padding:2px 8px;font-size:11px;color:#c55">删除</button>
          </div>
          ${h.goal ? '<div style="margin-top:4px;line-height:1.7">目标：' + esc(h.goal) + '</div>' : ''}
          ${h.why ? '<div class="muted" style="margin-top:2px;line-height:1.7">' + esc(h.why) + '</div>' : ''}
          ${h.stopReason ? '<div class="muted" style="margin-top:2px;line-height:1.6;font-size:11.5px">停因：' + esc(h.stopReason) + '</div>' : ''}
          ${h.error ? '<div style="margin-top:2px;line-height:1.6;font-size:11.5px;color:#d67a7f">' + esc(h.error) + '</div>' : ''}
        </div>`).join('');

      const shares = (j.shares || []).map((x) =>
        `<div style="padding:6px 0;font-size:12px"><span class="muted">${esc(fmtTime(x.at))}</span> · ${esc(x.title)}</div>`).join('');

      const digests = (j.digests || []).map((x) =>
        `<div style="padding:6px 0;font-size:12px"><span class="muted">${esc(fmtTime(x.at))}</span> · ${esc(x.text)}</div>`).join('');

      const mm = v5 && v5.metrics ? v5.metrics : null;
      const metricsHtml = mm ? `
        <h4 style="margin:0 0 8px;font-size:13px">近 7 天</h4>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:18px">
          ${stat('醒来轮次', String(mm.rounds || 0))}
          ${stat('主动聊天', String(mm.activeMessages || 0))}
          ${stat('分享', String(mm.shares || 0))}
          ${stat('评论/回复', String((mm.comments || 0) + (mm.replies || 0)))}
          ${stat('写日记/本子', String(mm.writes || 0))}
          ${stat('安静跳过', String(mm.quietSkips || 0))}
          ${stat('模型调用', String(mm.cost?.calls || 0))}
          ${stat('估算成本', (Number(mm.cost?.yuan) || 0).toFixed(3) + ' 元')}
        </div>` : '';

      box.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:18px">
          ${stat('状态', (v5 ? v5.status : j.status) || '—')}
          ${stat('上次醒来', fmtTime(v5 ? v5.lastWakeAt : j.lastWakeAt))}
          ${stat('下次醒来', wakeLabel(v5 ? v5.nextWakeAt : j.nextWakeAt, v5 ? v5.nextWakeSource : ''))}
          ${stat('节奏', v5 && v5.intervalMinutes ? `每 ${v5.intervalMinutes} 分钟 / 窗口 ${v5.windowMinutes} 分钟` : '—')}
          ${stat('静默', (v5 && v5.quietHours) || '—')}
          ${stat('活动', v5 && (v5.activities || []).length ? v5.activities.join('、') : '—')}
        </div>

        <div style="margin-bottom:16px;padding:12px;border:1px solid var(--bd);border-radius:8px">
          <div class="muted" style="font-size:11px;margin-bottom:4px">当前在追的方向（5.0 Goal）</div>
          <div style="font-size:13px;line-height:1.8">${v5 && v5.goal ? esc(v5.goal.text) : '<span class="muted">没有在追的长期方向</span>'}</div>
          ${v5 && v5.goal && v5.goal.source ? '<div class="muted" style="font-size:11px;margin-top:4px">来源：' + esc(v5.goal.source) + '</div>' : ''}
          ${v5pending ? '<div class="muted" style="font-size:11px;margin-top:10px">她的待办</div>' + v5pending : ''}
          ${v5 && v5.selfWake ? '<div class="muted" style="font-size:11px;margin-top:10px">她自己约的醒来：' + esc(fmtTime(v5.selfWake.wakeAt)) + (v5.selfWake.reason ? '（' + esc(v5.selfWake.reason) + '）' : '') + (v5.selfWake.due ? '（已到期，马上会醒）' : '') + '</div>' : ''}
        </div>

        ${metricsHtml}

        <h4 style="margin:0 0 8px;font-size:13px">最近的醒来（5.0）</h4>
        <div style="margin-bottom:18px">${v5recent || '<div class="muted" style="font-size:12px">还没有记录</div>'}</div>

        ${hist ? `<details style="margin-bottom:18px"><summary class="muted" style="cursor:pointer;font-size:12px">旧插件记录（4.0 之前，仅供参考）</summary><div style="margin-top:8px">${hist}</div></details>` : ''}
        ${shares ? `<h4 style="margin:0 0 8px;font-size:13px">最近分享（旧）</h4><div style="margin-bottom:18px">${shares}</div>` : ''}
        ${digests ? `<h4 style="margin:0 0 8px;font-size:13px">最近总结（旧）</h4><div>${digests}</div>` : ''}
      `;
      idleLoaded = true;
    } catch (e) {
      box.innerHTML = '<div class="muted" style="padding:20px">读取异常：' + esc(String(e?.message || e)) + '</div>';
    }
  }



  // ── 导航上的「关闭 QQ Agent」（2026-11-03）──────────────
  //
  // 原先是"重启机器人"，但自动拉起试过三种方案（helper bat / cmd spawn /
  // PowerShell Start-Process）全部失败：进程退了但不会自己回来。
  // 机主决定改成**只关不启** —— 关掉之后手动点桌面快捷方式重新打开。
  async function navQuit() {
    if (!await uiConfirm("关闭 QQ Agent？\n\n不会自动重启，需要手动点桌面快捷方式重新打开。\n（聊天记录和记忆都已保存）")) return;
    const btn = document.getElementById("nav-restart-btn");
    const old = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "关闭中…"; }
    try {
      await apiPost("/api/app/quit", {});
      // 请求发出去之后进程就会退出，正常拿不到什么响应
      alert("已发出关闭指令。如果页面没断，等 1~2 秒刷新一下。");
    } catch (e) {
      // 进程退出会导致 fetch 报错，这是预期的
      console.log("[quit] 连接被断开（预期行为）");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = old || "关闭"; }
    }
  }

  // ── 空闲时间记录删除（R7-C D6）──────────────────────────
  async function idleDelete(roundId) {
    if (!await uiConfirm("删除这条记录？\n\n" + roundId + "\n⚠️ 会真删 autonomous.json 里的这一条，不可恢复。")) return;
    const r = await apiPost("/api/autonomous/delete", { roundId, confirm: true });
    alert(r.ok ? (r.message + "（" + r.before + " → " + r.after + " 条）") : ("失败：" + (r.error || r.code)));
    idleLoaded = false;
    loadIdle();
  }

  // ── 表情包同步 / 修复（R7-C D7）──────────────────────────
  async function stickerSync() {
    const btn = document.getElementById("sticker-sync-btn");
    if (btn) { btn.disabled = true; btn.textContent = "同步中…"; }
    try {
      const r = await apiPost("/api/stickers/sync", {});
      alert(r.ok ? r.message : ("失败：" + (r.error || r.code)));
      if (r.ok) { stickerLoaded = false; setGalleryMode("sticker"); }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "同步"; }
    }
  }

  async function stickerRepair() {
    const btn = document.getElementById("sticker-repair-btn");
    if (btn) { btn.disabled = true; btn.textContent = "修复中…"; }
    try {
      const r = await apiPost("/api/stickers/repair", {});
      if (r.ok) {
        let msg = r.message;
        if (r.errors && r.errors.length) msg += "\n\n失败详情（前 5 条）：\n" + r.errors.join("\n");
        alert(msg);
        stickerLoaded = false;
        setGalleryMode("sticker");
      } else {
        alert("修复失败：" + (r.error || r.code));
      }
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "修复本地文件"; }
    }
  }

  // ── 表情包写操作（R7-C D5）──────────────────────────────
  async function stickerNote(id) {
    const note = await uiPrompt("给这个表情写备注（她会按备注选图）：");
    if (note === null) return;
    const r = await apiPost("/api/stickers/note", { id, localNote: note });
    alert(r.ok ? r.message : ("失败：" + (r.error || r.code)));
    stickerLoaded = false;
    setGalleryMode("sticker");
  }

  async function stickerDelete(id) {
    if (!await uiConfirm("从她的库里移除「" + id + "」？\n\n⚠️ 只从库移除，**QQ 收藏和本地图片都不动**。")) return;
    const r = await apiPost("/api/stickers/delete", { id, confirm: true });
    alert(r.ok ? r.message : ("失败：" + (r.error || r.code)));
    stickerLoaded = false;
    setGalleryMode("sticker");
  }

  async function drawingDelete(name) {
    if (!await uiConfirm("删除这张画？\n\n⚠️ **会真删文件**，不可恢复。\n" + name)) return;
    const r = await apiPost("/api/drawings/delete", { name, confirm: true });
    alert(r.ok ? r.message : ("失败：" + (r.error || r.code)));
    drawingLoaded = false;
    setGalleryMode("drawing");
  }

  async function drawingTitle(name, current) {
    const next = await uiPrompt("修改画作标题（最多 60 字）", current || "");
    if (next === null) return;
    if (next.length > 60) { alert("标题最多 60 字"); return; }
    const r = await apiPost("/api/drawings/title", { name, title: next });
    if (!r.ok) { alert("失败：" + (r.error || r.code)); return; }
    drawingLoaded = false;
    setGalleryMode("drawing");
  }

  async function diaryAdd() {
    const today = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const def = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const day = await uiPrompt("日期（YYYY-MM-DD）", def);
    if (day === null) return;
    const mood = await uiPrompt("心情", "平静");
    if (mood === null) return;
    const content = await uiPrompt("日记内容（最多 2000 字）", "");
    if (content === null) return;
    const r = await apiPost("/api/diary/add", { day, mood, content });
    if (!r.ok) { alert("新增失败：" + (r.error || r.code)); return; }
    diaryLoaded = false;
    setGalleryMode(galleryMode);
    loadDiary();
    window.dispatchEvent(new CustomEvent("diary-changed", { detail: { day } }));
  }

  async function diaryEdit(day, text) {
    const content = await uiPrompt("修改这条日记（最多 2000 字）", text);
    if (content === null) return;
    const r = await apiPost("/api/diary/edit", { day, match: text, content });
    if (!r.ok) { alert("修改失败：" + (r.error || r.code) + (r.candidates && r.candidates.length ? "\n\n候选：\n" + r.candidates.join("\n") : "")); return; }
    diaryLoaded = false;
    loadDiary();
    window.dispatchEvent(new CustomEvent("diary-changed", { detail: { day } }));
  }

  async function diaryDelete(day, text) {
    if (!await uiConfirm("删除这条日记？\n\n" + day + "\n" + text.slice(0, 120))) return;
    const r = await apiPost("/api/diary/delete", { day, match: text });
    if (!r.ok) { alert("删除失败：" + (r.error || r.code) + (r.candidates && r.candidates.length ? "\n\n候选：\n" + r.candidates.join("\n") : "")); return; }
    diaryLoaded = false;
    loadDiary();
    window.dispatchEvent(new CustomEvent("diary-changed", { detail: { day } }));
  }

  async function apiPost(path, body) {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return r.json();
  }

  // 绑定按钮
  document.addEventListener("click", (e) => {
    const t = e.target;
    if (!t) return;
    if (t.id === "sticker-sync-btn") { stickerSync(); return; }
    if (t.id === "sticker-repair-btn") { stickerRepair(); return; }
    if (t.id === "nav-restart-btn") { navQuit(); return; }
    if (t.classList && t.classList.contains("idle-del")) { idleDelete(t.dataset.round); return; }
    if (t.classList && t.classList.contains("sticker-note")) { stickerNote(t.dataset.id); return; }
    if (t.classList && t.classList.contains("sticker-del")) { stickerDelete(t.dataset.id); return; }
    if (t.classList && t.classList.contains("drawing-del")) { drawingDelete(t.dataset.name); return; }
    if (t.classList && t.classList.contains("drawing-title")) { drawingTitle(t.dataset.name, t.dataset.title || ""); return; }
  });

  // ══════════════════════════════════════════════════════════
  // 事件绑定
  // ══════════════════════════════════════════════════════════
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t) return;
    if (t.classList && t.classList.contains('module-item') && t.dataset && t.dataset.gallery) {
      setGalleryMode(t.dataset.gallery);
      return;
    }
    if (t.id === 'diary-refresh') { diaryLoaded = false; loadDiary(); }
    if (t.id === 'diary-add-btn') { diaryAdd(); return; }
    if (t.classList && t.classList.contains('diary-del')) { diaryDelete(t.dataset.day, t.dataset.text || ''); return; }
    if (t.classList && t.classList.contains('diary-edit')) { diaryEdit(t.dataset.day, t.dataset.text || ''); return; }
    if (t.id === 'gallery-refresh') { stickerLoaded = false; drawingLoaded = false; setGalleryMode(galleryMode); }
    if (t.id === 'idle-refresh') { idleLoaded = false; loadIdle(); }
  });

  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!t || !t.dataset || !t.classList || !t.classList.contains('tab')) return;
    if (t.dataset.tab === 'diary') setTimeout(loadDiary, 50);
    if (t.dataset.tab === 'gallery') setTimeout(() => setGalleryMode(galleryMode), 50);
    if (t.dataset.tab === 'idle') setTimeout(loadIdle, 50);
  });

  window.__readOnlyPages = { loadDiary, loadIdle, setGalleryMode };
})();
