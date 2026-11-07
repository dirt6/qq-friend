// 她自己写的小工具 —— 模板。
//
// 怎么用：
//   1. 把整个 templates/her-tool/ 复制到 skills/her-<名字>/
//   2. 改 skill.json 里的 id / name / description
//   3. 改下面 registerTool
//   4. 存盘就会热重载（机器人日志里会有一行「加载成功」）
//
// ⚠️ 三个字段少一个都注册不上（2026-10-31 她自己写第一版时就踩了这个：
//    「注册失败：工具必须提供 id」）：
//      id        内部标识，只允许字母数字下划线横线，最长 64
//      name      给人看的名字
//      execute   真正干活的函数
//
// ⚠️ parameters 必须是 JSON Schema（和 OpenAI function 一样），不是简化写法：
//      对： { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
//      错： { text: { type: 'string', required: true } }   ← DSH 插件的 defineTool 才吃这个
//
// 注意：
//   · 这里跑在机器人主进程里，写坏了只影响这一个工具（加载失败只打 warn）。
//   · 不要在这里直接发 QQ 消息，走 outbox（参考 skills/diary）。
//   · 不要改 data/config.json 和自己的人设。

export function setup(api) {
  api.registerTool({
    id: 'qq_her_example',
    name: '自检工具',
    description: '示例工具：把一个字符串原样送回来，顺带报当前时间。改这里就是你真正想做的事。',
    category: 'utility',
    icon: '🧪',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '随便一个词，会原样送回来' }
      },
      required: []
    },
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      return {
        ok: true,
        time: new Date().toLocaleString('zh-CN', { hour12: false }),
        echo: text || '(没给词)'
      };
    }
  });

  api.log?.('her-example 已加载（模板：复制走之后改成你自己的）');
}

// 可选：告诉程序这个技能现在能不能用（比如依赖某个文件在不在）
export function available() {
  return { ok: true };
}
