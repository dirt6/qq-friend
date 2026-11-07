// 小黑盒只读链路验证（不写任何东西）。
// 用法：node scripts/xhh-probe.mjs

import path from 'node:path';
import { XhhClient } from '../plugins/autonomous/lib/xhh/client.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const client = new XhhClient({ authFile: path.join(ROOT, 'data', 'xhh-auth.json') });

console.log(`登录态：${client.loggedIn ? '已加载' : '缺失（' + client.lastAuthError + '）'}`);

const id = await client.identity();
console.log(`\n[身份] ok=${id.ok} uid=${id.uid || '?'} 权限字段=${id.permissions} ${id.error || ''}`);

const s = await client.search('独立游戏', { limit: 3 });
console.log(`\n[搜索] ok=${s.ok} 条目=${s.items.length} ${s.error || ''}`);
for (const it of s.items) {
  console.log(`  · ${it.title.slice(0, 40)} | ${it.tags.join('/') || '-'} | ${it.publishedAt || '-'} | ${it.url}`);
}

const f = await client.feed({ limit: 3 });
console.log(`\n[推荐流] ok=${f.ok} 条目=${f.items.length} ${f.error || ''}`);
for (const it of f.items) console.log(`  · ${it.title.slice(0, 40)} | ${it.url}`);

const m = await client.messages('mention');
console.log(`\n[通知 mention] ok=${m.ok} ${m.error || ''}`);
if (m.ok) {
  const body = m.body || {};
  console.log(`  顶层键: ${Object.keys(body).join(',')}`);
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (Array.isArray(v)) console.log(`    ${k}: 数组 ${v.length} 条${v[0] ? '，首条键=' + Object.keys(v[0]).slice(0, 12).join(',') : ''}`);
  }
}

if (s.items[0]) {
  const t = await client.linkTree(s.items[0].contentId);
  console.log(`\n[帖子详情] ok=${t.ok} ${t.error || ''}`);
  const r = t.json?.result || {};
  console.log(`  result 键: ${Object.keys(r).slice(0, 12).join(',')}`);
}
