// qq-self 资料写入的"假失败"回归测试
//
// 背景（2026-10-13，真实事故）：主人让机器人改签名，QQ 后端返回
//   {"result":55,"errMsg":"UpdateUdcFail"}  /  {"result":999,"errMsg":"set longnick Fail"}
// 而**签名在 QQ 里确实已经改了**。此前的实现一看到 errMsg 含 Fail 就抛错、直接判失败，
// 于是机器人告诉主人"改不了 / 接口拒了"，主人自己去 QQ 一看：明明改成功了。
//
// 正确做法：资料类写入报错时**先回读实际状态**，用事实决定成败，而不是信 errMsg。
// 这个测试锁住三种情形：
//   ① 报 Fail 但回读已生效        -> 必须报成功（并说明"接口报错但已生效"）
//   ② 报 Fail 且回读没变化        -> 必须报失败（不能假成功）
//   ③ 只改签名时自动补全昵称      -> 请求里必须带 nickname（否则 NapCat 400）
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', '.tmp-qself-test');
process.env.QQ_AGENT_DATA_DIR = DATA;

let pass = 0; let fail = 0;
const ok = (n, c, extra = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${extra ? ' -> ' + extra : ''}`); }
};

const { registerTool, clearRegistry, listTools } = await import('../src/tool-registry.js');
const { executeTool } = await import('../src/tools.js');
const qself = await import('../skills/qq-self/index.js');

const CFG = {
  autonomous: true, allowPublish: true, allowProfile: true, allowAvatar: true,
  defaultVisibility: 'public', postCooldownMinutes: 30, postDailyLimit: 3,
  profileCooldownMinutes: 0, maxChars: 600, dryRun: false
};

// 假协议端：profile 状态可变；set_qq_profile 可配置为"报错但实际写入"或"报错且不写"
//
// ⚠️ 返回形状必须与真实链路一致：应用侧 onebot.call 会 `return body.data`（src/onebot.js:307），
//    也就是**解包后**才交给技能 —— 技能里 profile() 直接读 p.nickname。返回 {status,retcode,data}
//    会让回读永远读到空值（第一版测试就踩了这个，12 条断言假失败）。
function makeCtx({ errMsg = '', applyAnyway = true, throwOnSet = '', cur = { nickname: '！？哦鲸鲸？！', long_nick: '小鲸鱼，摸鱼中', sex: 0 } } = {}) {
  const state = { ...cur };
  const calls = [];
  return {
    state,
    calls,
    ctx: {
      kind: 'group', chatKey: 'group:103776782', chatId: '103776782', selfId: '2029382488',
      onebot: {
        selfId: '2029382488',
        selfInfo: { user_id: 2029382488, nickname: state.nickname },
        async call(action, params) {
          calls.push({ action, params });
          if (action === 'get_stranger_info') {
            // 解包后的形状：直接就是资料对象
            return { nickname: state.nickname, long_nick: state.long_nick, longNick: state.long_nick, sex: state.sex };
          }
          if (action === 'set_qq_profile') {
            if (applyAnyway) {
              if (params.nickname != null) state.nickname = params.nickname;
              if (params.personal_note != null) state.long_nick = params.personal_note;
              if (params.sex != null) state.sex = params.sex;
            }
            // 解包后的形状：业务错误就在这一层（真实样本 {result:55,errMsg:"UpdateUdcFail"}）
            if (throwOnSet) throw new Error(throwOnSet);   // 模拟 call() 直接抛错（如 retcode=400）
            return errMsg ? { result: errMsg === 'UpdateUdcFail' ? 55 : 999, errMsg } : { result: 0 };
          }
          return {};
        }
      }
    }
  };
}

clearRegistry();
qself.setup({
  config: () => CFG,
  log: () => {},
  registerTool,
  onebot: null,
  // createService 的 checkActive 默认是 () => true，但插件入口把它接到了 api.isSkillActive 上，
  // 所以这里必须提供：返回 { active: true } 表示技能生效。
  isSkillActive: () => ({ active: true })
});
const defs = listTools().filter((t) => /update_profile/.test(t.id));
ok('qq-self 注册了 update_profile', defs.length === 1, `找到 ${defs.length} 个`);

const run = async (args, opts) => {
  const { ctx, calls, state } = makeCtx(opts);
  const r = await executeTool(defs, ctx, 'update_profile', JSON.stringify(args));
  const text = typeof r?.content === 'string' ? r.content : JSON.stringify(r?.content ?? r);
  return { r, text, calls, state, isError: !!r?.isError, json: (() => { try { return JSON.parse(text) } catch { return null } })() };
};

// ── ① 报 Fail 但实际写成功 -> 必须报成功 ──
{
  const { json, text, calls, state, isError } = await run({ signature: '事已至此，先吃饭吧' }, { errMsg: 'UpdateUdcFail' });
  ok('① 接口报 UpdateUdcFail 但签名已生效 -> 不当失败', isError === false, text.slice(0, 200));
  ok('① ok=true 且 verified=true', json?.ok === true && json?.verified === true, text.slice(0, 200));
  ok('① 回读到的签名就是新值', json?.readback?.signature === '事已至此，先吃饭吧', JSON.stringify(json?.readback));
  ok('① 明确说明"接口报错但已生效"', /回读确认修改已生效/.test(String(json?.note || '')), String(json?.note));
  ok('① 请求里带上了 nickname（NapCat 必需）', calls.some((c) => c.action === 'set_qq_profile' && c.params.nickname === '！？哦鲸鲸？！'), JSON.stringify(calls.map((c) => c.params)));
  ok('① 状态里签名确实变了', state.long_nick === '事已至此，先吃饭吧', state.long_nick);
}

// ── ② 报 Fail 且实际没写进去 -> 必须报失败 ──
{
  const { json, text, isError } = await run({ signature: '这条写不进去' }, { errMsg: 'set longnick Fail', applyAnyway: false });
  ok('② 报错且回读没变化 -> 报失败', isError === true && json?.ok === false, text.slice(0, 200));
  ok('② 失败里带上回读结果，便于排查', !!json?.readback, JSON.stringify(json?.readback));
  ok('② 失败里指出哪一项没对上', Array.isArray(json?.readbackMismatch) && json.readbackMismatch.includes('signature'), JSON.stringify(json?.readbackMismatch));
}

// ── ③ 另一种 errMsg 拼写也要走同一条路径 ──
{
  const { json, isError } = await run({ signature: '换个写法试试' }, { errMsg: 'set longnick Fail' });
  ok('③ set longnick Fail 但已生效 -> 成功', isError === false && json?.ok === true, JSON.stringify(json).slice(0, 200));
}

// ── ④ 正常成功路径不受影响 ──
{
  const { json, calls, isError } = await run({ nickname: '小鲸鱼', signature: '新签名' }, { errMsg: '' });
  ok('④ 无错误时正常成功', isError === false && json?.ok === true);
  ok('④ 昵称与签名一起写入', calls.find((c) => c.action === 'set_qq_profile')?.params?.nickname === '小鲸鱼');
  ok('④ verified=true', json?.verified === true, JSON.stringify(json?.readback));
}

// ── ⑤ 接口直接抛错（如 retcode=400 / HTTP 错），但回读显示其实已生效 ──
{
  const { json, isError } = await run({ signature: '抛错也已生效' }, { throwOnSet: '协议端返回失败：Schema compilation error' });
  ok('⑤ call() 抛错但回读已生效 -> 仍报成功', isError === false && json?.ok === true, JSON.stringify(json).slice(0, 220));
  ok('⑤ 回读确是那一句', json?.readback?.signature === '抛错也已生效', JSON.stringify(json?.readback));
}

try { (await import('node:fs')).rmSync(DATA, { recursive: true, force: true }) } catch { /* ignore */ }

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exit(1);
