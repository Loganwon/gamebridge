import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { createActionExample, serializeActionProposal } from '../src/actions/spec.mjs';

const ENV_KEY = 'sk-action-http-environment-test';
const TRANSIENT_KEY = 'sk-action-http-transient-test';
const MISSING_ID = '00000000-0000-0000-0000-000000000000';
function example() {
  const { request, blueprint } = createActionExample();
  return { request, proposal: serializeActionProposal(blueprint) };
}
async function fixture(options, run) {
  const server = createWorkbenchServer({ apiKey: '', ...options });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data = {}, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
  try { await run({ base, post }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

test('project-owned action examples, simulations and downloads remain visibly separate from model or game success', async () => {
  let calls = 0;
  await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async () => { calls++; throw new Error('must not call'); } }, async ({ base, post }) => {
    const catalogResponse = await fetch(base + '/api/action-hosts');
    assert.equal(catalogResponse.status, 200);
    const catalog = await catalogResponse.json();
    assert.ok(catalog.every(host => host.status !== 'supported' && host.verifiedCapabilities.length === 0));
    for (const variant of ['hit-confirm', 'free-chain', 'committed-attack']) {
      const response = await post('/api/action-example', { variant });
      assert.equal(response.status, 200);
      const entry = await response.json();
      assert.equal(entry.report.provenance, 'project-example');
      assert.equal(entry.report.modelCalls, 0);
      assert.equal(entry.report.model, null);
      assert.equal(entry.hostAssessment.status, 'blocked');
      assert.equal(entry.report.readyToInstall, false);
      assert.equal(entry.report.realModBuild, 'not_run');
      assert.equal(entry.report.game, 'not_run');
      const simulationResponse = await post(`/api/action-plans/${entry.id}/simulate`);
      assert.equal(simulationResponse.status, 200);
      const simulation = await simulationResponse.json();
      assert.equal(simulation.scope, 'action-rules-simulation-only');
      assert.equal(simulation.provenance, 'project-example');
      assert.ok(simulation.simulations.length >= 3);
      for (const { result } of simulation.simulations) {
        assert.ok(Array.isArray(result.trace));
        assert.equal(result.scope, 'action-rules-simulation-only');
        assert.equal(result.realModBuild, 'not_run');
        assert.equal(result.game, 'not_run');
        assert.equal(result.readyToInstall, false);
      }
      const download = await fetch(`${base}/api/action-plans/${entry.id}/download`);
      assert.equal(download.status, 200);
      assert.match(download.headers.get('content-type'), /application\/json/);
      assert.match(download.headers.get('content-disposition'), /action-design\.json/);
      const text = await download.text();
      assert.ok(!text.includes(ENV_KEY));
      const saved = JSON.parse(text);
      assert.equal(saved.id, entry.id);
      assert.equal(saved.report.provenance, 'project-example');
      assert.equal(saved.blueprint.game, 'not_run');
    }
    assert.equal(calls, 0);
  });
});

test('HTTP action analysis uses one configured generator and preserves unknown host blockers in the download', async () => {
  let calls = 0;
  await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async (request, options) => {
    calls++;
    assert.equal(options.apiKey, TRANSIENT_KEY);
    assert.ok(options.signal instanceof AbortSignal);
    const { proposal } = example();
    proposal.hostGame = request.hostGame;
    proposal.sourceGame = request.sourceGame;
    return proposal;
  } }, async ({ base, post }) => {
    const { request } = example(); request.hostGame = 'unknown-action-host';
    const response = await post('/api/action-plans', { request, provider: { apiKey: TRANSIENT_KEY } });
    assert.equal(response.status, 200, await response.clone().text());
    const entry = await response.json();
    assert.deepEqual(entry.blueprint.originalRequest, request);
    assert.equal(entry.report.provenance, 'model');
    assert.equal(entry.report.modelCalls, 1);
    assert.equal(entry.report.completeRequirementCoverage, false);
    assert.equal(entry.report.sourceFidelityVerified, false);
    assert.equal(entry.hostAssessment.status, 'blocked');
    assert.ok(entry.hostAssessment.blockers.some(item => item.code === 'HOST_UNKNOWN'));
    const savedText = await (await fetch(`${base}/api/action-plans/${entry.id}/download`)).text();
    assert.ok(!savedText.includes(ENV_KEY));
    assert.ok(!savedText.includes(TRANSIENT_KEY));
    assert.equal(JSON.parse(savedText).report.readyToInstall, false);
    assert.equal(calls, 1);
  });
});

