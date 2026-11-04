// Real scheduler/store integration with mock role completions. No live model, game adapter or Mod evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunStore } from '../src/orchestration/store.mjs';
import { createAgentRuntime } from '../src/agents/runtime.mjs';
import { generateAgentArtifact } from '../src/agents/provider.mjs';
import { AGENT_WORKFLOW_ID, createAgentTaskGraph } from '../src/agents/workflow.mjs';
import { createAdapterRegistry } from '../src/adapters/registry.mjs';
import { createScheduler } from '../src/orchestration/scheduler.mjs';

const KEY = 'agent-runtime-test-canary-never-live';
const provider = { apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: 'test-only-model' };
const request = { hostGame: 'Any Host', sourceGame: 'Any Source', description: '保留来源动作和交互，不缩减需求。', contentKinds: ['moveset'] };
function proposal(role) {
  if (role === 'requirements') return { schemaVersion: 1, title: '通用需求分析', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '仅测试协作与恢复。',
    requirements: [{ id: 'moves', kind: 'moveset', description: request.description, disposition: 'needs_research', reason: '接口与资源未知。' }], assetNeeds: [], interfaceNeeds: [], questions: [], limitations: ['无真实游戏转换。'] };
  if (role === 'independent-validation') return { schemaVersion: 1, summary: '独立方案审查。', coverage: [{ requirementId: 'moves', assessment: 'unclear', reason: '仍需真实证据。' }], issues: [], limitations: ['未验收游戏。'] };
  return { schemaVersion: 1, summary: `角色 ${role} 的方案。`, items: [{ id: 'item', requirementIds: ['moves'], description: '保留完整交互需求。', nextStep: '调查并验证适配能力。' }], questions: [], limitations: ['仅未验证的建议。'] };
}
async function mockArtifact(role, req, upstream, options = {}) {
  return generateAgentArtifact(role, req, upstream, { ...provider, ...options, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal(role)) } }] })) });
}
async function scratch(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-agent-runtime-test-'));
  try { await work(root, await createRunStore({ root, secrets: [KEY] })); } finally { await rm(root, { recursive: true, force: true }); }
}

test('generic graph executes five isolated roles, parallel research and dependency-linked artifacts', { timeout: 10000 }, async () => {
  await scratch(async (root, store) => {
    const calls = [], started = new Set(); let release;
    const bothResearch = new Promise(resolve => { release = resolve; });
    let active = 0, peak = 0;
    const runtime = createAgentRuntime({ store, provider, maxConcurrency: 2, complete: async (role, req, upstream, options) => {
      calls.push(role); active++; peak = Math.max(peak, active);
      try {
        if (['source-research', 'host-research'].includes(role)) { started.add(role); if (started.size === 2) release(); await bothResearch; }
        if (role === 'conversion-implementation') assert.deepEqual(new Set(upstream.map(item => item.role)), new Set(['requirements', 'source-research', 'host-research']));
        if (role === 'independent-validation') assert.equal(upstream.length, 4);
        return await mockArtifact(role, req, upstream, options);
      } finally { active--; }
    } });
    const created = await runtime.create(request), result = await runtime.run(created.id);
    assert.equal(created.context.platform, process.platform);
    assert.equal(result.status, 'blocked'); assert.equal(result.budget.modelCallsReserved, 5);
    assert.equal(calls.length, 5); assert.equal(peak, 2);
    assert.equal(result.tasks.filter(task => task.status === 'succeeded').length, 5);
    for (const task of result.tasks.filter(task => task.status === 'succeeded')) {
      assert.equal(task.result.data.scope, 'analysis-only'); assert.equal(task.result.artifact.scope, 'analysis-only');
      assert.equal(task.result.data.game, 'not_run'); assert.equal(task.result.data.readyToInstall, false);
      assert.equal(task.result.artifact.provenance.taskId, task.id);
    }
    for (const id of ['generate-project', 'compile-mod', 'verify-game']) {
      const task = result.tasks.find(task => task.id === id); assert.equal(task.status, 'blocked'); assert.equal(task.attemptCount, 0);
    }
    assert.equal(runtime.describe().roles.length, 5); assert.deepEqual(runtime.describe().gameAdapters, []);
    const raw = await readFile(path.join(root, 'runs', created.id + '.json'), 'utf8');
    assert.ok(!raw.includes(KEY)); assert.ok(raw.includes('providerBinding')); assert.ok(!raw.includes('apiKey'));
    const readonly = createAgentRuntime({ store });
    assert.equal((await readonly.get(created.id)).status, 'blocked'); assert.equal((await readonly.list()).length, 1);
    await assert.rejects(readonly.run(created.id), { code: 'AGENT_PROVIDER_REQUIRED' });
    const resumed = createAgentRuntime({ store, provider, complete: async () => { throw new Error('Completed tasks must not replay.'); } });
    const again = await resumed.resume(created.id);
    assert.equal(again.budget.modelCallsReserved, 5); assert.equal(again.tasks.filter(task => task.status === 'succeeded').length, 5);
    runtime.close(); readonly.close(); resumed.close();
  });
});

