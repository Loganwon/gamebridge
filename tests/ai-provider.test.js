import test from 'node:test';
import assert from 'node:assert/strict';
import { generatePlan, buildProviderRequest, validateProviderConfig } from '../src/ai/provider.mjs';

const KEY = 'sk-test-secret-do-not-print';
const request = { hostGame: 'stardew-valley', sourceGame: 'terraria', description: '生成一个按 V 临时加速的源码草稿。' };
function plan() { return { schemaVersion: 1, title: '加速草稿', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '受支持的源码草稿。', requirements: [{ id: 'speed', description: '临时加速', capability: 'speed_burst', status: 'passed' }], mechanics: [{ type: 'speed_burst', key: 'V', amount: 2 }], assetRequirements: [], limitations: [], status: 'passed' }; }
function completion(value = plan(), finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] }), { status: 200 });
}

test('provider sends one compatible JSON request and returns only locally validated status', async () => {
  let count = 0;
  const result = await generatePlan(request, { apiKey: KEY, fetchImpl: async (url, options) => {
    count++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false);
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 4000);
    assert.match(body.messages[0].content, /JSON/);
    assert.deepEqual(JSON.parse(body.messages[1].content), request);
    assert.ok(!options.body.includes(KEY));
    assert.ok(options.signal instanceof AbortSignal);
    return completion();
  } });
  assert.equal(count, 1);
  assert.equal(result.status, 'draft_supported');
  assert.ok(result.requirements.every(item => item.status === 'draft_supported'));
});

test('cloud origin and model are configurable while URL credentials, paths and local endpoints fail', () => {
  const call = buildProviderRequest(request, { apiKey: KEY, baseUrl: 'https://model.example.com/', model: 'custom-model-v1' });
  assert.equal(call.url, 'https://model.example.com/chat/completions');
  assert.equal(JSON.parse(call.options.body).model, 'custom-model-v1');
  for (const baseUrl of ['http://api.deepseek.com', 'https://user:pass@api.deepseek.com', 'https://api.deepseek.com/v1', 'https://api.deepseek.com?key=x', 'https://api.deepseek.com#x', 'https://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://service.local']) {
    assert.throws(() => validateProviderConfig({ apiKey: KEY, baseUrl }));
  }
  for (const apiKey of ['', 'short', 'sk-key\nline', 'sk key spaces']) assert.throws(() => validateProviderConfig({ apiKey }));
  assert.throws(() => validateProviderConfig({ apiKey: KEY, model: 'model\nheader' }));
});

test('invalid configuration or request never causes a network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return completion(); };
  await assert.rejects(generatePlan(request, { apiKey: '', fetchImpl }));
  await assert.rejects(generatePlan({ ...request, description: '' }, { apiKey: KEY, fetchImpl }));
  assert.equal(calls, 0);
});

test('provider authentication, quota and HTTP errors omit response bodies and secrets', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_HTTP']]) {
    let calls = 0;
    await assert.rejects(generatePlan(request, { apiKey: KEY, fetchImpl: async () => { calls++; return new Response(`secret ${KEY}`, { status }); } }), error => {
      assert.equal(error.code, code);
      assert.ok(!String(error).includes(KEY));
      assert.ok(!JSON.stringify(error).includes(KEY));
      return true;
    });
    assert.equal(calls, 1, 'errors must not silently repeat chargeable provider calls');
  }
});

test('provider rejects malformed envelopes, incomplete completions and empty content', async () => {
  for (const response of [
    new Response('{broken'), new Response(JSON.stringify({ choices: [] })),
    completion(plan(), 'length'), completion(plan(), 'content_filter'),
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })),
    new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] })),
  ]) await assert.rejects(generatePlan(request, { apiKey: KEY, fetchImpl: async () => response }), error => {
    assert.ok(['INVALID_RESPONSE', 'INCOMPLETE_RESPONSE', 'EMPTY_RESPONSE', 'INVALID_PLAN'].includes(error.code));
    return true;
  });
});

test('malformed, wrong-direction and unbounded model plans never reach generation', async () => {
  for (const mutate of [raw => { raw.hostGame = 'terraria'; }, raw => { raw.mechanics[0].amount = 999; }, raw => { raw.code = KEY; }]) {
    const raw = plan(); mutate(raw);
    await assert.rejects(generatePlan(request, { apiKey: KEY, fetchImpl: async () => completion(raw) }), error => {
      assert.equal(error.code, 'INVALID_PLAN'); assert.ok(!String(error).includes(KEY)); return true;
    });
  }
});

test('response body limits apply to declared lengths and streamed bytes', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } }), new Response('x'.repeat(256 * 1024 + 1))]) {
    await assert.rejects(generatePlan(request, { apiKey: KEY, fetchImpl: async () => response }), error => error.code === 'RESPONSE_TOO_LARGE');
  }
});

test('timeouts and cancellation settle even when a test transport ignores AbortSignal', async () => {
  const timeout = AbortSignal.timeout(10);
  await assert.rejects(generatePlan(request, { apiKey: KEY, signal: timeout,
    fetchImpl: () => new Promise(resolve => setTimeout(() => resolve(completion()), 50)) }), error => error.code === 'PROVIDER_TIMEOUT');
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(generatePlan(request, { apiKey: KEY, signal: controller.signal, fetchImpl: async () => { calls++; return completion(); } }), error => error.code === 'PROVIDER_CANCELLED');
  assert.equal(calls, 0);
});

test('transport errors are generic and cannot leak a token embedded by a provider', async () => {
  await assert.rejects(generatePlan(request, { apiKey: KEY, fetchImpl: async () => { throw new Error(`network detail ${KEY}`); } }), error => {
    assert.equal(error.code, 'PROVIDER_NETWORK'); assert.ok(!String(error).includes(KEY)); return true;
  });
});

test('successful provider completions that echo credentials are discarded before a plan is returned', async () => {
  for (const apiKey of [KEY, 'sk-test-quote"and-backslash\\']) {
    const proposal = plan();
    proposal.summary = `Upstream unexpectedly echoed ${apiKey}`;
    await assert.rejects(generatePlan(request, { apiKey, fetchImpl: async () => completion(proposal) }), error => {
      assert.equal(error.code, 'CREDENTIAL_IN_RESPONSE');
      assert.ok(!String(error).includes(apiKey));
      assert.ok(!JSON.stringify(error).includes(JSON.stringify(apiKey).slice(1, -1)));
      assert.ok(!Object.hasOwn(error, 'plan'));
      return true;
    });
  }
});
