import { BEHAVIOR_LIMITS, validateBehaviorSpec } from './spec.mjs';

export class BehaviorEventError extends Error {
  constructor(code = 'INVALID_BEHAVIOR_EVENT') { super('Behavior event was rejected without changing machine state.'); this.name = 'BehaviorEventError'; this.code = code; }
}
function numeric(value) { if (!Number.isSafeInteger(value) || value < -BEHAVIOR_LIMITS.numeric || value > BEHAVIOR_LIMITS.numeric) throw new BehaviorEventError('BEHAVIOR_ARITHMETIC_BOUNDS'); return value; }
function evaluate(expression, variables, fields) {
  const op = expression.op;
  if (op === 'literal') return expression.value;
  if (op === 'variable') return variables[expression.id];
  if (op === 'event') return fields[expression.id];
  if (op === 'and') return evaluate(expression.args[0], variables, fields) && evaluate(expression.args[1], variables, fields);
  if (op === 'or') return evaluate(expression.args[0], variables, fields) || evaluate(expression.args[1], variables, fields);
  if (op === 'not') return !evaluate(expression.args[0], variables, fields);
  const left = evaluate(expression.args[0], variables, fields), right = evaluate(expression.args[1], variables, fields);
  switch (op) {
    case 'add': return numeric(left + right);
    case 'sub': return numeric(left - right);
    case 'min': return Math.min(left, right);
    case 'max': return Math.max(left, right);
    case 'eq': return left === right;
    case 'ne': return left !== right;
    case 'gt': return left > right;
    case 'gte': return left >= right;
    case 'lt': return left < right;
    case 'lte': return left <= right;
    default: throw new BehaviorEventError();
  }
}
function eventFields(raw, definition) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || Reflect.ownKeys(raw).length !== definition.fields.length) throw new BehaviorEventError();
  const fields = Object.create(null);
  for (const item of definition.fields) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, item.id);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') || !Number.isSafeInteger(descriptor.value) || Object.is(descriptor.value, -0) || descriptor.value < item.min || descriptor.value > item.max) throw new BehaviorEventError();
    fields[item.id] = descriptor.value;
  }
  return fields;
}

/** Deterministic state/data execution only. No animation, collision or host effects. */
export function createBehaviorMachine(raw, options = {}) {
  const spec = validateBehaviorSpec(raw, options), events = new Map(spec.events.map(item => [item.id, item]));
  const transitions = [...spec.transitions].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  let state = spec.initialState; const variables = Object.fromEntries(spec.variables.map(item => [item.id, item.initial]));
  const snapshot = (transitionId = null) => ({ state, variables: { ...variables }, transitionId });
  return Object.freeze({
    snapshot: () => snapshot(),
    step(eventId, rawFields = {}) {
      if (typeof eventId !== 'string' || !events.has(eventId)) throw new BehaviorEventError();
      const fields = eventFields(rawFields, events.get(eventId));
      const selected = transitions.find(item => item.from === state && item.event === eventId && evaluate(item.guard, variables, fields));
      if (!selected) return snapshot();
      const updates = selected.updates.map(update => {
        const value = numeric(evaluate(update.value, variables, fields)), definition = spec.variables.find(item => item.id === update.variable);
        if (value < definition.min || value > definition.max) throw new BehaviorEventError('BEHAVIOR_VARIABLE_BOUNDS');
        return [update.variable, value];
      });
      for (const [variable, value] of updates) variables[variable] = value;
      state = selected.to;
      return snapshot(selected.id);
    },
  });
}