test('generation receives the full direct analysis context under the locally observed platform', async () => {
  await scratch(async (_root, store) => {
    const registry = createAdapterRegistry(), dependencyIds = ['requirements', 'source-research', 'host-research', 'conversion-design', 'independent-review'];
    let generated = 0;
    registry.register({ schemaVersion: 1, id: 'host.generation-input-contract', version: '1.0.0', kind: 'host', role: 'conversion-implementation',
      targets: [{ game: request.hostGame, version: '1.2.3', platform: process.platform, role: 'host' }], contentKinds: ['moveset'],
      capabilities: [{ id: 'host.project.generate', operation: 'generate', outputTypes: ['mod.project'] }], allowedOperations: ['generate'],
      execution: { sideEffects: 'none', idempotent: true, modelCallsPerAttempt: 0 }, evidenceScope: 'contract-test-only', references: ['https://example.org/generation-input-contract'],
      limitations: ['Contract fixture only; does not generate a real project or Mod.'], resourceLimits: { maxInputBytes: 131072, maxOutputBytes: 16384, timeoutMs: 1000 },
    }, { generate: async ({ input }) => {
      generated++; assert.equal(input.context.platform, process.platform); assert.deepEqual(Object.keys(input.dependencies), dependencyIds);
      assert.equal(input.dependencies.requirements.data.role, 'requirements');
      assert.equal(input.dependencies['conversion-design'].data.role, 'conversion-implementation');
      assert.ok(input.dependencies['conversion-design'].data.analysis.items[0].description);
      return { data: { scope: 'contract-test-only', inputRoles: dependencyIds, generatedMod: false } };
    } });
    const runtime = createAgentRuntime({ store, registry, provider, complete: mockArtifact });
    const created = await runtime.create({ ...request, hostVersion: '1.2.3' }), result = await runtime.run(created.id);
    assert.equal(generated, 1); assert.equal(result.tasks.find(task => task.id === 'generate-project').status, 'succeeded');
    assert.equal(result.tasks.find(task => task.id === 'compile-mod').attemptCount, 0);
    assert.equal(result.report.realModBuild, 'not_run'); assert.equal(result.report.game, 'not_run'); assert.equal(result.report.readyToInstall, false);
    assert.equal(created.graph.find(task => task.id === 'generate-project').inputRefs.length, 6);
    await assert.rejects(runtime.create({ ...request, platform: 'untrusted-platform' }), { code: 'INVALID_CONVERSION_REQUEST' });
    await runtime.close();
  });
});

