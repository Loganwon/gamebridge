import { createHash } from 'node:crypto';
import { emitSquirrelBehavior } from '../behavior/squirrel.mjs';
import { createBehaviorVerificationCases } from '../behavior/verification-fixtures.mjs';

// A local, trusted interface experiment. This does not register a game adapter,
// accept model source, or claim that any source-game content was transferred.
export const SUPERTUX_PROBE = Object.freeze({
  version: '0.7.0', level: 'levels/world1/welcome_antarctica.stl',
  levelSha256: '8d637b021354566c24d61fea87977128322266176f3667075044a2c22c6c7d04',
  executables: Object.freeze({ arm64: '83517c0c00bb44883fbceedff95248a4d02f47f986ae5d58afb22e8a52684dda', x64: '6c3690746567b173b3b7323f77fe36fca8e8c8745b8699bd255184363ecb313e' }),
});
const literal = value => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(literal).join(',') + ']';
  return '{' + Object.entries(value).map(([key, item]) => '[' + JSON.stringify(key) + ']=' + literal(item)).join(',') + '}';
};

export function makeSuperTuxProbeLevel(original, script) {
  if (typeof original !== 'string' || createHash('sha256').update(original).digest('hex') !== SUPERTUX_PROBE.levelSha256 ||
      typeof script !== 'string' || Buffer.byteLength(script) > 128 * 1024) throw new Error('PINNED_PROBE_LEVEL_REQUIRED');
  const marker = '  (sector\n    (name "main")';
  if (original.split(marker).length !== 2 || original.includes('(init-script')) throw new Error('PINNED_PROBE_LEVEL_REQUIRED');
  // The official map, objects, statistics and attribution/license are retained;
  // only the native sector initialization extension is added to a private copy.
  return original.replace(marker, marker + '\n    (init-script-run-once #t)\n    (init-script ' + JSON.stringify(script) + ')');
}

export function makeSuperTuxProbeScript({ interactive = false, malformed = false } = {}) {
  if (malformed) return 'local rejected = ;\nprint("GB_UNREACHABLE\\n");';
  const lines = ['print("GB_PROBE_BEGIN\\n");'];
  for (const fixture of createBehaviorVerificationCases()) {
    lines.push('(function() {', emitSquirrelBehavior(fixture.spec, { requirementIds: fixture.spec.requirementIds }),
      'local machine = GameBridgeBehaviorMachine();');
    fixture.steps.forEach((step, index) => {
      lines.push('local error_' + index + ' = false;', 'local value_' + index + ' = null;',
        'try { value_' + index + ' = machine.step(' + literal(step.eventId) + ',' + literal(step.fields) + '); } catch (err) { error_' + index + ' = true; value_' + index + ' = machine.snapshot(); }');
      const expected = step.expected;
      const conditions = ['error_' + index + ' == ' + Boolean(step.error), 'value_' + index + '.state == ' + literal(expected.state),
        'value_' + index + '.transitionId == ' + literal(expected.transitionId),
        ...Object.entries(expected.variables).map(([key, value]) => 'value_' + index + '.variables[' + literal(key) + '] == ' + value)];
      lines.push('if (!(' + conditions.join(' && ') + ')) throw ' + literal('GB_VECTOR_MISMATCH ' + fixture.id + '/' + index) + ';',
        'print(' + literal('GB_VECTOR ' + fixture.id + ' ' + index + ' error=') + ' + error_' + index + ' + "\\n");');
    });
    lines.push('})();');
  }
  lines.push('print("GB_VECTORS_COMPLETE count=40\\n");',
    'local safe0 = Tux.get_is_intentionally_safe();',
    'local x0 = Tux.get_x();',
    'Tux.set_is_intentionally_safe(true);',
    'Tux.set_velocity(120.0, Tux.get_velocity_y());',
    'print("GB_EFFECT_WRITE vx=" + Tux.get_velocity_x() + " safe=" + Tux.get_is_intentionally_safe() + "\\n");',
    'wait(0.15, true);',
    'print("GB_EFFECT_AFTER dx=" + (Tux.get_x() - x0) + " vx=" + Tux.get_velocity_x() + "\\n");',
    'Tux.set_velocity(0.0, Tux.get_velocity_y());',
    'Tux.set_is_intentionally_safe(safe0);');
  if (interactive) {
    const spec = createBehaviorVerificationCases()[0].spec;
    lines.push('(function() {', emitSquirrelBehavior(spec, { requirementIds: spec.requirementIds }),
      'local machine = GameBridgeBehaviorMachine();',
      'local released = false, finished = false, started = false;',
      'print("GB_INPUT_READY control=action\\n");',
      'for (local n = 0; n < 7200; n += 1) {',
      '  local p = Tux.get_input_pressed("action"), h = Tux.get_input_held("action"), r = Tux.get_input_released("action");',
      '  if (p || r) print("GB_INPUT n=" + n + " p=" + p + " h=" + h + " r=" + r + "\\n");',
      '  if (r && started) released = true;',
      '  if (p) { started = true; released = false; finished = false; machine.step("begin", {duration=12}); print("GB_BOUND_BEGIN x=" + Tux.get_x() + "\\n"); }',
      '  local result = machine.snapshot();',
      '  if (result.state == "active") { Tux.set_velocity(220.0, Tux.get_velocity_y()); machine.step("tick", {dt=1}); }',
      '  if (result.state == "active" && machine.snapshot().state == "ready") { Tux.set_velocity(0.0,Tux.get_velocity_y()); finished = true; print("GB_BOUND_END x=" + Tux.get_x() + " remaining=" + machine.snapshot().variables.remaining + "\\n"); }',
      '  if (released && finished) break;',
      '  wait(0.0,true);',
      '}', '})();');
  }
  lines.push('print("GB_PROBE_END safeRestored=" + (Tux.get_is_intentionally_safe() == safe0) + "\\n");', 'Level.finish(false);', '');
  return lines.join('\n');
}

