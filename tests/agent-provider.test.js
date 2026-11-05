// Mock provider responses verify role and data boundaries only, not model or game acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAgentArtifact, buildAgentMessages, validateAgentArtifact, validateAgentProposal } from '../src/agents/provider.mjs';

const KEY = 'agent-provider-test-canary-not-live';
const request = { hostGame: 'Requested Host', sourceGame: 'Requested Source', description: '把来源角色的动作与交互带入宿主，保留完整需求。', contentKinds: ['character', 'moveset'] };
function plan() { return { schemaVersion: 1, title: '转换需求', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '未验证的转换计划。',
  requirements: [{ id: 'moves', kind: 'moveset', description: request.description, disposition: 'needs_research', reason: '需要正式接口和资源证据。' }],
  assetNeeds: [], interfaceNeeds: [{ id: 'interface', description: '调查接口。', requirementIds: ['moves'] }], questions: [], limitations: ['尚无已验收游戏适配器。'] }; }
function report() { return { schemaVersion: 1, summary: '未验证的研究或转换建议。', items: [{ id: 'proposal', requirementIds: ['moves'], description: '保留来源动作规格与资源缺口。', nextStep: '核对精确版本和正式接口。' }], questions: [], limitations: ['没有浏览、读取游戏、编译或运行。'] }; }
function review() { return { schemaVersion: 1, summary: '仅审查方案。', coverage: [{ requirementId: 'moves', assessment: 'unclear', reason: '尚无实际资源和接口证据。' }], issues: [{ id: 'unverified', requirementIds: ['moves'], description: '需要后续真实验收。' }], limitations: ['方案完整性意见不是游戏成功。'] }; }
function completion(value, finish_reason = 'stop') { return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] })); }
test('review diagnostics identify known excess fields while excluding untrusted property names', () => {
  const upstream = [{ schemaVersion: 1, role: 'requirements', scope: 'analysis-only', evidenceScope: 'unverified-proposal', hostGame: request.hostGame, sourceGame: request.sourceGame,
    analysis: plan(), realModBuild: 'not_run', game: 'not_run', readyToInstall: false }];
  assert.throws(() => validateAgentProposal('independent-validation', { ...review(), questions: [] }, { request, upstream }), error => {
    assert.equal(error.code, 'INVALID_AGENT_REPORT'); assert.equal(error.diagnostics[0].path, '/questions'); assert.equal(error.diagnostics[0].rule, 'property'); return true;
  });
  const privateProperty = 'untrusted-property-with-private-canary';
  assert.throws(() => validateAgentProposal('independent-validation', { ...review(), [privateProperty]: 'value' }, { request, upstream }), error => {
    assert.equal(error.diagnostics[0].path, '/'); assert.ok(!JSON.stringify(error.diagnostics).includes(privateProperty)); return true;
  });
});
async function invoke(role, upstream, value, inspect = () => {}) {
  let calls = 0;
  const result = await generateAgentArtifact(role, request, upstream, { apiKey: KEY, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions'); assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error'); assert.ok(!options.body.includes(KEY)); inspect(JSON.parse(options.body)); return completion(value);
  } });
  assert.equal(calls, 1); return result;
}

test('five roles exchange actual structured upstream data with one mock call per role', async () => {
  const requirement = await invoke('requirements', [], plan());
  const source = await invoke('source-research', [requirement], report(), body => {
    assert.match(body.messages[0].content, /NO web, filesystem or game tools/);
    const context = JSON.parse(body.messages[1].content); assert.equal(context.upstream[0].role, 'requirements');
    assert.equal(context.request.hostGame, request.hostGame); assert.equal(context.request.sourceGame, request.sourceGame);
  });
  const host = await invoke('host-research', [requirement], report());
  const implementation = await invoke('conversion-implementation', [requirement, source, host], report(), body => {
    const context = JSON.parse(body.messages[1].content); assert.equal(context.upstream.length, 3);
    assert.match(body.messages[0].content, /implementation DESIGN/); assert.match(body.messages[0].content, /cannot generate source code/);
  });
  const validation = await invoke('independent-validation', [requirement, source, host, implementation], review());
  for (const artifact of [requirement, source, host, implementation, validation]) {
    assert.equal(artifact.scope, 'analysis-only'); assert.equal(artifact.evidenceScope, 'unverified-proposal');
    assert.equal(artifact.realModBuild, 'not_run'); assert.equal(artifact.game, 'not_run'); assert.equal(artifact.readyToInstall, false);
  }
  assert.equal(validation.analysis.coverage[0].assessment, 'unclear');
});

