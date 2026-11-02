import { CONTENT_KINDS } from '../ai/plan.mjs';
import { TASK_ROLES, assertProtocolJson, protocolObject, protocolText, protocolIdentifier, protocolArray, validateTaskDefinition } from '../orchestration/protocol.mjs';

export const ADAPTER_KINDS = Object.freeze(['agent', 'source', 'host', 'resource', 'build', 'verification']);
export const ADAPTER_EVIDENCE_SCOPES = Object.freeze(['analysis-only', 'contract-test-only', 'real-mod-build', 'real-game']);
export const ADAPTER_REGISTRY_LIMITS = Object.freeze({ entries: 64, manifestBytes: 32768, capabilities: 32, operations: 16, targets: 16 });
const FIELDS = ['schemaVersion', 'id', 'version', 'kind', 'role', 'targets', 'contentKinds', 'capabilities', 'allowedOperations', 'execution', 'evidenceScope', 'references', 'limitations', 'resourceLimits'];
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const UNKNOWN_VERSION = /^(?:unknown|latest|current|any|unverified|未知|未确定|未验收)$/i;

export class AdapterRegistryError extends Error {
  constructor(code, message) { super(message); this.name = 'AdapterRegistryError'; this.code = code; }
}
function invalid(message) { throw new AdapterRegistryError('INVALID_ADAPTER_MANIFEST', message); }
function duplicate(values, label) { if (new Set(values).size !== values.length) invalid(`Duplicate ${label}.`); }
function names(value, label, maximum, minimum = 0) {
  const result = protocolArray(value, label, maximum, minimum).map(item => protocolIdentifier(item, label)); duplicate(result, label); return result;
}
function integer(value, label, minimum, maximum) { if (!Number.isSafeInteger(value) || value < minimum || value > maximum) invalid(`Invalid ${label}.`); return value; }
function reference(value) {
  let url; try { url = new URL(protocolText(value, 'adapter reference', 500)); } catch { invalid('Invalid adapter reference.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) invalid('Adapter references must be public HTTPS documents.');
  return url.href;
}

/** Versioned description of a locally trusted binding, never an authority granted by model output. */
export function validateAdapterManifest(raw) {
  try {
    protocolObject(raw, FIELDS, 'adapter manifest'); assertProtocolJson(raw, { maxBytes: ADAPTER_REGISTRY_LIMITS.manifestBytes });
    if (raw.schemaVersion !== 1 || !ADAPTER_KINDS.includes(raw.kind) || !TASK_ROLES.includes(raw.role) || !ADAPTER_EVIDENCE_SCOPES.includes(raw.evidenceScope)) invalid('Unknown adapter protocol, kind, role or evidence scope.');
    const id = protocolIdentifier(raw.id, 'adapter ID'), version = protocolText(raw.version, 'adapter version', 80);
    const versionMatch = version.match(VERSION);
    if (!versionMatch || versionMatch[1]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0'))) invalid('Adapter version must be exact semantic version text.');
    const targets = protocolArray(raw.targets, 'adapter targets', ADAPTER_REGISTRY_LIMITS.targets).map(target => {
      protocolObject(target, ['game', 'version', 'platform', 'role'], 'adapter target');
      const game = protocolText(target.game, 'target game', 80), targetVersion = protocolText(target.version, 'target version', 80);
      if (!['darwin', 'linux', 'win32'].includes(target.platform) || !['source', 'host'].includes(target.role) ||
          UNKNOWN_VERSION.test(targetVersion) || /[<>=*^~]/.test(targetVersion) || game === '*') invalid('Game targets need an exact version, platform and direction.');
      return { game, version: targetVersion, platform: target.platform, role: target.role };
    });
    duplicate(targets.map(target => JSON.stringify(target)), 'adapter targets');
    if (raw.kind === 'agent' && (targets.length || !['analysis-only', 'contract-test-only'].includes(raw.evidenceScope))) invalid('Logical agent adapters cannot declare game compatibility or executable-game evidence.');
    if (raw.kind !== 'agent' && !targets.length) invalid('Game/resource/tool adapters require explicit versioned game targets.');
    const contentKinds = protocolArray(raw.contentKinds, 'adapter content kinds', CONTENT_KINDS.length).map(kind => {
      if (!CONTENT_KINDS.includes(kind)) invalid('Invalid adapter content kind.'); return kind;
    }); duplicate(contentKinds, 'content kinds');
    if (raw.kind !== 'agent' && !contentKinds.length) invalid('Game adapters require explicit supported content kinds.');
    const allowedOperations = names(raw.allowedOperations, 'allowed operations', ADAPTER_REGISTRY_LIMITS.operations, 1);
    const capabilities = protocolArray(raw.capabilities, 'adapter capabilities', ADAPTER_REGISTRY_LIMITS.capabilities, 1).map(capability => {
      protocolObject(capability, ['id', 'operation', 'outputTypes'], 'adapter capability');
      const capabilityId = protocolIdentifier(capability.id, 'capability ID'), operation = protocolIdentifier(capability.operation, 'capability operation');
      if (!capabilityId.startsWith(raw.kind + '.') || !allowedOperations.includes(operation)) invalid('Capability namespace or operation exceeds the adapter contract.');
      const outputTypes = names(capability.outputTypes, 'capability output types', 16, 1);
      if (raw.kind === 'agent') {
        const prefix = raw.evidenceScope === 'analysis-only' ? 'analysis.' : 'test.';
        if (outputTypes.some(type => !type.startsWith(prefix))) invalid('Logical agent output types must remain in their analysis/test evidence namespace.');
      }
      return { id: capabilityId, operation, outputTypes };
    }); duplicate(capabilities.map(item => item.id), 'capability IDs');
    if (allowedOperations.some(operation => !capabilities.some(item => item.operation === operation))) invalid('Every operation needs an explicit capability binding.');
    protocolObject(raw.execution, ['sideEffects', 'idempotent', 'modelCallsPerAttempt'], 'adapter execution');
    const execution = { sideEffects: raw.execution.sideEffects, idempotent: raw.execution.idempotent,
      modelCallsPerAttempt: integer(raw.execution.modelCallsPerAttempt, 'local model call cost', 0, 2) };
    if (!['none', 'local-write', 'external'].includes(execution.sideEffects) || typeof execution.idempotent !== 'boolean') invalid('Invalid adapter execution metadata.');
    if (raw.kind === 'agent' && execution.sideEffects !== 'none') invalid('Analysis agent adapters cannot grant local tool or file side effects.');
    if (execution.modelCallsPerAttempt > 0 && execution.idempotent) invalid('Paid model operations cannot be declared safe for automatic replay.');
    const references = protocolArray(raw.references, 'adapter references', 16).map(reference); duplicate(references, 'references');
    if (raw.kind !== 'agent' && !references.length) invalid('Game adapters require traceable official/permitted interface references.');
    const limitations = protocolArray(raw.limitations, 'adapter limitations', 16, 1).map(value => protocolText(value, 'adapter limitation', 1000));
    protocolObject(raw.resourceLimits, ['maxInputBytes', 'maxOutputBytes', 'timeoutMs'], 'adapter resource limits');
    const resourceLimits = { maxInputBytes: integer(raw.resourceLimits.maxInputBytes, 'adapter input limit', 1, 1024 * 1024),
      maxOutputBytes: integer(raw.resourceLimits.maxOutputBytes, 'adapter output limit', 1, 1024 * 1024),
      timeoutMs: integer(raw.resourceLimits.timeoutMs, 'adapter timeout limit', 50, 180000) };
    return { schemaVersion: 1, id, version, kind: raw.kind, role: raw.role, targets, contentKinds, capabilities, allowedOperations, execution,
      evidenceScope: raw.evidenceScope, references, limitations, resourceLimits };
  } catch (error) {
    if (error instanceof AdapterRegistryError) throw error;
    throw new AdapterRegistryError('INVALID_ADAPTER_MANIFEST', 'Adapter manifest failed the bounded plain-data contract.');
  }
}

function matchTargets(manifest, context) {
  if (manifest.kind === 'agent') return true;
  const request = context?.request || context || {};
  const directions = [...new Set(manifest.targets.map(target => target.role))];
  if (!directions.every(direction => manifest.targets.some(target => target.role === direction &&
      target.game === request[direction === 'host' ? 'hostGame' : 'sourceGame'] &&
      target.version === request[direction === 'host' ? 'hostVersion' : 'sourceVersion'] && target.platform === context?.platform))) return false;
  const requestedKinds = request.contentKinds || [];
  return Array.isArray(requestedKinds) && requestedKinds.length > 0 && requestedKinds.every(kind => manifest.contentKinds.includes(kind));
}
const blocked = (code, message) => ({ blocked: true, code, message });

/** In-memory local-code registry. JSON manifests alone never create executable bindings. */
export function createAdapterRegistry() {
  const entries = new Map();
  return {
    register(rawManifest, handlers) {
      const manifest = validateAdapterManifest(rawManifest);
      if (entries.has(manifest.id)) throw new AdapterRegistryError('ADAPTER_ALREADY_REGISTERED', 'Adapter ID is already registered; implicit replacement is forbidden.');
      if (entries.size >= ADAPTER_REGISTRY_LIMITS.entries) throw new AdapterRegistryError('ADAPTER_REGISTRY_FULL', 'Adapter registry entry limit reached.');
      if (!handlers || typeof handlers !== 'object' || Array.isArray(handlers) || ![Object.prototype, null].includes(Object.getPrototypeOf(handlers)) ||
          Reflect.ownKeys(handlers).some(key => typeof key !== 'string' || !manifest.allowedOperations.includes(key)) ||
          Object.values(Object.getOwnPropertyDescriptors(handlers)).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) ||
          manifest.allowedOperations.some(operation => !Object.hasOwn(handlers, operation) || typeof handlers[operation] !== 'function')) {
        throw new AdapterRegistryError('INVALID_ADAPTER_BINDINGS', 'Every allowed operation needs exactly one local function binding.');
      }
      entries.set(manifest.id, { manifest: structuredClone(manifest), handlers: Object.fromEntries(manifest.allowedOperations.map(operation => [operation, handlers[operation]])) });
      return structuredClone(manifest);
    },
    list({ kind } = {}) { return [...entries.values()].filter(entry => kind === undefined || entry.manifest.kind === kind).map(entry => structuredClone(entry.manifest)); },
    get(id) { return entries.has(id) ? structuredClone(entries.get(id).manifest) : null; },
    resolveTask(rawTask, context = {}) {
      const task = validateTaskDefinition(rawTask);
      if (!task.requiredCapabilities.length) return blocked('TASK_CAPABILITY_REQUIRED', 'Task has no explicitly requested registered capability.');
      const matches = [];
      for (const entry of entries.values()) {
        const manifest = entry.manifest;
        if (manifest.kind === 'agent' && ['generation', 'build', 'game'].includes(task.kind)) continue;
        if (manifest.role !== task.role || !matchTargets(manifest, context)) continue;
        const capabilities = task.requiredCapabilities.map(id => manifest.capabilities.find(item => item.id === id));
        if (capabilities.some(item => !item)) continue;
        const operations = new Set(capabilities.map(item => item.operation));
        if (operations.size !== 1 || task.outputTypes.some(type => !capabilities.some(item => item.outputTypes.includes(type)))) continue;
        const operation = capabilities[0].operation;
        matches.push({ manifest: structuredClone(manifest), operation, handler: entry.handlers[operation] });
      }
      if (matches.length === 0) return blocked('ADAPTER_CAPABILITY_UNAVAILABLE', 'No local registered adapter matches the exact role, capabilities, target and output contract.');
      if (matches.length > 1) return blocked('ADAPTER_SELECTION_AMBIGUOUS', 'Multiple adapters match; task must not silently choose one.');
      return matches[0];
    },
  };
}
