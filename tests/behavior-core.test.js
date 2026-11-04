// Contract and generated-source checks only. No game or external model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BEHAVIOR_LIMITS, validateBehaviorSpec, createBehaviorMachine, emitCSharpBehavior } from '../src/behavior/index.mjs';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';

const fixture = () => createBehaviorVerificationCases()[0].spec;
const invalid = value => assert.throws(() => validateBehaviorSpec(value), { code: 'INVALID_BEHAVIOR_SPEC' });

test('three structurally different behavior contracts and one structural modification have explicit passing traces', () => {
  const cases = createBehaviorVerificationCases(); assert.equal(cases.length, 4);
  let steps = 0, rejected = 0;
  for (const item of cases) {
    const spec = validateBehaviorSpec(item.spec), machine = createBehaviorMachine(spec);
    assert.deepEqual(spec, item.spec);
    for (const entry of item.steps) {
      steps++;
      if (entry.error) { rejected++; assert.throws(() => machine.step(entry.eventId, entry.fields)); assert.deepEqual(machine.snapshot(), entry.expected); }
      else assert.deepEqual(machine.step(entry.eventId, entry.fields), entry.expected);
    }
  }
  assert.equal(steps, 40); assert.equal(rejected, 7);
});

test('unknown fields, scripts, effects, paths, accessors and malformed JSON are rejected without executing properties', () => {
  let invoked = false;
  const getter = fixture(); Object.defineProperty(getter, 'commands', { enumerable: true, get() { invoked = true; return ['must-not-run']; } }); invalid(getter);
  assert.equal(invoked, false);
  for (const field of ['commands', 'effects', 'files', 'hostGame', 'readyToInstall']) { const spec = fixture(); spec[field] = 'untrusted'; invalid(spec); }
  const nested = fixture(); nested.transitions[0].guard = { op: 'script', code: 'must-not-run' }; invalid(nested);
  const arraySubclass = fixture(); arraySubclass.states = new (class extends Array {})('ready', 'active'); invalid(arraySubclass);
  const sparse = fixture(); delete sparse.transitions[0]; invalid(sparse);
  const cyclic = fixture(); cyclic.variables.push(cyclic); invalid(cyclic);
  const hidden = fixture(); Object.defineProperty(hidden, 'hidden', { value: 1 }); invalid(hidden);
  const shared = fixture(); shared.transitions[1].guard = shared.transitions[0].guard; invalid(shared);
  const oversized = fixture(); oversized.extra = Array(128).fill('x'.repeat(4096)); invalid(oversized);
});

test('state, variable, event and requirement references must exist and retain unresolved requirements', () => {
  for (const mutate of [
    spec => { spec.initialState = 'missing'; }, spec => { spec.transitions[0].from = 'missing'; },
    spec => { spec.transitions[0].event = 'missing'; }, spec => { spec.transitions[0].updates[0].variable = 'missing'; },
    spec => { spec.transitions[0].requirementIds = ['invented']; }, spec => { spec.transitions[0].updates[0].value.id = 'missing'; },
    spec => { spec.requirementIds.push('not-covered'); },
  ]) { const spec = fixture(); mutate(spec); invalid(spec); }
  const incomplete = fixture(); incomplete.requirementIds.push('host-collision'); incomplete.unresolved.push({ requirementId: 'host-collision', reason: 'No admitted host collision capability.' });
  assert.deepEqual(validateBehaviorSpec(incomplete).unresolved, incomplete.unresolved);
  const empty = fixture(); empty.transitions = []; empty.unresolved = empty.requirementIds.map(requirementId => ({ requirementId, reason: 'Not expressible in this bounded contract.' }));
  assert.equal(validateBehaviorSpec(empty).transitions.length, 0);
});

test('external requirement binding rejects model omission and invented requirements', () => {
  const spec = fixture();
  assert.deepEqual(validateBehaviorSpec(spec, { requirementIds: ['interlock', 'timing'] }), spec);
  assert.throws(() => validateBehaviorSpec(spec, { requirementIds: ['timing'] }), { code: 'INVALID_BEHAVIOR_SPEC' });
  assert.throws(() => emitCSharpBehavior(spec, { requirementIds: ['timing', 'interlock', 'missing-host-effect'] }), { code: 'INVALID_BEHAVIOR_SPEC' });
  let called = false; const options = {}; Object.defineProperty(options, 'requirementIds', { enumerable: true, get() { called = true; return ['timing']; } });
  assert.throws(() => validateBehaviorSpec(spec, options), { code: 'INVALID_BEHAVIOR_SPEC' }); assert.equal(called, false);
});