test('missing dependencies and malformed upstream evidence fail before any provider call', async () => {
  let calls = 0;
  const options = { apiKey: KEY, fetchImpl: async () => { calls++; return completion(report()); } };
  await assert.rejects(generateAgentArtifact('host-research', request, [], options), { code: 'INVALID_AGENT_CONTEXT' });
  const requirement = await invoke('requirements', [], plan());
  await assert.rejects(generateAgentArtifact('conversion-implementation', request, [requirement], options), { code: 'INVALID_AGENT_CONTEXT' });
  const forged = structuredClone(requirement); forged.game = 'passed';
  await assert.rejects(generateAgentArtifact('host-research', request, [forged], options), { code: 'INVALID_AGENT_REPORT' });
  assert.equal(calls, 0);
});

test('role-specific data rejects success, commands, lost requirements and invalid review coverage', async () => {
  const requirement = await invoke('requirements', [], plan());
  for (const mutate of [value => { value.game = 'passed'; }, value => { value.commands = ['private-command-marker']; }, value => { value.items[0].requirementIds = ['invented']; }, value => { value.items = []; }]) {
    const value = report(); mutate(value); let calls = 0;
    await assert.rejects(generateAgentArtifact('source-research', request, [requirement], { apiKey: KEY, fetchImpl: async () => { calls++; return completion(value); } }), error => {
      assert.equal(error.code, 'INVALID_AGENT_REPORT'); assert.ok(!JSON.stringify(error).includes('private-command-marker')); return true;
    }); assert.equal(calls, 1);
  }
  const source = await invoke('source-research', [requirement], report()), host = await invoke('host-research', [requirement], report());
  const implementation = await invoke('conversion-implementation', [requirement, source, host], report());
  const missing = review(); missing.coverage = [];
  await assert.rejects(generateAgentArtifact('independent-validation', request, [requirement, implementation], { apiKey: KEY, fetchImpl: async () => completion(missing) }), { code: 'INVALID_AGENT_REPORT' });
});

test('credentials and provider failures never become persisted agent reports or retries', async () => {
  const requirement = await invoke('requirements', [], plan());
  const echo = report(); echo.summary = KEY;
  for (const [response, code] of [[completion(echo), 'CREDENTIAL_IN_RESPONSE'], [completion(report(), 'length'), 'INCOMPLETE_RESPONSE'], [new Response('not retained', { status: 429 }), 'PROVIDER_RATE_LIMIT']]) {
    let calls = 0;
    await assert.rejects(generateAgentArtifact('source-research', request, [requirement], { apiKey: KEY, fetchImpl: async () => { calls++; return response; } }), { code });
    assert.equal(calls, 1);
  }
  const accessor = {}; Object.defineProperty(accessor, 'role', { enumerable: true, get() { throw new Error('must not invoke'); } });
  assert.throws(() => validateAgentArtifact(accessor, { request }), { code: 'INVALID_AGENT_REPORT' });
  class HostileArray extends Array { toJSON() { throw new Error('must not invoke inherited conversion'); } }
  assert.throws(() => buildAgentMessages('source-research', request, new HostileArray()), { code: 'INVALID_AGENT_REPORT' });
  assert.throws(() => buildAgentMessages('not-a-role', request, []), { code: 'INVALID_AGENT_ROLE' });
});

