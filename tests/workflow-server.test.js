// Real HTTP + file store + scheduler integration. Completions use explicit mock
// JSON responses; no live model, executable game adapter, Mod build or game is run.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { createRunService } from '../src/orchestration/service.mjs';
import { generateAgentArtifact } from '../src/agents/provider.mjs';

const KEY = 'workflow-http-test-key-never-live', MODEL = 'workflow-test-model';
const request = { hostGame: 'Chosen Host', sourceGame: 'Chosen Source', description: '在宿主保留来源动作和交互的完整要求。', contentKinds: ['moveset'] };
function proposal(role, req) {
  if (role === 'requirements') return { schemaVersion: 1, title: '通用协作测试方案', hostGame: req.hostGame, sourceGame: req.sourceGame, summary: '只测试通用任务协作。',
    requirements: [{ id: 'interactions', kind: 'moveset', description: req.description, disposition: 'needs_research', reason: '没有经过验证的接口和资源。' }], assetNeeds: [], interfaceNeeds: [], questions: [], limitations: ['无游戏验收证据。'] };
  if (role === 'independent-validation') return { schemaVersion: 1, summary: '仅检查书面方案。', coverage: [{ requirementId: 'interactions', assessment: 'unclear', reason: '尚无真实接口和运行证据。' }], issues: [], limitations: ['不是构建或游戏验证。'] };
  return { schemaVersion: 1, summary: `通用 ${role} 建议。`, items: [{ id: 'proposal', requirementIds: ['interactions'], description: '保持原始交互要求与未知项。', nextStep: '调查正式接口及可用资源。' }], questions: [], limitations: ['仅未验证的方案。'] };
}
async function mockComplete(role, req, upstream, options) {
  return generateAgentArtifact(role, req, upstream, { ...options, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(proposal(role, req)) } }] })) });
}
async function fixture(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-workflow-http-')), web = path.join(root, 'web'), state = path.join(root, 'state');
  await mkdir(web); await writeFile(path.join(web, 'index.html'), '<!doctype html><title>workflow-control-test-only</title>');
  const servers = [];
  async function start(options = {}) {
    const server = createWorkbenchServer({ root: web, workflowRoot: state, apiKey: KEY, model: MODEL, workflowComplete: mockComplete, ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const entry = { server, base: `http://127.0.0.1:${server.address().port}`, closed: false, async close() {
      if (entry.closed) return; entry.closed = true;
      await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    } };
    servers.push(entry); return entry;
  }
  try { await work({ root, state, start }); }
  finally { for (const server of servers) await server.close(); await rm(root, { recursive: true, force: true }); }
}
function post(base, route, body, extra = {}) {
  return fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...extra.headers }, body: JSON.stringify(body), ...(extra.signal ? { signal: extra.signal } : {}) });
}
async function settled(base, id) {
  for (let i = 0; i < 200; i++) {
    const response = await fetch(`${base}/api/runs/${id}`); assert.equal(response.status, 200);
    const snapshot = await response.json();
    // Persisted status can still be an old blocked snapshot while resume is
    // acquiring its lease. Only the ephemeral observation flag says it settled.
    if (!snapshot.observation.active) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Workflow did not settle within the bounded test observation.');
}
async function waitFor(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('Expected bounded asynchronous worker transition.'); }

test('HTTP run collaborates across five roles, persists artifacts, and keeps game adapters blocked', { timeout: 10000 }, async () => {
  await fixture(async ({ start, state }) => {
    const calls = [], current = await start({ workflowComplete: async (...args) => { calls.push(args[0]); return mockComplete(...args); } });
    const roles = await (await fetch(current.base + '/api/agent-roles')).json();
    assert.equal(roles.roles.length, 5); assert.deepEqual(roles.gameAdapters, []);
    assert.ok(roles.roles.every(role => role.manifest.kind === 'agent' && role.manifest.evidenceScope === 'analysis-only' && role.manifest.targets.length === 0));
    assert.deepEqual(await (await fetch(current.base + '/api/adapters')).json(), []);
    const response = await post(current.base, '/api/runs', { request }); assert.equal(response.status, 202);
    const created = await response.json(), result = await settled(current.base, created.id);
    assert.equal(result.status, 'blocked'); assert.equal(calls.length, 5); assert.equal(result.budget.modelCallsReserved, 5);
    assert.equal(result.context.request.hostGame, request.hostGame); assert.equal(result.context.request.sourceGame, request.sourceGame);
    assert.equal(result.tasks.filter(task => task.result).length, 5);
    for (const task of result.tasks.filter(task => task.result)) assert.equal(task.result.artifact.scope, 'analysis-only');
    for (const id of ['generate-project', 'compile-mod', 'verify-game']) assert.equal(result.tasks.find(task => task.id === id).attemptCount, 0);
    assert.equal(result.report.realModBuild, 'not_run'); assert.equal(result.report.game, 'not_run'); assert.equal(result.report.readyToInstall, false);
    const download = await fetch(`${current.base}/api/runs/${created.id}/download`), text = await download.text();
    assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /gamebridge-workflow-run\.json/);
    assert.ok(!text.includes(KEY)); assert.equal(JSON.parse(text).tasks.filter(task => task.result).length, 5);
    const disk = await readFile(path.join(state, 'runs', created.id + '.json'), 'utf8'); assert.ok(!disk.includes(KEY)); assert.ok(!disk.includes('"observation"'));
    const listing = await (await fetch(current.base + '/api/runs')).json(); assert.equal(listing.runs.length, 1); assert.equal(listing.runs[0].observation.active, false);
  });
});

