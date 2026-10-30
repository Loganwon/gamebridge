import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTION_BLUEPRINT_LIMITS, ACTION_BLUEPRINT_SCHEMA_EXAMPLE, createActionExample, validateActionBlueprint, serializeActionProposal } from '../src/actions/spec.mjs';
import { createActionScenarios, simulateActionBlueprint } from '../src/actions/runtime.mjs';

function proposal(variant = 'hit-confirm') {
  const { request, blueprint } = createActionExample(variant);
  return { request, raw: serializeActionProposal(blueprint) };
}
function changed(change, variant = 'hit-confirm') {
  const { request, raw } = proposal(variant);
  change(raw);
  return validateActionBlueprint(raw, request);
}
function rejects(change, expression) {
  const { request, raw } = proposal();
  change(raw);
  assert.throws(() => validateActionBlueprint(raw, request), expression || { code: 'INVALID_ACTION_BLUEPRINT' });
}
function replay(blueprint, events, { durationTicks = 30, ...rest } = {}) {
  return simulateActionBlueprint(blueprint, { durationTicks, events, ...rest });
}
function started(result) { return result.trace.filter(item => item.type === 'action_started').map(item => item.actionId); }
const input = (tick, value = 'attack') => ({ tick, type: 'input', input: value });

test('action blueprint preserves direction, exact original request and unverified local state on repeated validation', () => {
  const { request, blueprint } = createActionExample();
  assert.equal(blueprint.hostGame, 'bannerlord');
  assert.deepEqual(blueprint.originalRequest, request);
  assert.equal(blueprint.sourceVerification, 'not_verified');
  assert.equal(blueprint.realModBuild, 'not_run');
  assert.equal(blueprint.game, 'not_run');
  assert.equal(blueprint.readyToInstall, false);
  assert.deepEqual(blueprint.coverage.unresolvedIds, ['host-integration']);
  assert.equal(blueprint.coverage.semanticCoverage, 'not_verified');
  assert.deepEqual(validateActionBlueprint(blueprint, request), blueprint);
  assert.deepEqual(validateActionBlueprint(serializeActionProposal(blueprint), request), blueprint);
  assert.equal(Object.hasOwn(serializeActionProposal(blueprint), 'readyToInstall'), false);
  assert.throws(() => validateActionBlueprint({ ...blueprint, readyToInstall: true }, request), /locally determined/);
  assert.throws(() => serializeActionProposal({ ...blueprint, readyToInstall: true }), /locally determined/);
  assert.throws(() => validateActionBlueprint({ ...blueprint, coverage: { ...blueprint.coverage, semanticCoverage: 'passed' } }, request), /locally determined/);
  assert.throws(() => validateActionBlueprint({ ...blueprint, originalRequest: { ...request, description: 'changed' } }, request), /locally determined/);
  assert.throws(() => validateActionBlueprint({ ...serializeActionProposal(blueprint), hostGame: request.sourceGame, sourceGame: request.hostGame }, request), /direction/);
});

test('action schema example is a complete proposal with explicit unknown host version and self-authored provenance', () => {
  const { request } = createActionExample();
  const blueprint = validateActionBlueprint(ACTION_BLUEPRINT_SCHEMA_EXAMPLE, request);
  assert.equal(blueprint.hostVersion, 'unknown');
  assert.equal(blueprint.sourceGame, 'gamebridge-reference-actions');
  assert.match(blueprint.limitations[0], /未调用模型/);
  assert.deepEqual(blueprint.source.references, []);
  assert.throws(() => createActionExample('imaginary-supported-game'), { code: 'INVALID_ACTION_BLUEPRINT' });
});

