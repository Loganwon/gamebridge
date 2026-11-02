// Durable service integration with mock role JSON only. No network, compiler,
// game adapter or actual game-conversion evidence is produced by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunService } from '../src/orchestration/service.mjs';
import { createRunStore } from '../src/orchestration/store.mjs';
import { generateAgentArtifact } from '../src/agents/provider.mjs';

const KEY = 'service-contract-canary-not-a-live-key';
const provider = { apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: 'contract-model' };
const request = { hostGame: 'Generic Host', sourceGame: 'Generic Source', description: '保留来源交互并标明资源与接口缺口。', contentKinds: ['moveset'] };
function proposal(role) {
  if (role === 'requirements') return { schemaVersion: 1, title: '通用协作合同', hostGame: request.hostGame, sourceGame: request.sourceGame,
    summary: '只验证服务生命周期。', requirements: [{ id: 'interaction', kind: 'moveset', description: request.description, disposition: 'needs_research', reason: '缺少接口证据。' }],
    assetNeeds: [], interfaceNeeds: [], questions: [], limitations: ['没有真实游戏验收。'] };
  if (role === 'independent-validation') return { schemaVersion: 1, summary: '独立分析合同审查。', coverage: [{ requirementId: 'interaction', assessment: 'unclear', reason: '等待真实接口证据。' }], issues: [], limitations: ['未运行游戏。'] };
  return { schemaVersion: 1, summary: '保留完整转换目标。', items: [{ id: 'item', requirementIds: ['interaction'], description: '调查实际能力。', nextStep: '核对接口与资源。' }], questions: [], limitations: ['仅未验证分析。'] };
}
async function complete(role, req, upstream, options) {
  return generateAgentArtifact(role, req, upstream, { ...options, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal(role)) } }] })) });
}
async function fixture(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-run-service-'));
  const services = [];
  const open = async options => { const service = await createRunService({ root, secrets: [KEY], complete, ...options }); services.push(service); return service; };
  try { await work(root, open); } finally { await Promise.allSettled(services.map(service => service.close())); await rm(root, { recursive: true, force: true }); }
}
async function settled(service, id) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) { const state = await service.get(id); if (!state.observation.active) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Contract service did not settle.');
}

test('service restart reads checkpoints without a provider and resumes only remaining roles within a larger budget', { timeout: 15000 }, async () => fixture(async (root, open) => {
  const calls = [];
  const first = await open({ complete: async (...args) => { calls.push(args[0]); return complete(...args); } });
  const created = await first.create({ request, provider, budget: { maxModelCalls: 2 } });
  const limited = await settled(first, created.id); assert.equal(limited.status, 'blocked'); assert.equal(calls.length, 2);
  await first.close();
  const second = await open({ complete: async (...args) => { calls.push(args[0]); return complete(...args); } });
  assert.equal((await second.list()).length, 1); assert.equal((await second.get(created.id)).budget.modelCallsReserved, 2);
  await assert.rejects(second.resume(created.id, { provider: { ...provider, model: 'other-model' } }), { code: 'AGENT_PROVIDER_BINDING_MISMATCH' });
  await assert.rejects(second.resume(created.id, { provider, budget: { maxModelCalls: 1 } }), { code: 'INVALID_RUN_BUDGET' });
  await second.resume(created.id, { provider, budget: { maxModelCalls: 5 } }); const result = await settled(second, created.id);
  assert.equal(result.budget.modelCallsReserved, 5); assert.equal(calls.length, 5);
  assert.equal(calls.filter(role => role === 'requirements').length, 1);
  assert.equal(result.report.game, 'not_run'); assert.equal(result.report.readyToInstall, false);
  assert.ok(!(await readFile(path.join(root, 'runs', created.id + '.json'), 'utf8')).includes(KEY));
}));

test('concurrent resume admission cannot launch duplicate workers or reserve duplicate model calls', { timeout: 15000 }, async () => fixture(async (_root, open) => {
  let calls = 0;
  const service = await open({ complete: async (...args) => { calls++; return complete(...args); } });
  const created = await service.create({ request, provider, budget: { maxModelCalls: 0 } }); await settled(service, created.id);
  const results = await Promise.allSettled([
    service.resume(created.id, { provider, budget: { maxModelCalls: 5 } }),
    service.resume(created.id, { provider, budget: { maxModelCalls: 5 } }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'RUN_BUSY');
  const state = await settled(service, created.id); assert.equal(state.budget.modelCallsReserved, 5); assert.equal(calls, 5);
}));

test('closing while resume awaits its snapshot cannot dispatch paid work after shutdown', { timeout: 10000 }, async () => fixture(async (_root, open) => {
  let calls = 0;
  const service = await open({ complete: async (...args) => { calls++; return complete(...args); } });
  const created = await service.create({ request, provider, budget: { maxModelCalls: 0 } }); await settled(service, created.id);
  const resuming = service.resume(created.id, { provider, budget: { maxModelCalls: 5 } });
  await service.close();
  await resuming.catch(error => { assert.ok(['RUN_SERVICE_CLOSED', 'AGENT_RUNTIME_CLOSED'].includes(error.code)); });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, 0, 'a closed service must not create a new model worker');
  const state = await service.get(created.id); assert.equal(state.budget.modelCallsReserved, 0);
}));

test('closing during creation waits for durable admission and restart reconciles the zero-attempt checkpoint', { timeout: 10000 }, async () => fixture(async (root, open) => {
  let calls = 0;
  const service = await open({ complete: async (...args) => { calls++; return complete(...args); } });
  const creating = service.create({ request, provider }); const outcome = creating.catch(error => error);
  await service.close(); await outcome;
  assert.equal(calls, 0);
  const records = await (await createRunStore({ root, secrets: [KEY] })).list();
  assert.equal(records.length, 1, 'admitted creation has finished persisting before close resolves');
  assert.ok(records.every(record => record.status !== 'running' && record.tasks.every(task => task.attemptCount === 0)));
  assert.ok(records.every(record => record.budget.modelCallsReserved === 0));
  const restarted = await open({ complete: async () => { throw new Error('restart observation must not execute a role'); } });
  const summaries = await restarted.list(); assert.equal(summaries.length, 1);
  assert.equal(summaries[0].status, 'interrupted'); assert.equal(summaries[0].budget.modelCallsReserved, 0);
}));
