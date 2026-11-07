// 密钥泄漏自查：扫接手文档，确认没有任何真实凭据被写进去
// 判据：文档里只能出现"字段名"（如 httpAccessToken），不能出现"字段值"。
import fs from 'node:fs';

const DOC = 'E:/dsh/QQ-agent/doc/接手-prompt.md';
const text = fs.readFileSync(DOC, 'utf8');

// 1) 从真实配置里取出所有敏感值（只用于比对，不打印）
const cfg = JSON.parse(fs.readFileSync('E:/dsh/QQ-agent/data/config.json', 'utf8'));
const secrets = [];
const collect = (obj, path = '') => {
  if (obj == null) return;
  if (typeof obj === 'string') {
    // 收集看起来像凭据的值：长度够长且不是普通中文/路径
    if (obj.length >= 16 && !/[\u4e00-\u9fa5]/.test(obj)) secrets.push({ path, value: obj });
    return;
  }
  if (typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if (/key|token|secret|cookie|password|authorization|sk-/i.test(k) || typeof v === 'object') {
      collect(v, path ? `${path}.${k}` : k);
    }
  }
};
collect(cfg);

console.log(`配置里候选敏感值 ${secrets.length} 个（下面只报命中，不打印值）`);
console.log('');

let leaked = 0;
for (const s of secrets) {
  if (s.value && text.includes(s.value)) {
    leaked++;
    console.log(`  ✘ 文档里出现了来自 ${s.path} 的值（长度 ${s.value.length}）—— 必须删掉！`);
  }
}
console.log(leaked ? `\n✘ 发现 ${leaked} 处泄漏` : '  ✔ 没有任何配置里的真实值出现在文档中');

// 2) 模式自查（机主上一版要求的四类）
console.log('\n=== 模式自查（命中数应全为 0）===');
const patterns = [
  ['sk- 开头的 Key', /sk-[A-Za-z0-9]{10,}/g],
  ['Bearer + 长串', /Bearer\s+[A-Za-z0-9._-]{16,}/g],
  ['apiKey":"值"', /"apiKey"\s*:\s*"[^"]{8,}"/g],
  ['token":"值"', /"token"\s*:\s*"[^"]{8,}"/g],
  ['accessToken":"值"', /"access?Token"\s*:\s*"[^"]{8,}"/g],
  ['形如 43 位随机串', /\b[A-Za-z0-9_-]{40,}\b/g],
];
for (const [name, re] of patterns) {
  const hits = text.match(re) || [];
  console.log(`  ${hits.length === 0 ? '✔' : '✘'} ${name}：${hits.length} 处${hits.length ? ' -> ' + hits.slice(0, 2).map((h) => h.slice(0, 12) + '…').join(', ') : ''}`);
}

// 3) 文档基本体检
console.log('\n=== 文档体检 ===');
const lines = text.split('\n');
console.log(`  行数 = ${lines.length}，字符数 = ${text.length}`);
console.log(`  坏字节(U+FFFD) = ${(text.match(/\uFFFD/g) || []).length}`);
console.log(`  首行 = ${JSON.stringify(lines[0].slice(0, 60))}`);
const sections = lines.filter((l) => /^# /.test(l)).map((l) => l.replace(/^# /, ''));
console.log(`  一级标题 ${sections.length} 个：`);
for (const s of sections) console.log('    ' + s.slice(0, 40));
