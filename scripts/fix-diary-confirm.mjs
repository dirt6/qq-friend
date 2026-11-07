// 日记改成"直接写"：关掉 requireConfirm（写前备份 + 回读校验）。
import fs from 'node:fs';

const FILE = 'E:\\dsh\\QQ-agent\\data\\config.json';
const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
cfg.skills = cfg.skills || {};
const before = cfg.skills.diary || null;
cfg.skills.diary = { ...(before || {}), requireConfirm: false };

const backup = `${FILE}.bak-${Date.now()}`;
fs.copyFileSync(FILE, backup);
const tmp = `${FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
fs.renameSync(tmp, FILE);

const back = JSON.parse(fs.readFileSync(FILE, 'utf8'));
if (back.skills.diary.requireConfirm !== false) throw new Error('回读校验失败');
console.log('ok, diary =', JSON.stringify(back.skills.diary), 'backup:', backup);
