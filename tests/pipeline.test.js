import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createPipeline } from '../src/pipeline.mjs';
import { createExamplePlan } from '../src/ai/plan.mjs';
import { generateProject } from '../src/generator/smapi.mjs';

// These tests simulate compiler and provider boundaries. No assertion here is
// evidence that a Mod compiled against real game assemblies or ran in a game.
const KEY = 'sk-pipeline-test-credential';
const provider = {apiKey: KEY, baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash'};
const ready = () => ({ready: true, dotnet: {available: true, version: 'simulated-sdk'}, game: {available: true, missing: []}, issues: []});
const source = generateProject(createExamplePlan()).files.find(file => file.path === 'ModEntry.cs').content;
const proposal = (revision = 0) => ({files: [{path: 'ModEntry.cs', content: source + '\n// Simulated provider revision ' + revision + '\n'}], summary: 'Simulated response for pipeline control-flow verification.'});
const csFailure = (message = 'Simulated C# diagnostic.') => ({status: 'failed', repairable: true, diagnostics: [{code: 'CS0103', severity: 'error', message, file: 'ModEntry.cs', line: 20}], artifacts: []});
const compiled = () => ({status: 'passed', repairable: false, diagnostics: [], artifacts: [{path: 'GameBridge.Generated.dll', data: Buffer.from('SIMULATED ARTIFACT — NOT A GAME DLL')}]});
const terminalStatuses = new Set(['generated', 'passed', 'failed', 'blocked', 'cancelled']);
async function waitFor(predicate, message = 'pipeline did not settle') {
  const end = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < end, message);
    await delay(2);
  }
}
async function settled(pipeline, id) {
  await waitFor(() => pipeline.activeCount === 0 && terminalStatuses.has(pipeline.get(id).status));
  return pipeline.get(id);
}
function start(pipeline, overrides = {}) {
  return pipeline.start({plan: createExamplePlan(), provenance: 'example', provider, maxRepairs: 1, ...overrides});
}
function noCredential(value, secret = KEY) {
  assert.ok(!JSON.stringify(value).includes(JSON.stringify(secret).slice(1, -1)), 'public job data must not retain a credential');
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

test('missing build environment blocks the pipeline before any paid provider call', async () => {
  let generated = 0, repaired = 0, compiledCount = 0;
  const pipeline = createPipeline({
    inspect: async () => ({ready: false, dotnet: {available: false}, game: {available: false, missing: ['Stardew Valley.dll']}, issues: [{code: 'SDK_REQUIRED', message: 'Install the SDK.'}]}),
    generate: async () => { generated++; return proposal(); },
    repair: async () => { repaired++; return proposal(1); },
    compile: async () => { compiledCount++; return compiled(); },
  });
  const job = await settled(pipeline, start(pipeline).id);
  assert.equal(job.status, 'blocked');
  assert.equal(job.error.code, 'ENVIRONMENT_REQUIRED');
  assert.equal(job.modelCalls, 0);
  assert.equal(job.report.build, 'not_run');
  assert.equal(job.report.game, 'not_run');
  assert.equal(job.project, undefined);
  assert.deepEqual([generated, repaired, compiledCount], [0, 0, 0]);
  noCredential(job);
});

test('generated source can fail compilation, receive one repair, and pass a simulated compiler without claiming game validation', async () => {
  const order = [], revision = proposal(1);
  let builds = 0;
  const pipeline = createPipeline({
    inspect: async () => { order.push('inspect'); return ready(); },
    generate: async ({plan, files}, options) => {
      order.push('generate'); assert.equal(options.apiKey, KEY);
      assert.equal(plan.hostGame, 'stardew-valley');
      assert.equal(files.find(file => file.path === 'ModEntry.cs').content, source);
      return proposal();
    },
    compile: async ({files}) => {
      order.push('compile'); builds++;
      assert.equal(files.find(file => file.path === 'ModEntry.cs').content, builds === 1 ? proposal().files[0].content : revision.files[0].content);
      return builds === 1 ? csFailure() : compiled();
    },
    repair: async ({plan, files, diagnostics, attempt}, options) => {
      order.push('repair'); assert.equal(attempt, 1); assert.equal(options.apiKey, KEY);
      assert.equal(plan.sourceGame, 'terraria'); assert.equal(diagnostics[0].code, 'CS0103');
      assert.equal(files.find(file => file.path === 'ModEntry.cs').content, proposal().files[0].content);
      return revision;
    },
  });
  const originalPlan = createExamplePlan();
  const job = await settled(pipeline, start(pipeline, {plan: originalPlan}).id);
  assert.deepEqual(order, ['inspect', 'generate', 'compile', 'repair', 'compile']);
  assert.equal(job.status, 'passed');
  assert.equal(job.modelCalls, 2); assert.equal(job.maxModelCalls, 2);
  assert.deepEqual(job.attempts.map(attempt => [attempt.attempt, attempt.status]), [[0, 'failed'], [1, 'passed']]);
  assert.equal(job.report.build, 'passed'); assert.equal(job.report.game, 'not_run');
  assert.equal(job.report.readyToInstall, false);
  assert.equal(job.project.report.game, 'not_run');
  assert.equal(job.project.report.completeRequirementCoverage, false);
  assert.equal(job.project.report.codeProvenance, 'model');
  assert.equal(job.project.report.provenance, 'example');
  assert.deepEqual(JSON.parse(job.project.files.find(file => file.path === 'plan.json').content), originalPlan);
  const metadata = JSON.parse(job.project.files.find(file => file.path === 'generation.json').content);
  assert.equal(metadata.codeProvenance, 'model'); assert.equal(metadata.build, 'passed'); assert.equal(metadata.game, 'not_run');
  noCredential(job);
});

test('the two-repair cap permits at most three model calls and three simulated compilations', async () => {
  let repairs = 0, builds = 0;
  const pipeline = createPipeline({
    inspect: async () => ready(), generate: async () => proposal(),
    compile: async () => csFailure('Different simulated diagnostic ' + (++builds)),
    repair: async ({attempt}) => { repairs++; assert.equal(attempt, repairs); return proposal(repairs); },
  });
  const job = await settled(pipeline, start(pipeline, {maxRepairs: 2}).id);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'REPAIR_LIMIT');
  assert.equal(job.modelCalls, 3); assert.equal(job.maxModelCalls, 3);
  assert.equal(repairs, 2); assert.equal(builds, 3); assert.equal(job.attempts.length, 3);
  assert.equal(job.report.build, 'failed'); assert.equal(job.report.game, 'not_run');
  assert.ok(job.project.files.some(file => file.path === 'ModEntry.cs'));
  assert.equal(job.project.report.readyToInstall, false);
});

