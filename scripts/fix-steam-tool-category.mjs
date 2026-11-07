// steam-deals 的 tools[].category 用了 "utility" —— 那是**技能**分类的合法值，不是**工具**分类的。
// 工具分类以 src/tool-registry.js 的 CATEGORY_META 为唯一事实来源：
//   messaging / sticker / query / memory / web / knowledge / media / system
// 这两个工具都是"查询 Steam 价格"，归 query。
// 注意：技能自身的 category="utility" 是合法的，绝不能顺手改掉。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VALID = ['messaging', 'sticker', 'query', 'memory', 'web', 'knowledge', 'media', 'system'];
const WANT = 'query';

const targets = ['skills/steam-deals/skill.json', 'skills/steam-deals/index.js'];
let total = 0;

for (const rel of targets) {
  const full = path.join(ROOT, rel);
  const raw = fs.readFileSync(full, 'utf8');
  let out = raw;
  let n = 0;

  if (rel.endsWith('.json')) {
    const m = JSON.parse(raw);
    for (const t of m.tools || []) {
      if (t.category && !VALID.includes(t.category)) {
        console.log(`  ${rel}: tools[${t.id}].category ${JSON.stringify(t.category)} -> ${JSON.stringify(WANT)}`);
        t.category = WANT;
        n++;
      }
    }
    if (n) out = JSON.stringify(m, null, 2) + '\n';
  } else {
    // 代码里也是 2 处 category: 'utility'；用 id 上下文定位，别误改别的字符串
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const cm = /category:\s*'([^']+)'/.exec(lines[i]);
      if (!cm) continue;
      if (VALID.includes(cm[1])) continue;
      // 往上看 8 行找它属于哪个工具
      let tool = '?';
      for (let k = i; k >= Math.max(0, i - 8); k--) {
        const idm = /id:\s*'([a-zA-Z0-9_]+)'/.exec(lines[k]);
        if (idm) { tool = idm[1]; break }
      }
      console.log(`  ${rel}:${i + 1} [${tool}] category ${JSON.stringify(cm[1])} -> ${JSON.stringify(WANT)}`);
      lines[i] = lines[i].replace(`category: '${cm[1]}'`, `category: '${WANT}'`);
      n++;
    }
    out = lines.join('\n');
  }

  if (n) {
    fs.writeFileSync(path.join(ROOT, 'data', path.basename(rel) + '.bak-' + Date.now()), raw, 'utf8');
    fs.writeFileSync(full, out, 'utf8');
    console.log(`  [写入] ${rel} 改动 ${n} 处（备份在 data/）`);
    total += n;
  } else {
    console.log(`  [跳过] ${rel} 没有非法分类`);
  }
}

// ── 校验 ──────────────────────────────────────────────────────────────────
console.log('\n[校验]');
const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'skills/steam-deals/skill.json'), 'utf8'));
console.log('  技能分类（应保持 utility）= ' + JSON.stringify(m.category));
console.log('  工具分类 = ' + (m.tools || []).map((t) => t.id + ':' + t.category).join(', '));
const bad = (m.tools || []).filter((t) => !VALID.includes(t.category));
console.log(bad.length ? '  [✘] 仍有非法' : '  [✔] 工具分类全部合法，技能分类未被误改');
console.log('  共改动 ' + total + ' 处');
