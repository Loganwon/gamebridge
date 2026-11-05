import { generateAgentArtifact } from '../../src/agents/provider.mjs';

export const TEST_KEY = 'pipeline-contract-credential-not-a-live-key';
export const provider = { apiKey: TEST_KEY, baseUrl: 'https://api.deepseek.com', model: 'pipeline-contract-model' };
export const request = { hostGame: 'Example Host', sourceGame: 'Example Source', hostVersion: '1.0.0', sourceVersion: '2.0.0',
  description: '把来源的输入互斥规则和角色外观带入宿主，并保留宿主世界。', contentKinds: ['moveset', 'character'] };

function roleProposal(role, req) {
  if (role === 'requirements') return { schemaVersion: 1, title: '通用转换流程合同', hostGame: req.hostGame, sourceGame: req.sourceGame,
    summary: '完整需求进入同一流程，不宣称游戏支持。', requirements: [
      { id: 'interaction', kind: 'moveset', description: '来源输入互斥规则。', disposition: 'needs_research', reason: '宿主事件接口未核验。' },
      { id: 'appearance', kind: 'character', description: '角色外观，保留宿主世界。', disposition: 'needs_assets', reason: '资源、骨骼和宿主绑定未准备。' },
    ], assetNeeds: [{ id: 'character-assets', description: '需要合法角色资源及骨骼绑定。', requirementIds: ['appearance'] }],
    interfaceNeeds: [{ id: 'native-events', description: '需要正式事件接口，不是已核验 API。', requirementIds: ['interaction', 'appearance'] }],
    questions: ['如何取得允许使用的资源？'], limitations: ['不得改变宿主世界。'] };
  if (role === 'independent-validation') return { schemaVersion: 1, summary: '仅审查书面转换方案。', coverage: [
    { requirementId: 'interaction', assessment: 'addressed_in_plan', reason: '只有文字规则，未绑定游戏。' },
    { requirementId: 'appearance', assessment: 'unclear', reason: '缺资源和接口证据。' },
  ], issues: [{ id: 'missing-assets', requirementIds: ['appearance'], description: '角色资源和动画仍未落实。' }], limitations: ['未审查后续行为规格语义。'] };
  return { schemaVersion: 1, summary: '分析建议而非已验证接口。', items: [{ id: 'mapping', requirementIds: ['interaction', 'appearance'],
    description: '保持动作与角色资源的完整要求。', nextStep: '核验正式接口及来源资料。' }], questions: ['待确认输入语义。'], limitations: ['没有游戏或构建证据。'] };
}

export async function complete(role, req, upstream, options) {
  return generateAgentArtifact(role, req, upstream, { ...options, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
    message: { content: JSON.stringify(roleProposal(role, req)) } }] })) });
}
export function behaviorProposal() {
  return { schemaVersion: 1, summary: '只表示事件互斥与整数状态，角色外观未表达。', assumptions: ['事件需要宿主实际绑定。'], limitations: ['整数状态不表达骨骼、动画和世界约束。'], spec: {
    schemaVersion: 1, id: 'requested-interlock', requirementIds: ['interaction', 'appearance'], initialState: 'ready', states: ['ready', 'active'],
    variables: [{ id: 'remaining', initial: 0, min: 0, max: 10 }], events: [{ id: 'begin', fields: [{ id: 'duration', min: 1, max: 10 }] }, { id: 'release', fields: [] }],
    transitions: [
      { id: 'begin-active', from: 'ready', event: 'begin', to: 'active', priority: 0, requirementIds: ['interaction'], guard: { op: 'literal', value: true }, updates: [{ variable: 'remaining', value: { op: 'event', id: 'duration' } }] },
      { id: 'release-ready', from: 'active', event: 'release', to: 'ready', priority: 0, requirementIds: ['interaction'], guard: { op: 'literal', value: true }, updates: [{ variable: 'remaining', value: { op: 'literal', value: 0 } }] },
    ], unresolved: [{ requirementId: 'appearance', reason: '角色外观、骨骼和宿主世界约束无法用纯整数状态表达。' }],
  } };
}
