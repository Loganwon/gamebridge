import { validateProviderConfig, ProviderError } from '../ai/provider.mjs';
import { validateConversionRequest } from '../converter/spec.mjs';
import { createAdapterRegistry } from '../adapters/registry.mjs';
import { createScheduler } from '../orchestration/scheduler.mjs';
import { AGENT_ROLES, getAgentRole, createAgentManifest } from './roles.mjs';
import { generateAgentArtifact, validateAgentArtifact, validateAgentUpstream } from './provider.mjs';
import { AGENT_WORKFLOW_ID, DEFAULT_AGENT_BUDGET, createAgentTaskGraph } from './workflow.mjs';

function fail(code, message) { throw new ProviderError(code, message); }
function secretList(values) { return [...new Set(values.filter(value => typeof value === 'string' && value))]; }
function guard(value, secrets) {
  const serialized = JSON.stringify(value);
  if (secrets.some(secret => serialized.includes(JSON.stringify(secret).slice(1, -1)))) fail('CREDENTIAL_IN_RESPONSE', 'Agent 数据包含凭据，已丢弃且未持久化。');
}
function snapshotProvider(raw) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !['apiKey', 'baseUrl', 'model'].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) {
    fail('INVALID_PROVIDER_CONFIG', '模型配置必须是仅含凭据、地址与型号的普通数据对象。');
  }
  return Object.freeze(validateProviderConfig({ ...raw }));
}

/** Credentials live only in worker closures. Recreate this wrapper to resume with fresh credentials. */
export function createAgentRuntime({ store, registry = createAdapterRegistry(), provider, complete = generateAgentArtifact,
  maxConcurrency = 2, secrets = [] } = {}) {
  const selected = snapshotProvider(provider);
  let closed = false;
  function ensureOpen() { if (closed) fail('AGENT_RUNTIME_CLOSED', 'Agent runtime 已关闭，不能再创建、执行或恢复任务。'); }
  function settings() {
    if (!selected) fail('AGENT_PROVIDER_REQUIRED', '执行或恢复模型任务需要重新提供本地模型凭据；读取任务不需要凭据。');
    return selected;
  }
  const keys = () => secretList([selected?.apiKey, ...(typeof secrets === 'function' ? secrets() : secrets)]);
  for (const definition of AGENT_ROLES) {
    const role = getAgentRole(definition.id), manifest = createAgentManifest(role.id);
    registry.register(manifest, { analyze: async ({ task, input, signal }) => {
      ensureOpen();
      const config = settings(), request = validateConversionRequest(input.context.request);
      const upstream = validateAgentUpstream(Object.values(input.dependencies).map(result => result.data), request);
      guard({ request, upstream }, keys());
      const report = await complete(role.id, request, upstream, { ...config, signal });
      ensureOpen();
      if (signal.aborted) fail('PROVIDER_CANCELLED', 'Agent 已取消，晚到结果已丢弃。');
      guard(report, keys());
      const normalized = validateAgentArtifact(report, { request, upstream });
      if (task.role !== role.id || normalized.role !== role.id) fail('INVALID_AGENT_ROLE', '任务、产物与本地角色绑定不一致。');
      return { data: normalized };
    } });
  }
  const scheduler = createScheduler({ store, registry, maxConcurrency, secrets: keys });
  async function binding(id) {
    ensureOpen();
    const config = settings(), snapshot = await scheduler.get(id), context = snapshot.context;
    ensureOpen();
    if (context?.workflow !== AGENT_WORKFLOW_ID || !context?.providerBinding ||
        context.providerBinding.baseUrl !== config.baseUrl || context.providerBinding.model !== config.model) {
      fail('AGENT_PROVIDER_BINDING_MISMATCH', '任务绑定的模型地址或型号不匹配；不会使用新凭据隐式改写原任务。');
    }
    return snapshot;
  }
  return {
    async create(rawRequest, { budget = DEFAULT_AGENT_BUDGET } = {}) {
      ensureOpen();
      const config = settings(), graph = createAgentTaskGraph(rawRequest);
      guard(graph.request, keys());
      const created = await scheduler.createRun(graph.tasks, { context: { workflow: AGENT_WORKFLOW_ID, request: graph.request,
        providerBinding: { baseUrl: config.baseUrl, model: config.model } }, budget });
      ensureOpen(); return created;
    },
    async run(id, options = {}) { ensureOpen(); await binding(id); ensureOpen(); return scheduler.run(id, options); },
    async resume(id, options = {}) { ensureOpen(); await binding(id); ensureOpen(); return scheduler.resume(id, options); },
    get: id => scheduler.get(id), list: () => scheduler.list(),
    recover(id) { ensureOpen(); return scheduler.recover(id); },
    cancel(id) { ensureOpen(); return scheduler.cancel(id); },
    close() { closed = true; return scheduler.close(); },
    describe() { return { workflow: AGENT_WORKFLOW_ID, roles: registry.list({ kind: 'agent' }), gameAdapters: registry.list().filter(item => item.kind !== 'agent'),
      analysisOnly: true, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }; },
  };
}
