// 修复 3：token-saver 的设置声明改成项目标准写法
//
// 三处不兼容（都会让设置页显示异常）：
//   ① 缺 label —— 审计与 UI 都认 label（ui/app/06-settings-render.js:1128 是 d.label || key），
//      只有 title 时表单会显示裸键名 keepRecentMessages 这种。
//   ② type:"select" + options —— UI 只把 type:"enum" + values 渲染成下拉
//      （06-settings-render.js:1145），否则会退化成文本框，得手打 off/window/aggressive。
//   ③ 缺 default —— 项目惯例是声明默认值。
// 保留 title 字段（向后兼容，别的读取方可能还在用），只做增益式修改。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'plugins', 'token-saver', 'plugin.json');

const raw = fs.readFileSync(FILE, 'utf8');
const before = JSON.parse(raw);
fs.writeFileSync(path.join(ROOT, 'data', `token-saver-plugin.json.bak-${Date.now()}`), raw, 'utf8');
console.log('[备份] data/token-saver-plugin.json.bak-*');

const defaults = before.settings || {};
const schema = before.configSchema || {};
const changes = [];

for (const [key, def] of Object.entries(schema)) {
  // ① label：从 title 补（项目里两边都写的扩展很多）
  if (!def.label) {
    def.label = def.title || key;
    changes.push(`${key}: 补 label = ${JSON.stringify(def.label)}`);
  }
  // ② select -> enum（UI 才认，否则渲染成文本框）
  if (def.type === 'select') {
    def.type = 'enum';
    changes.push(`${key}: type select -> enum`);
  }
  if (Array.isArray(def.options) && !Array.isArray(def.values)) {
    def.values = def.options;
    delete def.options;
    changes.push(`${key}: options -> values ${JSON.stringify(def.values)}`);
  }
  // ③ default：把当前 settings 里的值作为默认写进 schema
  if (def.default === undefined && defaults[key] !== undefined) {
    def.default = defaults[key];
    changes.push(`${key}: 补 default = ${JSON.stringify(def.default)}`);
  }
}

fs.writeFileSync(FILE, JSON.stringify(before, null, 2) + '\n', 'utf8');
console.log('[写入] 共 ' + changes.length + ' 处：');
for (const c of changes) console.log('   ' + c);

// ── 回读校验 ──────────────────────────────────────────────────────────────
const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const problems = [];
if (JSON.stringify(after.settings) !== JSON.stringify(defaults)) problems.push('settings 值被改动了（不该发生）');
for (const [k, d] of Object.entries(after.configSchema || {})) {
  if (!d.label) problems.push(k + ' 仍缺 label');
  if (!d.type) problems.push(k + ' 缺 type');
  if (d.type === 'enum' && !Array.isArray(d.values)) problems.push(k + ' 是 enum 但没有 values');
  if (/^[a-zA-Z]+$/.test(k) && String(d.label) === k) problems.push(k + ' 的 label 只是键名（等于没写）');
}
console.log('[校验] settings 原样 = ' + (JSON.stringify(after.settings) === JSON.stringify(defaults)));
console.log('[校验] 7 项声明:');
for (const [k, d] of Object.entries(after.configSchema || {})) {
  console.log(`   ${k.padEnd(22)} type=${String(d.type).padEnd(8)} label=${JSON.stringify(d.label)}${d.values ? ' values=' + JSON.stringify(d.values) : ''}`);
}
console.log(problems.length ? '[✘] ' + problems.join('; ') : '[✔] 全部合规');