test('a near-limit proposal remains valid after bounded local metadata is attached', () => {
  const { raw, request } = proposal();
  request.description = 'x'.repeat(8000);
  raw.requirements = Array.from({ length: 28 }, (_, index) => ({ id: `r${index}`, description: 'x'.repeat(1950),
    required: true, disposition: 'rule', actionIds: ['light-1', 'light-2', 'dodge'] }));
  const bytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  assert.ok(bytes(raw) < ACTION_BLUEPRINT_LIMITS.maxBytes);
  const blueprint = validateActionBlueprint(raw, request);
  assert.ok(bytes(blueprint) > ACTION_BLUEPRINT_LIMITS.maxBytes);
  assert.ok(bytes(blueprint) <= ACTION_BLUEPRINT_LIMITS.maxNormalizedBytes);
  assert.deepEqual(blueprint.originalRequest, request);
  assert.deepEqual(validateActionBlueprint(blueprint, request), blueprint);
  assert.deepEqual(validateActionBlueprint(serializeActionProposal(blueprint), request), blueprint);
  assert.equal(simulateActionBlueprint(blueprint, { durationTicks: 1, events: [] }).game, 'not_run');
  assert.throws(() => validateActionBlueprint({ ...blueprint, readyToInstall: true }, request), /locally determined/);
  assert.throws(() => serializeActionProposal({ ...blueprint, coverage: { ...blueprint.coverage, semanticCoverage: 'passed' } }), /locally determined/);

  raw.requirements = Array.from({ length: 32 }, (_, index) => ({ id: `r${index}`, description: 'x'.repeat(2000),
    required: true, disposition: 'rule', actionIds: ['light-1', 'light-2', 'dodge'] }));
  assert.ok(bytes(raw) > ACTION_BLUEPRINT_LIMITS.maxBytes);
  assert.throws(() => validateActionBlueprint(raw, request), /64 KiB/);
  assert.throws(() => validateActionBlueprint({ ...raw, scope: 'action-blueprint-only' }, request), /64 KiB/);
});

test('normalization expansion is checked before a blueprint is accepted', () => {
  const { raw, request } = proposal();
  raw.requirements = Array.from({ length: 28 }, (_, index) => ({ id: `r${index}`, description: 'x'.repeat(1950),
    required: true, disposition: 'rule', actionIds: ['light-1', 'light-2', 'dodge'] }));
  raw.limitations = [];
  const bytes = () => new TextEncoder().encode(JSON.stringify(raw)).byteLength;
  const target = ACTION_BLUEPRINT_LIMITS.maxBytes - 6;
  while (bytes() < target) raw.limitations.push('z'.repeat(Math.min(600, target - bytes() - (raw.limitations.length ? 3 : 2))));
  assert.ok(bytes() <= ACTION_BLUEPRINT_LIMITS.maxBytes);
  assert.throws(() => validateActionBlueprint(raw, request), /64 KiB/);
  const reference = proposal();
  reference.raw.source.references = ['https://example.com/' + '界'.repeat(100)];
  assert.throws(() => validateActionBlueprint(reference.raw, reference.request), /Normalized source reference/);
});

test('non-JSON shapes, inherited prototypes, accessors, cycles, sparse arrays and amplification are refused', () => {
  rejects(raw => { raw.extra = true; });
  rejects(raw => { raw.actions[0].execute = 'shell'; });
  rejects(raw => { Object.setPrototypeOf(raw.stamina, { max: 100 }); });
  rejects(raw => { Object.defineProperty(raw.actions[0], '__proto__', { value: {} }); });
  let invoked = false;
  rejects(raw => { Object.defineProperty(raw.source, 'version', { get() { invoked = true; return '1'; } }); });
  assert.equal(invoked, false);
  rejects(raw => { raw.source.toJSON = () => { invoked = true; return {}; }; });
  assert.equal(invoked, false);
  const { raw: unsafe } = proposal();
  unsafe.source.toJSON = () => { invoked = true; return {}; };
  assert.throws(() => serializeActionProposal(unsafe), /finite JSON tree/);
  assert.equal(invoked, false);
  rejects(raw => { raw.source.references = [raw]; });
  rejects(raw => { raw.source.references = new Array(1); raw.source.references.fake = 'https://example.com'; });
  rejects(raw => { raw.stamina.max = Infinity; });
  rejects(raw => { raw.requirements[0].description = 'x'.repeat(ACTION_BLUEPRINT_LIMITS.maxBytes + 1); });
  rejects(raw => { raw.source.references = ['http://example.com']; });
  rejects(raw => { raw.source.references = ['https://user:secret@example.com']; });
  rejects(raw => { raw.source.references = ['https://example.local']; });
});

