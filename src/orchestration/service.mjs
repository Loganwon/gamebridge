import { createRunStore } from './store.mjs';
import { createAgentRuntime } from '../agents/runtime.mjs';
import { validateProviderConfig } from '../ai/provider.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function checkedBudget(value, minimum = 0) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'maxModelCalls') ||
      !Number.isSafeInteger(value.maxModelCalls) || value.maxModelCalls < minimum || value.maxModelCalls > 20) fail('INVALID_RUN_BUDGET', '总调用预算必须为不小于已有预算的整数，且不超过 20。');
  return { maxModelCalls: value.maxModelCalls };
}

/** Local durable workflow service. Keys stay in active worker closures and a
 * process-local exclusion guard, never in task definitions, context or snapshots.
 */
export async function createRunService({ root, secrets = [], complete, maxConcurrency = 2 } = {}) {
  const knownSecrets = new Set(typeof secrets === 'function' ? secrets() : secrets);
  const guard = () => [...new Set([...knownSecrets, ...(typeof secrets === 'function' ? secrets() : secrets)])].filter(Boolean);
  const store = await createRunStore({ root, secrets: guard });
  const reader = createAgentRuntime({ store, secrets: guard });
  const active = new Map(), errors = new Map(); let creating = false, closed = false, admission = null;
  function beginAdmission() {
    creating = true; let done; const finished = new Promise(resolve => { done = resolve; }); admission = finished;
    return () => { creating = false; if (admission === finished) admission = null; done(); };
  }
  function ensureOpen() { if (closed) fail('RUN_SERVICE_CLOSED', '工作流服务已关闭，未启动后续任务。'); }
  function configuration(provider) {
    const checked = Object.freeze(validateProviderConfig(provider)); knownSecrets.add(checked.apiKey); return checked;
  }
  function available() { if (closed) fail('RUN_SERVICE_CLOSED', '工作流服务已关闭。'); if (creating || active.size) fail('RUN_BUSY', '已有协作任务在运行；可查看任务或先取消。'); }
  function runtime(provider) { return createAgentRuntime({ store, provider, ...(complete ? { complete } : {}), maxConcurrency, secrets: guard }); }
  function launch(worker, id, options, resume) {
    if (closed) { void worker.close(); ensureOpen(); }
    const entry = { worker, promise: null }; active.set(id, entry); errors.delete(id);
    entry.promise = (resume ? worker.resume(id, options) : worker.run(id, options)).catch(error => {
      const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'RUN_EXECUTION_FAILED';
      errors.set(id, { code, message: '工作流没有完成调度；检查记录和占用状态后再明确恢复。' });
    }).finally(() => { worker.close(); if (active.get(id) === entry) active.delete(id); });
  }
  async function get(id) {
    let state = await reader.get(id);
    if (!creating && !active.has(id) && ['created', 'running'].includes(state.status)) {
      try { state = await reader.recover(id); }
      catch (error) { if (error.code !== 'RUN_BUSY') throw error; }
    }
    return { ...state, observation: { active: active.has(id) }, ...(errors.has(id) ? { serviceError: errors.get(id) } : {}) };
  }
  // Observation/recovery only. A restart never submits a model request.
  for (const state of await reader.list()) if (['created', 'running'].includes(state.status)) {
    try { await reader.recover(state.id); } catch (error) { if (error.code !== 'RUN_BUSY') throw error; }
  }
  return {
    get activeCount() { return active.size + Number(creating); },
    describe: () => reader.describe(),
    async create({ request, provider, budget } = {}) {
      available(); const settings = configuration(provider), limits = checkedBudget(budget);
      const finished = beginAdmission();
      try {
        const worker = runtime(settings), state = await worker.create(request, { budget: { maxModelCalls: limits?.maxModelCalls ?? 5, maxAttempts: 16 } });
        if (closed) { await worker.close(); ensureOpen(); }
        launch(worker, state.id, {}, false); return get(state.id);
      } finally { finished(); }
    },
    get,
    async list() {
      const states = await reader.list(), summaries = [];
      for (const item of states) {
        const state = await get(item.id);
        summaries.push({ id: state.id, status: state.status, createdAt: state.createdAt, updatedAt: state.updatedAt,
          context: { request: { hostGame: state.context.request?.hostGame, sourceGame: state.context.request?.sourceGame } },
          budget: state.budget, report: state.report, observation: state.observation, ...(state.serviceError ? { serviceError: state.serviceError } : {}) });
      }
      return summaries;
    },
    async resume(id, { provider, budget, allowReplay = false } = {}) {
      available(); if (typeof allowReplay !== 'boolean') fail('INVALID_RESUME_OPTIONS', '恢复重放选项必须明确为布尔值。');
      const finished = beginAdmission();
      try {
        const settings = configuration(provider), state = await get(id), binding = state.context?.providerBinding;
        ensureOpen();
        if (!binding || binding.baseUrl !== settings.baseUrl || binding.model !== settings.model) fail('AGENT_PROVIDER_BINDING_MISMATCH', '恢复时需要原任务所绑定的 API 地址和模型；密钥须重新在本机提供。');
        const limits = checkedBudget(budget, state.budget.maxModelCalls);
        const worker = runtime(settings); launch(worker, id, { allowReplay, ...(limits ? { budget: limits } : {}) }, true);
        return get(id);
      } finally { finished(); }
    },
    async cancel(id) {
      const entry = active.get(id);
      if (entry) { await entry.worker.cancel(id); await entry.promise; return get(id); }
      return reader.cancel(id);
    },
    async close() {
      closed = true; for (const entry of active.values()) entry.worker.close();
      await admission;
      await Promise.allSettled([...active.values()].map(entry => entry.promise)); await reader.close();
    },
  };
}
