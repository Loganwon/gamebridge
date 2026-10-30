import { ACTION_BLUEPRINT_LIMITS, validateActionBlueprint, actionObject, actionText, actionArray, actionInteger } from './spec.mjs';

export class ActionSimulationError extends Error {
  constructor(code, message) { super(message); this.name = 'ActionSimulationError'; this.code = code; }
}
function fail(message) { throw new ActionSimulationError('INVALID_ACTION_SCENARIO', message); }

function validateScenario(raw, blueprint) {
  try {
    actionObject(raw, ['name', 'durationTicks', 'initialStamina', 'events'], 'action scenario');
    const name = raw.name === undefined ? '动作规则场景' : actionText(raw.name, 'scenario name', 120);
    const durationTicks = actionInteger(raw.durationTicks, 'scenario duration', 1, ACTION_BLUEPRINT_LIMITS.maxScenarioTicks);
    const initialStamina = raw.initialStamina === undefined ? blueprint.stamina.max : actionInteger(raw.initialStamina, 'initial stamina', 0, blueprint.stamina.max);
    let previousTick = -1;
    const events = actionArray(raw.events, 'scenario events', ACTION_BLUEPRINT_LIMITS.maxScenarioEvents).map(item => {
      actionObject(item, ['tick', 'type', 'input'], 'scenario event');
      const tick = actionInteger(item.tick, 'event tick', 0, durationTicks - 1);
      if (tick < previousTick) fail('Scenario events must be ordered by tick; same-tick order is significant.');
      previousTick = tick;
      if (!['input', 'hit', 'hurt', 'reset'].includes(item.type)) fail('Unknown scenario event type.');
      if (item.type === 'input') {
        const input = actionText(item.input, 'scenario input', 40);
        if (!/^[a-z][a-z0-9_-]{0,39}$/.test(input) || ['constructor', 'prototype'].includes(input)) fail('Invalid scenario input.');
        return { tick, type: item.type, input };
      }
      if (Object.hasOwn(item, 'input')) fail('Only input events may declare an input.');
      return { tick, type: item.type };
    });
    return { name, durationTicks, initialStamina, events };
  } catch (error) {
    if (error instanceof ActionSimulationError) throw error;
    throw new ActionSimulationError('INVALID_ACTION_SCENARIO', error.message);
  }
}

