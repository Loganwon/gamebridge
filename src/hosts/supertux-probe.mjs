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
  const lines = ['print("GB_PROBE_BEGIN\\n");', 'local safe0 = null;', 'local failureCode = "NATIVE_EXCEPTION";', 'try {'];
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
    // A native diagnostic overlay makes the required input phase visible. It
    // does not replace the controller, move Tux or admit a gameplay adapter.
    'local function status(text) { Text.set_text(text); Text.fade_in(0.1); }',
    'status("GameBridge input check\\nClick this window and release all keys.\\nWait for READY before pressing LEFT CTRL.");',
    // tick counts resumptions across native wait(), not wall-clock time or all
    // render frames. The first wait also keeps effects behind the native intro.
    'local tick = 0;',
    'local function advance() { wait(0.0,true); tick += 1; }',
    'local function magnitude(value) { return value < 0 ? -value : value; }',
    'local function require(value, code) { if (!value) { failureCode = code; throw code; } }',
    'local function read() { return {x=Tux.get_x(), y=Tux.get_y(), vx=Tux.get_velocity_x(), vy=Tux.get_velocity_y(), safe=Tux.get_is_intentionally_safe(), p=Tux.get_input_pressed("action"), h=Tux.get_input_held("action"), r=Tux.get_input_released("action"), left=Tux.get_input_held("left"), right=Tux.get_input_held("right")}; }',
    'local function emit(cycle, phase, value, state, remaining) { print("GB_OBS cycle="+cycle+" phase="+phase+" tick="+tick+" x="+value.x+" y="+value.y+" vx="+value.vx+" vy="+value.vy+" safe="+value.safe+" state="+state+" remaining="+remaining+" p="+value.p+" h="+value.h+" r="+value.r+" left="+value.left+" right="+value.right+"\\n"); }',
    'local function idle(value) { return !value.p && !value.h && !value.r && !value.left && !value.right && magnitude(value.vx) <= 0.01; }',
    'local baseline = null, previous = null, stable = 0;',
    'for (local n=0; n<180; n+=1) {',
    '  advance(); local value = read();',
    '  if (idle(value) && magnitude(value.vy) <= 0.01 && previous != null && magnitude(value.x-previous.x) <= 0.01 && magnitude(value.y-previous.y) <= 0.01) stable += 1; else stable = 0;',
    '  previous = value;',
    '  if (stable >= 4) { baseline = value; emit(0,"baseline",value,"not_bound",-1); break; }',
    '  if (n%30 == 0) emit(0,"settling",value,"not_bound",-1);',
    '}',
    'require(baseline != null,"BASELINE_NOT_IDLE");',
    'safe0 = baseline.safe; require(safe0 == false,"BASELINE_SAFETY_UNEXPECTED");',
    'advance(); require(idle(read()),"BASELINE_INPUT_CHANGED");',
    'Tux.set_is_intentionally_safe(true); Tux.set_velocity(120.0,Tux.get_velocity_y());',
    'local pulse = read(); require(pulse.safe && magnitude(pulse.vx-120.0)<=0.01,"PULSE_WRITE_FAILED"); emit(0,"pulse-start",pulse,"not_bound",-1);',
    'local after = null;',
    'for (local n=0; n<9; n+=1) { advance(); after=read(); require(!after.left && !after.right && !after.p && !after.h && !after.r && after.safe,"PULSE_INPUT_OR_SAFETY_CHANGED"); emit(0,n==8?"pulse-after":"pulse-active",after,"not_bound",-1); }',
    'require(after.x > pulse.x+0.01,"PULSE_NO_DISPLACEMENT");',
    'Tux.set_velocity(0.0,Tux.get_velocity_y()); Tux.set_is_intentionally_safe(safe0);',
    'local stoppedX = Tux.get_x();',
    'for (local n=0; n<4; n+=1) { advance(); local value=read(); require(idle(value) && value.safe==safe0 && magnitude(value.x-stoppedX)<=0.05,"PULSE_RECOVERY_FAILED"); emit(0,n==3?"pulse-restored":"pulse-recovery",value,"not_bound",-1); }');
  if (interactive) {
    const spec = createBehaviorVerificationCases()[0].spec;
    lines.push('(function() {', emitSquirrelBehavior(spec, { requirementIds: spec.requirementIds }),
      'local machine = GameBridgeBehaviorMachine();',
      'local pressed = false, released = false, held = false, finished = false, recovered = false, startX = 0.0, endX = 0.0, recovery = 0;',
      'status("READY: Hold LEFT CTRL for half a second, then release.\\nKeep the arrow keys released.");',
      'print("GB_INPUT_READY control=action cycle=1\\n");',
      'for (local n=0; n<7200; n+=1) {',
      '  advance(); local value=read(); require(!value.left && !value.right,"DIRECTION_INPUT_CONFLICT");',
      '  if (!pressed) {',
      '    if (!value.p) { if (n%60==0 || value.r) emit(1,"armed",value,"ready",0); continue; }',
      '    require(value.h && !value.r,"INVALID_PRESS_EDGE"); pressed=true; startX=value.x;',
      '    status("KEY RECEIVED: Release LEFT CTRL.\\nChecking movement and recovery...");',
      '    local begin=machine.step("begin",{duration=12}); require(begin.state=="active" && begin.variables.remaining==12,"BEGIN_STATE_FAILED");',
      '    Tux.set_is_intentionally_safe(true); Tux.set_velocity(220.0,Tux.get_velocity_y());',
      '    emit(1,"press",read(),begin.state,begin.variables.remaining); continue;',
      '  }',
      '  require(!value.p,"DUPLICATE_PRESS");',
      '  require(!released || (!value.h && !value.r),"RELEASE_STATE_CHANGED");',
      '  if (value.h && !value.r) held=true;',
      '  if (value.r) { require(!value.h && !released,"INVALID_RELEASE_EDGE"); released=true; }',
      '  local current=machine.snapshot();',
      '  if (current.state=="active") {',
      '    require(value.safe,"ACTIVE_SAFETY_CHANGED");',
      '    local result=machine.step("tick",{dt=1});',
      '    if (result.state=="active") { Tux.set_velocity(220.0,Tux.get_velocity_y()); emit(1,"active",read(),result.state,result.variables.remaining); }',
      '    else { require(result.state=="ready" && result.variables.remaining==0 && result.variables.operations==0,"READY_STATE_FAILED"); endX=value.x; require(endX>startX+0.01,"BOUND_NO_DISPLACEMENT"); Tux.set_velocity(0.0,Tux.get_velocity_y()); Tux.set_is_intentionally_safe(safe0); finished=true; emit(1,"ready",read(),result.state,result.variables.remaining); }',
      '    continue;',
      '  }',
      '  require(finished && current.state=="ready" && current.variables.remaining==0 && current.variables.operations==0,"RESTORED_STATE_FAILED");',
      '  require(value.safe==safe0 && magnitude(value.vx)<=0.01 && magnitude(value.x-endX)<=0.05,"BOUND_RECOVERY_FAILED");',
      '  if (value.r) { emit(1,"release",value,current.state,0); continue; }',
      '  if (!released) { if (value.r || n%60==0) emit(1,"release-wait",value,current.state,0); continue; }',
      '  require(held && !value.h && !value.r,"HELD_OR_RELEASE_INCOMPLETE");',
      '  recovery+=1; emit(1,recovery==4?"restored":"recovery",value,current.state,0);',
      '  if (recovery>=4) { recovered=true; break; }',
      '}',
      'require(pressed && held && released && finished && recovered,"INPUT_CYCLE_INCOMPLETE");',
      'print("GB_INPUT_COMPLETE cycle=1\\n");', '})();');
  }
  lines.push('require(Tux.get_is_intentionally_safe()==safe0 && magnitude(Tux.get_velocity_x())<=0.01,"FINAL_HOST_STATE_CHANGED");',
    'Text.fade_out(0.1);',
    `print("GB_PROBE_END mode=${interactive ? 'interactive' : 'automatic'} safeRestored=true stateRestored=true recoveryObserved=true\\n");`,
    'Level.finish(false);',
    '} catch (err) {',
    '  print("GB_PROBE_FAIL code="+failureCode+"\\n");',
    '  try { Tux.set_velocity(0.0,Tux.get_velocity_y()); if (safe0 != null) Tux.set_is_intentionally_safe(safe0); } catch (cleanupError) { print("GB_CLEANUP_FAIL\\n"); }',
    '}', '');
  return lines.join('\n');
}

