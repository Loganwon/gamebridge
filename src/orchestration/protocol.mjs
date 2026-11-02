// Game-neutral task definitions. Executable bindings and observed state are local concerns.
export const TASK_ROLES = Object.freeze(['requirements', 'source-research', 'host-research', 'conversion-implementation', 'independent-validation']);
export const TASK_KINDS = Object.freeze(['analysis', 'sourceResearch', 'hostInspection', 'assetMapping', 'interactionMapping', 'planning', 'generation', 'build', 'game', 'validation']);
export const TASK_PROTOCOL_LIMITS = Object.freeze({ tasks: 64, taskBytes: 16 * 1024, graphBytes: 256 * 1024, nodes: 16384, depth: 12, dependencies: 64, references: 64, criteria: 32, timeoutMs: 180000, maxAttempts: 3 });
const TASK_FIELDS = ['schemaVersion', 'id', 'kind', 'role', 'dependsOn', 'requirementIds', 'inputRefs', 'outputTypes', 'requiredCapabilities', 'acceptanceCriteria', 'retryPolicy', 'timeoutMs'];
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const REFERENCE = /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;

export class TaskProtocolError extends Error {
  constructor(rule, message) { super(message); this.name = 'TaskProtocolError'; this.code = 'INVALID_TASK_PROTOCOL'; this.rule = rule; }
}
function fail(rule, message) { throw new TaskProtocolError(rule, message); }

/** Validate before traversing or serializing arbitrary contract data. Never invokes accessors. */
export function assertProtocolJson(value, { maxBytes = TASK_PROTOCOL_LIMITS.graphBytes, maxNodes = TASK_PROTOCOL_LIMITS.nodes, maxDepth = TASK_PROTOCOL_LIMITS.depth } = {}) {
  const seen = new Set(), pending = [[value, 0]]; let count = 0;
  while (pending.length) {
    const [item, depth] = pending.pop();
    if (++count > maxNodes || depth > maxDepth) fail('structure', 'Protocol data exceeds structural limits.');
    if (item === null || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('number', 'Protocol numbers must be finite.'); continue; }
    if (typeof item === 'string') { if (item.length > 16384) fail('text', 'Protocol text exceeds its limit.'); continue; }
    if (!item || typeof item !== 'object' || seen.has(item) || (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item)))) fail('structure', 'Protocol values must form a finite plain JSON tree.');
    seen.add(item);
    if (Array.isArray(item) && (item.length > 256 || Reflect.ownKeys(item).length !== item.length + 1)) fail('array', 'Protocol arrays must be dense and bounded.');
    for (const key of Reflect.ownKeys(item)) {
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(descriptor, 'value')) fail('property', 'Protocol properties must be plain data.');
      if (Array.isArray(item) && key === 'length') continue;
      if (!descriptor.enumerable || (Array.isArray(item) && !/^(?:0|[1-9][0-9]*)$/.test(key))) fail('property', 'Protocol properties must be enumerable JSON fields.');
      pending.push([descriptor.value, depth + 1]);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) fail('bytes', 'Protocol data exceeds its byte limit.');
}

export function protocolObject(value, allowed, label = 'protocol') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))) fail('object', `Invalid ${label} fields.`);
}
export function protocolText(value, label, maximum = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) fail('text', `Invalid ${label} text.`);
  return value.trim();
}
export function protocolIdentifier(value, label = 'identifier', reference = false) {
  const checked = protocolText(value, label, 120);
  if (!(reference ? REFERENCE : IDENTIFIER).test(checked) || ['constructor', 'prototype'].includes(checked)) fail('identifier', `Invalid ${label}.`);
  return checked;
}
export function protocolArray(value, label, maximum = 64, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || Reflect.ownKeys(value).length !== value.length + 1 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value')) || Array.from({ length: value.length }, (_, i) => !Object.hasOwn(value, i)).some(Boolean)) fail('array', `Invalid ${label} array.`);
  return value;
}
function identifiers(value, label, maximum, reference = false) {
  const result = protocolArray(value === undefined ? [] : value, label, maximum).map(item => protocolIdentifier(item, label, reference));
  if (new Set(result).size !== result.length) fail('unique', `Duplicate ${label}.`);
  return result;
}

