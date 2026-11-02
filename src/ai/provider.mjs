const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const MAX_RESPONSE_BYTES = 256 * 1024;
const TIMEOUT_MS = 45000;
export class ProviderError extends Error {
  constructor(code, message, { category, diagnostics } = {}) {
    super(message); this.name = 'ProviderError'; this.code = code;
    if (category) this.category = category;
    if (diagnostics) this.diagnostics = diagnostics;
  }
}
function invalid(message) { throw new ProviderError('INVALID_PROVIDER_CONFIG', message); }
export function validateProviderConfig({ apiKey, baseUrl = DEFAULT_BASE_URL, model = 'deepseek-flash' } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length < 8 || apiKey.length > 512 || /[^\x21-\x7e]/.test(apiKey)) invalid('A valid API key is required.');
  if (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(model)) invalid('Invalid model identifier.');
  if (typeof baseUrl !== 'string' || baseUrl.length > 500) invalid('Invalid provider base URL.');
  let url;
  try { url = new URL(baseUrl); } catch { invalid('Invalid provider base URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) invalid('Provider base URL must be an HTTPS origin without a path, credentials or query.');
  if (!url.hostname.includes('.') || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) invalid('Provider must use a public cloud hostname.');
  return { apiKey, baseUrl: url.origin, model };
}

/** Environment credentials belong to their configured origin, never a new URL. */
export function resolveProviderConfig(override = {}, defaults = {}) {
  if (!override || typeof override !== 'object' || Array.isArray(override) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(override)) ||
      Reflect.ownKeys(override).some(key => typeof key !== 'string' || !['apiKey', 'baseUrl', 'model'].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(override)).some(item => !Object.hasOwn(item, 'value'))) invalid('Invalid provider selection.');
  for (const name of ['apiKey', 'baseUrl', 'model']) {
    if (Object.hasOwn(override, name) && typeof override[name] !== 'string') invalid('Provider selection fields must be strings.');
  }
  const baseUrl = override.baseUrl || defaults.baseUrl || DEFAULT_BASE_URL;
  const model = override.model || defaults.model || 'deepseek-flash';
  if (override.apiKey) return validateProviderConfig({ apiKey: override.apiKey, baseUrl, model });
  if (!defaults.apiKey) throw new ProviderError('API_KEY_REQUIRED', '请在本地填写 API Key，或配置默认供应商的密钥。');
  // Validate and canonicalize addresses without ever associating the real key
  // with the new destination until the origins have been compared.
  const originOnlyKey = 'origin-validation-placeholder';
  const requested = validateProviderConfig({ apiKey: originOnlyKey, baseUrl, model });
  const configured = validateProviderConfig({ apiKey: originOnlyKey, baseUrl: defaults.baseUrl || DEFAULT_BASE_URL, model });
  if (requested.baseUrl !== configured.baseUrl) {
    throw new ProviderError('PROVIDER_KEY_REQUIRED_FOR_ORIGIN', 'API 地址已更改，请填写该地址对应的 API Key；本地默认密钥不会发送到其他地址。');
  }
  return validateProviderConfig({ apiKey: defaults.apiKey, baseUrl: requested.baseUrl, model });
}
async function boundedText(response, signal) {
  const length = response.headers?.get?.('content-length');
  if (length !== null && length !== undefined && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw new ProviderError('RESPONSE_TOO_LARGE', 'Provider response exceeded the size limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (signal.aborted) throw signal.reason;
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw new ProviderError('RESPONSE_TOO_LARGE', 'Provider response exceeded the size limit.');
    return text;
  }
  const reader = response.body.getReader();
  let total = 0;
  const chunks = [];
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new ProviderError('RESPONSE_TOO_LARGE', 'Provider response exceeded the size limit.');
      chunks.push(value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { await reader.cancel().catch(() => {}); }
}
function abortRace(signal) {
  let handler;
  const promise = new Promise((_, reject) => {
    handler = () => reject(signal.reason || new Error('Aborted'));
    if (signal.aborted) handler(); else signal.addEventListener('abort', handler, { once: true });
  });
  // A caller may already be cancelled before the operation reaches Promise.race.
  promise.catch(() => {});
  return { promise, dispose: () => signal.removeEventListener('abort', handler) };
}

/** A single bounded JSON completion. Does not retry or retain provider responses. */
export async function requestJsonCompletion(messages, { apiKey, baseUrl = DEFAULT_BASE_URL, model = 'deepseek-flash', fetchImpl = fetch, signal, maxTokens = 4000, timeoutMs = TIMEOUT_MS } = {}) {
  const settings = validateProviderConfig({ apiKey, baseUrl, model });
  if (!Array.isArray(messages) || messages.length < 2 || messages.length > 4 ||
      messages.some(message => !message || !['system', 'user'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) ||
      Buffer.byteLength(JSON.stringify(messages), 'utf8') > 128 * 1024 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) invalid('Invalid JSON completion input.');
  if (JSON.stringify(messages).includes(JSON.stringify(apiKey).slice(1, -1))) throw new ProviderError('CREDENTIAL_IN_REQUEST', 'Request contained a credential and was discarded.');
  const call = { url: `${settings.baseUrl}/chat/completions`, options: {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model, messages, response_format: { type: 'json_object' }, max_tokens: maxTokens, stream: false,
      ...(settings.baseUrl === DEFAULT_BASE_URL ? { thinking: { type: 'disabled' } } : {}) }), redirect: 'error',
  } };
  if (typeof fetchImpl !== 'function') invalid('Invalid provider transport.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const abort = abortRace(combined);
  try {
    if (combined.aborted) throw combined.reason;
    const operation = (async () => {
      const response = await fetchImpl(call.url, { ...call.options, signal: combined });
      if (!response || typeof response.status !== 'number') throw new ProviderError('INVALID_RESPONSE', 'Provider returned an invalid response.');
      if (response.status === 401 || response.status === 403) throw new ProviderError('PROVIDER_AUTH', 'Provider authentication failed. Check the configured key and permissions.');
      if (response.status === 429) throw new ProviderError('PROVIDER_RATE_LIMIT', 'Provider rate limit or quota was reached.');
      if (response.status < 200 || response.status >= 300) throw new ProviderError('PROVIDER_HTTP', 'Provider request failed. No provider response body was retained.');
      let envelope;
      try { envelope = JSON.parse(await boundedText(response, combined)); }
      catch (error) { if (error instanceof ProviderError || combined.aborted) throw error; throw new ProviderError('INVALID_RESPONSE', 'Provider returned malformed JSON.'); }
      if (!Array.isArray(envelope?.choices) || envelope.choices.length !== 1) throw new ProviderError('INVALID_RESPONSE', 'Provider returned an unexpected completion shape.');
      const choice = envelope.choices[0];
      if (choice?.finish_reason !== 'stop') throw new ProviderError('INCOMPLETE_RESPONSE', 'Provider did not finish the plan. Retry with a smaller request.');
      if (typeof choice.message?.content !== 'string' || !choice.message.content.trim()) throw new ProviderError('EMPTY_RESPONSE', 'Provider returned an empty plan.');
      let proposal;
      try { proposal = JSON.parse(choice.message.content); }
      catch { throw new ProviderError('INVALID_PLAN', 'Provider returned an invalid JSON plan.', {
        category: 'json', diagnostics: Object.freeze([Object.freeze({ path: '/', rule: 'json', expected: 'one valid JSON value without Markdown' })]),
      }); }
      // Successful completions are untrusted too: never retain an echoed credential
      // in a plan, source file or download. Match JSON's escaping of punctuation.
      if (JSON.stringify(proposal).includes(JSON.stringify(apiKey).slice(1, -1))) {
        throw new ProviderError('CREDENTIAL_IN_RESPONSE', 'Provider result contained a credential and was discarded.');
      }
      return proposal;
    })();
    return await Promise.race([operation, abort.promise]);
  } catch (error) {
    if (combined.aborted) {
      const timedOut = timeout.aborted || combined.reason?.name === 'TimeoutError';
      throw new ProviderError(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_CANCELLED', timedOut ? 'Provider request timed out.' : 'Provider request was cancelled.');
    }
    if (error instanceof ProviderError) throw error;
    // Fetch exceptions may include credentials or URLs; never propagate their text.
    throw new ProviderError('PROVIDER_NETWORK', 'Could not reach the configured model provider.');
  } finally { abort.dispose(); }
}