test('review schema diagnostics locate missing or duplicate coverage without exposing report values', async () => {
  const requirements = plan();
  requirements.requirements.push({ id: 'character', kind: 'character', description: '保留来源角色。', disposition: 'needs_research', reason: '尚需证据。' });
  const requirement = await invoke('requirements', [], requirements);
  const safe = review(); safe.coverage.push({ requirementId: 'character', assessment: 'unclear', reason: '尚需证据。' });
  const valueMarker = 'private-review-value-never-echo';
  const keyMarker = 'private-review-field-never-echo';
  const cases = [
    { change: value => { delete value.coverage; }, path: '/coverage', rule: 'required' },
    { change: value => { value.coverage.pop(); }, path: '/coverage', rule: 'coverage' },
    { change: value => { value.coverage[1].requirementId = 'moves'; }, path: '/coverage', rule: 'unique' },
    { change: value => { value.coverage[0][keyMarker] = valueMarker; }, path: '/coverage/0', rule: 'object' },
    { change: value => { value[keyMarker] = valueMarker; }, path: '/', rule: 'object' },
    { change: value => { value.coverage[0].assessment = valueMarker; }, path: '/coverage/0/assessment', rule: 'enum' },
    { change: value => { value.coverage[0].requirementId = valueMarker; }, path: '/coverage/0/requirementId', rule: 'reference' },
  ];
  for (const { change, path, rule } of cases) {
    const value = structuredClone(safe); change(value); value.summary = valueMarker;
    assert.throws(() => validateAgentProposal('independent-validation', value, { request, upstream: [requirement] }), error => {
      assert.equal(error.code, 'INVALID_AGENT_REPORT'); assert.equal(error.category, 'schema');
      assert.equal(error.diagnostics.length, 1); assert.equal(error.diagnostics[0].path, path); assert.equal(error.diagnostics[0].rule, rule);
      assert.deepEqual(Object.keys(error.diagnostics[0]), ['path', 'rule', 'expected']);
      assert.ok(Object.isFrozen(error.diagnostics)); assert.ok(Object.isFrozen(error.diagnostics[0]));
      assert.ok(!JSON.stringify(error).includes(valueMarker)); assert.ok(!JSON.stringify(error).includes(keyMarker));
      return true;
    });
  }
});

test('review limits have bounded local diagnostics and generation still makes only one request', async () => {
  const requirement = await invoke('requirements', [], plan());
  const valueMarker = 'unsafe-limit-value-never-echo';
  const cases = [
    { change: value => { value.coverage = Array.from({ length: 33 }, () => ({ ...value.coverage[0] })); }, path: '/coverage', rule: 'array' },
    { change: value => { value.coverage[0].reason = valueMarker.repeat(50); }, path: '/coverage/0/reason', rule: 'text' },
    { change: value => { value.limitations = Array.from({ length: 12 }, () => '限'.repeat(1000)); }, path: '/', rule: 'bytes' },
  ];
  for (const { change, path, rule } of cases) {
    const value = review(); change(value); let calls = 0;
    // The design input is validated before the mock network call. No actual
    // model, compiler or game is involved in these diagnostics fixtures.
    const implementation = { ...requirement, role: 'conversion-implementation', analysis: report() };
    await assert.rejects(generateAgentArtifact('independent-validation', request, [requirement, implementation], { apiKey: KEY, fetchImpl: async () => { calls++; return completion(value); } }), error => {
      assert.equal(error.code, 'INVALID_AGENT_REPORT'); assert.equal(error.diagnostics[0].path, path); assert.equal(error.diagnostics[0].rule, rule);
      assert.ok(!JSON.stringify(error).includes(valueMarker)); assert.ok(!JSON.stringify(error).includes(KEY));
      return true;
    });
    assert.equal(calls, 1);
  }
});