test('zero repair budget publishes the failed source without a repair call', async () => {
  let repairs = 0;
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => csFailure(), repair: async () => { repairs++; return proposal(1); }});
  const job = await settled(pipeline, start(pipeline, {maxRepairs: 0}).id);
  assert.equal(job.error.code, 'REPAIR_LIMIT'); assert.equal(job.modelCalls, 1); assert.equal(repairs, 0);
  assert.equal(job.attempts.length, 1); assert.equal(job.project.report.build, 'failed');
});

test('unchanged repaired source stops the loop before another compilation or fee', async () => {
  let repairs = 0, builds = 0;
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => { builds++; return csFailure(); }, repair: async () => { repairs++; return proposal(); }});
  const job = await settled(pipeline, start(pipeline, {maxRepairs: 2}).id);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'UNCHANGED_REPAIR');
  assert.equal(job.modelCalls, 2); assert.equal(repairs, 1); assert.equal(builds, 1);
  assert.equal(job.project.files.find(file => file.path === 'ModEntry.cs').content, proposal().files[0].content);
  assert.equal(job.project.report.build, 'failed');
});

test('repeated compiler errors stop further repairs even when source text changed', async () => {
  let repairs = 0, builds = 0;
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => { builds++; return csFailure('Repeated simulated error.'); }, repair: async () => { repairs++; return proposal(repairs); }});
  const job = await settled(pipeline, start(pipeline, {maxRepairs: 2}).id);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'REPEATED_COMPILER_ERRORS');
  assert.equal(job.modelCalls, 2); assert.equal(repairs, 1); assert.equal(builds, 2);
  assert.equal(job.project.report.game, 'not_run');
});

