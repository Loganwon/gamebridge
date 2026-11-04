// Runtime contracts with deliberately failing local backend fixtures. No SDK,
// compiler, generated assembly, cloud model or game is executed by this file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBehaviorExecutionRuntime } from '../src/execution/runtime.mjs';
import { PROJECT_FILES } from '../src/execution/csharp-backend.mjs';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';

function input() {
  const fixture = createBehaviorVerificationCases()[0];
  return { spec: fixture.spec, requirementIds: fixture.spec.requirementIds, steps: fixture.steps,
    request: { hostGame: 'unselected-contract-host', sourceGame: 'project-owned-behavior-contract', description: 'Runtime fixture only.', contentKinds: ['rules'] } };
}
function backend(compile = async () => { throw Object.assign(new Error('No compiler is invoked by this fixture.'), { code: 'FIXTURE_COMPILER_UNAVAILABLE' }); }) {
  return { identity: { id: 'dotnet', version: '8.0.427', platform: process.platform }, targetFramework: 'net8.0',
    evidence: { executableSha256: '1'.repeat(64), compilerSha256: '2'.repeat(64), scope: 'contract-test-only' }, compile,
    async executeVerification() { assert.fail('A failed/no-output compiler fixture cannot start assembly verification.'); } };
}
async function scratch(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-execution-contract-'));
  const runtimes = [];
  async function runtime(options = {}) { const value = await createBehaviorExecutionRuntime({ root, ...options }); runtimes.push(value); return value; }
  try { await work({ root, runtime }); }
  finally { await Promise.allSettled(runtimes.map(value => value.close())); await rm(root, { recursive: true, force: true }); }
}
function noGameEvidence(result) {
  assert.deepEqual(result.report, { scope: 'orchestration-only', realModBuild: 'not_run', game: 'not_run', readyToInstall: false });
  assert.equal(result.budget.modelCallsReserved, 0);
  assert.ok(result.tasks.filter(item => item.result).every(item => item.result.artifact.type.startsWith('tool.') && item.result.artifact.scope === 'tool-execution'));
}
const task = (result, id) => result.tasks.find(item => item.id === id);

test('missing local backend blocks lowering and compilation without a project or assembly claim', async () => {
  await scratch(async ({ runtime }) => {
    const execution = await runtime(), created = await execution.create(input()), result = await execution.run(created.id);
    assert.equal(result.status, 'blocked'); assert.equal(task(result, 'validate-specification').status, 'succeeded');
    assert.equal(task(result, 'lower-project').attemptCount, 0); assert.equal(task(result, 'lower-project').result, undefined);
    assert.ok(task(result, 'lower-project').blockers.includes('ADAPTER_CAPABILITY_UNAVAILABLE'));
    assert.equal(task(result, 'compile-library').attemptCount, 0); assert.equal(task(result, 'verify-behavior').attemptCount, 0);
    assert.equal(execution.describe().tools.length, 1); assert.deepEqual(execution.describe().gameAdapters, []); noGameEvidence(result);
    await assert.rejects(execution.create({ ...input(), requirementIds: [] }), { code: 'REQUIREMENT_BINDING_REQUIRED' });
  });
});

test('unresolved original requirements stop before source lowering or any backend call', async () => {
  await scratch(async ({ runtime }) => {
    let calls = 0; const execution = await runtime({ backend: backend(async () => { calls++; assert.fail('Unresolved requirements cannot compile.'); }) });
    const request = input(); request.spec.unresolved = [{ requirementId: 'timing', reason: 'Required external mapping remains unresolved.' }];
    const created = await execution.create(request), result = await execution.run(created.id);
    assert.equal(result.status, 'failed'); assert.equal(calls, 0);
    assert.equal(task(result, 'validate-specification').attempts[0].error.code, 'BEHAVIOR_REQUIREMENTS_UNRESOLVED');
    assert.equal(task(result, 'lower-project').attemptCount, 0); assert.equal(task(result, 'compile-library').result, undefined); noGameEvidence(result);
  });
});

