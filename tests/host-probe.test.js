import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSuperTuxProbeLevel, makeSuperTuxProbeScript, inspectSuperTuxProbe } from '../src/hosts/supertux-probe.mjs';

test('candidate probe refuses a changed original level and accepts no user source entry point', () => {
  assert.throws(() => makeSuperTuxProbeLevel('(supertux-level)', 'print("hi");'), /PINNED_PROBE_LEVEL_REQUIRED/);
  const script = makeSuperTuxProbeScript();
  assert.ok(!/use_scripting_controller|on_ground|debug-scripts/.test(script));
  assert.ok(!/\b(?:system|exec|dofile|loadfile|import)\s*\(/.test(script));
});

test('partial, reordered or missing observations cannot become a successful probe', () => {
  const parsed = inspectSuperTuxProbe('GB_VECTORS_COMPLETE count=40\nGB_PROBE_END safeRestored=true');
  assert.equal(parsed.vectorsMatched, false);
  assert.equal(parsed.inputPressObserved, false);
  assert.equal(parsed.boundEffectObserved, false);
  assert.equal(parsed.realModBuild, 'not_run');
  assert.equal(parsed.conversionGameAcceptance, 'not_run');
  assert.equal(parsed.readyToInstall, false);
});

test('native physical effect and genuine edge observations stay independently measured', () => {
  const output = 'GB_EFFECT_WRITE vx=120 safe=true\nGB_EFFECT_AFTER dx=12.1 vx=20\n' +
    'GB_INPUT n=1 p=true h=true r=false\nGB_BOUND_BEGIN x=200\nGB_INPUT n=2 p=false h=false r=true\n' +
    'GB_BOUND_END x=230 remaining=0';
  const parsed = inspectSuperTuxProbe(output);
  assert.equal(parsed.stateWriteObserved, true);
  assert.equal(parsed.displacementObserved, true);
  assert.equal(parsed.inputPressObserved, true);
  assert.equal(parsed.inputReleaseObserved, true);
  assert.equal(parsed.boundEffectObserved, true);
  assert.equal(parsed.inputCycleObserved, true);
  assert.equal(parsed.vectorsMatched, false);
  assert.equal(inspectSuperTuxProbe(output.replace('dx=12.1', 'dx=0')).displacementObserved, false);
  assert.equal(inspectSuperTuxProbe(output.replace('x=230', 'x=200')).boundEffectObserved, false);
  assert.equal(inspectSuperTuxProbe(output.replace('x=230', 'x=1e999')).boundEffectObserved, false);
  assert.equal(inspectSuperTuxProbe('GB_INPUT n=0 p=false h=false r=true\n' + output.replace('GB_INPUT n=2 p=false h=false r=true\n', '')).inputCycleObserved, false);
});
