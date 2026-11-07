// 扫码登录页（R7 骨架，2026-11-03）。
//
// 机主授权范围：
//   · 显示二维码图片区域
//   · 显示文件更新时间
//   · 文件不存在时显示等待状态
//   · **显示"二维码有效性尚未验证"警告，不能误导用户扫码**
//   · 先不做自动登录状态判断
//
// ⚠️ 这里**不做**：自动刷新（避免在未验证更新语义前制造假象）、
//    登录状态判断、调用 6099 WebUI、读 token。

(function () {
  const $ = (id) => document.getElementById(id);

  let loaded = false;

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    } catch { return iso; }
  }

  function fmtSize(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    return (n / 1024).toFixed(1) + ' KB';
  }

  function show(which) {
    const map = { empty: 'qr-empty', box: 'qr-box', error: 'qr-error' };
    for (const [k, id] of Object.entries(map)) {
      const el = $(id);
      if (el) el.style.display = (k === which ? '' : 'none');
    }
  }

  async function load() {
    loaded = false;
    const errBox = $('qr-error');
    const errMsg = $('qr-error-msg');
    if (errBox) errBox.style.display = 'none';

    try {
      const r = await fetch('/api/napcat/qrcode', { cache: 'no-store' });
      const j = await r.json();

      if (!j.ok) {
        // 明确区分"文件不存在"和"读失败"
        if (j.code === 'QR_NOT_FOUND') {
          show('empty');
          return;
        }
        show('error');
        if (errMsg) errMsg.textContent = (j.code ? j.code + '：' : '') + (j.error || '未知错误');
        return;
      }

      // 成功：显示图片 + 元信息
      const img = $('qr-img');
      if (img) img.src = j.dataUrl;
      const mt = $('qr-mtime');
      if (mt) mt.textContent = fmtTime(j.mtime);
      const sz = $('qr-size');
      if (sz) sz.textContent = fmtSize(j.size);
      const note = $('qr-note');
      if (note) note.textContent = j.note || '';

      // ⚠️ updateVerified 为 false 时，警告条保持显示（不隐藏）
      const warn = $('qr-warning');
      if (warn) {
        if (j.updateVerified === true) warn.style.display = 'none';
        else warn.style.display = '';
      }

      show('box');
      loaded = true;
    } catch (e) {
      show('error');
      if (errMsg) errMsg.textContent = String(e?.message || e);
    }
  }

  // 挂到全局，供 tab 切换调用
  window.__qrLogin = {
    // 首次进入时加载；已经加载过就不重复请求
    onEnter() {
      if (!loaded) load();
    },
    reload: load
  };

  // 「重新读取」按钮
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.id === 'qr-refresh') load();
  });

  // tab 切换时触发（监听 data-tab 点击）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.dataset && t.dataset.tab === 'qrlogin') {
      // 等视图切换完成再加载
      setTimeout(() => window.__qrLogin.onEnter(), 50);
    }
  });
})();
