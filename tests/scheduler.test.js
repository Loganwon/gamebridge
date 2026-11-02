// These are orchestration contract tests. No model API, compiler or game is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createAdapterRegistry } from '../src/adapters/registry.mjs';
import { createRunStore } from '../src/orchestration/store.mjs';
import { createScheduler } from '../src/orchestration/scheduler.mjs';

function manifest(cost = 0) { return { schemaVersion: 1, id: 'contract.analyzer', version: '1.0.0', kind: 'agent', role: 'requirements', targets: [], contentKinds: [],
  capabilities: [{ id: 'agent.requirements.analysis', operation: 'analyze', outputTypes: ['test.contract'] }], allowedOperations: ['analyze'],
  execution: { sideEffects: 'none', idempotent: cost === 0, modelCallsPerAttempt: cost }, evidenceScope: 'contract-test-only', references: [], limitations: ['Orchestration contract fixture only.'], resourceLimits: { maxInputBytes: 131072, maxOutputBytes: 65536, timeoutMs: 2000 } }; }
function task(id, dependsOn = [], overrides = {}) { return { id, kind: 'analysis', role: 'requirements', dependsOn, requirementIds: [], inputRefs: dependsOn.map(value => 'task:' + value), outputTypes: ['test.contract'], requiredCapabilities: ['agent.requirements.analysis'], acceptanceCriteria: ['Return contract data only.'], timeoutMs: 1000, retryPolicy: { maxAttempts: 2, retryableCodes: ['TRANSIENT'], replaySafe: false }, ...overrides }; }
async function fixture(handler, fn, { cost = 0, secrets = [] } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-scheduler-'));
  let scheduler;
  try {
    const store = await createRunStore({ root: dir, secrets }), registry = createAdapterRegistry();
    if (handler) registry.register(manifest(cost), { analyze: handler });
    scheduler = createScheduler({ store, registry, maxConcurrency: 2, secrets });
    await fn({ dir, store, registry, scheduler });
  } finally { await scheduler?.close(); await rm(dir, { recursive: true, force: true }); }
}

test('dependency scheduling runs independent tasks concurrently and checkpoints accepted typed results', async () => {
  let active = 0, peak = 0; const calls = [];
  let release; const bothStarted = new Promise(resolve => { release = resolve; });
  await fixture(async ({ task, input }) => {
    active++; peak = Math.max(peak, active); calls.push(task.id);
    if (task.id !== 'join') { if (active === 2) release(); await bothStarted; }
    active--;
    return { data: { scope: 'contract-test-only', taskId: task.id, dependencyCount: Object.keys(input.dependencies).length } };
  }, async ({ store, scheduler, registry }) => {
    const created = await scheduler.createRun([task('left', [], { timeoutMs: 2000 }), task('right', [], { timeoutMs: 2000 }), task('join', ['left', 'right'])]);
    const result = await scheduler.run(created.id);
    assert.equal(result.status, 'succeeded'); assert.equal(peak, 2); assert.equal(calls.at(-1), 'join');
    assert.equal(result.tasks[2].result.data.dependencyCount, 2);
    assert.equal(result.tasks[2].result.artifact.scope, 'contract-test-only'); assert.match(result.tasks[2].result.artifact.sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.report.realModBuild, 'not_run'); assert.equal(result.report.game, 'not_run');
    const reopened = createScheduler({ store, registry });
    try {
      assert.equal((await reopened.get(created.id)).status, 'succeeded'); await reopened.resume(created.id, { allowReplay: true });
      assert.equal(calls.length, 3, 'completed tasks are never replayed');
    } finally { await reopened.close(); }
  });
});

test('model-call reservations are atomic across parallel candidates and a larger resume budget retains completed work', async () => {
  let calls = 0;
  await fixture(async () => { calls++; return { data: { scope: 'contract-test-only' } }; }, async ({ scheduler }) => {
    const created = await scheduler.createRun([task('left'), task('right')], { budget: { maxModelCalls: 1, maxAttempts: 4 } });
    const limited = await scheduler.run(created.id);
    assert.equal(limited.status, 'blocked'); assert.equal(limited.budget.modelCallsReserved, 1); assert.equal(calls, 1);
    assert.ok(limited.tasks.some(item => item.blockers.includes('RUN_BUDGET_EXHAUSTED')));
    const resumed = await scheduler.resume(created.id, { budget: { maxModelCalls: 2 } });
    assert.equal(resumed.status, 'succeeded'); assert.equal(calls, 2); assert.deepEqual(resumed.tasks.map(item => item.attemptCount), [1, 1]);
    await assert.rejects(scheduler.resume(created.id, { budget: { maxModelCalls: 1 } }), { code: 'INVALID_RUN_BUDGET' });
  }, { cost: 1 });
});

