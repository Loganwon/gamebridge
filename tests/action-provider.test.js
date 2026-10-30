import test from 'node:test';
import assert from 'node:assert/strict';
import { buildActionMessages, generateActionBlueprint } from '../src/ai/action-provider.mjs';
import { createActionExample, serializeActionProposal } from '../src/actions/spec.mjs';
import { assessActionHost } from '../src/actions/hosts.mjs';

const KEY = 'sk-action-test-secret-do-not-print';
function example() {
  const { request, blueprint } = createActionExample();
  return { request, proposal: serializeActionProposal(blueprint) };
}
function completion(proposal, finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(proposal) } }] }));
}

test('action planning sends one bounded JSON request and returns only rule-design evidence', async () => {
  const { request, proposal } = example();
  let calls = 0;
  const blueprint = await generateActionBlueprint(request, { apiKey: KEY, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.stream, false);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 8192);
    assert.match(body.messages[0].content, /RULE DESIGN/);
    assert.deepEqual(JSON.parse(body.messages[1].content), request);
    assert.ok(!options.body.includes(KEY));
    return completion(proposal);
  } });
  assert.equal(calls, 1);
  assert.deepEqual(blueprint.originalRequest, request);
  assert.equal(blueprint.scope, 'action-blueprint-only');
  assert.equal(blueprint.sourceVerification, 'not_verified');
  assert.equal(blueprint.realModBuild, 'not_run');
  assert.equal(blueprint.game, 'not_run');
  assert.equal(blueprint.readyToInstall, false);
});

test('action prompt keeps unsupported requests and requires explicit resource string arrays', () => {
  const { request } = example();
  const { messages } = buildActionMessages(request);
  assert.match(messages[0].content, /ALL original requirements/);
  assert.match(messages[0].content, /Do not replace complex combat with speed\/damage buffs/);
  assert.match(messages[0].content, /plain strings/);
  assert.match(messages[0].content, /no implemented host action adapter/i);
  assert.match(messages[0].content, /do not invent references/i);
});

test('action planning rejects invalid input and accidental input credentials before any model call', async () => {
  const { request } = example();
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not call'); };
  await assert.rejects(generateActionBlueprint({ ...request, description: '' }, { apiKey: KEY, fetchImpl }));
  await assert.rejects(generateActionBlueprint(request, { apiKey: '', fetchImpl }));
  await assert.rejects(generateActionBlueprint({ ...request, description: `Accidental credential ${KEY}` }, { apiKey: KEY, fetchImpl }), error => {
    assert.equal(error.code, 'CREDENTIAL_IN_REQUEST');
    assert.ok(!JSON.stringify(error).includes(KEY));
    return true;
  });
  assert.equal(calls, 0);
});

test('invalid action outputs are rejected without a retry, coercion or returned raw data', async () => {
  const mutations = [
    proposal => { proposal.actions[0].transitions[0].to = 'missing-action'; },
    proposal => { proposal.assetRequirements = [{ kind: 'weapon', note: 'private-detail-not-retained' }]; },
    proposal => { proposal.actions[0].durationTicks = 1000000; },
    proposal => { proposal.requirements[0].required = 'true'; },
    proposal => { proposal.hostGame = 'wrong-host'; },
    proposal => { proposal.readyToInstall = true; proposal.game = 'passed'; },
    proposal => { proposal.command = 'private-detail-not-retained'; },
  ];
  for (const mutate of mutations) {
    const { request, proposal } = example();
    mutate(proposal);
    let calls = 0;
    await assert.rejects(generateActionBlueprint(request, { apiKey: KEY, fetchImpl: async () => { calls++; return completion(proposal); } }), error => {
      assert.equal(error.code, 'INVALID_ACTION_BLUEPRINT');
      assert.ok(!JSON.stringify(error).includes('private-detail-not-retained'));
      assert.ok(!Object.hasOwn(error, 'proposal'));
      assert.ok(!Object.hasOwn(error, 'blueprint'));
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('unknown action hosts can be designed but cannot become supported through a model response', async () => {
  const { request, proposal } = example();
  request.hostGame = proposal.hostGame = 'unresearched-host';
  proposal.hostVersion = '99.1.0';
  const blueprint = await generateActionBlueprint(request, { apiKey: KEY, fetchImpl: async () => completion(proposal) });
  const assessment = assessActionHost(blueprint);
  assert.equal(assessment.status, 'blocked');
  assert.equal(assessment.host.status, 'unknown');
  assert.ok(assessment.blockers.some(item => item.code === 'HOST_UNKNOWN'));
  assert.equal(assessment.readyToInstall, false);
  assert.equal(assessment.game, 'not_run');
});

test('requested character resources and missing moves remain unresolved alongside action rules', async () => {
  const { request, proposal } = example();
  request.description += '另外需要来源角色外观和空中连击。';
  proposal.requirements.push(
    { id: 'character-assets', description: '来源角色外观', required: true, disposition: 'needs_assets', actionIds: [] },
    { id: 'aerial-combo', description: '空中连击', required: true, disposition: 'needs_adapter', actionIds: [] },
  );
  proposal.assetRequirements = ['用户提供可使用的角色资源，仍需宿主绑定。'];
  const blueprint = await generateActionBlueprint(request, { apiKey: KEY, fetchImpl: async () => completion(proposal) });
  assert.deepEqual(blueprint.originalRequest, request);
  assert.ok(blueprint.coverage.unresolvedIds.includes('character-assets'));
  assert.ok(blueprint.coverage.unresolvedIds.includes('aerial-combo'));
  assert.equal(blueprint.coverage.semanticCoverage, 'not_verified');
  assert.ok(blueprint.actions.every(action => ['attack', 'dodge'].includes(action.kind)));
});

test('action provider rejects successful credential echoes including escaped credentials', async () => {
  for (const apiKey of [KEY, 'sk-action-quote"and-backslash\\']) {
    const { request, proposal } = example();
    proposal.limitations.push(`Unexpected echo: ${apiKey}`);
    await assert.rejects(generateActionBlueprint(request, { apiKey, fetchImpl: async () => completion(proposal) }), error => {
      assert.equal(error.code, 'CREDENTIAL_IN_RESPONSE');
      assert.ok(!String(error).includes(apiKey));
      assert.ok(!JSON.stringify(error).includes(JSON.stringify(apiKey).slice(1, -1)));
      return true;
    });
  }
});

test('action analysis never retries malformed, truncated or failed completions', async () => {
  const { request, proposal } = example();
  for (const [response, code] of [
    [new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] })), 'INVALID_PLAN'],
    [completion(proposal, 'length'), 'INCOMPLETE_RESPONSE'],
    [new Response(`secret ${KEY}`, { status: 429 }), 'PROVIDER_RATE_LIMIT'],
  ]) {
    let calls = 0;
    await assert.rejects(generateActionBlueprint(request, { apiKey: KEY, fetchImpl: async () => { calls++; return response; } }), error => {
      assert.equal(error.code, code);
      assert.ok(!JSON.stringify(error).includes(KEY));
      return true;
    });
    assert.equal(calls, 1);
  }
});
