// 人设文本读写小工具（供「快速启动」脚本调用）
//
// 为什么单独走 Node 而不是让 PowerShell 直接改 config.json：
//   ① PowerShell 的 Set-Content -Encoding UTF8 会写 BOM，JSON.parse 直接报
//      "Unexpected token"，NapCat/本程序都可能读不了配置；
//   ② 本工具**只改指定字段**，其余配置一个字节都不动 —— 不经过 updateConfig
//      的深合并/派生字段重算，最不容易出事。
//
// 用法：
//   node scripts/persona-cli.mjs get                 -> stdout 输出人设文本
//   node scripts/persona-cli.mjs set <utf8文本文件>   -> 把该文件内容写进 persona.roleText
//   node scripts/persona-cli.mjs selftest            -> 读→原样写回→校验（不改内容）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG = path.join(ROOT, 'data', 'config.json');

function readConfig() {
  const raw = fs.readFileSync(CONFIG);
  // 明确按 UTF-8 解码，并拒绝 BOM：历史上有工具往里写过 BOM，会让 JSON.parse 炸
  let text = raw.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(text);
}

function writeConfig(cfg) {
  // 与项目其它写配置的地方保持一致的排版（2 空格缩进、无 BOM、末尾换行）
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), 'utf8');
}

const [, , cmd, arg] = process.argv;

try {
  if (cmd === 'get') {
    const cfg = readConfig();
    process.stdout.write(String(cfg?.persona?.roleText ?? ''));
    process.exit(0);
  }

  if (cmd === 'set') {
    if (!arg) throw new Error('缺少文本文件路径');
    let text = fs.readFileSync(arg).toString('utf8').replace(/^\uFEFF/, '');
    if (!text.trim()) throw new Error('人设文本为空，已取消（不允许把人设清空）');
    const cfg = readConfig();
    cfg.persona = cfg.persona || {};
    cfg.persona.roleText = text;
    writeConfig(cfg);
    // 回读校验：确实是合法 JSON 且写进去了
    const back = readConfig();
    if (back.persona.roleText !== text) throw new Error('写入后回读不一致');
    process.stdout.write(`OK ${text.length}`);
    process.exit(0);
  }

  if (cmd === 'selftest') {
    const before = readConfig().persona?.roleText ?? '';
    const tmp = path.join(path.dirname(CONFIG), `.persona-selftest-${process.pid}.txt`);
    fs.writeFileSync(tmp, before, 'utf8');
    const cfg = readConfig();
    cfg.persona.roleText = fs.readFileSync(tmp).toString('utf8');
    writeConfig(cfg);
    fs.rmSync(tmp, { force: true });
    const after = readConfig().persona?.roleText ?? '';
    if (after !== before) throw new Error('自检失败：往返后内容不一致');
    process.stdout.write(`SELFTEST OK 长度=${after.length} 前 20 字=${after.slice(0, 20).replace(/\n/g, ' ')}`);
    process.exit(0);
  }

  process.stderr.write('用法：persona-cli.mjs get | set <文件> | selftest\n');
  process.exit(2);
} catch (error) {
  process.stderr.write(`ERROR ${error?.message ?? error}\n`);
  process.exit(1);
}