test('action endpoints reject missing credentials, cross-origin requests, non-JSON bodies and oversized inputs before model work', async () => {
  let calls = 0;
  await fixture({ actionPlanGenerator: async () => { calls++; return example().proposal; } }, async ({ post }) => {
    const { request } = example();
    assert.equal((await post('/api/action-plans', { request })).status, 400);
    assert.equal((await post('/api/action-plans', { request, provider: { apiKey: TRANSIENT_KEY } }, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await post('/api/action-example', {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await post('/api/action-plans', { request, padding: 'x'.repeat(100000) })).status, 413);
    assert.equal((await post('/api/action-example', { variant: 'unsupported-example' })).status, 422);
    assert.equal(calls, 0);
  });
});

test('action requests containing either configured credential are stopped without sending them to a model', async () => {
  let calls = 0;
  await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async () => { calls++; return example().proposal; } }, async ({ post }) => {
    for (const secret of [ENV_KEY, TRANSIENT_KEY]) {
      const { request } = example(); request.description += ` accidental key ${secret}`;
      const response = await post('/api/action-plans', { request, provider: { apiKey: TRANSIENT_KEY } });
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.ok(!text.includes(ENV_KEY));
      assert.ok(!text.includes(TRANSIENT_KEY));
      assert.ok(!Object.hasOwn(JSON.parse(text), 'id'));
    }
    assert.equal(calls, 0);
  });
});

test('action generator credential echoes are rejected before a downloadable design is saved', async () => {
  for (const secret of [ENV_KEY, TRANSIENT_KEY]) {
    await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async () => {
      const { proposal } = example(); proposal.limitations.push(`echo ${secret}`); return proposal;
    } }, async ({ base, post }) => {
      const response = await post('/api/action-plans', { request: example().request, provider: { apiKey: TRANSIENT_KEY } });
      assert.equal(response.status, 502);
      const text = await response.text();
      assert.ok(!text.includes(ENV_KEY)); assert.ok(!text.includes(TRANSIENT_KEY));
      const error = JSON.parse(text); assert.equal(error.error.code, 'CREDENTIAL_IN_RESPONSE');
      assert.ok(!Object.hasOwn(error, 'id'));
      assert.equal((await fetch(`${base}/api/action-plans/${MISSING_ID}/download`)).status, 404);
    });
  }
});

test('invalid injected action models do not publish designs and cannot smuggle extra executable fields', async () => {
  for (const output of [null, { nonsense: 'not-a-blueprint' }, (() => {
    const { proposal } = example(); proposal.actions[0].transitions[0].to = 'unknown-target'; return proposal;
  })(), (() => {
    const { proposal } = example(); proposal.execute = 'not-allowed'; return proposal;
  })()]) {
    await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async () => output }, async ({ post }) => {
      const response = await post('/api/action-plans', { request: example().request });
      assert.equal(response.status, 422);
      const value = await response.json();
      assert.equal(value.error.code, 'INVALID_ACTION_BLUEPRINT');
      assert.ok(!Object.hasOwn(value, 'id'));
      assert.ok(!Object.hasOwn(value, 'blueprint'));
    });
  }
});

test('injected claims about local success cannot promote a rule design into a tested game Mod', async () => {
  await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async () => {
    const { request, proposal } = example();
    return { ...proposal, originalRequest: request, scope: 'fully-playable', sourceVerification: 'passed', realModBuild: 'passed', game: 'passed', readyToInstall: true,
      coverage: { semanticCoverage: 'passed', requiredCount: 0, unresolvedIds: [] } };
  } }, async ({ base, post }) => {
    const response = await post('/api/action-plans', { request: example().request });
    assert.equal(response.status, 422, await response.clone().text());
    const rejected = await response.json();
    assert.equal(rejected.error.code, 'INVALID_ACTION_BLUEPRINT');
    assert.ok(!Object.hasOwn(rejected, 'id'));
    assert.ok(!Object.hasOwn(rejected, 'blueprint'));
    assert.equal((await fetch(`${base}/api/action-plans/${MISSING_ID}/download`)).status, 404);
  });
});