test('array amplification and deep JSON are rejected before serialization can expand them', () => {
  rejects(raw => { raw.actions = new Array(2 ** 32 - 1); });
  const { raw } = proposal();
  raw.actions = new Array(2 ** 32 - 1);
  assert.throws(() => serializeActionProposal(raw), /array structure/);
  rejects(raw => {
    let deep = {};
    for (let index = 0; index < 30; index++) deep = { child: deep };
    raw.source.references = [deep];
  }, /nesting/);
});

test('action timing, resources, transition targets and reachability have strict bounds', () => {
  for (const value of [0, -1, 601, 1.5, Number.MAX_SAFE_INTEGER]) rejects(raw => { raw.actions[0].durationTicks = value; });
  rejects(raw => { raw.stamina.max = 1001; });
  rejects(raw => { raw.stamina.regenPerTick = 21; });
  rejects(raw => { raw.actions[0].staminaCost = 101; });
  rejects(raw => { raw.actions[0].hitWindow.endTick = 13; });
  rejects(raw => { raw.actions[0].hitWindow.startTick = 5; });
  rejects(raw => { raw.actions[2].hitWindow = { startTick: 0, endTick: 1 }; });
  rejects(raw => { raw.actions[0].transitions[0].windowEndTick = 13; });
  rejects(raw => { raw.actions[0].transitions[0].windowStartTick = 0; raw.actions[0].transitions[0].windowEndTick = 3; });
  rejects(raw => { raw.actions[0].transitions[0].to = 'missing'; });
  rejects(raw => { raw.entryActions[0].actionId = 'missing'; });
  rejects(raw => { raw.actions[0].transitions = []; });
  rejects(raw => { raw.entryActions.push({ ...raw.entryActions[0] }); });
  rejects(raw => { raw.actions[0].transitions.push({ ...raw.actions[0].transitions[0], condition: 'always' }); });
});

test('required feature gaps survive normalization and rule claims must reference declared actions', () => {
  rejects(raw => { raw.requirements[0].actionIds = []; });
  rejects(raw => { raw.requirements[0].actionIds = ['missing']; });
  rejects(raw => { raw.requirements[0].actionIds = ['light-1', 'light-1']; });
  rejects(raw => { raw.requirements.forEach(item => { item.required = false; }); });
  rejects(raw => { raw.requirements.forEach(item => { item.actionIds = item.actionIds.filter(id => id !== 'dodge'); }); });
  const blueprint = changed(raw => {
    raw.assetRequirements.push('用户提供的可用武器动画，尚未导入。');
    raw.requirements.push({ id: 'weapon-animation', description: '来源武器动作资源', required: true, disposition: 'needs_assets', actionIds: [] });
  });
  assert.deepEqual(blueprint.coverage.unresolvedIds, ['host-integration', 'weapon-animation']);
  assert.equal(blueprint.coverage.requiredCount, 5);
  assert.equal(blueprint.coverage.ruleMappedCount, 3);
  assert.equal(blueprint.coverage.semanticCoverage, 'not_verified');
});

test('attack startup, active, recovery and completion use exact half-open tick windows', () => {
  const { blueprint } = createActionExample();
  const result = replay(blueprint, [input(0), { tick: 2, type: 'hit' }, { tick: 3, type: 'hit' }, { tick: 5, type: 'hit' }], { durationTicks: 12 });
  assert.deepEqual(result.trace.filter(item => item.type === 'phase_changed').map(item => [item.tick, item.phase]), [[0, 'startup'], [3, 'active'], [5, 'recovery'], [12, 'idle']]);
  assert.deepEqual(result.trace.filter(item => item.type === 'hit_confirmed').map(item => item.tick), [3]);
  assert.deepEqual(result.trace.filter(item => item.type === 'hit_ignored').map(item => item.tick), [2, 5]);
  assert.equal(result.finalState.actionId, null);
  assert.equal(result.finalState.stamina, 75);
  assert.equal(result.scope, 'action-rules-simulation-only');
  assert.equal(result.realModBuild, 'not_run');
  assert.equal(result.game, 'not_run');
  assert.equal(result.readyToInstall, false);
});