test('failed paid attempts do not automatically retry and require explicit replay on resume', async () => {
  let calls = 0;
  await fixture(async () => { calls++; if (calls === 1) { const error = new Error('not retained'); error.code = 'TRANSIENT'; throw error; } return { data: { scope: 'contract-test-only' } }; }, async ({ scheduler }) => {
    const created = await scheduler.createRun([task('one')], { budget: { maxModelCalls: 2 } });
    const first = await scheduler.run(created.id); assert.equal(first.status, 'failed'); assert.equal(calls, 1);
    const unchanged = await scheduler.resume(created.id); assert.equal(unchanged.status, 'failed'); assert.equal(calls, 1);
    const replayed = await scheduler.resume(created.id, { allowReplay: true });
    assert.equal(replayed.status, 'succeeded'); assert.equal(calls, 2); assert.equal(replayed.tasks[0].attemptCount, 2);
  }, { cost: 1 });
});

test('failure diagnostics retain only local rules and paths without raw values or accessor calls', async () => {
  const key = 'diagnostic-private-canary'; let accessed = false;
  await fixture(() => {
    const unsafe = { rule: 'coverage' }; Object.defineProperty(unsafe, 'path', { get() { accessed = true; return key; } });
    throw Object.assign(new Error(key), { code: 'INVALID_AGENT_REPORT', diagnostics: [
      { path: '/coverage', rule: 'coverage', expected: key },
      { path: '/' + key, rule: 'object', expected: key }, unsafe,
    ] });
  }, async ({ scheduler }) => {
    const created = await scheduler.createRun([task('one')]), result = await scheduler.run(created.id);
    assert.equal(result.status, 'failed'); assert.equal(accessed, false);
    assert.deepEqual(result.tasks[0].attempts[0].error.diagnostics, [{ path: '/coverage', rule: 'coverage', expected: 'every requirement exactly once' }]);
    assert.ok(!JSON.stringify(result).includes(key));
  }, { secrets: [key] });
});

test('cancellation returns for an uncooperative handler and late output cannot overwrite a resumed attempt', async () => {
  let started, late, calls = 0; const ready = new Promise(resolve => { started = resolve; });
  await fixture(async () => { calls++; if (calls === 1) { started(); return new Promise(resolve => { late = resolve; }); } return { data: { phase: 'new-attempt' } }; }, async ({ scheduler }) => {
    const created = await scheduler.createRun([task('one')], { budget: { maxModelCalls: 2 } });
    const pending = scheduler.run(created.id); await ready;
    const cancelled = await scheduler.cancel(created.id); await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.tasks[0].result, undefined);
    const replayed = await scheduler.resume(created.id, { allowReplay: true }); assert.equal(replayed.status, 'succeeded');
    late({ data: { phase: 'old-late-result' } }); await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await scheduler.get(created.id)).tasks[0].result.data.phase, 'new-attempt');
    assert.equal(replayed.budget.modelCallsReserved, 2);
  }, { cost: 1 });
});

test('timeout, missing capabilities and malformed handler output never produce a success artifact', async () => {
  await fixture(() => new Promise(() => {}), async ({ scheduler }) => {
    const created = await scheduler.createRun([task('one', [], { timeoutMs: 50 })]); const start = Date.now();
    const result = await scheduler.run(created.id); assert.equal(result.status, 'failed');
    assert.equal(result.tasks[0].attempts[0].error.code, 'TASK_TIMEOUT'); assert.ok(Date.now() - start < 1500);
  });
  await fixture(null, async ({ scheduler }) => { const run = await scheduler.createRun([task('one')]); const result = await scheduler.run(run.id); assert.equal(result.status, 'blocked'); assert.equal(result.budget.attemptsReserved, 0); });
  let getterCalled = false;
  await fixture(() => Object.defineProperty({}, 'data', { enumerable: true, get() { getterCalled = true; return 'unsafe'; } }), async ({ scheduler }) => {
    const run = await scheduler.createRun([task('one')]); const result = await scheduler.run(run.id); assert.equal(result.status, 'failed'); assert.equal(result.tasks[0].result, undefined);
  });
  assert.equal(getterCalled, false);
});

test('dynamic secret guards reject inputs and outputs without retaining credential echoes', async () => {
  const secrets = [];
  await fixture(() => ({ data: { text: secrets[0] } }), async ({ scheduler, store, dir }) => {
    const run = await scheduler.createRun([task('one')]); secrets.push('scheduler-transient-canary-not-real');
    await assert.rejects(scheduler.createRun([task('two')], { context: { text: secrets[0] } }), { code: 'RUN_SECRET_DETECTED' });
    const failed = await scheduler.run(run.id); assert.equal(failed.status, 'failed'); assert.equal(failed.tasks[0].result, undefined);
    assert.ok(!(await readFile(path.join(dir, 'runs', run.id + '.json'), 'utf8')).includes(secrets[0]));
    const tampered = await store.read(run.id); tampered.status = 'succeeded'; await store.write(tampered, { expectedRevision: tampered.revision });
    await assert.rejects(scheduler.get(run.id), { code: 'RUN_STATE_INVALID' });
  }, { secrets: () => secrets });
});

