// 5.0-A2：沉默权 / Conversation Closure 纯逻辑。
// 只判断“是否仍有必要继续交流”，不发消息、不写历史、不调用模型/工具。
// 无 I/O、无系统时钟、无随机、无全局状态；不修改 Goal/Pending/Round/Action。

const QUESTION_RE = /[?？]\s*$|^(为什么|怎么|如何|什么|哪(里|个|些)?|谁|多少|是否|能不能|可不可以|可以吗|有没有|要不要|是不是|对不对|好吗|行吗)/;
const HELP_RE = /帮我|帮忙|教我|请问|求(助|你)|救(救|我)|麻烦你|我需要|能不能.{0,12}(帮|做|查|写|看|找)|可以帮我/;
const CONTINUE_RE = /继续|接着|还有(呢|吗)?|然后呢|别停|不要结束|再说|再讲|往下|go on|continue/i;
const END_RE = /先这样|就到这|结束(吧|了)?|不用了|没事了|拜拜|晚安|下次聊|stop here|that'?s all/i;
const THANKS_RE = /谢谢|感谢|多谢|辛苦了|thanks|thank you/i;
const ACK_RE = /^(好|好的|嗯|嗯嗯|哦|收到|明白|知道了|可以|行|ok|okay|对的|是的)[。.!！?？]*$/i;
const REPEAT_MIN = 6;

const textOf = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const norm = (v) => textOf(v).toLowerCase().replace(/[。.!！?？,，、\s]/g, '');
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n)));
const isUser = (role) => ['user', 'master', 'owner', 'human'].includes(String(role || '').toLowerCase());
const isAssistant = (role) => ['assistant', 'bot', 'self', 'partner'].includes(String(role || '').toLowerCase());
const parseTime = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) ? n : null;
};
const uncertainty = (code, detail) => ({ code, detail: String(detail || '') });

const INTENTS = ['question', 'help', 'continue', 'end', 'thanks', 'ack', 'statement'];

function intentOf(text) {
  const t = textOf(text);
  if (!t) return 'empty';
  // 求助优先于泛问题：'能不能帮我…' 是求助，不是普通追问。
  if (HELP_RE.test(t)) return 'help';
  if (QUESTION_RE.test(t)) return 'question';
  if (CONTINUE_RE.test(t)) return 'continue';
  if (END_RE.test(t)) return 'end';
  if (THANKS_RE.test(t)) return 'thanks';
  if (ACK_RE.test(t)) return 'ack';
  return 'statement';
}

function normalizeMessage(m, index) {
  if (!m || typeof m !== 'object') return null;
  const text = textOf(m.text ?? m.content);
  if (!text) return null;
  const role = isUser(m.role) ? 'user' : isAssistant(m.role) ? 'assistant' : 'unknown';
  const at = parseTime(m.at ?? m.ts);
  return {
    index,
    role,
    text,
    at,
    intent: m.intent || intentOf(text),
    answered: m.answered === false ? false : (m.answered === true ? true : null),
    requestId: m.requestId ? String(m.requestId) : '',
    id: m.id ? String(m.id) : `m-${index}`
  };
}

function collectUnresolved(messages, explicit) {
  const out = [];
  const seen = new Set();
  const add = (r) => {
    const id = String(r.id || r.requestId || `req-${out.length + 1}`);
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ id, text: textOf(r.text || r.title), kind: String(r.kind || 'request'), askedAt: r.askedAt || r.at || '', explicit: r.explicit === true });
  };
  for (const r of explicit) {
    if (!r || typeof r !== 'object') continue;
    const text = textOf(r.text || r.title);
    if (!text && !r.id) continue;
    add({ ...r, text, explicit: true });
  }
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (m.role !== 'user' || !['question', 'help'].includes(m.intent)) continue;
    const answered = messages.slice(i + 1).some((x) => x.role === 'assistant');
    const explicitUnanswered = m.answered === false || (m.requestId && explicit.some((r) => String(r.id || r.requestId) === m.requestId));
    if (!answered || explicitUnanswered) add({ id: m.requestId || `msg-${i}`, text: m.text, kind: m.intent, at: m.at, explicit: Boolean(explicitUnanswered) });
  }
  return out;
}

