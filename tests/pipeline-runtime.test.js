// Real scheduler/persistence/files/HTTP; model JSON is explicitly simulated.
// No cloud call, compiler, SDK, installation or game is started by this suite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunService } from '../src/orchestration/service.mjs';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { PROJECT_WORKFLOW_ID } from '../src/pipeline/workflow.mjs';
import { TEST_KEY, provider, request, complete, behaviorProposal } from './helpers/pipeline-fixture.mjs';

async function fixture(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-pipeline-')), services = [];
  const open = async (options = {}) => { const service = await createRunService({ root, complete, proposeBehavior: async () => behaviorProposal(), secrets: [TEST_KEY], ...options }); services.push(service); return service; };
  try { await work(root, open); } finally { await Promise.allSettled(services.map(service => service.close())); await rm(root, { recursive: true, force: true }); }
}
async function settled(service, id) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { const state = await service.get(id); if (!state.observation.active) return state; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Pipeline fixture did not settle.');
}

test('unified pipeline keeps requirements, validates model AST and produces private source files before the real host gate', { timeout: 15000 }, async () => fixture(async (root, open) => {
  let paid = 0;
  const service = await open({ complete: async (...args) => { paid++; return complete(...args); }, proposeBehavior: async () => { paid++; return behaviorProposal(); } });
  const created = await service.create({ request, provider, workflow: PROJECT_WORKFLOW_ID });
  const state = await settled(service, created.id);
  assert.equal(paid, 6); assert.equal(state.budget.modelCallsReserved, 6); assert.equal(state.status, 'blocked');
  for (const id of ['specify-behavior', 'validate-behavior', 'generate-adapter-project']) assert.equal(state.tasks.find(task => task.id === id).status, 'succeeded');
  assert.equal(state.tasks.find(task => task.id === 'generate-project').attemptCount, 0);
  assert.equal(state.report.realModBuild, 'not_run'); assert.equal(state.report.game, 'not_run'); assert.equal(state.report.readyToInstall, false);
  const validation = state.tasks.find(task => task.id === 'validate-behavior').result.data;
  assert.deepEqual(validation.requirementIds, ['interaction', 'appearance']); assert.deepEqual(validation.unresolvedRequirementIds, ['appearance']);
  const draft = state.tasks.find(task => task.id === 'generate-adapter-project').result.data;
  assert.equal(draft.metadata.semanticCompleteness, false); assert.equal(draft.metadata.hostBindingStatus, 'blocked');
  assert.ok(!JSON.stringify(state).includes('public sealed class')); assert.ok(!JSON.stringify(state).includes(TEST_KEY));
  const project = await service.project(state.id), contents = Object.fromEntries(project.files.map(file => [file.name, file.data.toString()]));
  assert.match(contents['Behavior.g.cs'], /class BehaviorMachine/); assert.match(contents['HostBridge.g.cs'], /BehaviorMachine/);
  assert.equal(JSON.parse(contents['request.json']).description, request.description);
  assert.ok(contents['binding-requirements.json'].includes('appearance'));
  assert.ok(contents['binding-requirements.json'].includes('missing-assets'));
  assert.ok(!JSON.stringify(contents).includes(TEST_KEY));
  assert.equal(state.projectDownloadUrl, `/api/runs/${state.id}/project`);
  const file = path.join(root, 'project-artifacts/objects', draft.project.id, 'files/Behavior.g.cs');
  await writeFile(file, 'tampered');
  await assert.rejects(service.project(state.id), { code: 'ARTIFACT_CORRUPT' });
}));

test('budget-five checkpoint resumes only the sixth call and local draft, then restart retains downloadable hashes', { timeout: 20000 }, async () => fixture(async (_root, open) => {
  let analysisCalls = 0, specCalls = 0;
  const options = { complete: async (...args) => { analysisCalls++; return complete(...args); }, proposeBehavior: async () => { specCalls++; return behaviorProposal(); } };
  const first = await open(options), created = await first.create({ request, provider, workflow: PROJECT_WORKFLOW_ID, budget: { maxModelCalls: 5 } });
  const limited = await settled(first, created.id); assert.equal(limited.status, 'blocked'); assert.equal(specCalls, 0);
  await assert.rejects(first.project(created.id), { code: 'PROJECT_NOT_AVAILABLE' }); await first.close();
  const second = await open(options); assert.equal(specCalls, 0);
  await second.resume(created.id, { provider, budget: { maxModelCalls: 6 } }); const completed = await settled(second, created.id);
  assert.equal(analysisCalls, 5); assert.equal(specCalls, 1);
  const before = await second.project(created.id); await second.close();
  const third = await open(options); const after = await third.project(created.id);
  assert.deepEqual(before.manifest, after.manifest); assert.equal(specCalls, 1);
  await third.resume(created.id, { provider }); await settled(third, created.id);
  assert.equal(specCalls, 1); assert.equal(completed.report.game, 'not_run');
}));

