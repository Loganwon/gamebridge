// A bounded, host-neutral state-machine contract. It does not execute host effects.
export const BEHAVIOR_LIMITS = Object.freeze({ bytes: 128 * 1024, states: 32, variables: 32, events: 32, fields: 16, transitions: 128, requirements: 32, expressionDepth: 12, expressionNodes: 2048, numeric: 1000000000 });
const ID = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ROOT = ['schemaVersion', 'id', 'requirementIds', 'initialState', 'states', 'variables', 'events', 'transitions', 'unresolved'];
const NUMERIC = new Set(['add', 'sub', 'min', 'max']);
const COMPARISON = new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte']);
export class BehaviorSpecError extends Error {
  constructor(path, rule) { super('Behavior data failed its local contract.'); this.name = 'BehaviorSpecError'; this.code = 'INVALID_BEHAVIOR_SPEC'; this.diagnostics = [{ path, rule }]; }
}
function fail(path = '/', rule = 'structure') { throw new BehaviorSpecError(path, rule); }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)); }
function bounded(raw) {
  const pending = [[raw, 0]], seen = new Set(), encoder = new TextEncoder(); let count = 0, bytes = 0;
  function consume(text) { bytes += encoder.encode(text).byteLength; if (bytes > BEHAVIOR_LIMITS.bytes) fail('/', 'bytes'); }
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++count > 16384 || depth > 32) fail();
    if (value === null || typeof value === 'boolean') { consume(JSON.stringify(value)); continue; }
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail(); consume(JSON.stringify(value)); continue; }
    if (typeof value === 'string') { if (value.length > 4096) fail(); consume(JSON.stringify(value)); continue; }
    if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && !plain(value))) fail();
    seen.add(value); consume('{}');
    if (Array.isArray(value) && (Object.getPrototypeOf(value) !== Array.prototype || value.length > 256 || Reflect.ownKeys(value).length !== value.length + 1)) fail();
    const keys = Reflect.ownKeys(value); if (keys.length > 257) fail();
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || key.length > 64 || ['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(descriptor, 'value')) fail();
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || (Array.isArray(value) && !/^(?:0|[1-9][0-9]*)$/.test(key))) fail();
      if (!Array.isArray(value)) consume(JSON.stringify(key) + ':');
      pending.push([descriptor.value, depth + 1]);
    }
  }
  if (encoder.encode(JSON.stringify(raw)).byteLength > BEHAVIOR_LIMITS.bytes) fail('/', 'bytes');
}
function object(value, keys, at) {
  if (!plain(value) || Reflect.ownKeys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !keys.includes(key))) fail(at, 'object');
}
function array(value, max, at, min = 0) { if (!Array.isArray(value) || value.length < min || value.length > max) fail(at, 'array'); return value; }
function id(value, at) { if (typeof value !== 'string' || value.length > 64 || !ID.test(value) || ['constructor', 'prototype'].includes(value)) fail(at, 'identifier'); return value; }
function integer(value, at, min = -BEHAVIOR_LIMITS.numeric, max = BEHAVIOR_LIMITS.numeric) { if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < min || value > max) fail(at, 'integer'); return value; }
function unique(values, at) { if (new Set(values).size !== values.length) fail(at, 'unique'); }
function identifiers(value, max, at, min = 0) { const result = array(value, max, at, min).map((item, index) => id(item, `${at}/${index}`)); unique(result, at); return result; }
function refs(value, ids, at, min = 1) { const result = identifiers(value, BEHAVIOR_LIMITS.requirements, at, min); if (result.some(item => !ids.has(item))) fail(at, 'reference'); return result; }