test('real process restart reconciles a running checkpoint and requires explicit paid replay', async () => {
  await fixture(async () => ({ data: { recovered: true } }), async ({ scheduler, dir }) => {
    const run = await scheduler.createRun([task('one')], { budget: { maxModelCalls: 2 } });
    const source = `import {createRunStore} from ${JSON.stringify(new URL('../src/orchestration/store.mjs', import.meta.url).href)};import {createScheduler} from ${JSON.stringify(new URL('../src/orchestration/scheduler.mjs', import.meta.url).href)};import {createAdapterRegistry} from ${JSON.stringify(new URL('../src/adapters/registry.mjs', import.meta.url).href)};const registry=createAdapterRegistry();registry.register(${JSON.stringify(manifest(1))},{analyze:async()=>{console.log('HANDLER_STARTED');setInterval(()=>{},1000);return new Promise(()=>{});}});const scheduler=createScheduler({store:await createRunStore({root:${JSON.stringify(dir)}}),registry});await scheduler.run(${JSON.stringify(run.id)});`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; await new Promise((resolve, reject) => { child.stdout.on('data', bytes => { output += bytes; if (output.includes('HANDLER_STARTED')) resolve(); }); child.once('error', reject); child.once('exit', code => { if (!output.includes('HANDLER_STARTED')) reject(new Error('Child failed: ' + code)); }); });
    await assert.rejects(scheduler.recover(run.id), { code: 'RUN_BUSY' });
    const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    const recovered = await scheduler.recover(run.id); assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.tasks[0].attempts[0].status, 'interrupted');
    const still = await scheduler.resume(run.id); assert.equal(still.status, 'interrupted'); assert.equal(still.budget.modelCallsReserved, 1);
    const replayed = await scheduler.resume(run.id, { allowReplay: true }); assert.equal(replayed.status, 'succeeded'); assert.equal(replayed.budget.modelCallsReserved, 2);
  }, { cost: 1 });
});

test('a created-but-never-started run can be recovered without reserving or replaying a model attempt', async () => {
  let calls = 0;
  await fixture(async () => { calls++; return { data: { firstExecution: true } }; }, async ({ scheduler }) => {
    const run = await scheduler.createRun([task('one')]); const recovered = await scheduler.recover(run.id);
    assert.equal(recovered.status, 'interrupted'); assert.equal(recovered.tasks[0].attemptCount, 0); assert.equal(recovered.budget.modelCallsReserved, 0);
    const resumed = await scheduler.resume(run.id); assert.equal(resumed.status, 'succeeded'); assert.equal(calls, 1);
  }, { cost: 1 });
});

test('a delayed initial dispatch cannot restart an early-cancelled paid run', async () => {
  let calls = 0;
  await fixture(async () => { calls++; return { data: { firstExecution: true } }; }, async ({ scheduler }) => {
    const run = await scheduler.createRun([task('one')]);
    const cancelled = await scheduler.cancel(run.id);
    assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.tasks[0].attemptCount, 0);
    const lateDispatch = await scheduler.run(run.id);
    assert.equal(lateDispatch.status, 'cancelled'); assert.equal(lateDispatch.revision, cancelled.revision);
    assert.equal(lateDispatch.budget.modelCallsReserved, 0); assert.equal(calls, 0);
    const resumed = await scheduler.resume(run.id);
    assert.equal(resumed.status, 'succeeded'); assert.equal(calls, 1); assert.equal(resumed.budget.modelCallsReserved, 1);
  }, { cost: 1 });
});

test('persisted artifact metadata cannot contradict its accepted task type, scope or dependency state', async () => {
  await fixture(async () => ({ data: { scope: 'contract-test-only' } }), async ({ scheduler, store }) => {
    const run = await scheduler.createRun([task('one'), task('two', ['one'])]); const complete = await scheduler.run(run.id);
    for (const mutate of [
      state => { state.tasks[1].result.artifact.scope = 'real-game'; },
      state => { state.tasks[1].result.artifact.type = 'game.loaded'; },
      state => { state.tasks[1].result.artifact.id = 'another-task.1'; },
      state => { state.tasks[1].result.artifact.provenance.adapterVersion = '99.0.0'; },
      state => { state.tasks[0].status = 'failed'; delete state.tasks[0].result; },
    ]) {
      const current = await store.read(run.id), changed = structuredClone(complete); changed.revision = current.revision; mutate(changed);
      await store.write(changed, { expectedRevision: current.revision });
      await assert.rejects(scheduler.get(run.id), { code: 'RUN_STATE_INVALID' });
    }
  });
});