test('confirmed-hit combo requires a simulated active-window hit and observes cancel-window boundaries', () => {
  const { blueprint } = createActionExample();
  const success = replay(blueprint, [input(0), { tick: 3, type: 'hit' }, input(5)]);
  assert.deepEqual(started(success), ['light-1', 'light-2']);
  assert.equal(success.trace.find(item => item.type === 'hit_confirmed').evidence, 'scenario-event-only');
  const whiff = replay(blueprint, [input(0), input(5)]);
  assert.deepEqual(started(whiff), ['light-1']);
  assert.ok(whiff.trace.some(item => item.reason === 'hit_required'));
  const early = replay(blueprint, [input(0), { tick: 3, type: 'hit' }, input(4)]);
  assert.deepEqual(started(early), ['light-1']);
  const late = replay(blueprint, [input(0), { tick: 3, type: 'hit' }, input(10)]);
  assert.deepEqual(started(late), ['light-1']);
});

test('same-tick event ordering is explicit and never sorts a hit before an earlier input', () => {
  const blueprint = changed(raw => { raw.actions[0].hitWindow.endTick = 6; });
  const confirmedFirst = replay(blueprint, [input(0), { tick: 5, type: 'hit' }, input(5)]);
  const inputFirst = replay(blueprint, [input(0), input(5), { tick: 5, type: 'hit' }]);
  assert.deepEqual(started(confirmedFirst), ['light-1', 'light-2']);
  assert.deepEqual(started(inputFirst), ['light-1']);
});

test('default replay finds a confirmed hit inside a transition that opens before the active window', () => {
  const blueprint = changed(raw => { raw.actions[0].transitions[0].windowStartTick = 0; });
  const scenarios = createActionScenarios(blueprint);
  const positive = scenarios.find(item => item.name === '转换 1 有模拟命中');
  assert.ok(positive);
  const hitIndex = positive.events.findIndex(item => item.type === 'hit');
  assert.deepEqual(positive.events.slice(hitIndex, hitIndex + 2), [{ tick: 3, type: 'hit' }, input(3)]);
  assert.deepEqual(started(simulateActionBlueprint(blueprint, positive)), ['light-1', 'light-2']);
  const whiff = scenarios.find(item => item.name === '转换 1 无命中');
  assert.deepEqual(started(simulateActionBlueprint(blueprint, whiff)), ['light-1']);
});

test('default replay reaches later actions with the necessary synthetic hit prefix', () => {
  const blueprint = changed(raw => {
    raw.actions[1].transitions.push({ input: 'attack', to: 'light-3', windowStartTick: 0, windowEndTick: 10, condition: 'hit_confirmed' });
    raw.actions.push({ id: 'light-3', kind: 'attack', durationTicks: 15, staminaCost: 20, interruptible: true,
      hitWindow: { startTick: 2, endTick: 5 }, transitions: [] });
    raw.requirements[0].actionIds.push('light-3');
  });
  const scenarios = createActionScenarios(blueprint);
  const later = scenarios.find(item => item.name === '动作 light-3：动作完整生命周期');
  assert.ok(later);
  const result = simulateActionBlueprint(blueprint, later);
  assert.deepEqual(started(result), ['light-1', 'light-2', 'light-3']);
  assert.equal(result.trace.filter(item => item.type === 'hit_confirmed').length, 2);
  assert.equal(result.finalState.phase, 'idle');
  assert.equal(result.sourceVerification, 'not_verified');
  assert.equal(result.readyToInstall, false);
});

