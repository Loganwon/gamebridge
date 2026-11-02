// These are registry/permission contract fixtures, not real game adapters or game support evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterRegistry, validateAdapterManifest } from '../src/adapters/registry.mjs';

function manifest() {
  return { schemaVersion: 1, id: 'agent.requirements', version: '1.0.0', kind: 'agent', role: 'requirements', targets: [], contentKinds: [],
    capabilities: [{ id: 'agent.requirements.analysis', operation: 'analyze', outputTypes: ['analysis.requirements'] }], allowedOperations: ['analyze'],
    execution: { sideEffects: 'none', idempotent: false, modelCallsPerAttempt: 1 }, evidenceScope: 'analysis-only', references: [], limitations: ['Analysis only; no game execution.'],
    resourceLimits: { maxInputBytes: 262144, maxOutputBytes: 131072, timeoutMs: 120000 } };
}
function task(extra = {}) { return { id: 'requirements', kind: 'analysis', role: 'requirements', requiredCapabilities: ['agent.requirements.analysis'], outputTypes: ['analysis.requirements'], acceptanceCriteria: ['Preserve the full request.'], ...extra }; }
function gameManifest() {
  return { ...manifest(), id: 'host.contract-fixture', kind: 'host', role: 'conversion-implementation', targets: [{ game: 'contract-host', version: '1.0.0', platform: 'darwin', role: 'host' }], contentKinds: ['rules'],
    capabilities: [{ id: 'host.project.generate', operation: 'generate', outputTypes: ['project.contract'] }], allowedOperations: ['generate'], execution: { sideEffects: 'none', idempotent: true, modelCallsPerAttempt: 0 }, evidenceScope: 'contract-test-only',
    references: ['https://example.org/contract-fixture-specification'], limitations: ['Test-only adapter contract; not a real game implementation.'] };
}

test('registry starts empty and only local function bindings can register executable operations', () => {
  const registry = createAdapterRegistry(); assert.deepEqual(registry.list(), []);
  assert.equal(registry.resolveTask(task()).blocked, true);
  for (const binding of [{}, { analyze: 'run-this' }, { analyze() {}, extra() {} }]) assert.throws(() => registry.register(manifest(), binding), { code: 'INVALID_ADAPTER_BINDINGS' });
  const handler = async () => ({ data: { text: 'analysis fixture only' } });
  registry.register(manifest(), { analyze: handler });
  assert.equal(registry.resolveTask(task()).handler, handler);
  assert.equal(registry.resolveTask(task()).manifest.execution.modelCallsPerAttempt, 1);
  assert.throws(() => registry.register(manifest(), { analyze: handler }), { code: 'ADAPTER_ALREADY_REGISTERED' });
  const listed = registry.list(); listed[0].version = 'changed'; assert.equal(registry.get('agent.requirements').version, '1.0.0');
  assert.ok(!JSON.stringify(registry.list()).includes('handler'));
});

test('agent registration cannot claim game support, tool namespaces or runtime evidence', () => {
  const changes = [
    m => { m.targets = [{ game: 'contract-host', version: '1.0.0', platform: 'darwin', role: 'host' }]; },
    m => { m.evidenceScope = 'real-game'; }, m => { m.capabilities[0].id = 'host.project.generate'; },
    m => { m.execution.sideEffects = 'local-write'; }, m => { m.execution.idempotent = true; },
    m => { m.allowedOperations.push('exec'); }, m => { m.status = 'passed'; }, m => { m.version = 'latest'; },
    m => { m.capabilities[0].outputTypes = ['mod.build']; }, m => { m.capabilities[0].outputTypes = ['game.acceptance']; },
    m => { m.capabilities[0].outputTypes = ['test.contract']; },
    m => { m.evidenceScope = 'contract-test-only'; m.capabilities[0].outputTypes = ['analysis.requirements']; },
  ];
  for (const change of changes) { const value = manifest(); change(value); assert.throws(() => validateAdapterManifest(value), { code: 'INVALID_ADAPTER_MANIFEST' }); }
  const registry = createAdapterRegistry(); registry.register(manifest(), { analyze: async () => ({ data: {} }) });
  for (const kind of ['generation', 'build', 'game']) assert.equal(registry.resolveTask(task({ kind })).blocked, true);
  assert.deepEqual(registry.list({ kind: 'host' }), []);
  const contractOnly = manifest(); contractOnly.evidenceScope = 'contract-test-only'; contractOnly.capabilities[0].outputTypes = ['test.contract'];
  assert.equal(validateAdapterManifest(contractOnly).capabilities[0].outputTypes[0], 'test.contract');
});

test('versioned game adapter contracts require exact target, platform, content, namespace and operation matches', () => {
  const value = gameManifest(), registry = createAdapterRegistry(); registry.register(value, { generate: async () => ({ data: {} }) });
  const definition = task({ kind: 'generation', role: 'conversion-implementation', requiredCapabilities: ['host.project.generate'], outputTypes: ['project.contract'] });
  const context = { platform: 'darwin', request: { hostGame: 'contract-host', hostVersion: '1.0.0', sourceGame: 'contract-source', sourceVersion: '2.0.0', contentKinds: ['rules'] } };
  assert.equal(registry.resolveTask(definition, context).operation, 'generate');
  for (const update of [{ platform: 'win32' }, { request: { ...context.request, hostVersion: 'unknown' } }, { request: { ...context.request, hostVersion: '1.0.1' } }, { request: { ...context.request, contentKinds: ['character'] } }]) assert.equal(registry.resolveTask(definition, { ...context, ...update }).blocked, true);
  for (const mutate of [m => { m.targets[0].version = '*'; }, m => { m.targets[0].platform = 'any'; }, m => { m.targets = []; }, m => { m.references = []; }, m => { m.capabilities[0].operation = 'shell'; }]) { const changed = gameManifest(); mutate(changed); assert.throws(() => validateAdapterManifest(changed), { code: 'INVALID_ADAPTER_MANIFEST' }); }
});

test('multiple trusted matches are blocked instead of silently selecting an implementation', () => {
  const registry = createAdapterRegistry();
  registry.register(manifest(), { analyze: async () => ({ data: {} }) });
  registry.register({ ...manifest(), id: 'agent.alternative' }, { analyze: async () => ({ data: {} }) });
  assert.equal(registry.resolveTask(task()).code, 'ADAPTER_SELECTION_AMBIGUOUS');
});

test('malformed manifests and handler maps cannot invoke getters or inflate permissions', () => {
  let accessed = 0; const value = manifest(); Object.defineProperty(value, 'version', { enumerable: true, get() { accessed++; return '1.0.0'; } });
  assert.throws(() => validateAdapterManifest(value), { code: 'INVALID_ADAPTER_MANIFEST' }); assert.equal(accessed, 0);
  const bindings = {}; Object.defineProperty(bindings, 'analyze', { enumerable: true, get() { accessed++; return async () => {}; } });
  assert.throws(() => createAdapterRegistry().register(manifest(), bindings), { code: 'INVALID_ADAPTER_BINDINGS' }); assert.equal(accessed, 0);
  const large = manifest(); large.limitations = ['x'.repeat(17000)]; assert.throws(() => validateAdapterManifest(large), { code: 'INVALID_ADAPTER_MANIFEST' });
});