function topPurpose(purpose, uncertainties) {
  let candidates = [];
  if (Array.isArray(purpose)) candidates = purpose;
  else if (purpose && typeof purpose === 'object' && Array.isArray(purpose.candidates)) candidates = purpose.candidates;
  else if (purpose && typeof purpose === 'object' && purpose.ok === false) {
    uncertainties.push(uncertainty('purpose_unavailable', purpose.error || purpose.code));
    return null;
  } else if (purpose !== undefined && purpose !== null) {
    uncertainties.push(uncertainty('purpose_invalid', 'purpose 既不是数组也不是 A1 输出'));
    return null;
  }
  const valid = candidates.filter((c) => c && typeof c === 'object' && textOf(c.title));
  if (!valid.length) return null;
  const sorted = [...valid].sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
  return { candidate: sorted[0], count: valid.length, topConfidence: clamp01(sorted[0].confidence) };
}

function findLast(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) if (messages[i].role === role) return messages[i];
  return null;
}

/**
 * @param {object} input
 * @returns {{ok:true,decision:'continue'|'close'|'hold'|'undetermined',reason:string,unresolvedRequests:Array,summary:string,nextOpening:string,uncertainties:Array,diagnostics:object}|{ok:false,code:string,error:string}}
 */
export function assessConversationClosure(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'INVALID_INPUT', error: 'input 必须是对象' };
  }
  for (const k of ['messages', 'unresolvedRequests']) {
    if (input[k] !== undefined && !Array.isArray(input[k])) return { ok: false, code: 'INVALID_INPUT', error: `${k} 必须是数组` };
  }
  const conv = input.conversation && typeof input.conversation === 'object' ? input.conversation : {};
  const now = parseTime(input.now ?? conv.now);
  const uncertainties = [];
  const diagnostics = { messagesRead: 0, skipped: 0, userMessages: 0, assistantMessages: 0, order: 'as_given', purposeProvided: false, purposeCount: 0 };

  const messages = [];
  for (let i = 0; i < (input.messages || []).length; i += 1) {
    const m = normalizeMessage(input.messages[i], i);
    if (!m) { diagnostics.skipped += 1; continue; }
    messages.push(m);
  }
  diagnostics.messagesRead = messages.length;
  diagnostics.userMessages = messages.filter((m) => m.role === 'user').length;
  diagnostics.assistantMessages = messages.filter((m) => m.role === 'assistant').length;

  // 乱序：全部有时间才排序；否则保留输入序并标记不可验证。
  const allTimed = messages.length > 0 && messages.every((m) => m.at !== null);
  if (allTimed) {
    const times = messages.map((m) => m.at);
    const sorted = [...messages].sort((a, b) => a.at - b.at || a.index - b.index);
    if (sorted.some((m, i) => m !== messages[i])) { diagnostics.order = 'out_of_order_sorted'; uncertainties.push(uncertainty('message_order', '消息时间倒序，已按时间排序')); }
    messages.length = 0;
    messages.push(...sorted);
  } else if (messages.length > 1) {
    diagnostics.order = 'unverified_no_time';
    uncertainties.push(uncertainty('message_order_unverified', '部分消息缺时间，按输入顺序判断'));
  }

  const last = messages[messages.length - 1] || null;
  const lastUser = findLast(messages, 'user');
  const lastAssistant = findLast(messages, 'assistant');
  const lastUserIndex = lastUser ? messages.lastIndexOf(lastUser) : -1;
  const lastAssistantIndex = lastAssistant ? messages.lastIndexOf(lastAssistant) : -1;

  // 显式未解决请求优先并入。
  const explicit = Array.isArray(input.unresolvedRequests) ? input.unresolvedRequests : [];
  const unresolved = collectUnresolved(messages, explicit);

  // 最近一次有效交流
  let lastEffectiveAt = parseTime(conv.lastEffectiveAt);
  if (lastEffectiveAt === null && allTimed && messages.length) lastEffectiveAt = messages[messages.length - 1].at;
  if (lastEffectiveAt === null) uncertainties.push(uncertainty('missing_time', '缺少最近交流时间，不做超时推断'));
  const idleMs = now !== null && lastEffectiveAt !== null ? Math.max(0, now - lastEffectiveAt) : null;

  // 用户意图：最后一条用户消息优先；显式 flags 覆盖文本。
  const lastUserIntent = lastUser?.intent || 'none';
  const userRequestedContinue = conv.userRequestedContinue === true || lastUserIntent === 'continue';
  const userEnded = conv.userEnded === true || conv.status === 'closed' || lastUserIntent === 'end';
  const userBusy = conv.userBusy === true;
  const userQuestionNow = lastUserIntent === 'question' || lastUserIntent === 'help';
  const userThanks = lastUserIntent === 'thanks';
  const userAck = lastUserIntent === 'ack';

  // 重复表达：最后两条 assistant/user 归一化相同，或连续用户消息相同。
  let repeated = false;
  if (messages.length >= 2) {
    const a = messages[messages.length - 1];
    const b = messages[messages.length - 2];
    repeated = norm(a.text).length >= REPEAT_MIN && norm(a.text) === norm(b.text);
  }
  diagnostics.lastRole = last?.role || 'none';
  diagnostics.lastUserIntent = lastUserIntent;
  diagnostics.flags = { userRequestedContinue, userEnded, userBusy, userQuestionNow, userThanks, userAck, repeated };

  // A1：只作为 nextOpening 的候选来源，不强制继续/结束。
  diagnostics.purposeProvided = input.purpose !== undefined;
  const purpose = topPurpose(input.purpose, uncertainties);
  diagnostics.purposeCount = purpose?.count || 0;
  if (purpose && purpose.topConfidence < 0.5) uncertainties.push(uncertainty('low_purpose_confidence', String(purpose.topConfidence)));

  let decision = 'undetermined';
  let reason = 'insufficient_context';

  // 1) 明确的问题/求助：优先于任何收尾；即使已有回答，也等待用户确认，不自动 close。
  if (userQuestionNow) {
    const assistantAfter = lastUserIndex >= 0 && messages.slice(lastUserIndex + 1).some((m) => m.role === 'assistant');
    if (unresolved.some((r) => r.explicit)) { decision = 'continue'; reason = 'unresolved_requests'; }
    else if (!assistantAfter) { decision = 'continue'; reason = lastUserIntent === 'help' ? 'user_needs_help' : 'user_asked_question'; }
    else if (!userThanks && !userAck) { decision = 'hold'; reason = 'answered_but_awaiting_user_ack'; }
    else { decision = 'close'; reason = 'user_acknowledged_answer'; }
  } else if (userRequestedContinue) {
    decision = 'continue'; reason = 'user_requested_continue';
  } else if (unresolved.length > 0) {
    // 2) 未解决请求：不得因感谢/时间/轮数强行结束。
    decision = 'continue'; reason = 'unresolved_requests';
  } else if (userEnded) {
    decision = 'close'; reason = 'user_ended';
  } else if (userBusy) {
    decision = 'hold'; reason = 'user_busy';
  } else if (userThanks || userAck) {
    decision = 'close'; reason = userThanks ? 'user_thanks' : 'user_acknowledged';
  } else if (!lastUser) {
    decision = 'undetermined'; reason = 'no_user_message';
  } else if (repeated) {
    // 4) 重复表达：没有新信息，但不生成告别消息；hold。
    decision = 'hold'; reason = 'repeated_content_no_new_info';
  } else if (last.role === 'assistant' && lastAssistantIndex > lastUserIndex) {
    // 3) 用户没有回复 ≠ 同意结束：hold，保留话题，不自动 close。
    decision = 'hold'; reason = 'user_has_not_replied';
    if (idleMs === null) uncertainties.push(uncertainty('no_reply_unknown_time', '无时间信息，不能判断等待时长'));
  } else if (last.role === 'user' && last.intent === 'statement') {
    decision = 'continue'; reason = 'substantive_user_message_awaiting_reply';
  } else {
    decision = 'hold'; reason = 'no_clear_closure_signal';
  }

  // 5) 空对话但显式未解决请求 → continue（上面已处理）；完全无输入 → undetermined。
  if (!messages.length && !unresolved.length && !conv.status && !conv.userEnded && !conv.userRequestedContinue) {
    decision = 'undetermined'; reason = 'empty_conversation';
  }

  // summary 不自动生成；只接受调用方已有摘要。
  const summary = textOf(conv.summary || input.summary).slice(0, 300);

  // 6) nextOpening：仅 close/hold，且无未解决请求、用户未明确结束时，才可留自然话题。
  let nextOpening = '';
  if (['close', 'hold'].includes(decision) && !unresolved.length && !userEnded && conv.allowNextOpening !== false) {
    const ctxTopic = textOf(conv.nextTopic || input.nextTopic);
    if (ctxTopic) nextOpening = ctxTopic.slice(0, 80);
    else if (purpose && purpose.topConfidence >= 0.5) nextOpening = textOf(purpose.candidate.title).slice(0, 80);
  }
  if (decision === 'close' && !nextOpening) uncertainties.push(uncertainty('no_next_opening', '没有值得延续的话题，nextOpening 为空'));

  return {
    ok: true,
    decision,
    reason,
    unresolvedRequests: unresolved,
    summary,
    nextOpening,
    uncertainties,
    diagnostics: { ...diagnostics, idleMs, lastEffectiveAt, lastRole: last?.role || 'none' }
  };
}

export default assessConversationClosure;