/** Executes only a bounded data state machine, never host APIs, generated code or assets. */
export function simulateActionBlueprint(rawBlueprint, rawScenario) {
  const blueprint = validateActionBlueprint(rawBlueprint, rawBlueprint?.originalRequest);
  const scenario = validateScenario(rawScenario, blueprint);
  const byId = new Map(blueprint.actions.map(item => [item.id, item]));
  const entries = new Map(blueprint.entryActions.map(item => [item.input, item.actionId]));
  const trace = [];
  const state = { actionId: null, startedAt: null, stamina: scenario.initialStamina, hitConfirmed: false, phase: 'idle' };
  function record(tick, type, details = {}) {
    if (trace.length >= ACTION_BLUEPRINT_LIMITS.maxTraceEntries) throw new ActionSimulationError('ACTION_TRACE_LIMIT', 'Action simulation trace exceeded its limit.');
    trace.push({ tick, type, ...details });
  }
  function phaseAt(tick) {
    if (state.actionId === null) return 'idle';
    const action = byId.get(state.actionId);
    if (action.kind === 'dodge') return 'dodge';
    const elapsed = tick - state.startedAt;
    return elapsed < action.hitWindow.startTick ? 'startup' : elapsed < action.hitWindow.endTick ? 'active' : 'recovery';
  }
  function updatePhase(tick) {
    const phase = phaseAt(tick);
    if (phase !== state.phase) { state.phase = phase; record(tick, 'phase_changed', { actionId: state.actionId, phase }); }
  }
  function clear(tick, type) {
    const actionId = state.actionId;
    state.actionId = null; state.startedAt = null; state.hitConfirmed = false;
    record(tick, type, { actionId });
    updatePhase(tick);
  }
  function start(tick, actionId, input, from = null) {
    const action = byId.get(actionId);
    if (state.stamina < action.staminaCost) { record(tick, 'input_ignored', { input, reason: 'insufficient_stamina', actionId: state.actionId, required: action.staminaCost, stamina: state.stamina }); return; }
    state.stamina -= action.staminaCost;
    state.actionId = actionId; state.startedAt = tick; state.hitConfirmed = false;
    record(tick, 'action_started', { actionId, from, input, stamina: state.stamina });
    updatePhase(tick);
  }
  let cursor = 0;
  record(0, 'initial_state', { phase: 'idle', stamina: state.stamina });
  for (let tick = 0; tick <= scenario.durationTicks; tick++) {
    if (state.actionId !== null && tick - state.startedAt >= byId.get(state.actionId).durationTicks) clear(tick, 'action_completed');
    updatePhase(tick);
    if (tick === scenario.durationTicks) break;
    while (cursor < scenario.events.length && scenario.events[cursor].tick === tick) {
      const event = scenario.events[cursor++];
      if (event.type === 'input') {
        if (state.actionId === null) {
          const actionId = entries.get(event.input);
          if (actionId) start(tick, actionId, event.input);
          else record(tick, 'input_ignored', { input: event.input, reason: 'no_entry', actionId: null });
        } else {
          const action = byId.get(state.actionId);
          const elapsed = tick - state.startedAt;
          const transition = action.transitions.find(item => item.input === event.input && elapsed >= item.windowStartTick && elapsed < item.windowEndTick);
          if (!transition) record(tick, 'input_ignored', { input: event.input, reason: 'no_transition', actionId: state.actionId });
          else if (transition.condition === 'hit_confirmed' && !state.hitConfirmed) record(tick, 'input_ignored', { input: event.input, reason: 'hit_required', actionId: state.actionId });
          else start(tick, transition.to, event.input, state.actionId);
        }
      } else if (event.type === 'hit') {
        if (state.actionId !== null && state.phase === 'active' && byId.get(state.actionId).kind === 'attack') {
          if (!state.hitConfirmed) { state.hitConfirmed = true; record(tick, 'hit_confirmed', { actionId: state.actionId, evidence: 'scenario-event-only' }); }
          else record(tick, 'hit_ignored', { actionId: state.actionId, reason: 'already_confirmed' });
        } else record(tick, 'hit_ignored', { actionId: state.actionId, reason: 'outside_active_window' });
      } else if (event.type === 'hurt') {
        if (state.actionId !== null && byId.get(state.actionId).interruptible) clear(tick, 'interrupted');
        else record(tick, 'hurt_ignored', { actionId: state.actionId, reason: state.actionId === null ? 'idle' : 'not_interruptible' });
      } else {
        clear(tick, 'reset'); state.stamina = blueprint.stamina.max;
        record(tick, 'stamina_reset', { stamina: state.stamina });
      }
    }
    if (state.actionId === null) state.stamina = Math.min(blueprint.stamina.max, state.stamina + blueprint.stamina.regenPerTick);
  }
  return { scope: 'action-rules-simulation-only', realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
    sourceVerification: 'not_verified', name: scenario.name, durationTicks: scenario.durationTicks,
    semantics: { tickOrder: 'complete-then-events-in-array-order-then-idle-regeneration', windows: 'start-inclusive-end-exclusive', hitEvidence: 'scenario-event-only' },
    trace, finalState: { tick: scenario.durationTicks, actionId: state.actionId, phase: state.phase,
      elapsedTicks: state.actionId === null ? 0 : scenario.durationTicks - state.startedAt, stamina: state.stamina, hitConfirmed: state.hitConfirmed } };
}

function transitionEvents(path, action, transition, withHit) {
  const elapsed = withHit ? Math.max(transition.windowStartTick, action.hitWindow.startTick) : transition.windowStartTick;
  if (elapsed >= transition.windowEndTick) return null;
  return [...path.events,
    ...(withHit ? [{ tick: path.startedAt + action.hitWindow.startTick, type: 'hit' }] : []),
    { tick: path.startedAt + elapsed, type: 'input', input: transition.input }];
}