test('service restart reads without credentials and resumes completed roles without new calls', { timeout: 10000 }, async () => {
  await fixture(async ({ start }) => {
    let calls = 0;
    const first = await start({ workflowComplete: async (...args) => { calls++; return mockComplete(...args); } });
    const created = await (await post(first.base, '/api/runs', { request })).json(); await settled(first.base, created.id); assert.equal(calls, 5); await first.close();
    const reopened = await start({ apiKey: '', workflowComplete: async (...args) => { calls++; return mockComplete(...args); } });
    const config = await (await fetch(reopened.base + '/api/config')).json(); assert.equal(config.providerConfigured, false);
    const read = await fetch(`${reopened.base}/api/runs/${created.id}`); assert.equal(read.status, 200); assert.equal((await read.json()).tasks.filter(task => task.result).length, 5);
    assert.equal((await (await fetch(reopened.base + '/api/runs')).json()).runs.length, 1); assert.equal(calls, 5);
    const missing = await post(reopened.base, `/api/runs/${created.id}/resume`, {}); assert.equal(missing.status, 400); assert.equal((await missing.json()).error.code, 'API_KEY_REQUIRED');
    const response = await post(reopened.base, `/api/runs/${created.id}/resume`, { provider: { apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: MODEL } });
    assert.equal(response.status, 202); await settled(reopened.base, created.id); assert.equal(calls, 5);
  });
});