test('non-C# infrastructure failures and lost build prerequisites do not trigger model repairs', async () => {
  for (const build of [
    {status: 'failed', repairable: false, diagnostics: [{code: 'NU1301', severity: 'error', message: 'Simulated package restore failure.'}], artifacts: []},
    {status: 'blocked', repairable: false, diagnostics: [{code: 'GAME_REFERENCES_REQUIRED', severity: 'error', message: 'Simulated missing game references.'}], artifacts: []},
  ]) {
    let repairs = 0;
    const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => build, repair: async () => { repairs++; return proposal(1); }});
    const job = await settled(pipeline, start(pipeline, {maxRepairs: 2}).id);
    assert.equal(job.status, build.status); assert.equal(job.error.code, 'BUILD_NOT_REPAIRABLE');
    assert.equal(job.modelCalls, 1); assert.equal(repairs, 0);
    assert.equal(job.report.build, build.status === 'blocked' ? 'not_run' : 'failed');
    assert.equal(job.report.game, 'not_run');
  }
});

test('cancellation during preflight prevents the first paid call', async () => {
  const gate = deferred(); let generated = 0;
  const pipeline = createPipeline({inspect: async () => gate.promise, generate: async () => { generated++; return proposal(); }});
  const initial = start(pipeline);
  await waitFor(() => pipeline.get(initial.id).events.some(event => event.stage === 'environment'));
  pipeline.cancel(initial.id); gate.resolve(ready());
  const job = await settled(pipeline, initial.id);
  assert.equal(job.status, 'cancelled'); assert.equal(generated, 0); assert.equal(job.modelCalls, 0);
  assert.equal(job.report.game, 'not_run'); assert.equal(job.project, undefined);
});

test('cancellation while a simulated provider is pending discards its result and starts no compilation', async () => {
  const gate = deferred(); let compiledCount = 0, repairs = 0;
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => gate.promise, compile: async () => { compiledCount++; return compiled(); }, repair: async () => { repairs++; return proposal(1); }});
  const initial = start(pipeline);
  await waitFor(() => pipeline.get(initial.id).status === 'generating');
  pipeline.cancel(initial.id); gate.resolve(proposal());
  const job = await settled(pipeline, initial.id);
  assert.equal(job.status, 'cancelled'); assert.equal(job.modelCalls, 1);
  assert.equal(compiledCount, 0); assert.equal(repairs, 0); assert.equal(job.project, undefined);
  noCredential(job);
});

test('cancellation before compilation returns a failure prevents the next repair call', async () => {
  const gate = deferred(); let repairs = 0;
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => gate.promise, repair: async () => { repairs++; return proposal(1); }});
  const initial = start(pipeline);
  await waitFor(() => pipeline.get(initial.id).status === 'compiling');
  pipeline.cancel(initial.id); gate.resolve(csFailure());
  const job = await settled(pipeline, initial.id);
  assert.equal(job.status, 'cancelled'); assert.equal(job.modelCalls, 1); assert.equal(repairs, 0);
  assert.equal(job.report.game, 'not_run'); assert.equal(job.project, undefined);
});

test('credentials echoed in successful model text or diagnostics are discarded from public jobs and downloads', async () => {
  const extraSecret = 'sk-environment-canary';
  for (const location of ['source', 'diagnostic']) {
    let published = 0;
    const pipeline = createPipeline({
      inspect: async () => ready(),
      generate: async () => location === 'source' ? {...proposal(), summary: 'Unexpected credential ' + KEY} : proposal(),
      compile: async () => ({...csFailure(), diagnostics: [{code: 'CS0103', severity: 'error', message: 'Unexpected echo ' + extraSecret}]}),
      publishProject: async value => { published++; return value; },
    });
    const job = await settled(pipeline, start(pipeline, {secrets: [extraSecret]}).id);
    assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'CREDENTIAL_IN_RESPONSE');
    assert.equal(job.project, undefined); assert.equal(published, 0);
    noCredential(job); noCredential(job, extraSecret);
  }
});

test('provider exceptions redact credentials while invalid initial code never falls back to an AI-labelled template', async () => {
  for (const generate of [
    async () => { throw new Error('Simulated provider exception ' + KEY); },
    async () => ({files: [{path: 'ModEntry.cs', content: 'Process.Start("invalid");'}], summary: 'Invalid simulated source.'}),
  ]) {
    let published = 0, builds = 0;
    const pipeline = createPipeline({inspect: async () => ready(), generate, compile: async () => { builds++; return compiled(); }, publishProject: async value => { published++; return value; }});
    const job = await settled(pipeline, start(pipeline).id);
    assert.equal(job.status, 'failed'); assert.equal(job.report.build, 'not_run'); assert.equal(job.report.game, 'not_run');
    assert.equal(job.modelCalls, 1); assert.equal(builds, 0); assert.equal(published, 0); assert.equal(job.project, undefined);
    noCredential(job);
  }
});