test('locked complete project files reach a failing backend but no assembly result or raw error is retained', async () => {
  await scratch(async ({ root, runtime }) => {
    let calls = 0; const canary = 'private-execution-error-canary';
    const execution = await runtime({ secrets: [canary], backend: backend(async directory => {
      calls++;
      for (const file of PROJECT_FILES) assert.ok((await readFile(path.join(directory, file))).length > 0);
      const project = await readFile(path.join(directory, 'GameBridge.BehaviorKernel.csproj'), 'utf8');
      assert.match(project, /GameBridge\.BehaviorKernelVerification/); assert.match(project, /EnableDefaultCompileItems>false/);
      assert.doesNotMatch(project, /PackageReference|Stardew|SMAPI|Terraria|Bannerlord/);
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'global.json'), 'utf8')), { sdk: { version: '8.0.427', rollForward: 'disable' } });
      throw Object.assign(new Error(canary), { code: 'FIXTURE_COMPILER_UNAVAILABLE' });
    }) });
    const created = await execution.create(input()), result = await execution.run(created.id);
    assert.equal(calls, 1); assert.equal(result.status, 'failed');
    const project = task(result, 'lower-project').result.data.project, manifest = await execution.artifacts.getManifest(project);
    assert.deepEqual(manifest.files.map(file => file.path), [...PROJECT_FILES]); assert.equal(project.scope, 'local-tool-artifact');
    assert.equal(task(result, 'compile-library').attempts[0].error.code, 'FIXTURE_COMPILER_UNAVAILABLE');
    assert.equal(task(result, 'compile-library').result, undefined); assert.equal(task(result, 'verify-behavior').attemptCount, 0);
    assert.ok(!(await readFile(path.join(root, 'runs/runs', created.id + '.json'), 'utf8')).includes(canary)); noGameEvidence(result);
  });
});

test('a backend changing a locked source is rejected before accepting compiled output', async () => {
  await scratch(async ({ runtime }) => {
    const marker = '// changed by a contract fixture';
    const execution = await runtime({ backend: backend(async directory => {
      const source = await readFile(path.join(directory, 'Behavior.cs'), 'utf8');
      await writeFile(path.join(directory, 'Behavior.cs'), source + '\n' + marker);
      return { scope: 'contract-test-only', compilerInvoked: false };
    }) });
    const created = await execution.create(input()), result = await execution.run(created.id);
    assert.equal(result.status, 'failed'); assert.equal(task(result, 'compile-library').attempts[0].error.code, 'COMPILER_SOURCE_CHANGED');
    assert.equal(task(result, 'compile-library').result, undefined); assert.equal(task(result, 'verify-behavior').attemptCount, 0);
    assert.ok(!(await execution.artifacts.readFile(task(result, 'lower-project').result.data.project, 'Behavior.cs')).toString().includes(marker)); noGameEvidence(result);
  });
});

test('returning from a compiler callback without required files cannot manufacture an assembly artifact', async () => {
  await scratch(async ({ runtime }) => {
    let calls = 0;
    const execution = await runtime({ backend: backend(async () => { calls++; return { scope: 'contract-test-only', compilerInvoked: false }; }) });
    const created = await execution.create(input()), result = await execution.run(created.id);
    assert.equal(result.status, 'failed'); assert.equal(calls, 1); assert.equal(task(result, 'lower-project').status, 'succeeded');
    assert.equal(task(result, 'compile-library').status, 'failed'); assert.equal(task(result, 'compile-library').result, undefined);
    assert.equal(task(result, 'verify-behavior').attemptCount, 0); noGameEvidence(result);
  });
});

test('cancellation settles an uncooperative backend and discards its late return before artifact publication', { timeout: 10000 }, async () => {
  await scratch(async ({ runtime }) => {
    let entered, release, cleaned;
    const started = new Promise(resolve => { entered = resolve; }), late = new Promise(resolve => { release = resolve; }), cleanup = new Promise(resolve => { cleaned = resolve; });
    const execution = await runtime({ backend: backend(async () => { entered(); return late; }) });
    const remove = execution.artifacts.removeWorkDirectory;
    execution.artifacts.removeWorkDirectory = async directory => { try { await remove(directory); } finally { cleaned(); } };
    const created = await execution.create(input()), pending = execution.run(created.id); await started;
    const cancelled = await execution.cancel(created.id); await pending;
    assert.equal(cancelled.status, 'cancelled'); assert.equal(task(cancelled, 'compile-library').result, undefined);
    release({ scope: 'contract-test-only', compilerInvoked: false }); await cleanup;
    const after = await execution.get(created.id);
    assert.equal(after.revision, cancelled.revision); assert.deepEqual(after.tasks, cancelled.tasks); noGameEvidence(after);
  });
});

test('resuming binds the original compiler version and probe fingerprints before any tool attempt', async () => {
  await scratch(async ({ runtime }) => {
    const original = await runtime({ backend: backend() }), created = await original.create(input()); await original.close();
    for (const change of [value => { value.identity.version = '8.0.428'; }, value => { value.evidence.executableSha256 = '3'.repeat(64); }, value => { value.evidence.compilerSha256 = '4'.repeat(64); }]) {
      let calls = 0; const selected = backend(async () => { calls++; assert.fail('Mismatched backend cannot compile.'); }); change(selected);
      const execution = await runtime({ backend: selected });
      await assert.rejects(execution.resume(created.id, { allowReplay: true }), { code: 'EXECUTION_BACKEND_MISMATCH' });
      assert.equal(calls, 0); assert.equal((await execution.get(created.id)).budget.attemptsReserved, 0); await execution.close();
    }
  });
});