export function validateTaskDefinition(raw) {
  protocolObject(raw, TASK_FIELDS, 'task'); assertProtocolJson(raw, { maxBytes: TASK_PROTOCOL_LIMITS.taskBytes });
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== 1) fail('version', 'Unsupported task protocol version.');
  if (!TASK_KINDS.includes(raw.kind) || !TASK_ROLES.includes(raw.role)) fail('enum', 'Unknown task kind or logical agent role.');
  const criteria = protocolArray(raw.acceptanceCriteria, 'acceptance criteria', TASK_PROTOCOL_LIMITS.criteria, 1).map(item => protocolText(item, 'acceptance criterion', 1000));
  const retry = raw.retryPolicy === undefined ? {} : raw.retryPolicy;
  protocolObject(retry, ['maxAttempts', 'retryableCodes', 'replaySafe'], 'retry policy');
  const maxAttempts = retry.maxAttempts === undefined ? 1 : retry.maxAttempts, replaySafe = retry.replaySafe === undefined ? false : retry.replaySafe;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > TASK_PROTOCOL_LIMITS.maxAttempts || typeof replaySafe !== 'boolean') fail('retry', 'Invalid bounded retry policy.');
  const retryableCodes = protocolArray(retry.retryableCodes === undefined ? [] : retry.retryableCodes, 'retryable error codes', 16).map(code => {
    if (typeof code !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) fail('retry', 'Invalid retryable error code.'); return code;
  });
  if (new Set(retryableCodes).size !== retryableCodes.length) fail('unique', 'Duplicate retryable error code.');
  const timeoutMs = raw.timeoutMs === undefined ? 120000 : raw.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > TASK_PROTOCOL_LIMITS.timeoutMs) fail('timeout', 'Invalid task observation timeout.');
  const outputTypes = identifiers(raw.outputTypes, 'output types', 16);
  if (!outputTypes.length) fail('output-type', 'Tasks require at least one explicit typed output.');
  return { schemaVersion: 1, id: protocolIdentifier(raw.id, 'task ID'), kind: raw.kind, role: raw.role,
    dependsOn: identifiers(raw.dependsOn, 'task dependencies', TASK_PROTOCOL_LIMITS.dependencies),
    requirementIds: identifiers(raw.requirementIds, 'requirement references', 32),
    inputRefs: identifiers(raw.inputRefs, 'logical input references', TASK_PROTOCOL_LIMITS.references, true),
    outputTypes,
    requiredCapabilities: identifiers(raw.requiredCapabilities, 'required capabilities', 16),
    acceptanceCriteria: criteria, retryPolicy: { maxAttempts, retryableCodes, replaySafe }, timeoutMs };
}

/** Returns detached normalized definitions. Neither models nor graph authors set execution state. */
export function validateTaskGraph(rawTasks) {
  assertProtocolJson(rawTasks); const tasks = protocolArray(rawTasks, 'task graph', TASK_PROTOCOL_LIMITS.tasks, 1).map(validateTaskDefinition);
  const byId = new Map();
  for (const task of tasks) { if (byId.has(task.id)) fail('unique', 'Task IDs must be unique.'); byId.set(task.id, task); }
  for (const task of tasks) for (const dependency of task.dependsOn) if (dependency === task.id || !byId.has(dependency)) fail('dependency', 'Task dependencies must reference a different existing task.');
  for (const task of tasks) for (const reference of task.inputRefs) if (reference.startsWith('task:')) {
    const dependency = reference.slice(5);
    if (!byId.has(dependency) || !task.dependsOn.includes(dependency)) fail('input-reference', 'Task output inputs require an explicit existing dependency.');
  }
  const complete = new Set(), visiting = new Set();
  function visit(id) {
    if (complete.has(id)) return;
    if (visiting.has(id)) fail('cycle', 'Task graph must be acyclic.');
    visiting.add(id); for (const dependency of byId.get(id).dependsOn) visit(dependency); visiting.delete(id); complete.add(id);
  }
  for (const task of tasks) visit(task.id);
  return tasks;
}
