import { createAgentTaskGraph } from '../agents/workflow.mjs';
import { validateTaskGraph } from '../orchestration/protocol.mjs';

export const PROJECT_WORKFLOW_ID = 'gamebridge.conversion-project.v1';
export const PROJECT_FORMAT = 'gamebridge.adapter-project.v1';
export const PROJECT_GENERATOR_VERSION = '1.0.0';
export const PROJECT_BUDGET = Object.freeze({ maxModelCalls: 6, maxAttempts: 20 });
export const ANALYSIS_TASK_IDS = Object.freeze(['requirements', 'source-research', 'host-research', 'conversion-design', 'independent-review']);

function task(id, kind, role, capability, outputType, dependsOn) {
  return { schemaVersion: 1, id, kind, role, dependsOn, requirementIds: [],
    inputRefs: ['input:request', ...dependsOn.map(id => `task:${id}`)], outputTypes: [outputType], requiredCapabilities: [capability],
    acceptanceCriteria: ['Preserve the complete request and all independently bound requirements.', 'Structured proposals and project drafts cannot establish semantic completeness or Mod/game evidence.'],
    retryPolicy: { maxAttempts: 2, retryableCodes: [], replaySafe: false }, timeoutMs: 120000 };
}

/** A new graph, never an in-place rewrite of persisted five-call analysis runs. */
export function createProjectTaskGraph(rawRequest) {
  const previous = createAgentTaskGraph(rawRequest), analysis = previous.tasks.slice(0, 5);
  const specificationInputs = [...ANALYSIS_TASK_IDS, 'specify-behavior'];
  const projectInputs = [...specificationInputs, 'validate-behavior'];
  const tasks = [...analysis,
    task('specify-behavior', 'planning', 'conversion-implementation', 'agent.behavior.specify', 'analysis.behavior.proposal', [...ANALYSIS_TASK_IDS]),
    task('validate-behavior', 'validation', 'independent-validation', 'tool.behavior.check', 'tool.behavior.specification', specificationInputs),
    task('generate-adapter-project', 'generation', 'conversion-implementation', 'tool.adapter.draft', 'tool.adapter.project', projectInputs),
    { ...previous.tasks[5], dependsOn: [...projectInputs, 'generate-adapter-project'],
      inputRefs: ['input:request', ...projectInputs.map(id => `task:${id}`), 'task:generate-adapter-project'],
      acceptanceCriteria: ['Requires a separately admitted host adapter and verified environment; a portable draft is not a Mod.', 'Unresolved requirements and unverified host bindings must not be silently dropped.'] },
    ...previous.tasks.slice(6),
  ];
  return { schemaVersion: 1, id: PROJECT_WORKFLOW_ID, request: previous.request, tasks: validateTaskGraph(tasks) };
}

export function projectNodeIdentity() { return { id: 'node', version: process.versions.node, platform: process.platform }; }

export function projectManifest(kind, operation, capability, outputType, role, sideEffects = 'none') {
  const generic = kind === 'tool';
  return { schemaVersion: 1, id: generic ? 'gamebridge.' + capability : 'gamebridge.agent.behavior-specification', version: PROJECT_GENERATOR_VERSION, kind, role,
    targets: [], contentKinds: [], ...(generic ? { toolchains: [projectNodeIdentity()], formats: [PROJECT_FORMAT] } : {}),
    capabilities: [{ id: capability, operation, outputTypes: [outputType] }], allowedOperations: [operation],
    execution: { sideEffects, idempotent: generic && sideEffects === 'none', modelCallsPerAttempt: generic ? 0 : 1 },
    evidenceScope: generic ? 'tool-execution' : 'analysis-only', references: generic ? ['https://github.com/Loganwon/gamebridge/blob/main/docs/conversion-pipeline.md'] : [],
    limitations: ['Bounded behavior data and a portable adapter project draft only. No verified source fidelity, host binding, Mod build, install or game acceptance.'],
    resourceLimits: { maxInputBytes: 128 * 1024, maxOutputBytes: 128 * 1024, timeoutMs: 120000 } };
}
