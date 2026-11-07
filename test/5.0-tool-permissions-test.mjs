// R7：工具四级权限 —— 分级推断 + 自主模式检查 + 注册表带字段。
import assert from 'node:assert/strict';
import { inferPermission, checkToolPermission, PERMISSION_LEVELS } from '../src/tool-permissions.js';
import { registerTool, getTool, clearRegistry } from '../src/tool-registry.js';

let pass = 0; let fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`OK    ${n}`); } else { fail++; console.log(`FAIL  ${n}${e ? ` -> ${e}` : ''}`); } };

ok('四级枚举完整', PERMISSION_LEVELS.join(',') === 'read,write,external_action,destructive');
ok('删除印象是 destructive', inferPermission({ id: 'memory_remove', category: 'memory' }) === 'destructive');
ok('发送消息是 external_action', inferPermission({ id: 'send_message', category: 'messaging' }) === 'external_action');
ok('B站评论是 external_action', inferPermission({ id: 'bili_comment' }) === 'external_action');
ok('写印象是 write', inferPermission({ id: 'memory_append', category: 'memory' }) === 'write');
ok('查询印象是 read', inferPermission({ id: 'memory_query', category: 'memory' }) === 'read');
ok('画画是 write', inferPermission({ id: 'draw_picture' }) === 'write');
ok('未知工具默认 read', inferPermission({ id: 'strange_tool' }) === 'read');
ok('显式权限优先', inferPermission({ id: 'send_message', permission: 'write' }) === 'write');
ok('非法显式值被忽略', inferPermission({ id: 'memory_query', permission: 'root' }) === 'read');

const destructive = { id: 'memory_remove' };
ok('聊天模式不阻断 destructive', checkToolPermission(destructive, { mode: 'chat' }).ok === true);
const auto = checkToolPermission(destructive, { mode: 'autonomous' });
ok('自主模式阻断 destructive', auto.ok === false && auto.code === 'CONFIRM_REQUIRED', JSON.stringify(auto));
ok('自主模式 confirm 后放行', checkToolPermission(destructive, { mode: 'autonomous', confirm: true }).ok === true);
const ext = checkToolPermission({ id: 'send_message' }, { mode: 'chat' });
ok('external_action 标记审计', ext.ok === true && ext.audit === true);
ok('read 不标记审计', checkToolPermission({ id: 'memory_query' }, { mode: 'chat' }).audit === false);

// 注册表：存下来的定义带 permission
clearRegistry();
registerTool({ id: 't_send', name: '发', description: 'd', category: 'messaging', execute: async () => ({ content: 'ok' }) });
registerTool({ id: 't_delete', name: '删', description: 'd', category: 'memory', execute: async () => ({ content: 'ok' }) });
registerTool({ id: 't_read', name: '读', description: 'd', category: 'query', execute: async () => ({ content: 'ok' }) });
ok('注册表保存权限', getTool('t_send').permission === 'external_action' && getTool('t_delete').permission === 'destructive' && getTool('t_read').permission === 'read');
clearRegistry();

console.log(`\nTool permissions: PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