test('default replay keeps resource- and time-limited paths partial without rejecting valid rules', () => {
  const resources = changed(raw => { raw.stamina.max = 25; });
  const limited = createActionScenarios(resources);
  assert.ok(limited.length > 0);
  assert.ok(!limited.some(item => item.name === '动作 light-2：动作完整生命周期'));
  for (const scenario of limited) assert.equal(simulateActionBlueprint(resources, scenario).game, 'not_run');
  const timed = changed(raw => {
    raw.actions = Array.from({ length: 8 }, (_, index) => ({ id: `stage-${index}`, kind: 'attack', durationTicks: 600,
      staminaCost: 0, interruptible: true, hitWindow: { startTick: 1, endTick: 2 },
      transitions: index === 7 ? [] : [{ input: 'attack', to: `stage-${index + 1}`, windowStartTick: 599, windowEndTick: 600, condition: 'always' }] }));
    raw.entryActions = [{ input: 'attack', actionId: 'stage-0' }];
    raw.requirements = [{ id: 'long-chain', description: '超过单场景时间预算的长链。', required: true, disposition: 'rule', actionIds: raw.actions.map(item => item.id) }];
  });
  const longScenarios = createActionScenarios(timed);
  assert.ok(longScenarios.length > 0);
  assert.ok(!longScenarios.some(item => item.name === '动作 stage-7：动作完整生命周期'));
  for (const scenario of longScenarios) {
    assert.ok(scenario.durationTicks <= ACTION_BLUEPRINT_LIMITS.maxScenarioTicks);
    assert.ok(scenario.events.length <= ACTION_BLUEPRINT_LIMITS.maxScenarioEvents);
    assert.equal(simulateActionBlueprint(timed, scenario).game, 'not_run');
  }
});

test('dense cyclic rules produce a bounded deterministic replay set rather than enumerating paths', () => {
  const blueprint = changed(raw => {
    raw.actions = Array.from({ length: 16 }, (_, index) => ({ id: `node-${index}`, kind: 'attack', durationTicks: 1,
      staminaCost: 0, interruptible: true, hitWindow: { startTick: 0, endTick: 1 },
      transitions: Array.from({ length: 8 }, (_, edge) => ({ input: `next-${edge}`, to: `node-${(index + edge + 1) % 16}`,
        windowStartTick: 0, windowEndTick: 1, condition: 'always' })) }));
    raw.entryActions = [{ input: 'attack', actionId: 'node-0' }];
    raw.requirements = [{ id: 'cyclic-chain', description: '有界循环规则测试。', required: true, disposition: 'rule', actionIds: raw.actions.map(item => item.id) }];
  });
  const scenarios = createActionScenarios(blueprint);
  assert.equal(scenarios.length, ACTION_BLUEPRINT_LIMITS.maxGeneratedScenarios);
  assert.deepEqual(createActionScenarios(blueprint), scenarios);
  assert.equal(scenarios.filter(item => item.name.endsWith('动作完整生命周期')).length, 16);
  for (const scenario of scenarios) {
    const result = simulateActionBlueprint(blueprint, scenario);
    assert.ok(scenario.durationTicks <= ACTION_BLUEPRINT_LIMITS.maxScenarioTicks);
    assert.ok(scenario.events.length <= ACTION_BLUEPRINT_LIMITS.maxScenarioEvents);
    assert.ok(result.trace.length <= ACTION_BLUEPRINT_LIMITS.maxTraceEntries);
    assert.equal(result.game, 'not_run');
  }
});

test('confirmed hits belong to one action and do not leak into a new combo stage', () => {
  const blueprint = changed(raw => {
    raw.actions[1].transitions.push({ input: 'attack', to: 'light-1', windowStartTick: 6, windowEndTick: 10, condition: 'hit_confirmed' });
  });
  const firstStageOnly = replay(blueprint, [input(0), { tick: 3, type: 'hit' }, input(5), input(11)]);
  assert.deepEqual(started(firstStageOnly), ['light-1', 'light-2']);
  assert.ok(firstStageOnly.trace.some(item => item.tick === 11 && item.reason === 'hit_required'));
  const bothStages = replay(blueprint, [input(0), { tick: 3, type: 'hit' }, input(5), { tick: 9, type: 'hit' }, input(11)]);
  assert.deepEqual(started(bothStages), ['light-1', 'light-2', 'light-1']);
});

