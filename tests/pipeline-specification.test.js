// Protocol/provider integration only: all completions are local fixtures, with
// no cloud request, SDK/compiler, game process or compatibility claim.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentArtifact } from '../src/agents/provider.mjs';
import { validateConversionPlan } from '../src/converter/spec.mjs';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';
import { assertRunData } from '../src/orchestration/store.mjs';
import { validatePipelineUpstream, validateBehaviorProposal, buildBehaviorProposalMessages, generateBehaviorProposal } from '../src/pipeline/specification.mjs';

const KEY = 'pipeline-specification-test-canary-never-live';
const request = { hostGame: 'Requested Host', sourceGame: 'Requested Source', hostVersion: '1.0.0', sourceVersion: '2.0.0',
  description: '迁入来源动作的时序和互锁，同时保留角色外观。\n不能缩减为速度 Buff。', contentKinds: ['moveset', 'character'] };
const ids = ['timing', 'interlock', 'appearance'];
function analyses(requirementIds = ids) {
  const proposal = { schemaVersion: 1, title: '完整转换请求', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '提案而非可用 Mod。',
    requirements: requirementIds.map(id => ({ id, kind: id === 'appearance' ? 'character' : 'moveset', description: '完整要求 ' + id,
      disposition: 'needs_research', reason: '需要规格与真实宿主接口。' })), assetNeeds: [], interfaceNeeds: [], questions: ['来源时序单位尚未确认。'], limitations: ['没有宿主适配器。'] };
  const result = [];
  const artifact = (role, analysis) => validateAgentArtifact({ schemaVersion: 1, role, scope: 'analysis-only', evidenceScope: 'unverified-proposal',
    hostGame: request.hostGame, sourceGame: request.sourceGame, analysis, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }, { request, upstream: result });
  result.push(artifact('requirements', validateConversionPlan(proposal, request)));
  for (const role of ['source-research', 'host-research', 'conversion-implementation']) result.push(artifact(role, {
    schemaVersion: 1, summary: role + ' 的未核实提案。', items: [{ id: 'all-needs', requirementIds: requirementIds.slice(), description: '保留全部需求、未知资源与接口。', nextStep: '调查精确来源和宿主版本。' }],
    questions: [], limitations: ['未浏览、编译或运行。'] }));
  result.push(artifact('independent-validation', { schemaVersion: 1, summary: '仅审查文稿。', coverage: requirementIds.map(requirementId => ({ requirementId, assessment: 'unclear', reason: '仍缺真实证据。' })),
    issues: [{ id: 'unknown-api', requirementIds: requirementIds.slice(), description: '没有接口验收证据。' }], limitations: ['不能证明后续规格语义。'] }));
  return result;
}
function behavior() {
  const spec = createBehaviorVerificationCases()[0].spec;
  spec.requirementIds.push('appearance'); spec.unresolved.push({ requirementId: 'appearance', reason: '角色外观需要资产与骨骼绑定，状态数据无法表达。' });
  return { schemaVersion: 1, summary: '时序与互锁的受限数据提案，角色外观仍未表达。', spec,
    assumptions: ['数值单位需要来源规格确认。'], limitations: ['独立行为数据没有连接真实宿主。'] };
}
const response = (value, finish_reason = 'stop') => new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] }));

test('complete five-role context is dependency-validated, detached and preserves every requirement and original description', () => {
  const raw = analyses(), original = structuredClone(raw);
  const context = validatePipelineUpstream(request, raw.slice().reverse());
  assert.deepEqual(context.upstream.map(item => item.role), ['requirements', 'source-research', 'host-research', 'conversion-implementation', 'independent-validation']);
  assert.deepEqual(context.requirementIds, ids); assert.equal(context.plan.originalRequest.description, request.description);
  assert.equal(context.upstream[4].analysis.issues[0].description, original[4].analysis.issues[0].description);
  assertRunData(context);
  raw[0].analysis.requirements[0].description = 'changed';
  assert.notEqual(context.plan.requirements[0].description, 'changed');
  context.plan.requirements[0].description = 'separate-plan-copy';
  assert.notEqual(context.upstream[0].analysis.requirements[0].description, 'separate-plan-copy');
});