/** Local parser for this fixed experiment only; stdout is not authenticated. */
export function inspectSuperTuxProbe(output) {
  const lines = output.split('\n').map(line => line.replace(/\r$/, '').replace(/^\[SCRIPTING\] /, ''));
  const vectors = lines.map(line => line.match(/^GB_VECTOR ([a-z-]+) (\d+) error=(true|false)$/)).filter(Boolean);
  const expected = createBehaviorVerificationCases().flatMap(item => item.steps.map((step, index) => item.id + '/' + index + '/' + Boolean(step.error)));
  const seen = vectors.map(item => item[1] + '/' + item[2] + '/' + item[3]);
  const number = '([-+]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][-+]?\\d+)?)';
  const observation = new RegExp('^GB_OBS cycle=([01]) phase=([a-z-]+) tick=(\\d+) x='+number+' y='+number+' vx='+number+' vy='+number+' safe=(true|false) state=([a-z_]+) remaining=(-?\\d+) p=(true|false) h=(true|false) r=(true|false) left=(true|false) right=(true|false)$');
  let valid = true, lastTick = -1, mode = null, beginSeen = false, vectorsComplete = false, endSeen = false, readySeen = false, inputComplete = false;
  let baseline, pulse, pulseAfter, pulseSteps=0, pulseRecovery=0, pulseRestored=false;
  let press, inputReady, held=false, released=false, inputRecovery=0, inputRestored=false, activeSteps=0;
  const nearZero = value => Math.abs(value)<=0.01;
  const idle = value => !value.p && !value.h && !value.r && !value.left && !value.right && nearZero(value.vx);
  for (const line of lines) {
    if (!line.startsWith('GB_')) continue;
    if (endSeen) { valid=false; continue; }
    if (/^GB_PROBE_FAIL(?: |$)|^GB_CLEANUP_FAIL(?: |$)/.test(line)) { valid=false; continue; }
    if (line==='GB_PROBE_BEGIN') { if (beginSeen) valid=false; beginSeen=true; continue; }
    if (!beginSeen) { valid=false; continue; }
    if (/^GB_VECTOR [a-z-]+ \d+ error=(true|false)$/.test(line)) { if (vectorsComplete) valid=false; continue; }
    if (line==='GB_VECTORS_COMPLETE count=40') { if (vectorsComplete) valid=false; vectorsComplete=true; continue; }
    if (!vectorsComplete) { valid=false; continue; }
    if (line==='GB_INPUT_READY control=action cycle=1') { if (readySeen || !pulseRestored) valid=false; readySeen=true; continue; }
    if (line==='GB_INPUT_COMPLETE cycle=1') { if (inputComplete || !inputRestored) valid=false; inputComplete=true; continue; }
    const ending=line.match(/^GB_PROBE_END mode=(automatic|interactive) safeRestored=true stateRestored=true recoveryObserved=true$/);
    if (ending) { mode=ending[1]; endSeen=true; if (!pulseRestored || (mode==='interactive' ? !inputComplete : readySeen || inputComplete)) valid=false; continue; }
    const match=line.match(observation);
    if (!match) { valid=false; continue; }
    const value={cycle:Number(match[1]),phase:match[2],tick:Number(match[3]),x:Number(match[4]),y:Number(match[5]),vx:Number(match[6]),vy:Number(match[7]),safe:match[8]==='true',state:match[9],remaining:Number(match[10]),p:match[11]==='true',h:match[12]==='true',r:match[13]==='true',left:match[14]==='true',right:match[15]==='true'};
    if (![value.tick,value.x,value.y,value.vx,value.vy,value.remaining].every(Number.isFinite) || !Number.isSafeInteger(value.tick) || value.tick<=lastTick || (value.phase!=='settling' && (value.left || value.right))) { valid=false; continue; }
    lastTick=value.tick;
    if (value.cycle===0) {
      if (readySeen || value.state!=='not_bound' || value.remaining!==-1) { valid=false; continue; }
      if (value.phase==='settling') { if (baseline || pulse) valid=false; continue; }
      if (value.phase==='baseline') { if (baseline || !idle(value) || value.safe || !nearZero(value.vy)) valid=false; baseline=value; continue; }
      if (value.phase==='pulse-start') { if (!baseline || pulse || !value.safe || Math.abs(value.vx-120)>0.01 || value.p || value.h || value.r) valid=false; pulse=value; continue; }
      if (value.phase==='pulse-active' || value.phase==='pulse-after') {
        if (!pulse || pulseAfter || value.p || value.h || value.r || !value.safe) valid=false;
        pulseSteps+=1;
        if (value.phase==='pulse-after') { if (pulseSteps!==9 || !pulse || value.x<=pulse.x+0.01) valid=false; pulseAfter=value; }
        else if (pulseSteps>=9) valid=false;
        continue;
      }
      if (value.phase==='pulse-recovery' || value.phase==='pulse-restored') {
        if (!pulseAfter || pulseRestored || !idle(value) || value.safe!==baseline?.safe || Math.abs(value.x-pulseAfter.x)>0.05) valid=false;
        pulseRecovery+=1;
        if (value.phase==='pulse-restored') { if (pulseRecovery!==4) valid=false; pulseRestored=true; }
        else if (pulseRecovery>=4) valid=false;
        continue;
      }
      valid=false; continue;
    }
    if (!readySeen || !pulseRestored || inputComplete) { valid=false; continue; }
    if (value.phase==='armed') { if (press || value.state!=='ready' || value.remaining!==0 || value.safe!==baseline.safe || !nearZero(value.vx) || value.p) valid=false; continue; }
    if (value.phase==='press') { if (press || !value.p || !value.h || value.r || value.state!=='active' || value.remaining!==12 || !value.safe || Math.abs(value.vx-220)>0.01) valid=false; press=value; continue; }
    if (!press || value.p || inputRestored || (released && (value.h || value.r)) || (value.r && value.h)) { valid=false; continue; }
    if (value.h && !value.r) held=true;
    if (value.r) released=true;
    if (value.phase==='active' || value.phase==='ready') {
      activeSteps+=1;
      if (inputReady || activeSteps>12 || value.remaining!==12-activeSteps) valid=false;
      if (value.phase==='active') { if (activeSteps>=12 || value.state!=='active' || !value.safe || Math.abs(value.vx-220)>0.01) valid=false; }
      else { if (activeSteps!==12 || value.state!=='ready' || value.remaining!==0 || value.safe!==baseline.safe || !nearZero(value.vx) || value.x<=press.x+0.01) valid=false; inputReady=value; }
      continue;
    }
    if (!inputReady || value.state!=='ready' || value.remaining!==0 || value.safe!==baseline.safe || !nearZero(value.vx) || Math.abs(value.x-inputReady.x)>0.05) { valid=false; continue; }
    if (value.phase==='release') { if (!value.r || value.h || inputRecovery || !held) valid=false; continue; }
    if (value.phase==='release-wait') { if (inputRecovery || released) valid=false; continue; }
    if (value.phase==='recovery' || value.phase==='restored') {
      if (!held || !released || value.h || value.r) valid=false;
      inputRecovery+=1;
      if (value.phase==='restored') { if (inputRecovery!==4) valid=false; inputRestored=true; }
      else if (inputRecovery>=4) valid=false;
      continue;
    }
    valid=false;
  }
  const vectorsMatched = expected.length === seen.length && expected.every((item, index) => seen[index] === item) && lines.filter(line=>line==='GB_VECTORS_COMPLETE count=40').length===1;
  const complete = valid && endSeen && vectorsMatched;
  return {
    vectorsMatched,
    vectorSteps: vectors.length, expectedRejections: vectors.filter(item => item[3] === 'true').length,
    protocolValid: valid, stateWriteObserved: valid && Boolean(pulse), displacementObserved: valid && Boolean(pulseAfter),
    timingObserved: valid && Boolean(pulseAfter) && pulseSteps===9,
    automaticRecoveryObserved: valid && pulseRestored,
    inputPressObserved: valid && Boolean(press), inputReleaseObserved: valid && released,
    heldObserved: valid && held, boundEffectObserved: valid && Boolean(inputReady),
    inputCycleObserved: complete && mode==='interactive' && inputComplete && inputRestored,
    stateRestored: complete && pulseRestored && (mode==='automatic' || inputRestored),
    recoveryObserved: complete && pulseRecovery===4 && (mode==='automatic' || inputRecovery===4),
    cleanCompletion: complete,
    scope: 'trusted-native-interface-probe-only', realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false,
  };
}
