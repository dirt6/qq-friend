// 星图 UI 冒烟：用最小 DOM / Canvas 桩加载 ui/app/18-star-map.js，
// 确认初始化、拉图、布局、绘制都不抛错。Canvas 的真实像素效果靠人工验收。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const coreCode = fs.readFileSync(path.join(ROOT, 'ui', 'app', 'star-map-core.js'), 'utf8');
const uiCode = fs.readFileSync(path.join(ROOT, 'ui', 'app', '18-star-map.js'), 'utf8');

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

// ── 极简 DOM 桩 ────────────────────────────────────────────
const draws = { fill: 0, arc: 0, stroke: 0 };
const ctx = new Proxy({}, {
  get(_t, k) {
    if (k === 'createRadialGradient') return () => ({ addColorStop() {} });
    if (k === 'arc') return () => { draws.arc += 1; };
    if (k === 'fill') return () => { draws.fill += 1; };
    if (k === 'stroke') return () => { draws.stroke += 1; };
    return () => {};
  },
  set() { return true; }
});

function makeEl(id) {
  const el = {
    id,
    hidden: true,
    textContent: '',
    innerHTML: '',
    style: {},
    width: 0,
    height: 0,
    dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener() {},
    getBoundingClientRect() { return { width: 720, height: 480, left: 0, top: 0 }; },
    getContext() { return ctx; },
    closest() { return null; }
  };
  return el;
}
const els = new Map();
const getEl = (id) => {
  if (!els.has(id)) {
    const el = makeEl(id);
    if (id === 'view-diary') el.classList.add('active');
    els.set(id, el);
  }
  return els.get(id);
};

const document = {
  getElementById: getEl,
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  createElement: () => makeEl('created')
};

let graphRequests = 0;
function fetchMock(url) {
  if (String(url).includes('/api/star-map/graph')) {
    graphRequests += 1;
    return Promise.resolve({ json: async () => ({
      ok: true,
      scope: 'diary',
      counts: { diaryDays: 2, diaryEntries: 3, learned: 0, impression: 0 },
      fingerprint: 'e7522a8b00000000000000000000000000000000',
      nodes: [
        { id: 'diary:2026-11-01:aaaaaaaa', kind: 'diary', layer: 'general', topic: 0, heat: 0.5, day: '2026-11-01', entryIndex: 0, content: '软件修好之后', mood: '踏实', important: false, weight: 0.6, brightness: 0.7, radiusPx: 3, flags: { today: false } },
        { id: 'diary:2026-11-01:bbbbbbbb', kind: 'diary', layer: 'general', topic: 0, heat: 0.5, day: '2026-11-01', entryIndex: 1, content: '想找人说话', mood: '想找人说话', important: false, weight: 0.6, brightness: 0.7, radiusPx: 3, flags: { today: false } },
        { id: 'diary:2026-11-02:cccccccc', kind: 'diary', layer: 'arm', topic: 0, heat: 0.7, day: '2026-11-02', entryIndex: 0, content: '整理房间', mood: '平静', important: true, weight: 0.8, brightness: 0.85, radiusPx: 4, flags: { today: true } }
      ],
      edges: [
        { from: 'diary:2026-11-01:aaaaaaaa', to: 'diary:2026-11-01:bbbbbbbb', kind: 'same-day', weight: 0.9 },
        { from: 'diary:2026-11-01:aaaaaaaa', to: 'diary:2026-11-02:cccccccc', kind: 'keyword', weight: 0.6 }
      ],
      meta: { truncated: false, omitted: 0, emptyReasons: [] }
    }) });
  }
  return Promise.resolve({ json: async () => ({ ok: true, days: 2, entries: 3, gaps: {}, emptyDays: [], moodFrequency: [] }) });
}

const sandbox = {
  console,
  document,
  fetch: fetchMock,
  localStorage: { getItem: () => null, setItem: () => {} },
  devicePixelRatio: 1,
  setTimeout,
  clearTimeout,
  confirm: () => true,
  CustomEvent: function () {},
  addEventListener: () => {},
  removeEventListener: () => {},
  Map, Set, Math, Date, Number, String, Object, Array, JSON
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

vm.runInNewContext(coreCode, sandbox);
vm.runInNewContext(uiCode, sandbox);

ok('core 已挂载', Boolean(sandbox.__starMapCore));
ok('UI 已挂载', Boolean(sandbox.__starMap));

await sandbox.__starMap.loadGraph();
const st = sandbox.__starMap.state;
ok('拉到了 graph', st.graph?.nodes?.length === 3, String(st.graph?.nodes?.length));
ok('布局覆盖全部节点', st.layout?.positions?.size === 3, String(st.layout?.positions?.size));
ok('画布尺寸已设置', st.w >= 320 && st.h >= 240, `${st.w}x${st.h}`);
ok('确实发生绘制', draws.arc > 0 && draws.fill > 0, JSON.stringify(draws));
ok('摘要更新', String(getEl('star-summary').textContent).includes('旋臂'), getEl('star-summary').textContent);
ok('空态隐藏', getEl('star-empty').hidden === true);
ok('只请求一次 graph', graphRequests === 1, String(graphRequests));

console.log(`\nStar map UI smoke: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