test('stored analysis v1 graphs remain readable and resumable without rewriting old inputs or platform', async () => {
  await scratch(async (_root, store) => {
    const oldGraph = createAgentTaskGraph(request).tasks, generation = oldGraph.find(task => task.id === 'generate-project');
    generation.dependsOn = ['independent-review']; generation.inputRefs = ['input:request', 'task:independent-review'];
    const creator = createScheduler({ store, registry: createAdapterRegistry() });
    const legacy = await creator.createRun(oldGraph, { context: { workflow: AGENT_WORKFLOW_ID, request,
      providerBinding: { baseUrl: provider.baseUrl, model: provider.model } } });
    await creator.close();
    let calls = 0;
    const runtime = createAgentRuntime({ store, provider, complete: async (...args) => { calls++; return mockArtifact(...args); } });
    assert.equal((await runtime.get(legacy.id)).context.platform, undefined);
    const resumed = await runtime.resume(legacy.id);
    assert.equal(resumed.status, 'blocked'); assert.equal(calls, 5); assert.equal(resumed.context.platform, undefined);
    assert.deepEqual(resumed.graph.find(task => task.id === 'generate-project').dependsOn, ['independent-review']);
    assert.deepEqual(resumed.graph.find(task => task.id === 'generate-project').inputRefs, ['input:request', 'task:independent-review']);
    assert.equal(resumed.report.game, 'not_run'); await runtime.close();
  });
});

test('budget and provider binding are local gates before additional worker attempts', async () => {
  await scratch(async (_root, store) => {
    let calls = 0;
    const runtime = createAgentRuntime({ store, provider, complete: async (...args) => { calls++; return mockArtifact(...args); } });
    const created = await runtime.create(request, { budget: { maxModelCalls: 2, maxAttempts: 16 } });
    const result = await runtime.run(created.id);
    assert.equal(calls, 2); assert.equal(result.budget.modelCallsReserved, 2); assert.equal(result.status, 'blocked');
    const wrong = createAgentRuntime({ store, provider: { ...provider, model: 'different-model' }, complete: async () => { throw new Error('must not execute'); } });
    await assert.rejects(wrong.resume(created.id, { allowReplay: true, budget: { maxModelCalls: 5 } }), { code: 'AGENT_PROVIDER_BINDING_MISMATCH' });
    assert.equal((await runtime.get(created.id)).budget.modelCallsReserved, 2);
    await assert.rejects(runtime.create({ ...request, description: KEY }), { code: 'CREDENTIAL_IN_RESPONSE' });
    assert.equal((await runtime.list()).length, 1); runtime.close(); wrong.close();
  });
});

test('cancelled workers cannot publish late analysis or implicitly replay paid tasks', { timeout: 10000 }, async () => {
  await scratch(async (_root, store) => {
    const artifact = await mockArtifact('requirements', request, []);
    let entered, release;
    const enteredPromise = new Promise(resolve => { entered = resolve; }), late = new Promise(resolve => { release = resolve; });
    const runtime = createAgentRuntime({ store, provider, complete: async () => { entered(); return late; } });
    const created = await runtime.create(request), pending = runtime.run(created.id); await enteredPromise;
    const cancelled = await runtime.cancel(created.id); await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.budget.modelCallsReserved, 1);
    const revision = cancelled.revision; release(artifact); await new Promise(resolve => setTimeout(resolve, 20));
    const after = await runtime.get(created.id); assert.equal(after.revision, revision); assert.ok(after.tasks.every(task => !task.result));
    let replayCalls = 0;
    const resumed = createAgentRuntime({ store, provider, complete: async (...args) => { replayCalls++; return mockArtifact(...args); } });
    const noReplay = await resumed.resume(created.id);
    assert.equal(replayCalls, 0); assert.equal(noReplay.budget.modelCallsReserved, 1);
    const explicit = await resumed.resume(created.id, { allowReplay: true, budget: { maxModelCalls: 6 } });
    assert.equal(replayCalls, 5); assert.equal(explicit.budget.modelCallsReserved, 6);
    assert.equal(explicit.tasks.find(task => task.id === 'requirements').attemptCount, 2);
    assert.equal(explicit.report.game, 'not_run'); runtime.close(); resumed.close();
  });
});

test('agent outputs cannot inject credentials or game evidence into durable results', async () => {
  await scratch(async (root, store) => {
    for (const mutate of [artifact => { artifact.game = 'passed'; }, artifact => { artifact.analysis.summary = KEY; }]) {
      const artifact = await mockArtifact('requirements', request, []); mutate(artifact);
      const runtime = createAgentRuntime({ store, provider, complete: async () => artifact });
      const created = await runtime.create(request), result = await runtime.run(created.id);
      assert.equal(result.status, 'failed'); assert.equal(result.tasks[0].result, undefined);
      assert.ok(!(await readFile(path.join(root, 'runs', created.id + '.json'), 'utf8')).includes(KEY));
      runtime.close();
    }
    const graph = createAgentTaskGraph(request);
    assert.equal(graph.tasks.filter(task => task.requiredCapabilities[0].startsWith('agent.')).length, 5);
    assert.ok(graph.tasks.every(task => !task.retryPolicy.replaySafe));
  });
});