test('backend identity, probe data and function references are snapshotted before asynchronous creation', async () => {
  await scratch(async ({ runtime }) => {
    let originalCalls = 0, replacementCalls = 0;
    const selected = backend(async () => { originalCalls++; throw Object.assign(new Error('Deliberately unavailable fixture.'), { code: 'FIXTURE_COMPILER_UNAVAILABLE' }); });
    const execution = await runtime({ backend: selected });
    selected.identity.version = '8.0.999'; selected.evidence.executableSha256 = '5'.repeat(64);
    selected.compile = async () => { replacementCalls++; assert.fail('Mutable replacement cannot run.'); };
    const created = await execution.create(input()), result = await execution.run(created.id);
    assert.equal(originalCalls, 1); assert.equal(replacementCalls, 0);
    assert.equal(created.context.backendBinding.identity.version, '8.0.427'); assert.equal(created.context.backendBinding.executableSha256, '1'.repeat(64));
    assert.equal(task(result, 'compile-library').attempts[0].error.code, 'FIXTURE_COMPILER_UNAVAILABLE'); noGameEvidence(result);
  });
});

test('malformed backend bindings reject getters and missing fingerprints before tool registration', async () => {
  await scratch(async ({ runtime }) => {
    let accessed = 0, calls = 0;
    const top = backend(async () => { calls++; assert.fail('Invalid backend cannot compile.'); });
    Object.defineProperty(top, 'identity', { enumerable: true, get() { accessed++; return backend().identity; } });
    await assert.rejects(runtime({ backend: top }), { code: 'INVALID_EXECUTION_BACKEND' });
    const nested = backend(); Object.defineProperty(nested.evidence, 'compilerSha256', { enumerable: true, get() { accessed++; return '2'.repeat(64); } });
    await assert.rejects(runtime({ backend: nested }));
    const missing = backend(); delete missing.evidence.executableSha256; await assert.rejects(runtime({ backend: missing }));
    assert.equal(accessed, 0); assert.equal(calls, 0);
  });
});

test('equivalent compiler bindings remain resumable when caller property order changes', async () => {
  await scratch(async ({ runtime }) => {
    const first = await runtime({ backend: backend() }), created = await first.create(input()); await first.close();
    let calls = 0; const selected = backend(async () => { calls++; throw Object.assign(new Error('No compiler invoked.'), { code: 'FIXTURE_COMPILER_UNAVAILABLE' }); });
    selected.identity = { platform: process.platform, version: '8.0.427', id: 'dotnet' };
    selected.evidence = { compilerSha256: '2'.repeat(64), scope: 'contract-test-only', executableSha256: '1'.repeat(64) };
    const execution = await runtime({ backend: selected }), result = await execution.resume(created.id);
    assert.equal(calls, 1); assert.equal(task(result, 'compile-library').attempts[0].error.code, 'FIXTURE_COMPILER_UNAVAILABLE');
    assert.equal(task(result, 'compile-library').result, undefined); noGameEvidence(result);
  });
});

test('immediate cancellation invalidates pending run and resume admissions before any tool starts', async () => {
  await scratch(async ({ runtime }) => {
    let calls = 0; const execution = await runtime({ backend: backend(async () => { calls++; assert.fail('Cancelled admission cannot compile.'); }) });
    for (const method of ['run', 'resume']) {
      const created = await execution.create(input()), pending = execution[method](created.id, { allowReplay: true });
      const rejected = assert.rejects(pending, { code: 'EXECUTION_CANCELLED' });
      const cancelled = await execution.cancel(created.id); await rejected;
      assert.equal(cancelled.status, 'cancelled'); assert.equal((await execution.get(created.id)).budget.attemptsReserved, 0);
    }
    assert.equal(calls, 0);
  });
});

test('closing while run or resume awaits binding prevents later tool dispatch', async () => {
  for (const method of ['run', 'resume']) await scratch(async ({ runtime }) => {
    let calls = 0; const execution = await runtime({ backend: backend(async () => { calls++; assert.fail('Closed runtime cannot compile.'); }) });
    const created = await execution.create(input()), pending = execution[method](created.id, { allowReplay: true });
    const rejected = assert.rejects(pending, { code: 'EXECUTION_RUNTIME_CLOSED' }); await execution.close(); await rejected;
    assert.equal(calls, 0); assert.equal((await execution.get(created.id)).budget.attemptsReserved, 0);
    await assert.rejects(execution.run(created.id), { code: 'EXECUTION_RUNTIME_CLOSED' });
  });
});
