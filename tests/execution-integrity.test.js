// Contract fixtures only: no SDK, compiler, generated DLL, cloud model or game
// is executed. Placeholder bytes deliberately are not loadable assemblies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';
import { evaluateBehaviorVectors, compareBehaviorTrace, COMPILED_FILES } from '../src/execution/csharp-backend.mjs';
import { compilerEnvironment, compilerSandboxProfile, validateCompilerRunOptions } from '../src/execution/isolation.mjs';
import { createBehaviorExecutionRuntime } from '../src/execution/runtime.mjs';

const original = () => createBehaviorVerificationCases()[0];
const binding = value => ({ requirementIds: value.spec.requirementIds });
const failed = result => result.tasks.find(task => task.id === 'verify-behavior');
const PLACEHOLDER = 'PROJECT-OWNED-CONTRACT-BYTES-NOT-AN-ASSEMBLY';
function backend(fixture, mutate) {
  return {
    identity: { id: 'dotnet', version: '8.0.427', platform: process.platform }, targetFramework: 'net8.0',
    evidence: { executableSha256: 'a'.repeat(64), compilerSha256: 'b'.repeat(64), scope: 'contract-test-only' },
    async compile(directory) {
      await mkdir(path.join(directory, 'compiled'), { mode: 0o755 });
      for (const name of COMPILED_FILES.filter(file => file.startsWith('compiled/'))) await writeFile(path.join(directory, name), PLACEHOLDER);
      return { scope: 'contract-test-only', compilerInvoked: false, realModBuild: 'not_run', game: 'not_run' };
    },
    async executeVerification(directory) {
      await mutate?.(directory);
      return { data: evaluateBehaviorVectors(fixture.spec, fixture.steps, binding(fixture)), isolation: { scope: 'contract-test-only' } };
    },
  };
}
async function scratch(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-integrity-contract-'));
  const runtimes = [];
  async function runtime(options = {}) { const value = await createBehaviorExecutionRuntime({ root, ...options }); runtimes.push(value); return value; }
  try { await work({ root, runtime }); }
  finally { await Promise.allSettled(runtimes.map(value => value.close())); await rm(root, { recursive: true, force: true }); }
}

test('explicit accepted/rejected assertions are enforced even without a golden snapshot', () => {
  const fixture = original();
  for (const [eventId, fields, error] of [['activate', {}, true], ['unknown', {}, false], ['begin', {}, false]]) {
    assert.throws(() => evaluateBehaviorVectors(fixture.spec, [{ eventId, fields, error }], binding(fixture)), { code: 'BEHAVIOR_EXPECTATION_FAILED' });
  }
  const accepted = evaluateBehaviorVectors(fixture.spec, [{ eventId: 'activate', fields: {}, error: false }], binding(fixture));
  assert.equal(accepted.observations[0].accepted, true);
  const rejected = evaluateBehaviorVectors(fixture.spec, [{ eventId: 'unknown', fields: {}, error: true }], binding(fixture));
  assert.equal(rejected.observations[0].accepted, false); assert.deepEqual(rejected.observations[0].snapshot, rejected.initial);
  assert.throws(() => evaluateBehaviorVectors(fixture.spec, [{ eventId: 'activate', fields: {}, error: 'true' }], binding(fixture)), { code: 'INVALID_BEHAVIOR_VECTORS' });
});

test('negative zero is rejected before JSON lowering can silently change input or golden expectations', () => {
  const fixture = original();
  for (const steps of [
    [{ eventId: 'tick', fields: { dt: -0 } }],
    [{ eventId: 'activate', fields: {}, expected: { state: 'ready', variables: { remaining: -0, operations: 1 }, transitionId: 'activate-ready' } }],
  ]) assert.throws(() => evaluateBehaviorVectors(fixture.spec, steps, binding(fixture)), { code: 'INVALID_BEHAVIOR_VECTORS' });
});

test('JavaScript equivalence alone does not claim declared golden-vector acceptance', () => {
  const fixture = original(), expected = evaluateBehaviorVectors(fixture.spec, fixture.steps, binding(fixture));
  const onlyEquivalent = compareBehaviorTrace(expected, structuredClone(expected));
  assert.equal(onlyEquivalent.matchesJavaScript, true); assert.equal(onlyEquivalent.matchesDeclaredVectors, false);
  assert.equal(compareBehaviorTrace(expected, structuredClone(expected), { declaredExpectedSteps: fixture.steps.length - 1 }).matchesDeclaredVectors, false);
  const declared = compareBehaviorTrace(expected, structuredClone(expected), { declaredExpectedSteps: fixture.steps.length });
  assert.equal(declared.matchesDeclaredVectors, true); assert.equal(declared.realModBuild, 'not_run'); assert.equal(declared.game, 'not_run'); assert.equal(declared.readyToInstall, false);
  const wrong = structuredClone(expected); wrong.observations[0].snapshot.variables.operations++;
  assert.throws(() => compareBehaviorTrace(expected, wrong, { declaredExpectedSteps: fixture.steps.length }), { code: 'BEHAVIOR_BACKEND_MISMATCH' });
});