/** Local parser for this fixed experiment only; stdout is not authenticated. */
export function inspectSuperTuxProbe(output) {
  const vectors = [...output.matchAll(/GB_VECTOR ([a-z-]+) (\d+) error=(true|false)/g)];
  const expected = createBehaviorVerificationCases().flatMap(item => item.steps.map((step, index) => item.id + '/' + index + '/' + Boolean(step.error)));
  const seen = vectors.map(item => item[1] + '/' + item[2] + '/' + item[3]);
  const after = output.match(/GB_EFFECT_AFTER dx=([\d.eE+-]+) vx=([\d.eE+-]+)/);
  let cycle, inputCycleObserved = false, boundEffectObserved = false, inputReleaseObserved = false;
  for (const line of output.split('\n')) {
    if (/GB_INPUT n=\d+ p=true h=true r=false/.test(line)) cycle = {};
    const begin = line.match(/GB_BOUND_BEGIN x=([\d.eE+-]+)/), end = line.match(/GB_BOUND_END x=([\d.eE+-]+) remaining=0/);
    if (cycle && begin) cycle.begin = Number(begin[1]);
    if (cycle && Number.isFinite(cycle.begin) && /GB_INPUT n=\d+ p=false h=false r=true/.test(line)) { cycle.released = true; inputReleaseObserved = true; }
    if (cycle && end && Number.isFinite(cycle.begin) && Number.isFinite(Number(end[1])) && Number(end[1]) > cycle.begin) { cycle.ended = true; boundEffectObserved = true; }
    if (cycle?.released && cycle?.ended) inputCycleObserved = true;
  }
  return {
    vectorsMatched: expected.length === seen.length && expected.every((item, index) => seen[index] === item) && output.includes('GB_VECTORS_COMPLETE count=40') && !output.includes('GB_VECTOR_MISMATCH'),
    vectorSteps: vectors.length, expectedRejections: vectors.filter(item => item[3] === 'true').length,
    stateWriteObserved: output.includes('GB_EFFECT_WRITE vx=120 safe=true'),
    displacementObserved: Boolean(after && Number.isFinite(Number(after[1])) && Number(after[1]) > 0),
    inputPressObserved: /GB_INPUT n=\d+ p=true h=true r=false/.test(output),
    inputReleaseObserved, boundEffectObserved, inputCycleObserved,
    cleanCompletion: output.includes('GB_PROBE_END safeRestored=true'),
    scope: 'trusted-native-interface-probe-only', realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false,
  };
}
