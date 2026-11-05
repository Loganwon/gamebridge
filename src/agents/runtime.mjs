import { validateProviderConfig, ProviderError } from '../ai/provider.mjs';
import { validateConversionRequest } from '../converter/spec.mjs';
import { createAdapterRegistry } from '../adapters/registry.mjs';
import { createScheduler } from '../orchestration/scheduler.mjs';
import { AGENT_ROLES, getAgentRole, createAgentManifest } from './roles.mjs';
import { generateAgentArtifact, validateAgentArtifact, validateAgentUpstream } from './provider.mjs';
import { AGENT_WORKFLOW_ID, DEFAULT_AGENT_BUDGET, createAgentTaskGraph } from './workflow.mjs';
import { createHash } from 'node:crypto';
import { PROJECT_WORKFLOW_ID, PROJECT_FORMAT, PROJECT_GENERATOR_VERSION, PROJECT_BUDGET, ANALYSIS_TASK_IDS, createProjectTaskGraph, projectNodeIdentity, projectManifest } from '../pipeline/workflow.mjs';
import { generateBehaviorProposal, validateBehaviorProposal, validatePipelineUpstream } from '../pipeline/specification.mjs';
import { makeAdapterProjectDraft } from '../pipeline/project.mjs';

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
  maxConcurrency = 2, secrets = [], workflow = AGENT_WORKFLOW_ID, artifacts, proposeBehavior = generateBehaviorProposal } = {}) {
  if (![AGENT_WORKFLOW_ID, PROJECT_WORKFLOW_ID].includes(workflow)) fail('INVALID_RUN_WORKFLOW', '未知工作流，不会隐式改写任务。');
  if (workflow === PROJECT_WORKFLOW_ID && (!artifacts || typeof artifacts.create !== 'function')) fail('PROJECT_STORE_REQUIRED', '统一流程需要受控私有文件产物库。');
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
  if (workflow === PROJECT_WORKFLOW_ID) {
    const inputs = input => validatePipelineUpstream(input.context.request, ANALYSIS_TASK_IDS.map(id => input.dependencies[id]?.data));
    const digest = spec => createHash('sha256').update(JSON.stringify(spec)).digest('hex');
    const evidence = { semanticCompleteness: false, realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
    registry.register(projectManifest('agent', 'specify', 'agent.behavior.specify', 'analysis.behavior.proposal', 'conversion-implementation'), {
      specify: async ({ input, signal }) => {
        ensureOpen(); const config = settings(), { request, upstream } = inputs(input);
        guard({ request, upstream }, keys());
        const raw = await proposeBehavior(request, upstream, { ...config, signal, secrets: keys() });
        ensureOpen(); if (signal.aborted) fail('PROVIDER_CANCELLED', '规格分析已取消，晚到结果丢弃。');
        const proposal = validateBehaviorProposal(raw, { request, upstream, secrets: keys() }); guard(proposal, keys());
        return { data: { proposal, scope: 'unverified-behavior-proposal', ...evidence } };
      },
    });
    registry.register(projectManifest('tool', 'check', 'tool.behavior.check', 'tool.behavior.specification', 'independent-validation'), {
      check: async ({ input }) => {
        ensureOpen(); const { request, upstream, requirementIds } = inputs(input);
        const proposal = validateBehaviorProposal(input.dependencies['specify-behavior'].data.proposal, { request, upstream, secrets: keys() });
        return { data: { proposal, requirementIds, specificationSha256: digest(proposal.spec), unresolvedRequirementIds: proposal.spec.unresolved.map(item => item.requirementId), scope: 'bounded-behavior-contract', ...evidence } };
      },
    });
    registry.register(projectManifest('tool', 'draft', 'tool.adapter.draft', 'tool.adapter.project', 'conversion-implementation', 'local-write'), {
      draft: async ({ input, signal }) => {
        ensureOpen(); const { request, upstream } = inputs(input), checked = input.dependencies['validate-behavior'].data;
        const proposal = validateBehaviorProposal(checked.proposal, { request, upstream, secrets: keys() });
        if (checked.specificationSha256 !== digest(proposal.spec)) fail('PROJECT_SPECIFICATION_CHANGED', '规格指纹不一致。');
        const generated = makeAdapterProjectDraft({ request, upstream, proposal }, { secrets: keys() });
        guard(generated.metadata, keys());
        if (signal.aborted) fail('PROVIDER_CANCELLED', '工程草稿生成已取消。');
        const project = await artifacts.create({ files: generated.files, provenance: { producer: 'gamebridge.adapter-draft.v1', specificationSha256: digest(proposal.spec), generatorVersion: PROJECT_GENERATOR_VERSION } }, { signal });
        ensureOpen(); if (signal.aborted) fail('PROVIDER_CANCELLED', '工程草稿已取消，晚到结果丢弃。');
        return { data: { project, metadata: generated.metadata, specificationSha256: digest(proposal.spec) } };
      },
    });
  }
  const scheduler = createScheduler({ store, registry, maxConcurrency, secrets: keys });
  async function binding(id) {
    ensureOpen();
    const config = settings(), snapshot = await scheduler.get(id), context = snapshot.context;
    ensureOpen();
    if (context?.workflow !== workflow || !context?.providerBinding ||
        context.providerBinding.baseUrl !== config.baseUrl || context.providerBinding.model !== config.model) {
      fail('AGENT_PROVIDER_BINDING_MISMATCH', '任务绑定的模型地址或型号不匹配；不会使用新凭据隐式改写原任务。');
    }
    if (workflow === PROJECT_WORKFLOW_ID && (context.platform !== process.platform || context.generatorVersion !== PROJECT_GENERATOR_VERSION ||
      JSON.stringify(context.toolchains) !== JSON.stringify([projectNodeIdentity()]) || JSON.stringify(context.formats) !== JSON.stringify([PROJECT_FORMAT]))) {
      fail('PROJECT_ENVIRONMENT_BINDING_MISMATCH', '工程生成器版本或本机 Node 绑定已变化；不会重放收费任务。');
    }
    return snapshot;
  }
  return {
    async create(rawRequest, { budget = workflow === PROJECT_WORKFLOW_ID ? PROJECT_BUDGET : DEFAULT_AGENT_BUDGET } = {}) {
      ensureOpen();
      const config = settings(), graph = workflow === PROJECT_WORKFLOW_ID ? createProjectTaskGraph(rawRequest) : createAgentTaskGraph(rawRequest);
      guard(graph.request, keys());
      const created = await scheduler.createRun(graph.tasks, { context: { workflow, platform: process.platform, request: graph.request,
        ...(workflow === PROJECT_WORKFLOW_ID ? { generatorVersion: PROJECT_GENERATOR_VERSION, toolchains: [projectNodeIdentity()], formats: [PROJECT_FORMAT] } : {}),
        providerBinding: { baseUrl: config.baseUrl, model: config.model } }, budget });
      ensureOpen(); return created;
    },
    async run(id, options = {}) { ensureOpen(); await binding(id); ensureOpen(); return scheduler.run(id, options); },
    async resume(id, options = {}) { ensureOpen(); await binding(id); ensureOpen(); return scheduler.resume(id, options); },
    get: id => scheduler.get(id), list: () => scheduler.list(),
    recover(id) { ensureOpen(); return scheduler.recover(id); },
    cancel(id) { ensureOpen(); return scheduler.cancel(id); },
    close() { closed = true; return scheduler.close(); },
    describe() { return { workflow, roles: registry.list({ kind: 'agent' }), tools: registry.list({ kind: 'tool' }), gameAdapters: registry.list().filter(item => !['agent', 'tool'].includes(item.kind)),
      analysisOnly: workflow === AGENT_WORKFLOW_ID, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }; },
  };
}
