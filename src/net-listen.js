// 独占监听（R8-0-A2）。
//
// 单实例守门只认 **OS 的真实 bind 结果**：
//   · 端口空闲 → listening，拿到实际端口；
//   · 已被占用 → EADDRINUSE（由调用方转成 INSTANCE_ALREADY_RUNNING）。
//
// 禁止的做法：先探测端口是否可用、再 listen —— 两步之间的竞争窗口会让两个
// 实例同时通过检查。这里只调用一次 listen，用它的结果说话。

/**
 * @param {import('node:net').Server} server
 * @param {number} port
 * @param {string} [host] 固定 127.0.0.1（不读配置，避免 IPv4/IPv6 双绑绕过）
 * @returns {Promise<number>} 实际监听端口
 */
export function listenExclusive(server, port, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const onError = (error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(server.address()?.port ?? port); };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    // exclusive:true —— 明确不共享端口（不启用 reusePort 语义）
    server.listen({ port, host, exclusive: true });
  });
}
