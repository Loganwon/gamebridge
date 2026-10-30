import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const PAGES = [
  { name: 'action workbench', script: 'actions.js', html: 'index.html', form: 'action-form', base: 'base-url', key: 'api-key',
    hint: 'key-status', analyze: 'analyze', inputs: ['host', 'source', 'description', 'base-url', 'model', 'api-key'], connection: 'connection' },
  { name: 'SMAPI pipeline', script: 'app.js', html: 'pipeline.html', form: 'request-form', base: 'provider-base-url', key: 'provider-api-key',
    hint: 'api-key-hint', analyze: 'analyze-button', inputs: ['host-game', 'source-game', 'request-description', 'provider-base-url', 'provider-model', 'provider-api-key'], connection: 'connection-text' },
];
const validConfig = () => ({ local: true, providerConfigured: true,
  defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } });

// A small event/attribute surface, with IDs read from the real page. It does not
// implement provider selection; all business behavior comes from the site script.
function node() {
  const listeners = new Map(), attributes = new Map(), classes = new Set();
  return {
    value: '', textContent: '', disabled: true, hidden: false, children: [],
    classList: { add: value => classes.add(value), remove: value => classes.delete(value),
      toggle(value, enabled) { if (enabled) classes.add(value); else classes.delete(value); } },
    addEventListener(type, handler) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(handler); },
    async dispatch(type) { for (const handler of listeners.get(type) || []) await handler({ target: this, preventDefault() {} }); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    removeAttribute(name) { attributes.delete(name); },
    replaceChildren(...values) { this.children = values; },
    append(...values) { this.children.push(...values); },
    focus() {}, reportValidity() { return true; },
  };
}

async function loadPage(page, config) {
  const [html, source] = await Promise.all([
    readFile(new URL(`../site/${page.html}`, import.meta.url), 'utf8'),
    readFile(new URL(`../site/${page.script}`, import.meta.url), 'utf8'),
  ]);
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, node()]));
  const calls = [];
  const context = {
    document: { getElementById: id => elements.get(id) ?? null, createElement: node,
      createTextNode: text => ({ textContent: text }), querySelectorAll: () => [] },
    location: { hostname: '127.0.0.1' }, window: { addEventListener() {} },
    URL, AbortSignal, AbortController, setTimeout, clearTimeout,
    async fetch(url, options) {
      calls.push({ url, method: options?.method || 'GET' });
      if (url === '/api/config') return { ok: true, json: async () => config };
      if (url === '/api/environment') return { ok: true, json: async () => ({ ready: false, issues: [] }) };
      throw new Error('Unexpected paid API request in provider UI test.');
    },
  };
  let executable = source;
  if (page.script === 'actions.js') {
    const imports = [...source.matchAll(/^import \{ ([^}]+) \} from '(\.\/core\/actions\/(?:spec|runtime|hosts)\.mjs)';$/gm)];
    assert.equal(imports.length, 3, 'Only the known browser core imports are replaced for this provider-only test.');
    executable = source.replace(/^import \{ [^}]+ \} from '\.\/core\/actions\/(?:spec|runtime|hosts)\.mjs';\n/gm, '');
    for (const [, bindings] of imports) for (const binding of bindings.split(',').map(value => value.trim())) {
      context[binding] = () => { throw new Error('Rule operation was unexpectedly invoked in a provider UI test.'); };
    }
  }
  // The last expression is the actual initialize()/connect() promise.
  await vm.runInNewContext(executable, context, { filename: page.script, timeout: 1000 });
  return { elements, calls };
}

for (const page of PAGES) {
  test(`${page.name} binds credential hints and manual keys to the displayed origin`, async () => {
    const { elements, calls } = await loadPage(page, validConfig());
    const base = elements.get(page.base), key = elements.get(page.key), hint = elements.get(page.hint);
    assert.equal(elements.get(page.analyze).disabled, false);
    assert.match(hint.textContent, /可留空/);
    key.value = 'fake-key-for-original-provider';
    base.value = 'https://API.DEEPSEEK.COM:443/';
    await base.dispatch('input');
    assert.equal(key.value, 'fake-key-for-original-provider', 'Equivalent origin keeps the explicitly typed key.');
    assert.match(hint.textContent, /可留空/);

    base.value = 'https://other-provider.example';
    await base.dispatch('input');
    assert.equal(key.value, '', 'Changing origin clears the previous manually entered key.');
    assert.match(hint.textContent, /地址已更改.*对应/);
    elements.get(page.inputs[0]).value = 'test-host';
    elements.get(page.inputs[1]).value = 'test-source';
    elements.get(page.inputs[2]).value = '有效的测试需求';
    await elements.get(page.form).dispatch('submit');
    assert.ok(calls.every(call => ['/api/config', '/api/environment'].includes(call.url)), 'Missing replacement key cannot start paid work.');

    key.value = 'fake-key-for-replacement-provider';
    base.value = 'https://api.deepseek.com';
    await base.dispatch('input');
    assert.equal(key.value, '');
    assert.match(hint.textContent, /可留空/);
  });

  test(`${page.name} stays disconnected and disabled for malformed configuration`, async () => {
    for (const config of [null, { local: false }, { local: true },
      { ...validConfig(), defaultProvider: { baseUrl: 'not a URL', model: 'test-model' } },
      { ...validConfig(), defaultProvider: { baseUrl: 'https://api.deepseek.com' } },
      { ...validConfig(), defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 7 } },
    ]) {
      const { elements, calls } = await loadPage(page, config);
      assert.match(elements.get(page.connection).textContent, /未连接|未就绪/);
      assert.equal(elements.get(page.analyze).disabled, true);
      for (const id of page.inputs) assert.equal(elements.get(id).disabled, true, `${id} must stay disabled.`);
      assert.deepEqual(calls.map(call => call.url), ['/api/config']);
    }
  });
}
