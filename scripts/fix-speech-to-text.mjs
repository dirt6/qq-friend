// 把 speech-to-text 接到本机 whisper.cpp 上（数据目录里的 config.json）。
// 只改 skills['speech-to-text'] 一个键，其余原样；写前备份、写后回读校验。
import fs from 'node:fs';

const FILE = 'E:\\dsh\\QQ-agent\\data\\config.json';
const RAW = fs.readFileSync(FILE, 'utf8');
const cfg = JSON.parse(RAW);

const settings = {
  enabled: true,
  engine: 'whisper-cli',
  exePath: 'E:\\dsh\\whisper\\Release\\whisper-cli.exe',
  modelPath: 'E:\\dsh\\whisper\\models\\ggml-base.bin',
  pythonExe: '',
  pythonModel: 'base',
  language: 'zh',
  timeoutMs: 120000
};

for (const [k, v] of Object.entries(settings)) {
  if (k === 'exePath' && !fs.existsSync(v)) throw new Error(`whisper-cli 不存在：${v}`);
  if (k === 'modelPath' && !fs.existsSync(v)) throw new Error(`模型不存在：${v}`);
}

cfg.skills = cfg.skills || {};
const before = cfg.skills['speech-to-text'] || null;
cfg.skills['speech-to-text'] = settings;

const backup = `${FILE}.bak-${Date.now()}`;
fs.copyFileSync(FILE, backup);
const tmp = `${FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
fs.renameSync(tmp, FILE);

const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const got = back.skills['speech-to-text'];
if (JSON.stringify(got) !== JSON.stringify(settings)) throw new Error('回读校验失败');
console.log('ok');
console.log('before:', before ? JSON.stringify(before) : '(none)');
console.log('after :', JSON.stringify(got));
console.log('backup:', backup);
