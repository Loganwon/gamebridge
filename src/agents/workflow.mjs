import { validateConversionRequest } from '../converter/spec.mjs';
import { validateTaskGraph } from '../orchestration/protocol.mjs';
import { getAgentRole } from './roles.mjs';

export const AGENT_WORKFLOW_ID = 'gamebridge.multi-agent-analysis.v1';
export const DEFAULT_AGENT_BUDGET = Object.freeze({ maxModelCalls: 5, maxAttempts: 16 });

/** The executable portion collaborates on analysis; downstream game work stays capability-gated. */
export function createAgentTaskGraph(rawRequest) {
  const request = validateConversionRequest(rawRequest);
  function agentTask(id, roleId, dependsOn) {
    const role = getAgentRole(roleId);
    return { schemaVersion: 1, id, kind: role.taskKind, role: role.id, dependsOn,
      requirementIds: [], inputRefs: ['input:request', ...dependsOn.map(id => `task:${id}`)], outputTypes: [role.outputType],
      requiredCapabilities: [role.capability], acceptanceCriteria: [
        'Output conforms to the role-specific bounded structured-data contract.',
        'Original request direction and requirement references are retained; no execution claims are promoted.',
      ], retryPolicy: { maxAttempts: 2, retryableCodes: [], replaySafe: false }, timeoutMs: 120000 };
  }
  const tasks = [
    agentTask('requirements', 'requirements', []),
    agentTask('source-research', 'source-research', ['requirements']),
    agentTask('host-research', 'host-research', ['requirements']),
    agentTask('conversion-design', 'conversion-implementation', ['requirements', 'source-research', 'host-research']),
    agentTask('independent-review', 'independent-validation', ['requirements', 'source-research', 'host-research', 'conversion-design']),
    { schemaVersion: 1, id: 'generate-project', kind: 'generation', role: 'conversion-implementation', dependsOn: ['requirements', 'source-research', 'host-research', 'conversion-design', 'independent-review'], requirementIds: [],
      inputRefs: ['input:request', 'task:requirements', 'task:source-research', 'task:host-research', 'task:conversion-design', 'task:independent-review'], outputTypes: ['mod.project'], requiredCapabilities: ['host.project.generate'],
      acceptanceCriteria: ['Requires a separately admitted, versioned host generation adapter and locally verified prerequisites.'],
      retryPolicy: { maxAttempts: 1, retryableCodes: [], replaySafe: false }, timeoutMs: 120000 },
    { schemaVersion: 1, id: 'compile-mod', kind: 'build', role: 'conversion-implementation', dependsOn: ['generate-project'], requirementIds: [],
      inputRefs: ['task:generate-project'], outputTypes: ['mod.build'], requiredCapabilities: ['build.project.compile'],
      acceptanceCriteria: ['Requires real SDK/dependencies and build evidence from a separately admitted build adapter.'],
      retryPolicy: { maxAttempts: 1, retryableCodes: [], replaySafe: false }, timeoutMs: 120000 },
    { schemaVersion: 1, id: 'verify-game', kind: 'game', role: 'independent-validation', dependsOn: ['compile-mod'], requirementIds: [],
      inputRefs: ['input:request', 'task:compile-mod'], outputTypes: ['game.acceptance'], requiredCapabilities: ['verification.game.acceptance'],
      acceptanceCriteria: ['Requires a separately admitted game verification adapter and observed evidence against original requirements.'],
      retryPolicy: { maxAttempts: 1, retryableCodes: [], replaySafe: false }, timeoutMs: 120000 },
  ];
  return { schemaVersion: 1, id: AGENT_WORKFLOW_ID, request, tasks: validateTaskGraph(tasks) };
}
