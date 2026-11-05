import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSuperTuxProbeLevel, makeSuperTuxProbeScript, inspectSuperTuxProbe } from '../src/hosts/supertux-probe.mjs';

// Explicit contract traces. These are parser inputs, never native game evidence.
const vectorCases = [
  ['timed-interlock', 9, [6, 7, 8]], ['resource-reservation', 11, [7, 9, 10]],
  ['sequence-window', 12, [11]], ['timed-pause-resume', 8, []],
];
function prefix() {
  return ['GB_PROBE_BEGIN', ...vectorCases.flatMap(([id, count, errors]) => Array.from({ length: count }, (_, index) => `GB_VECTOR ${id} ${index} error=${errors.includes(index)}`)), 'GB_VECTORS_COMPLETE count=40'];
}
function record(phase, tick, extra = {}) {
  const value = { cycle: 0, x: 256, y: 928, vx: 0, vy: 0, safe: false, state: 'not_bound', remaining: -1, p: false, h: false, r: false, left: false, right: false, ...extra };
  return `GB_OBS cycle=${value.cycle} phase=${phase} tick=${tick} x=${value.x} y=${value.y} vx=${value.vx} vy=${value.vy} safe=${value.safe} state=${value.state} remaining=${value.remaining} p=${value.p} h=${value.h} r=${value.r} left=${value.left} right=${value.right}`;
}
function automaticRows() {
  return [record('baseline', 5), record('pulse-start', 6, { vx: 120, safe: true }),
    ...Array.from({ length: 9 }, (_, index) => record(index===8 ? 'pulse-after' : 'pulse-active', 7+index, { x: 256+(index+1)/2, vx: 120-index*10, safe: true })),
    ...Array.from({ length: 4 }, (_, index) => record(index===3 ? 'pulse-restored' : 'pulse-recovery', 16+index, { x: 260.5 })),
  ];
}
const ending = mode => `GB_PROBE_END mode=${mode} safeRestored=true stateRestored=true recoveryObserved=true`;
function golden({ interactive = true, lateRelease = false } = {}) {
  const rows=[...prefix(),...automaticRows()];
  if (!interactive) return [...rows,ending('automatic')].join('\n');
  const input = { cycle: 1, x: 260.5, state: 'ready', remaining: 0 };
  rows.push('GB_INPUT_READY control=action cycle=1', record('armed',20,input),
    record('press',21,{...input,p:true,h:true,safe:true,vx:220,state:'active',remaining:12}));
  for (let step=1;step<=11;step++) rows.push(record('active',21+step,{...input,x:260.5+step*2,vx:220,safe:true,state:'active',remaining:12-step,h:lateRelease || step<7,r:!lateRelease && step===7}));
  const ready={...input,x:284.5,h:lateRelease};
  rows.push(record('ready',33,ready));
  let offset=0;
  if (lateRelease) {
    rows.push(record('release-wait',34,ready),record('release',35,{...ready,h:false,r:true})); offset=2;
  }
  for (let step=1;step<=4;step++) rows.push(record(step===4?'restored':'recovery',33+offset+step,{...ready,h:false}));
  rows.push('GB_INPUT_COMPLETE cycle=1',ending('interactive'));
  return rows.join('\n');
}
const assertRejected = log => {
  const parsed=inspectSuperTuxProbe(log);
  assert.equal(parsed.cleanCompletion,false);
  assert.equal(parsed.inputCycleObserved,false);
  assert.equal(parsed.stateRestored,false);
  assert.equal(parsed.recoveryObserved,false);
};

