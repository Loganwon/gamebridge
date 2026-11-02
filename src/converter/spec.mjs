import { CONTENT_KINDS, validateRequest } from '../ai/plan.mjs';
import { createConversionWorkflow } from './workflow.mjs';

export { CONTENT_KINDS };
export const CONVERSION_LIMITS = Object.freeze({ proposalBytes: 64 * 1024, normalizedBytes: 96 * 1024, nodes: 8192, depth: 12, requirements: 32, dependencies: 32, questions: 16, limitations: 16 });
const PROPOSAL_FIELDS = ['schemaVersion', 'title', 'hostGame', 'sourceGame', 'summary', 'requirements', 'assetNeeds', 'interfaceNeeds', 'questions', 'limitations'];
const LOCAL_FIELDS = ['originalRequest', 'scope', 'status', 'workflow', 'evidence', 'coverage', 'readyToGenerate', 'realModBuild', 'game', 'readyToInstall'];
const ID = /^[a-z][a-z0-9_-]{0,63}$/;

export class ConversionPlanError extends Error {
  constructor(path, rule, expected) {
    super(`Conversion plan failed local ${rule} checks.`); this.name = 'ConversionPlanError'; this.code = 'INVALID_CONVERSION_PLAN';
    this.category = 'schema'; this.diagnostics = Object.freeze([Object.freeze({ path, rule, expected })]);
  }
}
function fail(path, rule, expected) { throw new ConversionPlanError(path, rule, expected); }
function object(value, allowed, at) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))) fail(at, 'object', 'plain object containing only contract fields');
}
function text(value, at, max, multiline = true) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(at, 'text', `non-empty text of at most ${max} characters`);
  return value.trim();
}
function array(value, at, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max || Reflect.ownKeys(value).length !== value.length + 1 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value')) ||
      Array.from({ length: value.length }, (_, i) => !Object.hasOwn(value, i)).some(Boolean)) fail(at, 'array', `dense array containing ${min}..${max} items`);
  return value;
}
function unique(values, at) { if (new Set(values).size !== values.length) fail(at, 'unique', 'unique values'); }
function bounded(raw, maxBytes) {
  const seen = new Set(), pending = [[raw, 0]]; let count = 0;
  while (pending.length) {
    const [value, depth] = pending.pop();
    if (++count > CONVERSION_LIMITS.nodes || depth > CONVERSION_LIMITS.depth) fail('/', 'structure', 'bounded finite JSON tree');
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('/', 'number', 'finite JSON number'); continue; }
    if (typeof value === 'string') { if (value.length > 12000) fail('/', 'text', 'bounded JSON string'); continue; }
    if (!value || typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail('/', 'structure', 'plain finite JSON tree without repeated references');
    seen.add(value);
    if (Array.isArray(value)) array(value, '/', 128);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || ['__proto__', 'prototype', 'constructor'].includes(key) || !Object.hasOwn(descriptor, 'value')) fail('/', 'property', 'plain JSON property');
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable) fail('/', 'property', 'enumerable JSON property');
      pending.push([descriptor.value, depth + 1]);
    }
  }
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > maxBytes) fail('/', 'bytes', `JSON no larger than ${maxBytes} bytes`);
}
function textList(value, at, maxItems, maxLength) { return array(value, at, maxItems).map((item, i) => text(item, `${at}/${i}`, maxLength)); }
function id(value, at) { const checked = text(value, at, 64, false); if (!ID.test(checked)) fail(at, 'identifier', 'lowercase identifier'); return checked; }
function proposal(raw) { return Object.fromEntries(PROPOSAL_FIELDS.filter(key => Object.hasOwn(raw, key)).map(key => [key, raw[key]])); }

export const validateConversionRequest = validateRequest;