test('dodge cancellation, attack interruption and non-interruptible dodge follow distinct rules', () => {
  const { blueprint } = createActionExample();
  assert.deepEqual(started(replay(blueprint, [input(0), input(5, 'dodge')])), ['light-1']);
  const cancel = replay(blueprint, [input(0), input(6, 'dodge')]);
  assert.deepEqual(started(cancel), ['light-1', 'dodge']);
  assert.equal(cancel.trace.find(item => item.actionId === 'dodge' && item.type === 'action_started').from, 'light-1');
  const afterComplete = replay(blueprint, [input(0), input(12, 'dodge')]);
  assert.equal(afterComplete.trace.find(item => item.actionId === 'dodge' && item.type === 'action_started').from, null);
  const interrupt = replay(blueprint, [input(0), { tick: 1, type: 'hurt' }], { durationTicks: 2 });
  assert.ok(interrupt.trace.some(item => item.type === 'interrupted' && item.actionId === 'light-1'));
  assert.equal(interrupt.finalState.actionId, null);
  assert.equal(interrupt.finalState.stamina, 76);
  const dodge = replay(blueprint, [input(0, 'dodge'), { tick: 1, type: 'hurt' }], { durationTicks: 2 });
  assert.equal(dodge.finalState.actionId, 'dodge');
  assert.ok(dodge.trace.some(item => item.reason === 'not_interruptible'));
});

test('resource checks do not cancel the existing action, active actions do not regenerate, and reset is bounded', () => {
  const { blueprint } = createActionExample();
  const blockedEntry = replay(blueprint, [input(0)], { durationTicks: 1, initialStamina: 24 });
  assert.equal(blockedEntry.finalState.actionId, null);
  assert.equal(blockedEntry.finalState.stamina, 25);
  const blockedCancel = replay(blueprint, [input(0), input(6, 'dodge')], { durationTicks: 7, initialStamina: 25 });
  assert.equal(blockedCancel.finalState.actionId, 'light-1');
  assert.equal(blockedCancel.finalState.stamina, 0);
  assert.ok(blockedCancel.trace.some(item => item.reason === 'insufficient_stamina' && item.required === 15));
  const recovered = replay(blueprint, [input(0)], { durationTicks: 13, initialStamina: 25 });
  assert.equal(recovered.finalState.stamina, 1);
  const reset = replay(blueprint, [input(0), { tick: 1, type: 'reset' }], { durationTicks: 2 });
  assert.equal(reset.finalState.stamina, 100);
  assert.equal(reset.finalState.actionId, null);
});

test('three authored examples produce behavior differences, with no game or source-fidelity claim', () => {
  const hitConfirm = createActionExample('hit-confirm').blueprint;
  const freeChain = createActionExample('free-chain').blueprint;
  const committed = createActionExample('committed-attack').blueprint;
  const whiff = [input(0), input(5)];
  assert.deepEqual(started(replay(hitConfirm, whiff)), ['light-1']);
  assert.deepEqual(started(replay(freeChain, whiff)), ['light-1', 'light-2']);
  const cancel = [input(0), input(6, 'dodge')];
  assert.deepEqual(started(replay(hitConfirm, cancel)), ['light-1', 'dodge']);
  assert.deepEqual(started(replay(committed, cancel)), ['light-1']);
  const cancelScenario = blueprint => createActionScenarios(blueprint).find(item => item.name === '攻击中尝试另一入口动作');
  assert.deepEqual(started(simulateActionBlueprint(hitConfirm, cancelScenario(hitConfirm))), ['light-1', 'dodge']);
  assert.deepEqual(started(simulateActionBlueprint(committed, cancelScenario(committed))), ['light-1']);
  for (const blueprint of [hitConfirm, freeChain, committed]) {
    assert.equal(blueprint.sourceVerification, 'not_verified');
    assert.equal(blueprint.readyToInstall, false);
    for (const scenario of createActionScenarios(blueprint)) {
      const result = simulateActionBlueprint(blueprint, scenario);
      assert.equal(result.scope, 'action-rules-simulation-only');
      assert.equal(result.game, 'not_run');
    }
  }
});

