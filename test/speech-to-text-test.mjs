// 语音转文字（plugins/speech-to-text）的单元测试
//
// 锁住四件事：
//   ① 文本清洗：去时间戳、去 [BLANK_AUDIO]/(音乐)，合并空白
//   ② 引擎选择：auto 先 whisper-cli 再 python；指定引擎但没配路径 → 空
//   ③ 没启用时能力返回 ok:false（核心退回 [语音] 占位）
//   ④ manifest 声明的能力与导出的 providers 一致
import fs from 'node:fs';

const mod = await import('../plugins/speech-to-text/index.js');
const { cleanText, pickEngine } = mod.internals;

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' -> ' + extra : ''}`); }
};

console.log('=== 一、文本清洗 ===');
{
  ok('去时间戳', cleanText('[00:00:01.000] 你好\n[00:00:03.000] 世界') === '你好 世界');
  ok('去 [BLANK_AUDIO]', cleanText('[00:00.000] [BLANK_AUDIO]') === '');
  ok('去（音乐）', cleanText('(音乐)\n[00:01.000] 好') === '好');
  ok('合并空白', cleanText('  你   好  ') === '你 好');
  ok('空输入 → 空串', cleanText(null) === '');
}

console.log('=== 二、引擎选择 ===');
{
  ok('auto + 都没配 → 空', pickEngine({ engine: 'auto', exePath: '', pythonExe: '' }) === '');
  ok('auto + 只有 whisper-cli → whisper-cli', pickEngine({ engine: 'auto', exePath: 'x', pythonExe: '' }) === 'whisper-cli');
  ok('auto + 只有 python → python', pickEngine({ engine: 'auto', exePath: '', pythonExe: 'p' }) === 'python');
  ok('指定 whisper-cli 但没配 → 空', pickEngine({ engine: 'whisper-cli', exePath: '', pythonExe: 'p' }) === '');
  ok('指定 python 但没配 → 空', pickEngine({ engine: 'python', exePath: 'x', pythonExe: '' }) === '');
}

console.log('=== 三、未启用时的回退 ===');
{
  mod.internals.setConfig(() => ({ enabled: false }));
  const fn = mod.providers['media.transcribe'];
  const r = await fn({ record: { data: { file: 'a.silk' } }, onebot: null });
  ok('返回 ok:false', r?.ok === false);
  ok('有错误说明', typeof r?.error === 'string' && r.error.length > 0);
  ok('不抛异常', true);
}

console.log('=== 四、manifest 一致性 ===');
{
  const manifest = JSON.parse(fs.readFileSync(new URL('../plugins/speech-to-text/plugin.json', import.meta.url), 'utf8'));
  ok('manifest 声明了 media.transcribe', (manifest.capabilities || []).includes('media.transcribe'));
  ok('providers 实现了 media.transcribe', typeof mod.providers['media.transcribe'] === 'function');
  ok('默认不启用（没配 whisper 前不打扰）', manifest.enabledByDefault === false);
  ok('有 enabled 开关', manifest.settings?.enabled === false);
}

console.log('');
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
