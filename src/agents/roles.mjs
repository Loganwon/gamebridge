export const AGENT_ROLES = Object.freeze([
  Object.freeze({ id: 'requirements', label: '需求规划', taskKind: 'analysis' }),
  Object.freeze({ id: 'source-research', label: '来源研究', taskKind: 'sourceResearch' }),
  Object.freeze({ id: 'host-research', label: '宿主研究', taskKind: 'hostInspection' }),
  Object.freeze({ id: 'conversion-implementation', label: '转换方案', taskKind: 'planning' }),
  Object.freeze({ id: 'independent-validation', label: '独立方案审查', taskKind: 'validation' }),
]);

export function getAgentRole(id) {
  const role = AGENT_ROLES.find(item => item.id === id);
  if (!role) { const error = new TypeError('Unknown conversion agent role.'); error.code = 'INVALID_AGENT_ROLE'; throw error; }
  return { ...role, capability: `agent.${role.id}.analysis`, outputType: `analysis.${role.id}` };
}

/** These are executable analysis workers, not game/source/build adapters. */
export function createAgentManifest(id) {
  const role = getAgentRole(id);
  return {
    schemaVersion: 1, id: `gamebridge.agent.${role.id}`, version: '1.0.0', kind: 'agent', role: role.id,
    targets: [], contentKinds: [],
    capabilities: [{ id: role.capability, operation: 'analyze', outputTypes: [role.outputType] }],
    allowedOperations: ['analyze'], execution: { sideEffects: 'none', idempotent: false, modelCallsPerAttempt: 1 },
    evidenceScope: 'analysis-only', references: [],
    limitations: ['Structured analysis only; no browsing, filesystem, code generation, compilation or game execution tools.', 'Research notes are unverified proposals, not inspected interfaces or verified source behavior.'],
    resourceLimits: { maxInputBytes: 256 * 1024, maxOutputBytes: 128 * 1024, timeoutMs: 120000 },
  };
}
