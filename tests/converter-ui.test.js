import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const id = '12345678-1234-1234-1234-123456789abc';
function element() {
  const events = new Map(), attributes = new Map();
  return {
    value: '', textContent: '', disabled: true, hidden: false, children: [], checked: false,
    addEventListener(type, handler) { if (!events.has(type)) events.set(type, []); events.get(type).push(handler); },
    async dispatch(type) { for (const handler of events.get(type) || []) await handler({ target: this, preventDefault() {} }); },
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); delete this[name]; },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, focus() {},
  };
}
function configuration() { return { local: true, providerConfigured: true, defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' } }; }
function record(extra = {}) {
  return { id, report: { modelCalls: 1, realModBuild: 'not_run', game: 'not_run' }, plan: {
    title: '跨游戏完整需求调查', summary: '保留角色、武器与动作要求，并调查宿主接口。', hostGame: 'host-world', sourceGame: 'source-content',
    requirements: [{ id: 'character', description: '来源角色与动作', disposition: 'needs_assets', reason: '资源来源与绑定尚未核验。' }, { id: 'interaction', description: '作用于宿主真实对象', disposition: 'needs_research', reason: '需调查正式接口。' }],
    assetNeeds: [{ id: 'model', description: '允许使用的角色与动作资源', requirementIds: ['character'] }],
    interfaceNeeds: [{ id: 'hit', description: '宿主输入与目标交互接口', requirementIds: ['interaction'] }], questions: ['请补充精确版本。'], limitations: ['无已验收的游戏适配器。'],
    workflow: { tasks: [{ id: 'analyze', kind: 'analysis', label: '需求合同', dependsOn: [], status: 'validated', blockers: [] }, { id: 'inspect', kind: 'host_inspection', label: '宿主调查', dependsOn: ['analyze'], status: 'blocked', blockers: ['游戏适配器缺失。'] }] },
  }, ...extra };
}
async function load({ hostname = '127.0.0.1', config = configuration(), result = record(), handler } = {}) {
  const [html, source] = await Promise.all([readFile(new URL('../site/index.html', import.meta.url), 'utf8'), readFile(new URL('../site/converter.js', import.meta.url), 'utf8')]);
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, name]) => [name, element()]));
  const kinds = ['character', 'weapon', 'moveset', 'rules', 'assets', 'other'].map(value => Object.assign(element(), { value }));
  const calls = [];
  const context = {
    document: { getElementById: name => nodes.get(name), createElement: element, querySelectorAll: () => kinds },
    location: { hostname }, URL, AbortSignal, AbortController,
    async fetch(url, options) {
      calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : null, signal: options?.signal });
      if (handler) { const response = await handler(url, options); if (response) return response; }
      if (url === '/api/config') return { ok: true, json: async () => config };
      if (url === '/api/conversions') return { ok: true, json: async () => result };
      throw new Error('Unexpected endpoint.');
    },
  };
  await vm.runInNewContext(source, context, { filename: 'converter.js', timeout: 1000 });
  for (const [name, value] of Object.entries({ 'host-game': 'host-world', 'source-game': 'source-content', description: '保留来源角色、武器与动作交互，在宿主的世界中作用于真实对象。' })) nodes.get(name).value = value;
  return { nodes, kinds, calls, html, source };
}

test('public converter page makes no requests and cannot collect provider credentials', async () => {
  const { nodes, kinds, calls, html, source } = await load({ hostname: 'loganwon.github.io' });
  assert.deepEqual(calls, []); assert.equal(nodes.get('analyze').disabled, true);
  for (const name of ['host-game', 'source-game', 'description', 'provider-base', 'provider-model', 'provider-key']) assert.equal(nodes.get(name).disabled, true);
  assert.ok(kinds.every(node => node.disabled));
  assert.match(html, /type="password" autocomplete="off"/);
  assert.doesNotMatch(html, /value="(?:Bannerlord|Xonotic|Minecraft)"|pipeline\.html|actions\.js|xonotic\.html/);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|innerHTML)\b/);
  await nodes.get('conversion-form').dispatch('submit'); assert.deepEqual(calls, []);
});

test('malformed local configuration leaves all cloud controls disabled', async () => {
  for (const config of [null, { local: false }, { local: true }, { ...configuration(), defaultProvider: { baseUrl: 'not-a-url', model: 'test' } }, { ...configuration(), defaultProvider: { baseUrl: 'https://api.deepseek.com/private', model: 'test' } }, { ...configuration(), defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 5 } }]) {
    const { nodes, calls } = await load({ config });
    assert.equal(nodes.get('analyze').disabled, true); assert.equal(nodes.get('provider-key').disabled, true);
    assert.match(nodes.get('connection').textContent, /未连接/);
    await nodes.get('conversion-form').dispatch('submit'); assert.deepEqual(calls.map(call => call.url), ['/api/config']);
  }
});