test('new run API checks host, origin, JSON, budget and provider-origin boundaries before work', { timeout: 10000 }, async () => {
  await fixture(async ({ start }) => {
    let calls = 0, seen;
    const { base, server } = await start({ workflowComplete: async (...args) => { calls++; seen = args[3]; return mockComplete(...args); } });
    const hostStatus = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/runs', headers: { Host: 'attacker.example' } }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); }); req.once('error', reject); req.end();
    }); assert.equal(hostStatus, 403);
    assert.equal((await post(base, '/api/runs', { request }, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    assert.equal((await fetch(base + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
    assert.equal((await post(base, '/api/runs', { request, execute: 'must not execute' })).status, 400);
    assert.equal((await post(base, '/api/runs', { request: { ...request, description: 'x'.repeat(33000) } })).status, 413);
    for (const budget of [{ maxModelCalls: -1 }, { maxModelCalls: 21 }, { maxModelCalls: 1.5 }, { maxModelCalls: '5' }, { maxModelCalls: 5, command: 'no' }]) {
      const response = await post(base, '/api/runs', { request, budget }); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, 'INVALID_RUN_BUDGET');
    }
    const denied = await post(base, '/api/runs', { request, provider: { baseUrl: 'https://other-provider.example' } });
    assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, 'PROVIDER_KEY_REQUIRED_FOR_ORIGIN'); assert.equal(calls, 0);
    const response = await post(base, '/api/runs', { request, provider: { apiKey: 'explicit-workflow-transient-key', baseUrl: 'https://other-provider.example', model: MODEL }, budget: { maxModelCalls: 1 } });
    assert.equal(response.status, 202); const created = await response.json(), result = await settled(base, created.id);
    assert.equal(calls, 1); assert.equal(seen.apiKey, 'explicit-workflow-transient-key'); assert.equal(seen.baseUrl, 'https://other-provider.example');
    assert.ok(!JSON.stringify(result).includes('explicit-workflow-transient-key'));
  });
});

test('resume rejects lower budgets or a changed bound model before reserving more calls', { timeout: 10000 }, async () => {
  await fixture(async ({ start }) => {
    let calls = 0;
    const { base } = await start({ workflowComplete: async (...args) => { calls++; return mockComplete(...args); } });
    const created = await (await post(base, '/api/runs', { request, budget: { maxModelCalls: 1 } })).json(); await settled(base, created.id);
    assert.equal(calls, 1);
    const lower = await post(base, `/api/runs/${created.id}/resume`, { budget: { maxModelCalls: 0 } }); assert.equal(lower.status, 400); assert.equal((await lower.json()).error.code, 'INVALID_RUN_BUDGET');
    const changed = await post(base, `/api/runs/${created.id}/resume`, { provider: { model: 'changed-model' }, budget: { maxModelCalls: 5 } });
    assert.equal(changed.status, 400); assert.equal((await changed.json()).error.code, 'AGENT_PROVIDER_BINDING_MISMATCH');
    const badReplay = await post(base, `/api/runs/${created.id}/resume`, { allowReplay: 'yes' }); assert.equal(badReplay.status, 400);
    const result = await (await fetch(`${base}/api/runs/${created.id}`)).json(); assert.equal(result.budget.modelCallsReserved, 1); assert.equal(calls, 1);
  });
});

test('cancel and explicit resume use the active credential-bearing worker, discard late results and expose active observation', { timeout: 10000 }, async () => {
  await fixture(async ({ start }) => {
    let calls = 0, signal, release, resumedRelease, resumedEntered = false;
    const late = new Promise(resolve => { release = resolve; }), resumed = new Promise(resolve => { resumedRelease = resolve; });
    const prepared = await mockComplete('requirements', request, [], { apiKey: KEY, model: MODEL });
    const { base } = await start({ workflowComplete: async (...args) => {
      calls++; if (calls === 1) { signal = args[3].signal; return late; }
      if (calls === 2) { resumedEntered = true; await resumed; }
      return mockComplete(...args);
    } });
    const response = await post(base, '/api/runs', { request }), created = await response.json(); assert.equal(response.status, 202); await waitFor(() => Boolean(signal));
    const cancelledResponse = await post(base, `/api/runs/${created.id}/cancel`, {}), cancelled = await cancelledResponse.json();
    assert.equal(cancelledResponse.status, 200); assert.equal(cancelled.status, 'cancelled'); assert.equal(signal.aborted, true); assert.equal(cancelled.observation.active, false);
    release(prepared); await new Promise(resolve => setTimeout(resolve, 20));
    const after = await (await fetch(`${base}/api/runs/${created.id}`)).json(); assert.equal(after.revision, cancelled.revision); assert.ok(after.tasks.every(task => !task.result));
    const noReplayResponse = await post(base, `/api/runs/${created.id}/resume`, {}); assert.equal(noReplayResponse.status, 202); await settled(base, created.id); assert.equal(calls, 1);
    const resumeResponse = await post(base, `/api/runs/${created.id}/resume`, { allowReplay: true, budget: { maxModelCalls: 6 } }); assert.equal(resumeResponse.status, 202);
    const observing = await resumeResponse.json(); assert.equal(observing.observation.active, true); await waitFor(() => resumedEntered);
    const active = await (await fetch(`${base}/api/runs/${created.id}`)).json(); assert.equal(active.observation.active, true);
    resumedRelease(); const final = await settled(base, created.id);
    assert.equal(calls, 6); assert.equal(final.budget.modelCallsReserved, 6); assert.equal(final.tasks.filter(task => task.result).length, 5); assert.equal(final.report.game, 'not_run');
  });
});

test('credential-bearing run input and worker output never appear in downloads or snapshots', { timeout: 10000 }, async () => {
  await fixture(async ({ start, state }) => {
    let calls = 0;
    const { base } = await start({ workflowComplete: async (...args) => { calls++; const result = await mockComplete(...args); result.analysis.summary = KEY; return result; } });
    const denied = await post(base, '/api/runs', { request: { ...request, description: KEY } }); assert.equal(denied.status, 502); assert.equal((await denied.json()).error.code, 'CREDENTIAL_IN_REQUEST'); assert.equal(calls, 0);
    const created = await (await post(base, '/api/runs', { request })).json(), result = await settled(base, created.id);
    assert.equal(result.status, 'failed'); assert.equal(result.tasks[0].result, undefined); assert.equal(calls, 1);
    const download = await (await fetch(`${base}/api/runs/${created.id}/download`)).text(), raw = await readFile(path.join(state, 'runs', created.id + '.json'), 'utf8');
    assert.ok(!download.includes(KEY)); assert.ok(!raw.includes(KEY));
  });
});

test('HTTP shutdown checkpoints an active run before reopening the same store without credentials', { timeout: 10000 }, async () => {
  await fixture(async ({ start }) => {
    let calls = 0, signal, release;
    const late = new Promise(resolve => { release = resolve; });
    const prepared = await mockComplete('requirements', request, [], { apiKey: KEY, model: MODEL });
    const first = await start({ workflowComplete: async (...args) => { calls++; signal = args[3].signal; return late; } });
    const created = await (await post(first.base, '/api/runs', { request })).json(); await waitFor(() => Boolean(signal));
    await first.close(); assert.equal(signal.aborted, true);
    const reopened = await start({ apiKey: '', workflowComplete: async () => { calls++; throw new Error('Restart must not execute model work.'); } });
    const response = await fetch(`${reopened.base}/api/runs/${created.id}`); assert.equal(response.status, 200);
    const snapshot = await response.json(); assert.ok(['cancelled', 'interrupted'].includes(snapshot.status));
    assert.equal(snapshot.observation.active, false); assert.equal(snapshot.budget.modelCallsReserved, 1); assert.ok(snapshot.tasks.every(task => !task.result));
    release(prepared); await new Promise(resolve => setTimeout(resolve, 20));
    const after = await (await fetch(`${reopened.base}/api/runs/${created.id}`)).json(); assert.equal(after.revision, snapshot.revision); assert.equal(calls, 1);
  });
});

test('closing a service while resume awaits its prior snapshot cannot launch new workers', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-workflow-close-test-')); let service;
  try {
    let calls = 0;
    service = await createRunService({ root, complete: async (...args) => { calls++; return mockComplete(...args); } });
    const provider = { apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: MODEL };
    const created = await service.create({ request, provider, budget: { maxModelCalls: 0 } });
    await waitFor(() => service.activeCount === 0); assert.equal(calls, 0);
    const pending = service.resume(created.id, { provider, budget: { maxModelCalls: 5 } });
    const caught = pending.then(value => ({ value }), error => ({ error }));
    await service.close(); const result = await caught;
    await service.close();
    assert.equal(result.error?.code, 'RUN_SERVICE_CLOSED'); assert.equal(service.activeCount, 0); assert.equal(calls, 0);
  } finally { await service?.close(); await rm(root, { recursive: true, force: true }); }
});