test('a claimed successful compile without the expected DLL cannot become a passed job', async () => {
  const pipeline = createPipeline({inspect: async () => ready(), generate: async () => proposal(), compile: async () => ({status: 'passed', diagnostics: [], artifacts: []})});
  const job = await settled(pipeline, start(pipeline).id);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'MISSING_BUILD_ARTIFACT');
  assert.notEqual(job.report.build, 'passed'); assert.equal(job.report.game, 'not_run');
  assert.equal(job.project.report.readyToInstall, false);
});

test('invalid repair budgets and missing credentials are rejected synchronously without starting a task', () => {
  let inspected = 0;
  const pipeline = createPipeline({inspect: async () => { inspected++; return ready(); }});
  for (const maxRepairs of [-1, 3, 1.5, '1']) assert.throws(() => start(pipeline, {maxRepairs}), error => error.code === 'INVALID_REPAIR_LIMIT');
  assert.throws(() => start(pipeline, {provider: {apiKey: ''}}), error => error.code === 'API_KEY_REQUIRED');
  assert.equal(pipeline.activeCount, 0); assert.equal(inspected, 0);
});


test('source-only mode generates one model source draft without SDK/game inspection, compilation, or repairs', async () => {
  let generated = 0, inspected = 0, builds = 0, repairs = 0;
  const pipeline = createPipeline({
    inspect: async () => { inspected++; throw new Error('Source-only mode must not require game prerequisites.'); },
    generate: async () => { generated++; return proposal(); },
    compile: async () => { builds++; return compiled(); },
    repair: async () => { repairs++; return proposal(1); },
  });
  const job = await settled(pipeline, start(pipeline, {mode: 'source', maxRepairs: 0}).id);
  assert.equal(job.status, 'generated');
  assert.deepEqual([generated, inspected, builds, repairs], [1, 0, 0, 0]);
  assert.equal(job.modelCalls, 1); assert.equal(job.maxModelCalls, 1);
  assert.equal(job.attempts.length, 0);
  assert.equal(job.report.build, 'not_run'); assert.equal(job.report.game, 'not_run');
  assert.equal(job.report.readyToInstall, false);
  assert.equal(job.project.report.artifact, 'source-draft');
  assert.equal(job.project.report.build, 'not_run'); assert.equal(job.project.report.game, 'not_run');
  assert.equal(job.project.report.codeProvenance, 'model');
  assert.equal(job.project.report.completeRequirementCoverage, false);
  assert.equal(job.project.files.find(file => file.path === 'ModEntry.cs').content, proposal().files[0].content);
  const metadata = JSON.parse(job.project.files.find(file => file.path === 'generation.json').content);
  assert.equal(metadata.modelCalls, 1); assert.equal(metadata.build, 'not_run'); assert.equal(metadata.game, 'not_run');
  noCredential(job);
});

test('source-only mode rejects invalid model source instead of publishing a fixed-template fallback', async () => {
  let published = 0, inspected = 0;
  const pipeline = createPipeline({
    inspect: async () => { inspected++; return ready(); },
    generate: async () => ({files: [{path: 'ModEntry.cs', content: 'Process.Start("invalid");'}], summary: 'Invalid simulated source.'}),
    publishProject: async value => { published++; return value; },
  });
  const job = await settled(pipeline, start(pipeline, {mode: 'source', maxRepairs: 0}).id);
  assert.equal(job.status, 'failed'); assert.equal(job.error.code, 'INVALID_CODE');
  assert.equal(job.modelCalls, 1); assert.equal(inspected, 0); assert.equal(published, 0);
  assert.equal(job.project, undefined); assert.equal(job.attempts.length, 0);
  assert.equal(job.report.build, 'not_run'); assert.equal(job.report.game, 'not_run');
  noCredential(job);
});

