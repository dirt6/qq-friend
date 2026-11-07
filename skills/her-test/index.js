// 她自己写的第一个小工具 —— 自检用。
//
// 目的很简单：证明「我能给自己加一个工具，并且它真的能被调用」。
// 成功之后，这个文件就可以改成她真正想要的功能。
//
// 2026-10-31 第一版注册失败（「工具必须提供 id」）：照抄的模板写错了，
// 少了 id，parameters 也不是 JSON Schema。下面按 tool-registry 的真实要求改正，
// 逻辑一个字没动。

export function setup(api) {
  api.registerTool({
    id: 'qq_her_test',
    name: '自检工具',
    description: '自检工具：回一句「活着」，带上服务器当前时间，并把你给的词原样送回来。用来确认小鲸鱼自己写的插件能跑。',
    category: 'utility',
    icon: '🧪',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '随便一个词，会原样送回来' }
      }
    },
    async execute(args) {
      const text = String(args?.text ?? '').trim();
      const now = new Date().toLocaleString('zh-CN', { hour12: false });
      return {
        ok: true,
        alive: true,
        time: now,
        echo: text || '(没给词)',
        note: '这条路是通的：文件我写得了，工具也调得动。'
      };
    }
  });

  api.log?.('her-test 已加载（小鲸鱼的自检工具）');
}

export function available() {
  return { ok: true };
}