test('a source worker cannot substitute a valid artifact from another logical role', async () => {
  await scratch(async (_root, store) => {
    const requirementArtifact = await mockArtifact('requirements', request, []);
    const runtime = createAgentRuntime({ store, provider, complete: async (role, req, upstream, options) =>
      role === 'source-research' ? structuredClone(requirementArtifact) : mockArtifact(role, req, upstream, options) });
    const created = await runtime.create(request), result = await runtime.run(created.id);
    const source = result.tasks.find(task => task.id === 'source-research');
    assert.equal(source.status, 'failed'); assert.equal(source.result, undefined);
    assert.equal(source.attempts[0].error.code, 'INVALID_AGENT_ROLE');
    assert.equal(result.tasks.find(task => task.id === 'conversion-design').attemptCount, 0);
    runtime.close();
  });
});

test('runtime snapshots plain provider configuration before create or worker awaits', async () => {
  await scratch(async (_root, store) => {
    const mutable = { ...provider }; let calls = 0;
    const runtime = createAgentRuntime({ store, provider: mutable, complete: async (role, req, upstream, options) => {
      calls++; assert.equal(options.apiKey, KEY); assert.equal(options.baseUrl, provider.baseUrl); assert.equal(options.model, provider.model);
      return mockArtifact(role, req, upstream, options);
    } });
    mutable.apiKey = 'replacement-test-key-never-live'; mutable.baseUrl = 'https://changed.example.com'; mutable.model = 'changed-model';
    const created = await runtime.create(request);
    assert.deepEqual(created.context.providerBinding, { baseUrl: provider.baseUrl, model: provider.model });
    await runtime.run(created.id); assert.equal(calls, 5);
    await assert.rejects(runtime.create({ ...request, description: KEY }), { code: 'CREDENTIAL_IN_RESPONSE' });
    let getterInvoked = false;
    const accessor = { baseUrl: provider.baseUrl, model: provider.model };
    Object.defineProperty(accessor, 'apiKey', { enumerable: true, get() { getterInvoked = true; return KEY; } });
    assert.throws(() => createAgentRuntime({ store, provider: accessor }), { code: 'INVALID_PROVIDER_CONFIG' });
    assert.equal(getterInvoked, false); runtime.close();
  });
});

test('closing during asynchronous provider-binding checks cannot start paid work afterwards', { timeout: 10000 }, async () => {
  await scratch(async (_root, store) => {
    for (const method of ['run', 'resume']) {
      let entered, release, holdRead = false, calls = 0;
      const enteredRead = new Promise(resolve => { entered = resolve; }), delayed = new Promise(resolve => { release = resolve; });
      const wrappedStore = { ...store, read: async id => { if (holdRead) { entered(); await delayed; } return store.read(id); } };
      const runtime = createAgentRuntime({ store: wrappedStore, provider, complete: async (...args) => { calls++; return mockArtifact(...args); } });
      const created = await runtime.create(request); holdRead = true;
      const pending = runtime[method](created.id); await enteredRead;
      await runtime.close(); release();
      await assert.rejects(pending, { code: 'AGENT_RUNTIME_CLOSED' });
      assert.equal(calls, 0);
      const snapshot = await runtime.get(created.id);
      assert.equal(snapshot.budget.modelCallsReserved, 0); assert.equal(snapshot.budget.attemptsReserved, 0);
      assert.equal((await runtime.list()).some(item => item.id === created.id), true);
      await assert.rejects(runtime.run(created.id), { code: 'AGENT_RUNTIME_CLOSED' });
      await assert.rejects(runtime.create(request), { code: 'AGENT_RUNTIME_CLOSED' });
    }
  });
});