test('candidate probe refuses a changed original level and accepts no user source entry point', () => {
  assert.throws(() => makeSuperTuxProbeLevel('(supertux-level)', 'print("hi");'), /PINNED_PROBE_LEVEL_REQUIRED/);
  const script = makeSuperTuxProbeScript({interactive:true});
  assert.ok(!/use_scripting_controller|on_ground|debug-scripts/.test(script));
  assert.ok(!/\b(?:system|exec|dofile|loadfile|import)\s*\(/.test(script));
  assert.ok(!/\bset_pos\s*\(/.test(script));
  assert.equal(makeSuperTuxProbeScript({malformed:true}), 'local rejected = ;\nprint("GB_UNREACHABLE\\n");');
});

test('complete automatic trace independently records scheduler progress, physical displacement and post-update recovery', () => {
  const parsed=inspectSuperTuxProbe(golden({interactive:false}));
  assert.equal(parsed.protocolValid,true);
  assert.equal(parsed.vectorsMatched,true);
  assert.equal(parsed.vectorSteps,40);
  assert.equal(parsed.expectedRejections,7);
  for (const field of ['stateWriteObserved','timingObserved','displacementObserved','automaticRecoveryObserved','stateRestored','recoveryObserved','cleanCompletion']) assert.equal(parsed[field],true,field);
  assert.equal(parsed.inputCycleObserved,false);
  assert.equal(parsed.heldObserved,false);
  assert.equal(parsed.realModBuild,'not_run');
  assert.equal(parsed.conversionGameAcceptance,'not_run');
  assert.equal(parsed.readyToInstall,false);
});

test('press, later held, release, twelve state updates and four stable recovery observations belong to one cycle', () => {
  for (const lateRelease of [false,true]) {
    const parsed=inspectSuperTuxProbe(golden({lateRelease}));
    for (const field of ['protocolValid','vectorsMatched','inputPressObserved','heldObserved','inputReleaseObserved','boundEffectObserved','inputCycleObserved','stateRestored','recoveryObserved','cleanCompletion']) assert.equal(parsed[field],true,field);
  }
  const prefixed=golden().split('\n').map(line=>'[SCRIPTING] '+line).join('\r\n');
  assert.equal(inspectSuperTuxProbe(prefixed).inputCycleObserved,true);
});

test('partial vectors, missing native observations and the previous substring spoof never count as completion', () => {
  assertRejected('GB_VECTORS_COMPLETE count=40\nGB_PROBE_END safeRestored=true');
  assertRejected('GB_INPUT n=20 p=true h=true r=false\nGB_BOUND_BEGIN x=100\nGB_BOUND_END x=101 remaining=0\nGB_INPUT n=1 p=false h=false r=true\nGB_PROBE_END safeRestored=true-not-really');
  assertRejected(golden().replace('GB_VECTORS_COMPLETE count=40\n',''));
  assertRejected(golden().replace('GB_VECTOR timed-interlock 0 error=false\n',''));
  assertRejected(golden().replace(ending('interactive'),ending('interactive')+'-not-really'));
  assertRejected(golden().replace('GB_INPUT_COMPLETE cycle=1\n',''));
});

test('duplicate headers, cycles, phases, or backwards ticks cannot be combined into a successful input cycle', () => {
  assertRejected('GB_PROBE_BEGIN\n'+golden());
  assertRejected(golden().replace('phase=active tick=22','phase=active tick=20'));
  assertRejected(golden().replace('cycle=1 phase=ready','cycle=0 phase=ready'));
  assertRejected(golden().replace('cycle=1 phase=active','cycle=2 phase=active'));
  assertRejected(golden().replace('GB_INPUT_READY control=action cycle=1','GB_INPUT_READY control=action cycle=1\nGB_INPUT_READY control=action cycle=1'));
  assertRejected(golden()+'\n'+ending('interactive'));
  assertRejected(golden().replace('phase=active tick=22','phase=press tick=22'));
});

test('held and release are separately observed after the actual press and cannot be supplied by an unrelated cycle', () => {
  const rows=golden().split('\n');
  const noHeld=rows.map(line=>line.includes('phase=active')?line.replace(' h=true',' h=false'):line).join('\n');
  assertRejected(noHeld);
  const noRelease=rows.map(line=>line.includes('phase=active')?line.replace(' r=true',' r=false'):line).join('\n');
  assertRejected(noRelease);
  assertRejected(golden().replace('phase=armed tick=20','phase=release tick=20'));
  assertRejected(golden().replace('remaining=10 p=false h=true r=false','remaining=10 p=true h=true r=false'));
});

test('zero, nonfinite and unrelated displacement cannot stand in for physical motion', () => {
  assertRejected(golden().replace('phase=pulse-after tick=15 x=260.5','phase=pulse-after tick=15 x=256'));
  assertRejected(golden().replace('phase=ready tick=33 x=284.5','phase=ready tick=33 x=260.5'));
  assertRejected(golden().replace('phase=ready tick=33 x=284.5','phase=ready tick=33 x=1e999'));
  assertRejected(golden().replace('phase=ready tick=33 x=284.5','phase=ready tick=33 x=NaN'));
  assertRejected(golden().replace('phase=press tick=21 x=260.5','phase=press tick=21 x=-1e999'));
});

test('ready state, restored safety, zero speed and several stable native updates are all required', () => {
  assertRejected(golden().replace('phase=ready tick=33 x=284.5 y=928 vx=0 vy=0 safe=false state=ready','phase=ready tick=33 x=284.5 y=928 vx=0 vy=0 safe=false state=active'));
  assertRejected(golden().replace('phase=ready tick=33 x=284.5 y=928 vx=0 vy=0 safe=false','phase=ready tick=33 x=284.5 y=928 vx=220 vy=0 safe=false'));
  assertRejected(golden().replace('phase=restored tick=37 x=284.5 y=928 vx=0 vy=0 safe=false','phase=restored tick=37 x=284.5 y=928 vx=0 vy=0 safe=true'));
  assertRejected(golden().replace('phase=recovery tick=35 x=284.5','phase=recovery tick=35 x=285.5'));
  assertRejected(golden().split('\n').filter(line=>!line.includes('phase=recovery tick=34')).join('\n'));
  assertRejected(golden().replace('phase=pulse-restored tick=19 x=260.5','phase=pulse-restored tick=19 x=270'));
  assertRejected(golden().replace('remaining=0 p=false h=false r=false left=false right=false','remaining=0 p=false h=false r=false left=true right=false'));
  assertRejected(golden().replace('GB_INPUT_COMPLETE cycle=1','GB_PROBE_FAIL code=BOUND_RECOVERY_FAILED\nGB_INPUT_COMPLETE cycle=1'));
});