test('invalid external requirement binding fails without paid retry or draft files', { timeout: 15000 }, async () => fixture(async (root, open) => {
  let specCalls = 0;
  const service = await open({ proposeBehavior: async () => { specCalls++; const proposal = behaviorProposal(); proposal.spec.requirementIds = ['invented']; return proposal; } });
  const created = await service.create({ request, provider, workflow: PROJECT_WORKFLOW_ID }), state = await settled(service, created.id);
  assert.equal(specCalls, 1); assert.equal(state.status, 'failed');
  const task = state.tasks.find(item => item.id === 'specify-behavior'); assert.equal(task.attemptCount, 1); assert.equal(task.attempts[0].error.code, 'INVALID_BEHAVIOR_PROPOSAL');
  assert.equal(state.tasks.find(item => item.id === 'generate-adapter-project').attemptCount, 0);
  assert.deepEqual(await readdir(path.join(root, 'project-artifacts/objects')), []);
}));

test('cancelling a late specification response cannot create project artifacts or persist the provider key', { timeout: 15000 }, async () => fixture(async (root, open) => {
  let release, started; const entered = new Promise(resolve => { started = resolve; });
  const late = new Promise(resolve => { release = resolve; });
  const service = await open({ proposeBehavior: async () => { started(); return late; } });
  const created = await service.create({ request, provider, workflow: PROJECT_WORKFLOW_ID }); await entered;
  await service.cancel(created.id); const rejected = behaviorProposal(); rejected.summary = TEST_KEY; release(rejected);
  await new Promise(resolve => setTimeout(resolve, 30)); const state = await service.get(created.id);
  assert.equal(state.status, 'cancelled'); assert.ok(!JSON.stringify(state).includes(TEST_KEY));
  assert.deepEqual(await readdir(path.join(root, 'project-artifacts/objects')), []);
  assert.ok(!(await readFile(path.join(root, 'runs', state.id + '.json'), 'utf8')).includes(TEST_KEY));
}));

test('real local HTTP exposes only the accepted private project archive and blocks unsupported execution APIs', { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-pipeline-http-')), web = path.join(root, 'web'); await mkdir(web); await writeFile(path.join(web, 'index.html'), '<title>contract only</title>');
  const server = createWorkbenchServer({ root: web, workflowRoot: path.join(root, 'state'), apiKey: TEST_KEY, model: provider.model, workflowComplete: complete, workflowProposeBehavior: async () => behaviorProposal() });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  try {
    const config = await (await fetch(base + '/api/config')).json(); assert.equal(config.capabilities.adapterProjectDrafts, true); assert.equal(config.capabilities.gameExecution, false);
    const response = await post('/api/runs', { request, workflow: PROJECT_WORKFLOW_ID, budget: { maxModelCalls: 6 } }); assert.equal(response.status, 202); const created = await response.json();
    let state; for (let n = 0; n < 300; n++) { state = await (await fetch(base + `/api/runs/${created.id}`)).json(); if (!state.observation.active) break; await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(state.status, 'blocked'); const archive = await fetch(base + state.projectDownloadUrl); assert.equal(archive.status, 200); assert.equal(archive.headers.get('content-type'), 'application/zip');
    const bytes = Buffer.from(await archive.arrayBuffer()); assert.equal(bytes.readUInt32LE(0), 0x04034b50); assert.ok(bytes.includes(Buffer.from('HostBridge.g.cs'))); assert.ok(!bytes.includes(Buffer.from(TEST_KEY)));
    assert.equal((await post('/api/execute', { command: 'arbitrary' })).status, 404);
    assert.equal((await post('/api/runs', { request, workflow: 'invented-workflow' })).status, 400);
    const crossOrigin = await fetch(base + state.projectDownloadUrl, { headers: { Origin: 'https://example.net' } }); assert.equal(crossOrigin.status, 403);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); await rm(root, { recursive: true, force: true }); }
});
