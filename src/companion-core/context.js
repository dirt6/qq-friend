// Companion Core 的 ChatStore 组合根注册（只读上下文用）。
// app 在创建 ChatStore 后注册；Core 不在任何地方维护第二份聊天历史。
let store = null;

export function setChatStore(s) {
  if (!s || typeof s.recent !== 'function') throw new Error('setChatStore 需要 ChatStore 实例');
  store = s;
}

export function getChatStore() {
  return store;
}

export function clearChatStore() {
  store = null;
}