// One finite feasible path per action is enough to broaden a replay, not to
// establish complete graph coverage. Resource/time limits may exclude paths.
function replayPaths(blueprint, byId) {
  const pending = blueprint.entryActions.map(entry => ({ actionId: entry.actionId, startedAt: 0,
    spent: byId.get(entry.actionId).staminaCost, depth: 1, events: [{ tick: 0, type: 'input', input: entry.input }] }));
  const paths = new Map();
  const maxSearchSteps = ACTION_BLUEPRINT_LIMITS.maxEntryActions + ACTION_BLUEPRINT_LIMITS.maxActions * ACTION_BLUEPRINT_LIMITS.maxTransitionsPerAction;
  let searchSteps = 0;
  while (pending.length && paths.size < blueprint.actions.length && searchSteps++ < maxSearchSteps) {
    pending.sort((a, b) => a.spent - b.spent || a.startedAt - b.startedAt);
    const path = pending.shift();
    if (paths.has(path.actionId)) continue;
    paths.set(path.actionId, path);
    const action = byId.get(path.actionId);
    if (path.depth >= ACTION_BLUEPRINT_LIMITS.maxActions) continue;
    for (const transition of action.transitions) {
      if (paths.has(transition.to)) continue;
      const events = transitionEvents(path, action, transition, transition.condition === 'hit_confirmed');
      const startedAt = events?.at(-1).tick;
      const target = byId.get(transition.to);
      const spent = path.spent + target.staminaCost;
      if (!events || spent > blueprint.stamina.max || events.length > ACTION_BLUEPRINT_LIMITS.maxScenarioEvents ||
          startedAt + target.durationTicks + 1 > ACTION_BLUEPRINT_LIMITS.maxScenarioTicks) continue;
      pending.push({ actionId: target.id, startedAt, spent, depth: path.depth + 1, events });
    }
  }
  return paths;
}

export function createActionScenarios(rawBlueprint) {
  const blueprint = validateActionBlueprint(rawBlueprint, rawBlueprint?.originalRequest);
  if (!blueprint.actions.length) return [];
  const byId = new Map(blueprint.actions.map(item => [item.id, item]));
  const entry = blueprint.entryActions.find(item => byId.get(item.actionId).kind === 'attack') || blueprint.entryActions[0];
  const paths = replayPaths(blueprint, byId);
  const primary = paths.get(entry.actionId);
  const orderedPaths = [primary, ...paths.values()].filter((path, index, all) => all.findIndex(item => item.actionId === path.actionId) === index);
  const scenarios = [];
  function add(path, name, events = path.events, extras = {}) {
    if (scenarios.length >= ACTION_BLUEPRINT_LIMITS.maxGeneratedScenarios || events.length > ACTION_BLUEPRINT_LIMITS.maxScenarioEvents) return;
    const action = byId.get(path.actionId);
    const lastTick = events.at(-1)?.tick ?? 0;
    const durationTicks = Math.min(ACTION_BLUEPRINT_LIMITS.maxScenarioTicks,
      Math.max(path.startedAt + action.durationTicks + 1, lastTick + ACTION_BLUEPRINT_LIMITS.maxActionTicks + 1));
    if (lastTick >= durationTicks) return;
    const prefix = path.actionId === entry.actionId ? '' : `动作 ${path.actionId}：`;
    scenarios.push({ name: prefix + name, durationTicks, events, ...extras });
  }
  // Give every discovered action a baseline before spending the scenario budget
  // on branches. Later-action paths retain the synthetic evidence needed to enter.
  for (const path of orderedPaths) add(path, '动作完整生命周期');
  for (const path of orderedPaths) {
    const action = byId.get(path.actionId);
    add(path, '受击中断规则', [...path.events, { tick: path.startedAt + Math.min(1, action.durationTicks - 1), type: 'hurt' }]);
    if (action.staminaCost > 0) add(path, '资源不足阻断动作', path.events, { initialStamina: path.spent - 1 });
    const otherEntry = blueprint.entryActions.find(item => item.actionId !== action.id && byId.get(item.actionId).kind === 'dodge') ||
      blueprint.entryActions.find(item => item.actionId !== action.id);
    if (otherEntry) {
      const transition = action.transitions.find(item => item.input === otherEntry.input);
      const tick = path.startedAt + (transition ? transition.windowStartTick : Math.floor(action.durationTicks / 2));
      add(path, '攻击中尝试另一入口动作', [...path.events, { tick, type: 'input', input: otherEntry.input }]);
    }
    for (const [index, transition] of action.transitions.entries()) {
      add(path, `转换 ${index + 1} 无命中`, transitionEvents(path, action, transition, false));
      // A transition may open before the active window. Delay input until a
      // hit can exist, placing same-tick hit before input without reordering it.
      const confirmed = action.hitWindow ? transitionEvents(path, action, transition, true) : null;
      if (confirmed) add(path, `转换 ${index + 1} 有模拟命中`, confirmed);
    }
  }
  return scenarios;
}
