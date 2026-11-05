// Generator/contract tests only. Exact-VM compilation is a separate host probe.
import test from 'node:test';
import assert from 'node:assert/strict';
import { emitSquirrelBehavior } from '../src/behavior/squirrel.mjs';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';

test('Squirrel emission preserves external requirement binding and rejects source-bearing input', () => {
  const spec = createBehaviorVerificationCases()[0].spec;
  assert.throws(() => emitSquirrelBehavior(spec, { requirementIds: ['timing'] }), { code: 'INVALID_BEHAVIOR_SPEC' });
  for (const field of ['commands', 'files', 'source', 'hostGame', 'readyToInstall']) {
    assert.throws(() => emitSquirrelBehavior({ ...structuredClone(spec), [field]: 'untrusted' }), { code: 'INVALID_BEHAVIOR_SPEC' });
  }
  let invoked = false;
  const getter = structuredClone(spec);
  Object.defineProperty(getter.transitions[0], 'source', { enumerable: true, get() { invoked = true; return 'unsafe'; } });
  assert.throws(() => emitSquirrelBehavior(getter), { code: 'INVALID_BEHAVIOR_SPEC' });
  assert.equal(invoked, false);
});

test('distinct behavior structures and an edit produce deterministic, host-neutral Squirrel sources', () => {
  const cases = createBehaviorVerificationCases(), sources = cases.map(item => emitSquirrelBehavior(item.spec));
  assert.equal(new Set(sources).size, 4);
  cases.forEach((item, index) => {
    assert.equal(emitSquirrelBehavior(structuredClone(item.spec)), sources[index]);
    assert.match(sources[index], /local GameBridgeBehaviorMachine = class \{/);
    assert.match(sources[index], /function step\(eventId, fields\)/);
    assert.match(sources[index], /function snapshot\(\)/);
    assert.doesNotMatch(sources[index], /\b(?:import|dofile|loadfile|compilestring|system|exec|require|suspend|wait|Tux|SuperTux|Terraria)\b/);
    assert.doesNotMatch(sources[index], /fields\.(?:len|rawget|getdelegate)\(/);
  });
});

test('invalid operators, unsafe numeric literals and injectable identifiers never reach generated source', () => {
  const base = () => structuredClone(createBehaviorVerificationCases()[0].spec);
  for (const mutate of [
    spec => { spec.states[0] = 'ready"; print("unsafe");'; },
    spec => { spec.transitions[0].guard = { op: 'code', value: 'unsafe' }; },
    spec => { spec.variables[0].max = 2147483647; },
    spec => { spec.transitions[0].updates[0].value = { op: 'literal', value: -0 }; },
  ]) {
    const spec = base(); mutate(spec);
    assert.throws(() => emitSquirrelBehavior(spec), { code: 'INVALID_BEHAVIOR_SPEC' });
  }
});