test('disconnected action requests discard a late generator result before validation or publication', async () => {
  let calls = 0;
  let markStarted;
  let release;
  let providerSignal;
  let lateResultReads = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const { request, proposal } = example();
  const lateProposal = new Proxy(proposal, {
    // Promise resolution only checks `then`; ownKeys observes actual subsequent
    // serialization/validation without patching clocks, maps or other globals.
    ownKeys(target) { lateResultReads++; return Reflect.ownKeys(target); },
  });
  await fixture({ apiKey: ENV_KEY, actionPlanGenerator: async (_request, options) => {
    calls++;
    if (calls > 1) return example().proposal;
    providerSignal = options.signal;
    markStarted();
    await new Promise(resolve => { release = resolve; });
    // Deliberately ignore the signal, simulating an uncooperative late provider.
    return lateProposal;
  } }, async ({ base, post }) => {
    const controller = new AbortController();
    const pending = fetch(base + '/api/action-plans', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request }), signal: controller.signal,
    });
    // Register the rejection before aborting so this test cannot leak a rejection.
    const cancelled = assert.rejects(pending, { name: 'AbortError' });
    await started;
    const observedAbort = once(providerSignal, 'abort');
    controller.abort();
    await observedAbort;
    assert.equal(providerSignal.aborted, true);
    release();
    await cancelled;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateResultReads, 0, 'cancelled results must not reach validation, host assessment or persistence');

    const next = await post('/api/action-plans', { request });
    assert.equal(next.status, 200, await next.clone().text());
    const entry = await next.json();
    assert.equal(entry.report.modelCalls, 1);
    assert.equal(entry.report.readyToInstall, false);
    assert.equal(calls, 2);
  });
});

test('accidental configured credentials in simulation metadata are rejected without echoing them', async () => {
  await fixture({ apiKey: ENV_KEY }, async ({ post }) => {
    const entry = await (await post('/api/action-example')).json();
    const response = await post(`/api/action-plans/${entry.id}/simulate`, {
      scenario: { name: `accidental credential ${ENV_KEY}`, durationTicks: 10, events: [] },
    });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.ok(!text.includes(ENV_KEY));
    assert.equal(JSON.parse(text).error.code, 'CREDENTIAL_IN_RESPONSE');
  });
});

test('malformed explicit scenarios are rejected rather than silently replaced with the default scenarios', async () => {
  await fixture({}, async ({ post }) => {
    const entry = await (await post('/api/action-example')).json();
    const route = `/api/action-plans/${entry.id}/simulate`;
    const invalidScenarios = [null, false, 0, '', {},
      { durationTicks: 3601, events: [] },
      { durationTicks: 5, events: [{ tick: 2, type: 'input', input: 'attack' }, { tick: 1, type: 'hurt' }] },
      { durationTicks: 5, events: [{ tick: 0, type: 'shell', input: 'execute' }] },
    ];
    for (const scenario of invalidScenarios) {
      const response = await post(route, { scenario });
      assert.equal(response.status, 400, `invalid scenario must fail: ${JSON.stringify(scenario)}`);
      const value = await response.json();
      assert.equal(value.error.code, 'INVALID_ACTION_SCENARIO');
      assert.ok(!Object.hasOwn(value, 'simulations'));
    }
    const valid = await post(route, { scenario: { name: 'explicit scenario', durationTicks: 10, events: [{ tick: 0, type: 'input', input: 'attack' }] } });
    assert.equal(valid.status, 200);
    const result = await valid.json();
    assert.equal(result.simulations.length, 1);
    assert.equal(result.simulations[0].result.name, 'explicit scenario');
    assert.equal(result.game, 'not_run');
  });
});

test('unknown or malformed action design IDs never resolve a simulation or download', async () => {
  await fixture({}, async ({ base, post }) => {
    assert.equal((await post(`/api/action-plans/${MISSING_ID}/simulate`)).status, 404);
    assert.equal((await fetch(`${base}/api/action-plans/${MISSING_ID}/download`)).status, 404);
    assert.equal((await post('/api/action-plans/not-an-id/simulate')).status, 404);
    assert.equal((await fetch(base + '/api/action-plans/not-an-id/download')).status, 404);
  });
});