test('every pinned verification input is rechecked after the local backend returns', async () => {
  for (const changedPath of COMPILED_FILES) await scratch(async ({ runtime }) => {
    const fixture = original(); let mutationRan = false;
    const execution = await runtime({ backend: backend(fixture, async directory => {
      await writeFile(path.join(directory, changedPath), 'MODIFIED-BY-A-CONTRACT-FIXTURE'); mutationRan = true;
    }) });
    const created = await execution.create({ spec: fixture.spec, requirementIds: fixture.spec.requirementIds, steps: fixture.steps });
    const result = await execution.run(created.id);
    assert.equal(mutationRan, true, changedPath); assert.equal(result.status, 'failed', changedPath);
    assert.equal(failed(result).attempts[0].error.code, 'VERIFIER_INPUT_CHANGED', changedPath); assert.equal(failed(result).result, undefined);
    const assembly = result.tasks.find(task => task.id === 'compile-library').result.data.assembly;
    const stored = await execution.artifacts.readFile(assembly, changedPath);
    assert.ok(!stored.toString().includes('MODIFIED-BY-A-CONTRACT-FIXTURE'), changedPath);
    assert.equal(result.report.realModBuild, 'not_run'); assert.equal(result.report.game, 'not_run'); assert.equal(result.report.readyToInstall, false);
  });
});

test('a run with no golden snapshots remains explicitly limited to cross-backend equivalence', async () => scratch(async ({ runtime }) => {
  const fixture = original(); fixture.steps = fixture.steps.map(({ expected, ...step }) => step);
  const execution = await runtime({ backend: backend(fixture) }), created = await execution.create({ spec: fixture.spec, requirementIds: fixture.spec.requirementIds, steps: fixture.steps });
  const result = await execution.run(created.id), verification = failed(result).result.data.equivalence;
  assert.equal(result.status, 'succeeded'); assert.equal(verification.matchesDeclaredVectors, false); assert.equal(verification.matchesJavaScript, true);
  assert.equal(result.budget.modelCallsReserved, 0); assert.equal(result.report.realModBuild, 'not_run'); assert.equal(result.report.game, 'not_run');
}));

test('compiler environment excludes caller credentials, runtime injection hooks and path overrides', () => {
  const names = ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'DOTNET_STARTUP_HOOKS', 'PATH'], old = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'synthetic-private-environment-canary';
    const environment = compilerEnvironment('/isolated/work', '/trusted/sdk');
    assert.ok(!JSON.stringify(environment).includes('synthetic-private-environment-canary'));
    for (const name of names.filter(name => name !== 'PATH')) assert.equal(Object.hasOwn(environment, name), false);
    assert.equal(environment.PATH, '/usr/bin:/bin'); assert.equal(environment.DOTNET_CLI_HOME, '/isolated/work'); assert.equal(environment.NUGET_PACKAGES, '/isolated/work/.packages');
    assert.equal(environment.DOTNET_ROOT, '/trusted/sdk'); assert.equal(environment.DOTNET_CLI_TELEMETRY_OPTOUT, '1');
  } finally { for (const name of names) if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; }
});

test('compiler profile fixes private writes, protected credential paths and network denial', () => {
  const profile = compilerSandboxProfile({ sdkRoot: '/trusted/sdk', workRoot: '/isolated/work', policyRoot: '/isolated/policy', protectedPaths: ['/project/.env'] });
  assert.match(profile, /\(deny network\*\)/); assert.match(profile, /\(allow file-write\* \(subpath "\/isolated\/work"\)\)/);
  assert.match(profile, /\(deny file-read\*[^\n]*\/isolated\/policy[^\n]*\/project\/\.env/);
  assert.throws(() => compilerSandboxProfile({ sdkRoot: '/sdk', workRoot: '/', policyRoot: '/policy' }), { code: 'INVALID_TOOL_PATH' });
  assert.throws(() => compilerSandboxProfile({ sdkRoot: '/sdk', workRoot: '/work', policyRoot: '/work/mutable-policy' }), { code: 'INVALID_TOOL_PATH' });
  assert.throws(() => compilerEnvironment('relative', '/sdk'), { code: 'INVALID_TOOL_PATH' });
});

test('compiler invocation options cannot override environment or cwd or invoke accessors', () => {
  const signal = new AbortController().signal, input = { signal, timeoutMs: 5000 }, accepted = validateCompilerRunOptions(input);
  input.timeoutMs = 99; assert.equal(accepted.timeoutMs, 5000); assert.equal(accepted.signal, signal);
  assert.deepEqual(Object.keys(accepted), ['signal', 'timeoutMs']);
  for (const invalid of [null, [], { env: { DEEPSEEK_API_KEY: 'synthetic-must-not-be-forwarded' } }, { cwd: '/outside' }, { NODE_OPTIONS: '--require=outside' },
    { timeoutMs: 49 }, { timeoutMs: 180001 }, { timeoutMs: Infinity }, { timeoutMs: 1.1 }, { signal: {} }, { [Symbol('not-a-local-option')]: true }]) {
    assert.throws(() => validateCompilerRunOptions(invalid), { code: 'INVALID_TOOL_OPTIONS' });
  }
  let accessed = false;
  const getter = Object.defineProperty({}, 'timeoutMs', { enumerable: true, get() { accessed = true; return 1000; } });
  assert.throws(() => validateCompilerRunOptions(getter), { code: 'INVALID_TOOL_OPTIONS' });
  const inherited = Object.create({ get signal() { accessed = true; return signal; } });
  assert.throws(() => validateCompilerRunOptions(inherited), { code: 'INVALID_TOOL_OPTIONS' }); assert.equal(accessed, false);
});
