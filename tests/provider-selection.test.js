import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderConfig } from '../src/ai/provider.mjs';

const DEFAULTS = Object.freeze({ apiKey: 'default-provider-test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' });

test('default credentials remain bound to their canonical configured HTTPS origin', () => {
  for (const selection of [undefined, {}, { apiKey: '' }, { baseUrl: 'https://API.DEEPSEEK.com:443/' }]) {
    const result = resolveProviderConfig(selection, DEFAULTS);
    assert.equal(result.apiKey, DEFAULTS.apiKey);
    assert.equal(result.baseUrl, DEFAULTS.baseUrl);
  }
  assert.equal(resolveProviderConfig({ model: 'another-model' }, DEFAULTS).model, 'another-model');
});

test('changed domain or port requires an explicit credential before provider work', () => {
  for (const baseUrl of ['https://other-provider.example', 'https://api.deepseek.com:444', 'https://api.deepseek.com.attacker.example']) {
    for (const apiKey of [undefined, '']) {
      const override = { baseUrl, ...(apiKey === undefined ? {} : { apiKey }) };
      assert.throws(() => resolveProviderConfig(override, DEFAULTS), error => {
        assert.equal(error.code, 'PROVIDER_KEY_REQUIRED_FOR_ORIGIN');
        assert.ok(!error.message.includes(DEFAULTS.apiKey));
        return true;
      });
    }
  }
});

test('an explicit new credential can select another provider without mutating defaults', () => {
  const result = resolveProviderConfig({ apiKey: 'new-provider-test-key', baseUrl: 'https://other-provider.example/', model: 'compatible-model' }, DEFAULTS);
  assert.deepEqual(result, { apiKey: 'new-provider-test-key', baseUrl: 'https://other-provider.example', model: 'compatible-model' });
  assert.equal(DEFAULTS.apiKey, 'default-provider-test-key');
  assert.throws(() => resolveProviderConfig({}, { ...DEFAULTS, apiKey: '' }), { code: 'API_KEY_REQUIRED' });
  assert.equal(resolveProviderConfig({ apiKey: 'explicit-test-key' }, { baseUrl: DEFAULTS.baseUrl }).apiKey, 'explicit-test-key');
});

test('provider selections reject malformed values, invalid URLs and executable properties', () => {
  for (const value of [null, [], 'provider', { apiKey: null }, { baseUrl: false }, { model: 4 }, { unknown: true }, { baseUrl: 'https://api.deepseek.com/path' }, { baseUrl: 'https://api.deepseek.com?token=ignored' }, { apiKey: ' ' }]) {
    assert.throws(() => resolveProviderConfig(value, DEFAULTS), { code: 'INVALID_PROVIDER_CONFIG' });
  }
  let read = false;
  const accessor = Object.defineProperty({}, 'apiKey', { enumerable: true, get() { read = true; return 'must-not-read'; } });
  assert.throws(() => resolveProviderConfig(accessor, DEFAULTS), { code: 'INVALID_PROVIDER_CONFIG' });
  assert.equal(read, false);
});