/** Validated analysis data and local blockers; never a claim of code or game support. */
export function validateConversionPlan(raw, rawRequest) {
  object(raw, [...PROPOSAL_FIELDS, ...LOCAL_FIELDS], '/');
  const request = validateRequest(rawRequest === undefined ? raw.originalRequest : rawRequest);
  bounded(raw, LOCAL_FIELDS.some(key => Object.hasOwn(raw, key)) ? CONVERSION_LIMITS.normalizedBytes : CONVERSION_LIMITS.proposalBytes);
  bounded(proposal(raw), CONVERSION_LIMITS.proposalBytes);
  if (raw.schemaVersion !== 1 || raw.hostGame !== request.hostGame || raw.sourceGame !== request.sourceGame) fail('/', 'direction', 'schemaVersion 1 and exact requested host/source direction');
  const title = text(raw.title, '/title', 120), summary = text(raw.summary, '/summary', 1800);
  const requirements = array(raw.requirements, '/requirements', CONVERSION_LIMITS.requirements, 1).map((item, i) => {
    const at = `/requirements/${i}`;
    object(item, ['id', 'kind', 'description', 'disposition', 'reason'], at);
    if (!CONTENT_KINDS.includes(item.kind)) fail(`${at}/kind`, 'enum', CONTENT_KINDS.join(', '));
    if (!['needs_research', 'needs_assets', 'out_of_scope'].includes(item.disposition)) fail(`${at}/disposition`, 'enum', 'needs_research, needs_assets, out_of_scope');
    return { id: id(item.id, `${at}/id`), kind: item.kind, description: text(item.description, `${at}/description`, 1600),
      disposition: item.disposition, reason: text(item.reason, `${at}/reason`, 800) };
  });
  unique(requirements.map(item => item.id), '/requirements');
  const ids = new Set(requirements.map(item => item.id));
  function needs(value, at) {
    const result = array(value, at, CONVERSION_LIMITS.dependencies).map((item, i) => {
      const index = `${at}/${i}`; object(item, ['id', 'description', 'requirementIds'], index);
      const requirementIds = array(item.requirementIds, `${index}/requirementIds`, CONVERSION_LIMITS.requirements, 1).map((value, j) => {
        const ref = id(value, `${index}/requirementIds/${j}`); if (!ids.has(ref)) fail(`${index}/requirementIds/${j}`, 'reference', 'existing requirement ID'); return ref;
      });
      unique(requirementIds, `${index}/requirementIds`);
      return { id: id(item.id, `${index}/id`), description: text(item.description, `${index}/description`, 1000), requirementIds };
    });
    unique(result.map(item => item.id), at); return result;
  }
  const assetNeeds = needs(raw.assetNeeds, '/assetNeeds'), interfaceNeeds = needs(raw.interfaceNeeds, '/interfaceNeeds');
  for (const item of requirements) if (item.disposition === 'needs_assets' && !assetNeeds.some(need => need.requirementIds.includes(item.id))) fail('/assetNeeds', 'coverage', 'an asset dependency for each needs_assets requirement');
  const questions = textList(raw.questions, '/questions', CONVERSION_LIMITS.questions, 800);
  const limitations = textList(raw.limitations, '/limitations', CONVERSION_LIMITS.limitations, 800);
  const checked = { schemaVersion: 1, title, hostGame: request.hostGame, sourceGame: request.sourceGame, summary, requirements, assetNeeds, interfaceNeeds, questions, limitations };
  const local = {
    originalRequest: request, scope: 'conversion-plan', status: 'needs_adapter', workflow: createConversionWorkflow(checked),
    evidence: { analysis: 'schema_validated', sourceResearch: 'not_run', hostInspection: 'not_run', assetMapping: 'not_run', interactionMapping: 'not_run', generation: 'not_run', build: 'not_run', game: 'not_run' },
    coverage: { requiredCount: requirements.length, unresolvedIds: requirements.map(item => item.id), semanticCoverage: 'not_verified' },
    readyToGenerate: false, realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
  };
  for (const key of LOCAL_FIELDS) if (Object.hasOwn(raw, key) && JSON.stringify(raw[key]) !== JSON.stringify(local[key])) fail(`/${key}`, 'evidence', 'locally derived unverified evidence');
  const result = { ...checked, ...local };
  bounded(result, CONVERSION_LIMITS.normalizedBytes);
  return result;
}

export function serializeConversionProposal(plan) { return JSON.parse(JSON.stringify(proposal(validateConversionPlan(plan)))); }
