// 5.0-E5/P2：执行器独立权限校验。上游 selectedActivity/Receipt 不能替代。
const TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

function validateSchema(value, schema, path = '') {
  if (!schema || typeof schema !== 'object') return [];
  const errs = [];
  if (schema.type && !TYPES.has(schema.type)) errs.push(`${path}:schema_type`);
  if (schema.type === 'string' && typeof value !== 'string') errs.push(`${path}:string`);
  if (schema.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) errs.push(`${path}:number`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') errs.push(`${path}:boolean`);
  if (schema.type === 'array' && !Array.isArray(value)) errs.push(`${path}:array`);
  if (schema.type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) errs.push(`${path}:object`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}:enum`);
  if (schema.type === 'object' && schema.properties && value && typeof value === 'object') {
    for (const req of schema.required || []) if (!(req in value)) errs.push(`${path}.${req}:required`);
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties[k]) {
        if (schema.additionalProperties === false) errs.push(`${path}.${k}:unknown`);
        continue;
      }
      errs.push(...validateSchema(v, schema.properties[k], path ? `${path}.${k}` : k));
    }
  }
  return errs;
}

export function validateExecution({ activity, plan, authorization, tools, paused = false, budget = null, runs = 0 } = {}) {
  if (paused) return { ok: false, reason: 'paused' };
  if (!activity || !plan || typeof plan !== 'object') return { ok: false, reason: 'plan_required' };
  if (!authorization || typeof authorization !== 'object') return { ok: false, reason: 'authorization_required' };
  if (!tools || typeof tools !== 'object' || !tools[plan.tool]) return { ok: false, reason: 'tool_not_whitelisted' };
  if (plan.tool !== authorization.actionType) return { ok: false, reason: 'action_mismatch' };
  if (String(plan.target || '') !== String(authorization.target || '')) return { ok: false, reason: 'target_mismatch' };
  const a = JSON.stringify(plan.params || {});
  const b = JSON.stringify(authorization.params || {});
  if (a !== b) return { ok: false, reason: 'params_mismatch' };
  const schemaErrs = validateSchema(plan.params || {}, tools[plan.tool].schema || {});
  if (schemaErrs.length) return { ok: false, reason: `schema:${schemaErrs.join(',')}` };
  if (budget && Number.isFinite(Number(budget.remainingActions)) && Number(budget.remainingActions) <= 0) return { ok: false, reason: 'budget_actions' };
  if (budget && Number.isFinite(Number(budget.remainingTokens)) && tools[plan.tool].tokens && Number(budget.remainingTokens) < Number(tools[plan.tool].tokens)) return { ok: false, reason: 'budget_tokens' };
  const max = Number(tools[plan.tool].maxRuns ?? 1);
  if (Number(runs) >= max) return { ok: false, reason: 'run_limit' };
  return { ok: true };
}
export { validateSchema };
