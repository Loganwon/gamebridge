import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { validateBehaviorCompilationInput, readBehaviorCompilationInput } from '../src/execution/input.mjs';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';

function input() {
  const fixture = createBehaviorVerificationCases()[0];
  return { schemaVersion: 1, request: { hostGame: 'Unselected Host', sourceGame: 'Provided Behavior', contentKinds: ['rules'],
    description: 'Preserve the timed interlock requirements and report unsupported host behavior.' },
  requirementIds: [...fixture.spec.requirementIds], spec: fixture.spec, steps: fixture.steps };
}
test('portable input retains the request, binds independent requirement IDs and detaches returned data', () => {
  const raw = input(), accepted = validateBehaviorCompilationInput(raw);
  assert.equal(accepted.request.description, raw.request.description);
  raw.steps[0].fields.changed = 1;
  assert.equal(accepted.steps[0].fields.changed, undefined);
  const lost = input(); lost.requirementIds.push('unrepresented-original');
  assert.throws(() => validateBehaviorCompilationInput(lost));
  assert.throws(() => validateBehaviorCompilationInput({ ...input(), command: 'not-a-tool-operation' }));
});
test('portable input rejects credential fields, known values and executable properties before retaining anything', () => {
  const key = 'input-test-canary-not-live', raw = input(); raw.request.description += key;
  assert.throws(() => validateBehaviorCompilationInput(raw, { secrets: [key] }), { code: 'RUN_SECRET_DETECTED' });
  assert.throws(() => validateBehaviorCompilationInput({ ...input(), apiKey: key }), { code: 'RUN_SECRET_DETECTED' });
  let invoked = false; const accessor = input(); Object.defineProperty(accessor, 'steps', { get() { invoked = true; return []; } });
  assert.throws(() => validateBehaviorCompilationInput(accessor)); assert.equal(invoked, false);
});
test('explicit JSON file input rejects links, oversized bytes and malformed data', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-behavior-input-'));
  try {
    const file = path.join(directory, 'input.json'); await writeFile(file, JSON.stringify(input()));
    const accepted = await readBehaviorCompilationInput(file); assert.equal(accepted.spec.id, input().spec.id);
    const alias = path.join(directory, 'alias.json'); await symlink(file, alias);
    await assert.rejects(readBehaviorCompilationInput(alias), { code: 'INVALID_COMPILATION_INPUT' });
    await writeFile(file, 'x'.repeat(131073)); await assert.rejects(readBehaviorCompilationInput(file), { code: 'INVALID_COMPILATION_INPUT' });
    await writeFile(file, '{invalid'); await assert.rejects(readBehaviorCompilationInput(file), { code: 'INVALID_COMPILATION_INPUT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