test('typed expression contract rejects invalid operators, arity, depth and unsafe integers', () => {
  for (const guard of [
    { op: 'literal', value: 1 }, { op: 'and', args: [{ op: 'literal', value: 1 }, { op: 'literal', value: true }] },
    { op: 'eq', args: [{ op: 'literal', value: true }, { op: 'literal', value: true }] },
    { op: 'not', args: [] }, { op: 'literal', value: Infinity }, { op: 'literal', value: -0 },
  ]) { const spec = fixture(); spec.transitions[0].guard = guard; invalid(spec); }
  const wrongUpdate = fixture(); wrongUpdate.transitions[0].updates[0].value = { op: 'literal', value: true }; invalid(wrongUpdate);
  const tooDeep = fixture(); let tree = { op: 'literal', value: true };
  for (let i = 0; i < BEHAVIOR_LIMITS.expressionDepth + 1; i++) tree = { op: 'not', args: [tree] };
  tooDeep.transitions[0].guard = tree; invalid(tooDeep);
  const tooLarge = fixture(); tooLarge.variables[0].max = BEHAVIOR_LIMITS.numeric + 1; invalid(tooLarge);
  const wrongBounds = fixture(); wrongBounds.events[0].fields[0].max = 0; invalid(wrongBounds);
});

test('ambiguous priorities and conflicting simultaneous updates are rejected', () => {
  const priorities = fixture(); priorities.transitions.find(item => item.id === 'countdown-active').priority = 0; invalid(priorities);
  const duplicate = fixture(); duplicate.transitions[0].updates.push(structuredClone(duplicate.transitions[0].updates[0])); invalid(duplicate);
  const duplicateIds = fixture(); duplicateIds.events.push(structuredClone(duplicateIds.events[0])); invalid(duplicateIds);
});

test('event boundary rejects missing, extra, negative-zero, fractional and accessor payloads atomically', () => {
  const machine = createBehaviorMachine(fixture()), before = machine.snapshot(); let invoked = false;
  const accessor = {}; Object.defineProperty(accessor, 'duration', { enumerable: true, get() { invoked = true; return 1; } });
  for (const fields of [{}, { duration: 1, extra: 0 }, { duration: -0 }, { duration: 1.5 }, { duration: 1001 }, accessor, []]) {
    assert.throws(() => machine.step('begin', fields), { code: 'INVALID_BEHAVIOR_EVENT' }); assert.deepEqual(machine.snapshot(), before);
  }
  assert.equal(invoked, false);
  assert.throws(() => machine.step('not-an-event'), { code: 'INVALID_BEHAVIOR_EVENT' });
});

test('arithmetic and later update failures cannot partially commit earlier updates or state', () => {
  const spec = fixture();
  spec.transitions[0].updates.push({ variable: 'operations', value: { op: 'add', args: [{ op: 'literal', value: BEHAVIOR_LIMITS.numeric }, { op: 'literal', value: 1 }] } });
  const machine = createBehaviorMachine(spec), before = machine.snapshot();
  assert.throws(() => machine.step('begin', { duration: 5 }), { code: 'BEHAVIOR_ARITHMETIC_BOUNDS' }); assert.deepEqual(machine.snapshot(), before);
  const bounded = fixture(); bounded.transitions[0].updates.push({ variable: 'operations', value: { op: 'literal', value: 101 } });
  const boundedMachine = createBehaviorMachine(bounded);
  assert.throws(() => boundedMachine.step('begin', { duration: 5 }), { code: 'BEHAVIOR_VARIABLE_BOUNDS' }); assert.deepEqual(boundedMachine.snapshot(), before);
});

test('short-circuit boolean guards and explicit priorities select one deterministic transition', () => {
  const spec = fixture();
  spec.transitions[0].guard = { op: 'or', args: [{ op: 'literal', value: true }, { op: 'gt', args: [{ op: 'add', args: [{ op: 'literal', value: BEHAVIOR_LIMITS.numeric }, { op: 'literal', value: 1 }] }, { op: 'literal', value: 0 }] }] };
  spec.transitions.push({ ...structuredClone(spec.transitions[0]), id: 'lower-priority', priority: 10, to: 'ready' });
  const machine = createBehaviorMachine(spec);
  assert.equal(machine.step('begin', { duration: 2 }).transitionId, 'begin-active');
});

test('machines and snapshots are detached from caller mutation', () => {
  const spec = fixture(), machine = createBehaviorMachine(spec); spec.initialState = 'active'; spec.transitions[0].to = 'ready';
  const initial = machine.snapshot(); initial.variables.remaining = 999;
  assert.deepEqual(machine.step('begin', { duration: 2 }), { state: 'active', variables: { remaining: 2, operations: 0 }, transitionId: 'begin-active' });
});

test('C# emission is deterministic, changes for a structural edit and exposes only the host-neutral fixed interface', () => {
  const cases = createBehaviorVerificationCases();
  for (const item of cases) {
    const source = emitCSharpBehavior(item.spec); assert.equal(source, emitCSharpBehavior(structuredClone(item.spec)));
    assert.match(source, /namespace GameBridge\.Generated/); assert.match(source, /public StepResult Step\(string eventId, IReadOnlyDictionary<string, long> fields\)/);
    assert.match(source, /public StepResult Snapshot\(\)/); assert.doesNotMatch(source, /System\.(?:IO|Net|Diagnostics|Reflection)|Process\.Start|DllImport|Assembly\.Load|Stardew|Terraria|UnityEngine/);
  }
  assert.notEqual(emitCSharpBehavior(cases[0].spec), emitCSharpBehavior(cases[3].spec));
});
