import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProtocolJson, validateTaskDefinition, validateTaskGraph, TASK_PROTOCOL_LIMITS } from '../src/orchestration/protocol.mjs';

function task(id = 'requirements', dependsOn = []) {
  return { id, kind: 'analysis', role: 'requirements', dependsOn, requirementIds: ['req-1'], inputRefs: ['input:request'],
    outputTypes: ['analysis.requirements'], requiredCapabilities: ['agent.requirements.analysis'], acceptanceCriteria: ['Preserve the complete request and report missing information.'] };
}

test('task protocol normalizes detached game-neutral definitions without executable or status fields', () => {
  const input = task(), normalized = validateTaskDefinition(input);
  assert.equal(normalized.schemaVersion, 1);
  assert.deepEqual(normalized.retryPolicy, { maxAttempts: 1, retryableCodes: [], replaySafe: false });
  assert.equal(normalized.timeoutMs, 120000);
  assert.deepEqual(normalized.inputRefs, ['input:request']);
  input.requirementIds.push('req-2'); assert.deepEqual(normalized.requirementIds, ['req-1']);
  for (const property of ['status', 'command', 'handler', 'apiKey', 'budget', 'execution', 'filePath']) assert.throws(() => validateTaskDefinition({ ...task(), [property]: 'untrusted-canary' }), error => {
    assert.equal(error.code, 'INVALID_TASK_PROTOCOL'); assert.ok(!error.message.includes('untrusted-canary')); return true;
  });
});

test('task dependency graphs reject unknown dependencies, duplicate IDs, self references and cycles', () => {
  assert.equal(validateTaskGraph([task('first'), task('second', ['first'])]).length, 2);
  for (const graph of [[], [task('same'), task('same')], [task('first', ['missing'])], [task('first', ['first'])], [task('first', ['second']), task('second', ['first'])]]) assert.throws(() => validateTaskGraph(graph), { code: 'INVALID_TASK_PROTOCOL' });
  const implicit = task('second'); implicit.inputRefs = ['task:first'];
  assert.throws(() => validateTaskGraph([task('first'), implicit]), error => error.rule === 'input-reference');
  implicit.dependsOn = ['first']; assert.equal(validateTaskGraph([task('first'), implicit]).length, 2);
});

test('task policies and logical references have finite type, count and namespace boundaries', () => {
  const mutations = [
    t => { t.acceptanceCriteria = []; }, t => { t.inputRefs = ['/Users/private/game']; }, t => { t.inputRefs = ['../outside']; },
    t => { t.dependsOn = null; }, t => { t.retryPolicy = null; }, t => { t.retryPolicy = { maxAttempts: null }; },
    t => { t.retryPolicy = { maxAttempts: 4 }; }, t => { t.retryPolicy = { maxAttempts: 2, retryableCodes: ['network retry'] }; },
    t => { t.retryPolicy = { replaySafe: 'true' }; }, t => { t.timeoutMs = null; }, t => { t.timeoutMs = 180001; },
    t => { t.kind = 'run-shell'; }, t => { t.role = 'root'; }, t => { t.outputTypes = []; }, t => { delete t.outputTypes; }, t => { t.outputTypes = ['analysis.requirements', 'analysis.requirements']; },
  ];
  for (const mutate of mutations) { const value = task(); mutate(value); assert.throws(() => validateTaskDefinition(value), { code: 'INVALID_TASK_PROTOCOL' }); }
  assert.throws(() => validateTaskGraph(Array.from({ length: TASK_PROTOCOL_LIMITS.tasks + 1 }, (_, i) => task(`task-${i}`))), { code: 'INVALID_TASK_PROTOCOL' });
});

test('protocol reader rejects accessors, hidden properties, sparse arrays, cycles and oversized data before serialization', () => {
  let calls = 0;
  const accessor = task(); Object.defineProperty(accessor, 'timeoutMs', { enumerable: true, get() { calls++; return 100; } });
  assert.throws(() => validateTaskDefinition(accessor)); assert.equal(calls, 0);
  const hidden = task(); Object.defineProperty(hidden, 'private', { value: 'not-visible' }); assert.throws(() => validateTaskDefinition(hidden));
  const circular = {}; circular.self = circular;
  for (const value of [circular, { invalid: Infinity }, [,'sparse'], Object.assign(Object.create({}), { id: 'inherited' }), { tooLong: 'x'.repeat(16385) }]) assert.throws(() => assertProtocolJson(value), { code: 'INVALID_TASK_PROTOCOL' });
  assert.throws(() => assertProtocolJson({ text: 'x'.repeat(1000) }, { maxBytes: 100 }));
});