test('cancelling source-only generation discards a late provider result and starts no build or repair', async () => {
  const gate = deferred(); let builds = 0, repairs = 0;
  const pipeline = createPipeline({
    inspect: async () => ready(), generate: async () => gate.promise,
    compile: async () => { builds++; return compiled(); },
    repair: async () => { repairs++; return proposal(1); },
  });
  const initial = start(pipeline, {mode: 'source', maxRepairs: 0});
  await waitFor(() => pipeline.get(initial.id).status === 'generating');
  pipeline.cancel(initial.id); gate.resolve(proposal());
  const job = await settled(pipeline, initial.id);
  assert.equal(job.status, 'cancelled'); assert.equal(job.modelCalls, 1);
  assert.equal(builds, 0); assert.equal(repairs, 0); assert.equal(job.project, undefined);
  assert.equal(job.report.build, 'not_run'); assert.equal(job.report.game, 'not_run');
  noCredential(job);
});

test('source and compiled jobs become terminal only after the downloadable project is published', async () => {
  for (const mode of ['source', 'build']) {
    const gate = deferred(); let publishing;
    const pipeline = createPipeline({
      inspect: async () => ready(), generate: async () => proposal(), compile: async () => compiled(),
      publishProject: async project => { publishing = project; await gate.promise; return project; },
    });
    const initial = start(pipeline, {mode});
    await waitFor(() => Boolean(publishing));
    const pending = pipeline.get(initial.id);
    assert.ok(!terminalStatuses.has(pending.status), 'polling must continue while the project is being published');
    assert.equal(pending.project, undefined);
    assert.equal(publishing.report.status, mode === 'source' ? 'source_generated' : 'build_passed');
    gate.resolve();
    const job = await settled(pipeline, initial.id);
    assert.equal(job.status, mode === 'source' ? 'generated' : 'passed');
    assert.ok(job.project);
    assert.equal(job.project.report.build, mode === 'source' ? 'not_run' : 'passed');
  }
});

test('failed or blocked builds publish retained source before the polling terminal state', async () => {
  for (const build of [csFailure(), {status: 'blocked', repairable: false, diagnostics: [{code: 'BUILD_TIMEOUT', severity: 'error', message: 'Simulated timeout.'}], artifacts: []}]) {
    const gate = deferred(); let publishing;
    const pipeline = createPipeline({
      inspect: async () => ready(), generate: async () => proposal(), compile: async () => build,
      publishProject: async project => { publishing = project; await gate.promise; return project; },
    });
    const initial = start(pipeline, {maxRepairs: 0});
    await waitFor(() => Boolean(publishing));
    assert.ok(!terminalStatuses.has(pipeline.get(initial.id).status));
    assert.equal(pipeline.get(initial.id).project, undefined);
    gate.resolve();
    const job = await settled(pipeline, initial.id);
    assert.equal(job.status, build.status);
    assert.ok(job.project);
    assert.equal(job.project.report.readyToInstall, false);
  }
});

test('a failed repair publishes the last accepted source before exposing the failed terminal state', async () => {
  const gate = deferred(); let publishing;
  const pipeline = createPipeline({
    inspect: async () => ready(), generate: async () => proposal(), compile: async () => csFailure(),
    repair: async () => { throw new Error('Simulated repair provider error.'); },
    publishProject: async project => { publishing = project; await gate.promise; return project; },
  });
  const initial = start(pipeline);
  await waitFor(() => Boolean(publishing));
  assert.ok(!terminalStatuses.has(pipeline.get(initial.id).status));
  gate.resolve();
  const job = await settled(pipeline, initial.id);
  assert.equal(job.status, 'failed');
  assert.ok(job.project);
  assert.equal(job.project.files.find(file => file.path === 'ModEntry.cs').content, proposal().files[0].content);
});

test('cancellation while publishing discards late source and compiled package results', async () => {
  for (const mode of ['source', 'build']) {
    const gate = deferred(); let publishing;
    const pipeline = createPipeline({
      inspect: async () => ready(), generate: async () => proposal(), compile: async () => compiled(),
      publishProject: async project => { publishing = project; await gate.promise; return project; },
    });
    const initial = start(pipeline, {mode});
    await waitFor(() => Boolean(publishing));
    assert.equal(pipeline.cancel(initial.id).status, 'cancelled');
    gate.resolve();
    const job = await settled(pipeline, initial.id);
    assert.equal(job.status, 'cancelled');
    assert.equal(job.project, undefined);
    assert.equal(job.report.game, 'not_run');
  }
});