test('unified service notice distinguishes project drafts from actual Mod generation and game execution', async () => {
  const config = { ...configuration(), capabilities: { unifiedConversionWorkflow: true } };
  const { nodes } = await load({ config });
  assert.match(nodes.get('runtime-notice').textContent, /AI 分析、行为规格与本地适配工程草稿/);
  assert.match(nodes.get('runtime-notice').textContent, /正式 Mod 工程、构建和游戏实测仍保持阻断/);
  assert.match(nodes.get('runtime-notice').textContent, /不会自动启动游戏/);
});

test('converter submits host/source direction, full requirements, kinds and explicit versions unchanged', async () => {
  const { nodes, kinds, calls } = await load();
  kinds[0].checked = true; kinds[2].checked = true;
  nodes.get('host-version').value = '1.2.3'; nodes.get('source-version').value = '4.5.6';
  await nodes.get('conversion-form').dispatch('submit');
  const request = calls.find(call => call.url === '/api/conversions').body.request;
  assert.deepEqual(request, { hostGame: 'host-world', sourceGame: 'source-content', description: '保留来源角色、武器与动作交互，在宿主的世界中作用于真实对象。', contentKinds: ['character', 'moveset'], hostVersion: '1.2.3', sourceVersion: '4.5.6' });
  assert.equal(nodes.get('requirements').children.length, 2);
  assert.equal(nodes.get('tasks').children.length, 2);
  assert.equal(nodes.get('analysis-status').textContent, '结构已校验');
  assert.equal(nodes.get('download-plan').href, `/api/conversions/${id}/download`);
  assert.equal(nodes.get('download-plan').hidden, false);
  nodes.get('description').value += '新增需求'; await nodes.get('description').dispatch('input');
  assert.equal(nodes.get('download-plan').hidden, true, 'Editing a brief invalidates its previous export link.');
});

test('changing provider origin clears transient keys and blocks use of the default key at another origin', async () => {
  const { nodes, calls } = await load();
  const base = nodes.get('provider-base'), key = nodes.get('provider-key');
  key.value = 'test-transient-original-key'; base.value = 'https://API.DEEPSEEK.COM:443/'; await base.dispatch('input');
  assert.equal(key.value, 'test-transient-original-key');
  base.value = 'https://other-provider.example'; await base.dispatch('input');
  assert.equal(key.value, ''); assert.match(nodes.get('key-status').textContent, /对应/);
  await nodes.get('conversion-form').dispatch('submit'); assert.ok(calls.every(call => call.url === '/api/config'));
  key.value = 'test-transient-new-key'; base.value = 'https://api.deepseek.com'; await base.dispatch('input');
  assert.equal(key.value, ''); assert.match(nodes.get('key-status').textContent, /可留空/);
});

test('analysis cannot expose build/install controls or accept a model-provided download destination', async () => {
  const forged = record({ report: { realModBuild: 'passed', game: 'passed', readyToInstall: true }, downloadUrl: 'https://untrusted.example/package' });
  const { nodes, html } = await load({ result: forged });
  await nodes.get('conversion-form').dispatch('submit');
  assert.equal(nodes.get('download-plan').href, `/api/conversions/${id}/download`);
  assert.doesNotMatch(html, /id="(?:build|install|make-mod|download-mod)"/);
  assert.match(html, /Mod 构建<strong>未运行/); assert.match(html, /游戏实测<strong>未运行/);
});

test('cancel aborts the analysis and discards a later server success', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const { nodes, calls } = await load({ handler: async url => url === '/api/conversions' ? pending : null });
  const submission = nodes.get('conversion-form').dispatch('submit');
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const active = calls.find(call => call.url === '/api/conversions'); assert.ok(active);
  await nodes.get('cancel-analysis').dispatch('click');
  assert.equal(active.signal.aborted, true); assert.equal(nodes.get('provenance').textContent, '已取消');
  release({ ok: true, json: async () => record() }); await submission;
  assert.equal(nodes.get('provenance').textContent, '已取消'); assert.equal(nodes.get('download-plan').hidden, true);
  assert.equal(nodes.get('analyze').disabled, false);
});

test('provider error text cannot echo the current transient key into the page', async () => {
  const key = 'test-transient-secret';
  const { nodes } = await load({ handler: async url => url === '/api/conversions' ? { ok: false, json: async () => ({ error: { message: 'Failure: ' + key } }) } : null });
  nodes.get('provider-key').value = key;
  await nodes.get('conversion-form').dispatch('submit');
  assert.ok(!nodes.get('error').textContent.includes(key)); assert.match(nodes.get('error').textContent, /已隐藏密钥/);
});
