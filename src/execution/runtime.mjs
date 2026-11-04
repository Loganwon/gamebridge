import path from 'node:path';
import { createHash } from 'node:crypto';
import { createArtifactStore } from '../artifacts/store.mjs';
import { createRunStore } from '../orchestration/store.mjs';
import { createScheduler } from '../orchestration/scheduler.mjs';
import { createAdapterRegistry } from '../adapters/registry.mjs';
import { validateBehaviorSpec } from '../behavior/index.mjs';
import { assertProtocolJson } from '../orchestration/protocol.mjs';
import { makeBehaviorProject, evaluateBehaviorVectors, compareBehaviorTrace, PROJECT_FILES, COMPILED_FILES } from './csharp-backend.mjs';

export const BEHAVIOR_FORMAT = 'gamebridge.behavior.v1';
export const EXECUTION_WORKFLOW = 'gamebridge.portable-behavior-execution.v1';
const nodeIdentity = () => ({ id: 'node', version: process.versions.node, platform: process.platform });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function snapshotBackend(raw) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => !['identity', 'targetFramework', 'evidence', 'compile', 'executeVerification'].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(item => !Object.hasOwn(item, 'value')) ||
      typeof raw.compile !== 'function' || typeof raw.executeVerification !== 'function') fail('INVALID_EXECUTION_BACKEND', 'A locally bound compiler backend is required.');
  // The locally constructed backend deliberately shares identity with its probe
  // evidence; validate each tree separately before taking detached snapshots.
  assertProtocolJson(raw.identity, { maxBytes: 32768 });
  assertProtocolJson(raw.evidence, { maxBytes: 32768 });
  const checkedIdentity = structuredClone(raw.identity), targetFramework = raw.targetFramework, evidence = structuredClone(raw.evidence);
  const identity = checkedIdentity && { id: checkedIdentity.id, version: checkedIdentity.version, platform: checkedIdentity.platform };
  if (!identity || Object.keys(checkedIdentity).sort().join(',') !== 'id,platform,version' || identity.id !== 'dotnet' || identity.platform !== process.platform ||
      !/^(?:8|10)\.\d+\.\d+$/.test(identity.version) || targetFramework !== 'net' + identity.version.split('.')[0] + '.0' ||
      !/^[a-f0-9]{64}$/.test(evidence.executableSha256) || !/^[a-f0-9]{64}$/.test(evidence.compilerSha256)) fail('INVALID_EXECUTION_BACKEND', 'Backend identity, framework and compiler fingerprints must be locally pinned.');
  return Object.freeze({ identity: Object.freeze(identity), targetFramework, evidence: Object.freeze(evidence),
    compile: raw.compile, executeVerification: raw.executeVerification });
}
function task(id, kind, role, capability, output, dependsOn) {
  return { schemaVersion: 1, id, kind, role, requiredCapabilities: [capability], outputTypes: [output], dependsOn,
    inputRefs: ['input:request', ...dependsOn.map(id => 'task:' + id)], requirementIds: [],
    acceptanceCriteria: ['Local structured/tool evidence only; no Mod or game success promotion.'],
    retryPolicy: { maxAttempts: 2, retryableCodes: [], replaySafe: false }, timeoutMs: 180000 };
}
export function behaviorExecutionGraph() {
  return [
    task('validate-specification', 'validation', 'requirements', 'tool.behavior.validate', 'tool.behavior.specification', []),
    task('lower-project', 'generation', 'conversion-implementation', 'tool.behavior.lower', 'tool.behavior.project', ['validate-specification']),
    task('compile-library', 'build', 'conversion-implementation', 'tool.csharp.compile', 'tool.behavior.assembly', ['validate-specification', 'lower-project']),
    task('verify-behavior', 'validation', 'independent-validation', 'tool.behavior.verify', 'tool.behavior.verification', ['validate-specification', 'lower-project', 'compile-library']),
  ];
}
function manifest(id, role, operation, output, toolchains, sideEffects = 'none') {
  return { schemaVersion: 1, id: 'gamebridge.tool.' + id, version: '1.0.0', kind: 'tool', role, targets: [], contentKinds: [],
    capabilities: [{ id: 'tool.' + id, operation, outputTypes: [output] }], allowedOperations: [operation],
    toolchains, formats: [BEHAVIOR_FORMAT], execution: { sideEffects, idempotent: sideEffects === 'none', modelCallsPerAttempt: 0 },
    evidenceScope: 'tool-execution', references: ['https://github.com/Loganwon/gamebridge/blob/main/docs/execution-kernel.md'],
    limitations: ['Portable state data only. No host input, animation, collision, damage, installation or game execution.'],
    resourceLimits: { maxInputBytes: 128 * 1024, maxOutputBytes: 128 * 1024, timeoutMs: 180000 } };
}

