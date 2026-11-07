// 4.0：Memory Hub 与 MemoryStore 的聊天印象格式兼容测试（临时 DATA_DIR）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chat-'));
process.env.QQ_AGENT_DATA_DIR = dir;
const chat = 'private:123';
const chatDir = path.join(dir, 'memory', 'private_123');
fs.mkdirSync(chatDir, { recursive: true });
fs.writeFileSync(path.join(chatDir, '456.json'), JSON.stringify({
  userId: '456', name: '阿明', updatedAt: new Date().toISOString(), lastConsolidatedAt: 0,
  impressions: [
    { content: '喜欢钓鱼', createdAt: Date.now() - 3000 },
    { content: '最近在学吉他', createdAt: Date.now() - 2000 },
    { content: '不喜欢被叫老板', createdAt: Date.now() - 1000 }
  ]
}), 'utf8');
fs.writeFileSync(path.join(chatDir, '789.json'), JSON.stringify({
  userId: '789', name: '', updatedAt: new Date().toISOString(), lastConsolidatedAt: 0,
  impressions: [{ content: '常发猫图', createdAt: Date.now() }]
}), 'utf8');

const { MemoryStore } = await import('../src/memory.js');
const { readImpressions } = await import('../src/memory-hub/adapters.js');
const direct = new MemoryStore().formatForPrompt(chat);
const viaHub = new MemoryStore({ impressionReader: readImpressions }).formatForPrompt(chat);
assert.ok(direct.includes('喜欢钓鱼'));
assert.equal(viaHub, direct);

const directQuery = new MemoryStore().query(chat);
const hubQuery = new MemoryStore({ impressionReader: readImpressions }).query(chat);
assert.deepEqual(hubQuery, directQuery);

const filtered = new MemoryStore({ impressionReader: readImpressions }).formatForPrompt(chat, { userIds: ['456'] });
assert.ok(filtered.includes('456') === false); // 文本用名字；确认有阿明、没有 789
assert.ok(filtered.includes('阿明'));
assert.ok(!filtered.includes('常发猫图'));

fs.rmSync(dir, { recursive: true, force: true });
console.log('Memory Hub chat compat: PASS');