test('scenario structure, order, counts and duration are bounded before execution', () => {
  const { blueprint } = createActionExample();
  const invalid = scenario => assert.throws(() => simulateActionBlueprint(blueprint, scenario), { code: 'INVALID_ACTION_SCENARIO' });
  invalid({ durationTicks: 3601, events: [] });
  invalid({ durationTicks: 0, events: [] });
  invalid({ durationTicks: 10, events: [input(5), input(4)] });
  invalid({ durationTicks: 10, events: [input(10)] });
  invalid({ durationTicks: 10, events: [{ tick: 0, type: 'network', url: 'https://example.com' }] });
  invalid({ durationTicks: 10, events: [{ tick: 0, type: 'hit', verified: true }] });
  invalid({ durationTicks: 10, events: [{ tick: 0, type: 'hit', input: 'attack' }] });
  let invoked = false;
  const accessor = { tick: 0 };
  Object.defineProperty(accessor, 'type', { get() { invoked = true; return 'input'; } });
  invalid({ durationTicks: 10, events: [accessor] });
  assert.equal(invoked, false);
  invalid({ durationTicks: 10, initialStamina: 101, events: [] });
  invalid({ durationTicks: 10, events: Array.from({ length: 257 }, () => input(0)) });
  invalid({ durationTicks: 10, events: new Array(1) });
});

test('input-driven graph cycles stay finite and cannot perform unbounded automatic transitions', () => {
  const blueprint = changed(raw => {
    raw.stamina.regenPerTick = 0;
    raw.actions = [{ id: 'loop', kind: 'attack', durationTicks: 1, staminaCost: 0, interruptible: true,
      hitWindow: { startTick: 0, endTick: 1 }, transitions: [{ input: 'attack', to: 'loop', windowStartTick: 0, windowEndTick: 1, condition: 'always' }] }];
    raw.entryActions = [{ input: 'attack', actionId: 'loop' }];
    raw.requirements = [{ id: 'loop-rule', description: '有限输入驱动的循环，仅用于测试边界。', required: true, disposition: 'rule', actionIds: ['loop'] }];
  });
  const result = replay(blueprint, Array.from({ length: 256 }, () => input(0)), { durationTicks: 3600 });
  assert.equal(started(result).length, 256);
  assert.ok(result.trace.length < ACTION_BLUEPRINT_LIMITS.maxTraceEntries);
  assert.equal(result.finalState.actionId, null);
  assert.equal(result.finalState.stamina, 100);
  for (const scenario of createActionScenarios(blueprint)) assert.equal(simulateActionBlueprint(blueprint, scenario).game, 'not_run');
});

test('unrepresentable requests preserve mandatory gaps without inventing an executable action', () => {
  const blueprint = changed(raw => {
    raw.actions = [];
    raw.entryActions = [];
    raw.requirements = [
      { id: 'flight-controller', description: '来源游戏的飞行控制器不在当前动作表达范围。', required: true, disposition: 'needs_adapter', actionIds: [] },
      { id: 'character-assets', description: '需要来源角色的可用资源。', required: true, disposition: 'needs_assets', actionIds: [] },
    ];
  });
  assert.deepEqual(blueprint.coverage.unresolvedIds, ['flight-controller', 'character-assets']);
  assert.equal(blueprint.coverage.ruleMappedCount, 0);
  assert.deepEqual(createActionScenarios(blueprint), []);
  const result = replay(blueprint, [input(0), { tick: 1, type: 'hit' }]);
  assert.deepEqual(started(result), []);
  assert.equal(result.finalState.phase, 'idle');
  assert.equal(result.readyToInstall, false);
  assert.equal(result.game, 'not_run');
});