test('missing, duplicate, forged and hostile upstream context is rejected without evaluating accessors', () => {
  const upstream = analyses(); let getterCalls = 0;
  const getter = Object.defineProperty({}, 'role', { enumerable: true, get() { getterCalls++; return 'requirements'; } });
  const sparse = Array(5);
  const forged = structuredClone(upstream); forged[3].game = 'passed';
  for (const bad of [upstream.slice(0, 4), [...upstream, upstream[0]], [upstream[0], upstream[0], ...upstream.slice(2)], [getter, ...upstream.slice(1)], sparse, forged]) {
    assert.throws(() => validatePipelineUpstream(request, bad), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  }
  const reqGetter = Object.defineProperty({}, 'description', { enumerable: true, get() { getterCalls++; return 'not read'; } });
  assert.throws(() => validatePipelineUpstream(reqGetter, upstream), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(getterCalls, 0);
});

test('behavior proposal binds the entire external ID set and preserves out-of-language requirements as unresolved', () => {
  const value = behavior(), upstream = analyses(), normalized = validateBehaviorProposal(value, { request, upstream });
  assert.deepEqual(normalized, value); assert.deepEqual(normalized.spec.requirementIds, ids);
  assert.equal(normalized.spec.unresolved[0].requirementId, 'appearance');
  assert.deepEqual(Object.keys(normalized), ['schemaVersion', 'summary', 'spec', 'assumptions', 'limitations']);
  value.spec.unresolved[0].reason = 'changed'; assert.notEqual(normalized.spec.unresolved[0].reason, 'changed');
});

test('omitted IDs, invented IDs, executable fields and malformed ASTs have static safe diagnostics', () => {
  const marker = 'private-invalid-field-or-value';
  const changes = [value => { value[marker] = marker; }, value => { value.code = marker; }, value => { value.spec.requirementIds.pop(); value.spec.unresolved = []; },
    value => { value.spec.requirementIds.push('invented'); }, value => { value.spec.transitions[0].guard = { op: 'execute', command: marker }; },
    value => { value.spec.variables[0].max = Infinity; }, value => { value.assumptions = Array(17).fill(marker); }, value => { value.summary = marker.repeat(100); }];
  for (const change of changes) {
    const value = behavior(); change(value);
    assert.throws(() => validateBehaviorProposal(value, { request, upstream: analyses() }), error => {
      assert.equal(error.code, 'INVALID_BEHAVIOR_PROPOSAL'); assert.equal(error.category, 'schema');
      assert.deepEqual(error.diagnostics, [{ path: '/', rule: 'contract', expected: 'bounded behavior data bound to all original requirement IDs' }]);
      assert.ok(!JSON.stringify(error).includes(marker)); return true;
    });
  }
});

test('proposal/options accessors and exotic note arrays are rejected without invocation', () => {
  let invoked = 0; const value = behavior(); Object.defineProperty(value, 'spec', { enumerable: true, get() { invoked++; return {}; } });
  assert.throws(() => validateBehaviorProposal(value, { request, upstream: analyses() }), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  const options = Object.defineProperty({}, 'request', { enumerable: true, get() { invoked++; return request; } });
  assert.throws(() => validateBehaviorProposal(behavior(), options), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  class Notes extends Array { toJSON() { invoked++; return []; } }
  const exotic = behavior(); exotic.limitations = new Notes('unsafe');
  assert.throws(() => validateBehaviorProposal(exotic, { request, upstream: analyses() }), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(invoked, 0);
});

test('messages include all five reports, full request, external IDs and the bounded AST language without proof promotion', () => {
  const built = buildBehaviorProposalMessages(request, analyses()), input = JSON.parse(built.messages[1].content);
  assert.equal(input.request.description, request.description); assert.equal(input.upstream.length, 5); assert.deepEqual(input.requirementIds, ids);
  assert.match(built.messages[0].content, /add,sub,min,max/); assert.match(built.messages[0].content, /NO host effects/);
  assert.match(built.messages[0].content, /unresolved/); assert.match(built.messages[0].content, /not proof of semantic completeness/);
  assert.ok(!Object.hasOwn(built, 'readyToGenerate')); assertRunData(built);
});

test('over-limit valid analysis context is rejected rather than dropping reports or truncating requirements', () => {
  const upstream = analyses();
  const plan = upstream[0].analysis;
  const proposal = Object.fromEntries(['schemaVersion', 'title', 'hostGame', 'sourceGame', 'summary', 'requirements', 'assetNeeds', 'interfaceNeeds', 'questions', 'limitations'].map(key => [key, plan[key]]));
  proposal.summary = '摘'.repeat(1800);
  for (const requirement of proposal.requirements) { requirement.description = '需'.repeat(1600); requirement.reason = '据'.repeat(800); }
  proposal.questions = Array(16).fill('q'.repeat(800)); proposal.limitations = Array(16).fill('l'.repeat(800));
  upstream[0].analysis = validateConversionPlan(proposal, request);
  for (const artifact of upstream.slice(1, 4)) {
    artifact.analysis.items = Array.from({ length: 6 }, (_, i) => ({ id: 'item-' + i, requirementIds: ids.slice(), description: 'd'.repeat(1100), nextStep: 'n'.repeat(1100) }));
    artifact.analysis.summary = 's'.repeat(1700);
  }
  upstream[4].analysis.issues = Array.from({ length: 8 }, (_, i) => ({ id: 'issue-' + i, requirementIds: ids.slice(), description: 'i'.repeat(1200) }));
  upstream[4].analysis.coverage.forEach(item => { item.reason = 'r'.repeat(1200); });
  upstream[4].analysis.summary = 's'.repeat(1800);
  assert.equal(validatePipelineUpstream(request, upstream).upstream.length, 5);
  assert.throws(() => buildBehaviorProposalMessages(request, upstream), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(upstream.length, 5); assert.equal(upstream[1].analysis.items[0].description.length, 1100);
});

test('analysis IDs outside the behavior grammar block before a paid proposal rather than being renamed', async () => {
  let calls = 0; const upstream = analyses(['timing--', 'interlock', 'appearance']);
  await assert.rejects(generateBehaviorProposal(request, upstream, { apiKey: KEY, fetchImpl: async () => { calls++; return response(behavior()); } }), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(calls, 0); assert.equal(upstream[0].analysis.requirements[0].id, 'timing--');
});

test('mock provider makes exactly one structured call and schema failures never trigger retries', async () => {
  let calls = 0;
  const options = { apiKey: KEY, fetchImpl: async (url, opts) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(opts.redirect, 'error');
    assert.equal(opts.headers.Authorization, `Bearer ${KEY}`); assert.ok(!opts.body.includes(KEY));
    const body = JSON.parse(opts.body); assert.equal(body.max_tokens, 8192); assert.equal(JSON.parse(body.messages[1].content).upstream.length, 5);
    return response(behavior());
  } };
  const accepted = await generateBehaviorProposal(request, analyses(), options); assert.deepEqual(accepted, behavior()); assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(generateBehaviorProposal(request, analyses(), { apiKey: KEY, fetchImpl: async () => { calls++; return response({ code: 'never executed' }); } }), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(generateBehaviorProposal(request, analyses().slice(1), { ...options, fetchImpl: async () => { calls++; return response(behavior()); } }), { code: 'INVALID_BEHAVIOR_PROPOSAL' });
  assert.equal(calls, 0);
});

test('credentials in proposals, upstream and unknown keys never escape validation or enter a provider request', async () => {
  const echo = behavior(); echo.summary = KEY;
  assert.throws(() => validateBehaviorProposal(echo, { request, upstream: analyses(), secrets: [KEY] }), { code: 'CREDENTIAL_IN_RESPONSE' });
  const unknown = behavior(); unknown[KEY] = 'blocked';
  assert.throws(() => validateBehaviorProposal(unknown, { request, upstream: analyses(), secrets: [KEY] }), error => {
    assert.equal(error.code, 'CREDENTIAL_IN_RESPONSE'); assert.ok(!JSON.stringify(error).includes(KEY)); return true;
  });
  const upstream = analyses(); upstream[1].analysis.summary = KEY; let calls = 0;
  await assert.rejects(generateBehaviorProposal(request, upstream, { apiKey: KEY, fetchImpl: async () => { calls++; return response(behavior()); } }), { code: 'CREDENTIAL_IN_RESPONSE' });
  assert.equal(calls, 0);
  await assert.rejects(generateBehaviorProposal(request, analyses(), { apiKey: KEY, fetchImpl: async () => { calls++; return response(echo); } }), { code: 'CREDENTIAL_IN_RESPONSE' });
  assert.equal(calls, 1);
});

test('rate limits and cancellation remain safe provider failures with no replay', async () => {
  let calls = 0;
  await assert.rejects(generateBehaviorProposal(request, analyses(), { apiKey: KEY, fetchImpl: async () => { calls++; return new Response(KEY, { status: 429 }); } }), { code: 'PROVIDER_RATE_LIMIT' });
  assert.equal(calls, 1);
  const controller = new AbortController(); let release;
  const pending = generateBehaviorProposal(request, analyses(), { apiKey: KEY, signal: controller.signal, fetchImpl: async () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  controller.abort();
  await assert.rejects(pending, error => { assert.equal(error.code, 'PROVIDER_CANCELLED'); assert.ok(!JSON.stringify(error).includes(KEY)); return true; });
  release(response(behavior())); assert.equal(calls, 2);
});