/** Returns a detached normalized contract. Unknown requirements remain unresolved. */
export function validateBehaviorSpec(raw, options = {}) {
  bounded(raw); object(raw, ROOT, '/'); if (raw.schemaVersion !== 1) fail('/schemaVersion', 'version');
  const specId = id(raw.id, '/id'), requirementIds = identifiers(raw.requirementIds, BEHAVIOR_LIMITS.requirements, '/requirementIds', 1), requirements = new Set(requirementIds);
  if (!plain(options) || Reflect.ownKeys(options).some(key => key !== 'requirementIds') || Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))) fail('/', 'options');
  if (options.requirementIds !== undefined) {
    bounded(options.requirementIds);
    const expected = identifiers(options.requirementIds, BEHAVIOR_LIMITS.requirements, '/requirementIds', 1);
    if (expected.length !== requirementIds.length || expected.some(item => !requirements.has(item))) fail('/requirementIds', 'binding');
  }
  const states = identifiers(raw.states, BEHAVIOR_LIMITS.states, '/states', 1), stateIds = new Set(states), initialState = id(raw.initialState, '/initialState');
  if (!stateIds.has(initialState)) fail('/initialState', 'reference');
  const variables = array(raw.variables, BEHAVIOR_LIMITS.variables, '/variables').map((item, index) => {
    const at = `/variables/${index}`; object(item, ['id', 'initial', 'min', 'max'], at);
    const variable = { id: id(item.id, at + '/id'), min: integer(item.min, at + '/min'), max: integer(item.max, at + '/max') };
    if (variable.min > variable.max) fail(at, 'bounds');
    return { id: variable.id, initial: integer(item.initial, at + '/initial', variable.min, variable.max), min: variable.min, max: variable.max };
  }); unique(variables.map(item => item.id), '/variables'); const variableIds = new Set(variables.map(item => item.id));
  const events = array(raw.events, BEHAVIOR_LIMITS.events, '/events', 1).map((item, index) => {
    const at = `/events/${index}`; object(item, ['id', 'fields'], at);
    const fields = array(item.fields, BEHAVIOR_LIMITS.fields, at + '/fields').map((field, fieldIndex) => {
      const path = `${at}/fields/${fieldIndex}`; object(field, ['id', 'min', 'max'], path);
      const result = { id: id(field.id, path + '/id'), min: integer(field.min, path + '/min'), max: integer(field.max, path + '/max') };
      if (result.min > result.max) fail(path, 'bounds'); return result;
    }); unique(fields.map(field => field.id), at + '/fields'); return { id: id(item.id, at + '/id'), fields };
  }); unique(events.map(item => item.id), '/events'); const eventMap = new Map(events.map(item => [item.id, item]));
  let expressionNodes = 0;
  function expression(rawExpression, fields, at, depth = 0) {
    if (++expressionNodes > BEHAVIOR_LIMITS.expressionNodes || depth > BEHAVIOR_LIMITS.expressionDepth || !plain(rawExpression)) fail(at, 'expression-budget');
    if (rawExpression.op === 'literal') {
      object(rawExpression, ['op', 'value'], at); const value = rawExpression.value;
      if (typeof value === 'boolean') return { data: { op: 'literal', value }, type: 'boolean' };
      return { data: { op: 'literal', value: integer(value, at + '/value') }, type: 'integer' };
    }
    if (rawExpression.op === 'variable' || rawExpression.op === 'event') {
      object(rawExpression, ['op', 'id'], at); const key = id(rawExpression.id, at + '/id');
      if (!(rawExpression.op === 'variable' ? variableIds : fields).has(key)) fail(at, 'reference');
      return { data: { op: rawExpression.op, id: key }, type: 'integer' };
    }
    const op = rawExpression.op;
    if (!NUMERIC.has(op) && !COMPARISON.has(op) && !['and', 'or', 'not'].includes(op)) fail(at, 'operator');
    object(rawExpression, ['op', 'args'], at);
    const count = op === 'not' ? 1 : 2;
    if (!Array.isArray(rawExpression.args) || rawExpression.args.length !== count) fail(at + '/args', 'arity');
    const args = rawExpression.args.map((item, index) => expression(item, fields, `${at}/args/${index}`, depth + 1));
    const required = ['and', 'or', 'not'].includes(op) ? 'boolean' : 'integer';
    if (args.some(item => item.type !== required)) fail(at, 'type');
    return { data: { op, args: args.map(item => item.data) }, type: NUMERIC.has(op) ? 'integer' : 'boolean' };
  }
  const transitions = array(raw.transitions, BEHAVIOR_LIMITS.transitions, '/transitions').map((item, index) => {
    const at = `/transitions/${index}`; object(item, ['id', 'from', 'event', 'to', 'priority', 'requirementIds', 'guard', 'updates'], at);
    const transition = { id: id(item.id, at + '/id'), from: id(item.from, at + '/from'), event: id(item.event, at + '/event'), to: id(item.to, at + '/to'), priority: integer(item.priority, at + '/priority', 0, 65535) };
    if (!stateIds.has(transition.from) || !stateIds.has(transition.to) || !eventMap.has(transition.event)) fail(at, 'reference');
    const fields = new Set(eventMap.get(transition.event).fields.map(field => field.id)), guard = expression(item.guard, fields, at + '/guard');
    if (guard.type !== 'boolean') fail(at + '/guard', 'type');
    const updates = array(item.updates, BEHAVIOR_LIMITS.variables, at + '/updates').map((update, updateIndex) => {
      const path = `${at}/updates/${updateIndex}`; object(update, ['variable', 'value'], path);
      const variable = id(update.variable, path + '/variable'); if (!variableIds.has(variable)) fail(path, 'reference');
      const value = expression(update.value, fields, path + '/value'); if (value.type !== 'integer') fail(path, 'type');
      return { variable, value: value.data };
    }); unique(updates.map(update => update.variable), at + '/updates');
    return { ...transition, requirementIds: refs(item.requirementIds, requirements, at + '/requirementIds'), guard: guard.data, updates };
  }); unique(transitions.map(item => item.id), '/transitions');
  unique(transitions.map(item => JSON.stringify([item.from, item.event, item.priority])), '/transitions');
  const unresolved = array(raw.unresolved, BEHAVIOR_LIMITS.requirements, '/unresolved').map((item, index) => {
    const at = `/unresolved/${index}`; object(item, ['requirementId', 'reason'], at);
    const requirementId = id(item.requirementId, at + '/requirementId');
    if (!requirements.has(requirementId) || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1200 || /[\x00-\x1f\x7f]/.test(item.reason)) fail(at, 'unresolved');
    return { requirementId, reason: item.reason.trim() };
  }); unique(unresolved.map(item => item.requirementId), '/unresolved');
  const covered = new Set([...transitions.flatMap(item => item.requirementIds), ...unresolved.map(item => item.requirementId)]);
  if (requirementIds.some(item => !covered.has(item))) fail('/requirementIds', 'coverage');
  return { schemaVersion: 1, id: specId, requirementIds, initialState, states, variables, events, transitions, unresolved };
}
