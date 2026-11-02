import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConversionMessages, generateConversionPlan } from '../src/converter/provider.mjs';

const KEY = 'test-converter-key-never-live';
const request = { hostGame: 'Any Host', sourceGame: 'Any Source', description: '把来源角色和动作带入宿主，保留宿主世界。', contentKinds: ['character', 'moveset'] };
function proposal() { return { schemaVersion: 1, title: '内容转换分析', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '分析需求与缺口。', requirements: [{ id: 'moves', kind: 'moveset', description: request.description, disposition: 'needs_research', reason: '接口与资源未验证。' }], assetNeeds: [], interfaceNeeds: [{ id: 'host-api', description: '需要核验正式接口。', requirementIds: ['moves'] }], questions: ['需要精确版本。'], limitations: ['没有已验收适配器。'] }; }
function completion(value) { return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] })); }

test('conversion provider analyzes arbitrary host/source text once and preserves local stage gates', async () => {
  let calls = 0;
  const result = await generateConversionPlan(request, { apiKey: KEY, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    const call = JSON.parse(options.body); assert.equal(call.max_tokens, 8192);
    assert.match(call.messages[0].content, /No executable game adapters are registered/);
    assert.deepEqual(JSON.parse(call.messages[1].content), resultRequest());
    assert.ok(!options.body.includes(KEY)); return completion(proposal());
  } });
  assert.equal(calls, 1); assert.equal(result.originalRequest.description, request.description);
  assert.equal(result.readyToGenerate, false); assert.equal(result.realModBuild, 'not_run'); assert.equal(result.game, 'not_run');
});
function resultRequest() { return { ...request, hostVersion: 'unknown', sourceVersion: 'unknown' }; }

test('prompt does not reduce conversion requests to a fixed game or a weapon template', () => {
  const { messages } = buildConversionMessages(request), content = messages[0].content;
  assert.match(content, /complete original intent/); assert.match(content, /standalone minigame/); assert.match(content, /fixed weapon\/speed\/damage template/);
  assert.match(content, /Unknown information becomes a question/); assert.match(content, /scope statements.*stay in limitations/);
  assert.doesNotMatch(content, /stardew|smapi|xonotic|minecraft|tmodloader/i);
});

test('invalid requests/config and request credential echoes cause zero outbound calls', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return completion(proposal()); };
  await assert.rejects(generateConversionPlan({ ...request, description: '' }, { apiKey: KEY, fetchImpl }));
  await assert.rejects(generateConversionPlan(request, { apiKey: '', fetchImpl }));
  await assert.rejects(generateConversionPlan({ ...request, description: KEY }, { apiKey: KEY, fetchImpl }), { code: 'CREDENTIAL_IN_REQUEST' });
  assert.equal(calls, 0);
});

test('invalid model data and unsupported success claims stop without exposing values or charging retries', async () => {
  for (const mutate of [p => { p.hostGame = 'wrong'; }, p => { p.requirements[0].description = { privateMarker: 'omit-this-value' }; }, p => { p.game = 'passed'; }, p => { p.code = 'not executable'; }]) {
    const raw = proposal(); mutate(raw); let calls = 0;
    await assert.rejects(generateConversionPlan(request, { apiKey: KEY, fetchImpl: async () => { calls++; return completion(raw); } }), error => {
      assert.equal(error.code, 'INVALID_CONVERSION_PLAN'); assert.ok(!JSON.stringify(error).includes('omit-this-value')); assert.ok(!Object.hasOwn(error, 'proposal')); return true;
    }); assert.equal(calls, 1);
  }
});
