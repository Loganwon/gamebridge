import test from 'node:test';
import assert from 'node:assert/strict';
import { requestJsonCompletion, validateProviderConfig } from '../src/ai/provider.mjs';

const KEY = 'test-provider-secret-do-not-retain';
const MESSAGES = [{ role: 'system', content: 'Return one bounded JSON object.' }, { role: 'user', content: 'Analyze this conversion request.' }];
function completion(value = { analysis: 'unverified' }, finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify(value) } }] }));
}

test('generic provider sends one bounded JSON request without game-specific instructions', async () => {
  let calls = 0;
  const result = await requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(options.method, 'POST'); assert.equal(options.headers.Authorization, `Bearer ${KEY}`); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.messages, MESSAGES); assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.stream, false); assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.max_tokens > 0 && body.max_tokens <= 8192); assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!options.body.includes(KEY)); return completion();
  } });
  assert.equal(calls, 1); assert.deepEqual(result, { analysis: 'unverified' });
});

test('provider configuration remains cloud-only and does not accept URL credentials or local endpoints', () => {
  assert.deepEqual(validateProviderConfig({ apiKey: KEY, baseUrl: 'https://model.example.com/', model: 'custom-model' }), { apiKey: KEY, baseUrl: 'https://model.example.com', model: 'custom-model' });
  for (const baseUrl of ['http://api.deepseek.com', 'https://user:pass@api.deepseek.com', 'https://api.deepseek.com/path', 'https://api.deepseek.com?key=x', 'https://api.deepseek.com#x', 'https://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://service.local']) assert.throws(() => validateProviderConfig({ apiKey: KEY, baseUrl }));
  for (const apiKey of ['', 'short', 'key\nline', 'key spaces']) assert.throws(() => validateProviderConfig({ apiKey }));
  assert.throws(() => validateProviderConfig({ apiKey: KEY, model: 'model\nheader' }));
});

test('invalid transport input and request credential echoes stop before any network call', async () => {
  let calls = 0; const fetchImpl = async () => { calls++; return completion(); };
  for (const messages of [[], [{ role: 'user', content: 'only one message' }], [{ role: 'system', content: '' }, MESSAGES[1]], [{ role: 'bad', content: 'x' }, MESSAGES[1]]]) await assert.rejects(requestJsonCompletion(messages, { apiKey: KEY, fetchImpl }));
  for (const options of [{ apiKey: '' }, { maxTokens: 8193 }, { maxTokens: 0 }, { timeoutMs: 10 }]) await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl, ...options }));
  await assert.rejects(requestJsonCompletion([MESSAGES[0], { role: 'user', content: KEY }], { apiKey: KEY, fetchImpl }), { code: 'CREDENTIAL_IN_REQUEST' });
  assert.equal(calls, 0);
});

test('provider authentication, quota and HTTP errors omit response bodies and never retry', async () => {
  for (const [status, code] of [[401, 'PROVIDER_AUTH'], [403, 'PROVIDER_AUTH'], [429, 'PROVIDER_RATE_LIMIT'], [500, 'PROVIDER_HTTP']]) {
    let calls = 0;
    await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl: async () => { calls++; return new Response(`private ${KEY}`, { status }); } }), error => {
      assert.equal(error.code, code); assert.ok(!String(error).includes(KEY)); assert.ok(!JSON.stringify(error).includes(KEY)); return true;
    }); assert.equal(calls, 1);
  }
});

test('malformed envelopes, truncation, empty content and invalid JSON are rejected safely', async () => {
  for (const response of [new Response('{broken'), new Response(JSON.stringify({ choices: [] })), completion({}, 'length'), completion({}, 'content_filter'), new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '' } }] })), new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] }))]) {
    await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl: async () => response }), error => {
      assert.ok(['INVALID_RESPONSE', 'INCOMPLETE_RESPONSE', 'EMPTY_RESPONSE', 'INVALID_PLAN'].includes(error.code)); assert.ok(!JSON.stringify(error).includes('{broken')); return true;
    });
  }
});

test('response limits apply to declared lengths and streamed bytes', async () => {
  for (const response of [new Response('{}', { headers: { 'content-length': String(256 * 1024 + 1) } }), new Response('x'.repeat(256 * 1024 + 1))]) await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl: async () => response }), { code: 'RESPONSE_TOO_LARGE' });
});

test('timeouts and cancellation settle even when a test transport ignores the signal', async () => {
  await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, signal: AbortSignal.timeout(10), fetchImpl: () => new Promise(resolve => setTimeout(() => resolve(completion()), 60)) }), { code: 'PROVIDER_TIMEOUT' });
  const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, signal: controller.signal, fetchImpl: async () => { calls++; return completion(); } }), { code: 'PROVIDER_CANCELLED' });
  assert.equal(calls, 0);
});

test('network exceptions and successful returned credential echoes cannot leak secrets', async () => {
  await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey: KEY, fetchImpl: async () => { throw new Error(`private network detail ${KEY}`); } }), error => {
    assert.equal(error.code, 'PROVIDER_NETWORK'); assert.ok(!String(error).includes(KEY)); return true;
  });
  for (const apiKey of [KEY, 'key-quote"and-backslash\\']) await assert.rejects(requestJsonCompletion(MESSAGES, { apiKey, fetchImpl: async () => completion({ analysis: `echo ${apiKey}` }) }), error => {
    assert.equal(error.code, 'CREDENTIAL_IN_RESPONSE'); assert.ok(!JSON.stringify(error).includes(JSON.stringify(apiKey).slice(1, -1))); assert.ok(!Object.hasOwn(error, 'proposal')); return true;
  });
});