/** Actual local compiler workflow. It has no HTTP command/file entry point and
 * never claims a portable library is a Mod or a host compatibility proof.
 */
export async function createBehaviorExecutionRuntime({ root, backend, secrets = [] } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) fail('INVALID_EXECUTION_ROOT', 'A private absolute execution directory is required.');
  backend = snapshotBackend(backend);
  const artifacts = await createArtifactStore({ root: path.join(root, 'artifacts'), secrets });
  const store = await createRunStore({ root: path.join(root, 'runs'), secrets });
  const registry = createAdapterRegistry(), identities = [nodeIdentity()];
  if (backend) identities.push({ ...backend.identity });
  const specFrom = input => validateBehaviorSpec(input.context.specification, { requirementIds: input.context.requirementIds });
  registry.register(manifest('behavior.validate', 'requirements', 'validate', 'tool.behavior.specification', [nodeIdentity()]), {
    validate: async ({ input }) => {
      const spec = specFrom(input);
      if (spec.unresolved.length) fail('BEHAVIOR_REQUIREMENTS_UNRESOLVED', 'Unrepresented requirements block this complete portable verification.');
      const expected = evaluateBehaviorVectors(spec, input.context.steps, { requirementIds: input.context.requirementIds });
      return { data: { specificationSha256: hash(spec), requirements: spec.requirementIds, declaredSteps: expected.observations.length,
        scope: 'bounded-behavior-contract', semanticCompleteness: false, realModBuild: 'not_run', game: 'not_run' } };
    },
  });
  // Generation needs a locally probed compiler, even though the lowering itself
  // is deterministic. There is no paid or speculative source-generation step.
  if (backend) {
    registry.register(manifest('behavior.lower', 'conversion-implementation', 'lower', 'tool.behavior.project', identities, 'local-write'), {
      lower: async ({ input, signal }) => {
        const spec = specFrom(input), files = makeBehaviorProject(spec, input.context.steps, backend, { requirementIds: input.context.requirementIds });
        const project = await artifacts.create({ files, provenance: { producer: 'gamebridge.behavior.csharp.v1', specificationSha256: hash(spec), toolchain: backend.identity } }, { signal });
        return { data: { project, specificationSha256: hash(spec), filePaths: [...PROJECT_FILES], scope: 'portable-project', realModBuild: 'not_run', game: 'not_run' } };
      },
    });
    registry.register(manifest('csharp.compile', 'conversion-implementation', 'compile', 'tool.behavior.assembly', identities, 'local-write'), {
      compile: async ({ input, signal }) => {
        const project = input.dependencies['lower-project'].data.project, directory = await artifacts.createWorkDirectory({ signal });
        try {
          const before = await artifacts.materialize(project, { directory, allowedPaths: [...PROJECT_FILES], signal });
          const evidence = await backend.compile(directory, { signal });
          const afterHandle = await artifacts.capture({ directory, paths: [...PROJECT_FILES], provenance: { producer: 'source-integrity-check' } }, { signal });
          const after = await artifacts.getManifest(afterHandle);
          const fingerprints = manifest => manifest.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
          if (JSON.stringify(fingerprints(before)) !== JSON.stringify(fingerprints(after))) fail('COMPILER_SOURCE_CHANGED', 'Compiler changed a locked source/project input.');
          const assembly = await artifacts.capture({ directory, paths: [...COMPILED_FILES],
            provenance: { producer: 'gamebridge.csharp.compile.v1', project, toolchain: backend.identity } }, { signal });
          return { data: { assembly, sourceProject: project, evidence, scope: 'portable-library-build', realModBuild: 'not_run', game: 'not_run', readyToInstall: false } };
        } catch (error) {
          const diagnostic = Object.getOwnPropertyDescriptor(error, 'toolDiagnostic')?.value;
          if (diagnostic && typeof diagnostic.output === 'string' && !signal.aborted) {
            error.failureArtifact = await artifacts.create({ files: [{ path: 'tool-output.txt', content: diagnostic.output }],
              provenance: { producer: 'gamebridge.compiler-diagnostic.v1', project, code: error.code,
                cancelled: Boolean(diagnostic.cancelled), timedOut: Boolean(diagnostic.timedOut), overflow: Boolean(diagnostic.overflow) } });
          }
          throw error;
        } finally { await artifacts.removeWorkDirectory(directory); }
      },
    });
    registry.register(manifest('behavior.verify', 'independent-validation', 'verify', 'tool.behavior.verification', identities, 'local-write'), {
      verify: async ({ input, signal }) => {
        const assembly = input.dependencies['compile-library'].data.assembly, directory = await artifacts.createWorkDirectory({ signal });
        try {
          const before = await artifacts.materialize(assembly, { directory, allowedPaths: [...COMPILED_FILES], signal });
          const expected = evaluateBehaviorVectors(specFrom(input), input.context.steps, { requirementIds: input.context.requirementIds });
          const observed = await backend.executeVerification(directory, { signal });
          const afterHandle = await artifacts.capture({ directory, paths: [...COMPILED_FILES], provenance: { producer: 'verification-integrity-check' } }, { signal });
          const after = await artifacts.getManifest(afterHandle);
          const fingerprints = manifest => manifest.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
          if (JSON.stringify(fingerprints(before)) !== JSON.stringify(fingerprints(after))) fail('VERIFIER_INPUT_CHANGED', 'Verification changed a pinned compiled/input artifact.');
          const equivalence = compareBehaviorTrace(expected, observed.data, { declaredExpectedSteps: input.context.steps.filter(step => step.expected !== undefined).length });
          const observations = await artifacts.create({ files: [{ path: 'observations.json', content: JSON.stringify(observed.data) }],
            provenance: { producer: 'gamebridge.behavior.verify.v1', assembly } }, { signal });
          return { data: { equivalence, observations, assembly, isolation: observed.isolation } };
        } finally { await artifacts.removeWorkDirectory(directory); }
      },
    });
  }
  const scheduler = createScheduler({ store, registry, maxConcurrency: 1, secrets });
  let closed = false; const pendingAdmissions = new Map();
  const backendBinding = backend ? { identity: backend.identity, targetFramework: backend.targetFramework,
    executableSha256: backend.evidence.executableSha256, compilerSha256: backend.evidence.compilerSha256 } : null;
  async function binding(id) {
    if (closed) fail('EXECUTION_RUNTIME_CLOSED', 'Execution runtime is closed.');
    const state = await scheduler.get(id);
    if (state.context.workflow !== EXECUTION_WORKFLOW || (backend && JSON.stringify(state.context.backendBinding) !== JSON.stringify(backendBinding))) fail('EXECUTION_BACKEND_MISMATCH', 'Execution resume requires its original locally probed backend.');
  }
  async function dispatch(id, options, resume) {
    if (closed) fail('EXECUTION_RUNTIME_CLOSED', 'Execution runtime is closed.');
    const token = { cancelled: false };
    if (!pendingAdmissions.has(id)) pendingAdmissions.set(id, new Set());
    const tokens = pendingAdmissions.get(id); tokens.add(token);
    try {
      await binding(id);
      if (closed) fail('EXECUTION_RUNTIME_CLOSED', 'Execution runtime is closed.');
      if (token.cancelled) fail('EXECUTION_CANCELLED', 'Execution was cancelled before tool dispatch.');
      return await (resume ? scheduler.resume(id, options) : scheduler.run(id, options));
    } finally { tokens.delete(token); if (!tokens.size && pendingAdmissions.get(id) === tokens) pendingAdmissions.delete(id); }
  }
  return {
    artifacts, describe: () => ({ tools: registry.list(), gameAdapters: [], realModBuild: 'not_run', game: 'not_run' }),
    async create({ spec, requirementIds, steps, request = { hostGame: 'unselected-host', sourceGame: 'provided-behavior-specification' } }) {
      if (closed) fail('EXECUTION_RUNTIME_CLOSED', 'Execution runtime is closed.');
      if (!Array.isArray(requirementIds) || !requirementIds.length) fail('REQUIREMENT_BINDING_REQUIRED', 'The original requirement IDs must be supplied independently.');
      const normalized = validateBehaviorSpec(spec, { requirementIds });
      evaluateBehaviorVectors(normalized, steps, { requirementIds });
      return scheduler.createRun(behaviorExecutionGraph(), { context: { workflow: EXECUTION_WORKFLOW, platform: process.platform,
        request, specification: normalized, requirementIds: [...requirementIds], steps, toolchains: identities, formats: [BEHAVIOR_FORMAT], backendBinding },
      budget: { maxModelCalls: 0, maxAttempts: 8 } });
    },
    run: (id, options) => dispatch(id, options, false),
    resume: (id, options) => dispatch(id, options, true),
    get: id => scheduler.get(id), recover: id => scheduler.recover(id),
    cancel(id) { for (const token of pendingAdmissions.get(id) || []) token.cancelled = true; return scheduler.cancel(id); },
    async close() { closed = true; for (const tokens of pendingAdmissions.values()) for (const token of tokens) token.cancelled = true; await scheduler.close(); },
  };
}
