// Browser controller checks only. No model request, registered worker or game is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const FIRST = '12345678-1234-1234-1234-123456789abc';
const SECOND = '23456789-2345-2345-2345-23456789abcd';
function element() {
  const events = new Map(), attributes = new Map();
  return {
    value: '', textContent: '', disabled: true, hidden: false, children: [], checked: false,
    addEventListener(type, callback) { if (!events.has(type)) events.set(type, []); events.get(type).push(callback); },
    async dispatch(type) { for (const callback of events.get(type) || []) await callback({ target: this, preventDefault() {} }); },
    getAttribute(name) { return attributes.get(name) ?? null; }, setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) { attributes.delete(name); delete this[name]; },
    append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; },
    reportValidity() { return true; }, focus() {},
  };
}
function configuration(enabled = true) {
  return { local: true, providerConfigured: true, defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, capabilities: { multiAgentAnalysis: enabled } };
}
function run({ id = FIRST, status = 'blocked', maxModelCalls = 5, tasks, report } = {}) {
  return { schemaVersion: 1, id, status, budget: { maxModelCalls, modelCallsReserved: 5 },
    context: { request: { hostGame: 'host-world', sourceGame: 'source-content' } },
    graph: [{ id: 'requirements', role: 'requirements', kind: 'analysis', dependsOn: [] }],
    tasks: tasks || [{ id: 'requirements', status: 'succeeded', attemptCount: 1, attempts: [], result: { data: { summary: 'control-flow fixture only' }, artifact: { scope: 'analysis-only' } } }],
    report: report || { realModBuild: 'not_run', game: 'not_run', readyToInstall: false } };
}
const response = data => ({ ok: true, json: async () => data });
async function flush() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
async function load({ hostname = '127.0.0.1', config = configuration(), history = [], snapshot = run(), handler } = {}) {
  const [html, source] = await Promise.all([readFile(new URL('../site/index.html', import.meta.url), 'utf8'), readFile(new URL('../site/runs.js', import.meta.url), 'utf8')]);
  const nodes = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(([, id]) => [id, element()]));
  const kinds = ['character', 'moveset'].map(value => Object.assign(element(), { value, checked: true }));
  const calls = [], timers = new Map(); let timerSequence = 0;
  Object.assign(nodes.get('provider-base'), { value: 'https://api.deepseek.com' });
  Object.assign(nodes.get('provider-model'), { value: 'deepseek-flash' });
  Object.assign(nodes.get('model-budget'), { value: '5' });
  nodes.get('host-game').value = 'host-world'; nodes.get('source-game').value = 'source-content'; nodes.get('description').value = '保留角色、资源与交互完整要求。';
  const context = {
    document: { getElementById: name => nodes.get(name), createElement: element, querySelectorAll: () => kinds }, location: { hostname }, URL, AbortSignal, AbortController,
    setTimeout(callback) { const id = ++timerSequence; timers.set(id, callback); return id; }, clearTimeout(id) { timers.delete(id); },
    async fetch(url, options) {
      const call = { url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined }; calls.push(call);
      if (handler) { const answer = await handler(url, options, call); if (answer) return answer; }
      if (url === '/api/config') return response(config);
      if (url === '/api/runs' && call.method === 'GET') return response({ runs: history });
      if (url === '/api/runs' && call.method === 'POST') return response(snapshot);
      if (url === `/api/runs/${snapshot.id}`) return response(snapshot);
      if (url === `/api/runs/${snapshot.id}/resume`) return response(snapshot);
      if (url === `/api/runs/${snapshot.id}/cancel`) return response({ ...snapshot, status: 'cancelled' });
      throw new Error('Unexpected workflow API call.');
    },
  };
  vm.runInNewContext(source, context, { filename: 'runs.js', timeout: 1000 }); await flush();
  function tick() { const next = timers.entries().next().value; if (next) { timers.delete(next[0]); next[1](); } }
  return { nodes, kinds, calls, timers, tick, html, source };
}

test('public workflow UI makes no requests and cannot start paid work or collect keys', async () => {
  const { nodes, calls, source } = await load({ hostname: 'loganwon.github.io' });
  assert.deepEqual(calls, []); assert.equal(nodes.get('start-run').disabled, true); assert.equal(nodes.get('provider-key').disabled, true);
  await nodes.get('start-run').dispatch('click'); assert.deepEqual(calls, []);
  assert.doesNotMatch(source, /\b(?:localStorage|sessionStorage|innerHTML)\b/);
});

test('workflow controls require the explicit local multi-agent capability', async () => {
  const { nodes, calls } = await load({ config: configuration(false) });
  assert.equal(nodes.get('start-run').disabled, true); await nodes.get('start-run').dispatch('click');
  assert.deepEqual(calls.map(call => call.url), ['/api/config']);
});

test('start requires an explicit click and sends the full brief with total five-call budget', async () => {
  const { nodes, calls } = await load(); assert.equal(nodes.get('start-run').disabled, false);
  assert.ok(calls.every(call => call.method === 'GET'));
  await nodes.get('start-run').dispatch('click');
  const starts = calls.filter(call => call.url === '/api/runs' && call.method === 'POST'); assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].body.budget, { maxModelCalls: 5 });
  assert.deepEqual(starts[0].body.request, { hostGame: 'host-world', sourceGame: 'source-content', description: '保留角色、资源与交互完整要求。', contentKinds: ['character', 'moveset'] });
  assert.equal(starts[0].body.provider.apiKey, '');
  assert.equal(nodes.get('download-run').href, `/api/runs/${FIRST}/download`);
});

test('resume transmits explicit replay consent and total budget instead of resetting spent calls', async () => {
  const snapshot = run({ status: 'interrupted', tasks: [{ id: 'requirements', status: 'interrupted', attemptCount: 1, attempts: [], blockers: ['EXPLICIT_REPLAY_REQUIRED'] }] });
  const { nodes, calls } = await load({ snapshot }); await nodes.get('start-run').dispatch('click');
  assert.equal(nodes.get('replay-label').hidden, false); assert.equal(nodes.get('allow-replay').checked, false);
  await nodes.get('resume-run').dispatch('click');
  let resumes = calls.filter(call => call.url.endsWith('/resume')); assert.equal(resumes.length, 1); assert.equal(resumes[0].body.allowReplay, false);
  nodes.get('allow-replay').checked = true; nodes.get('model-budget').value = '7'; await nodes.get('resume-run').dispatch('click');
  resumes = calls.filter(call => call.url.endsWith('/resume')); assert.equal(resumes.length, 2);
  assert.equal(resumes[1].body.allowReplay, true); assert.deepEqual(resumes[1].body.budget, { maxModelCalls: 7 });
});

test('cancel issues one cancellation without replay and rejects a late running-task poll', async () => {
  let release; const late = new Promise(resolve => { release = resolve; }); let reads = 0;
  const snapshot = run({ status: 'running', tasks: [{ id: 'requirements', status: 'running', attemptCount: 1, attempts: [] }] });
  const ui = await load({ snapshot, handler: async (url, options, call) => url === `/api/runs/${FIRST}` && call.method === 'GET' && ++reads > 1 ? late : null });
  await ui.nodes.get('start-run').dispatch('click'); ui.tick(); await flush();
  await ui.nodes.get('cancel-run').dispatch('click'); assert.equal(ui.nodes.get('run-status').textContent, '已取消');
  release(response(run({ status: 'succeeded' }))); await flush();
  assert.equal(ui.nodes.get('run-status').textContent, '已取消');
  assert.equal(ui.calls.filter(call => call.url === '/api/runs' && call.method === 'POST').length, 1);
  assert.equal(ui.calls.filter(call => call.url.endsWith('/cancel')).length, 1); assert.ok(ui.calls.every(call => !call.url.endsWith('/resume')));
});

test('switching history selection prevents a late previous poll from replacing the selected run', async () => {
  let release; const late = new Promise(resolve => { release = resolve; });
  const first = run({ status: 'running' }), second = run({ id: SECOND, status: 'failed', maxModelCalls: 9 });
  const { nodes } = await load({ history: [first, second], handler: async url => url === `/api/runs/${FIRST}` ? late : url === `/api/runs/${SECOND}` ? response(second) : null });
  await nodes.get('run-history').children[0].dispatch('click'); await flush();
  await nodes.get('run-history').children[1].dispatch('click'); await flush();
  assert.equal(nodes.get('download-run').href, `/api/runs/${SECOND}/download`); assert.equal(nodes.get('run-status').textContent, '失败');
  release(response(first)); await flush();
  assert.equal(nodes.get('download-run').href, `/api/runs/${SECOND}/download`); assert.equal(nodes.get('run-status').textContent, '失败');
});

test('an explicitly selected history run survives a late create response', async () => {
  let release; const late = new Promise(resolve => { release = resolve; });
  const second = run({ id: SECOND, status: 'failed', maxModelCalls: 9 });
  const { nodes } = await load({ history: [second], handler: async (url, options, call) => {
    if (url === '/api/runs' && call.method === 'POST') return late;
    if (url === `/api/runs/${SECOND}`) return response(second);
    return null;
  } });
  const creation = nodes.get('start-run').dispatch('click'); await flush();
  await nodes.get('run-history').children[0].dispatch('click'); await flush();
  assert.equal(nodes.get('download-run').href, `/api/runs/${SECOND}/download`);
  release(response(run())); await creation; await flush();
  assert.equal(nodes.get('download-run').href, `/api/runs/${SECOND}/download`);
});

test('succeeded task metadata cannot promote actual build/game evidence or add install controls', async () => {
  const forged = run({ status: 'succeeded', report: { realModBuild: 'passed', game: 'passed', readyToInstall: true } });
  const { nodes, html } = await load({ snapshot: forged }); await nodes.get('start-run').dispatch('click');
  assert.match(nodes.get('run-summary').textContent, /真实 Mod 构建和游戏仍未运行/);
  assert.match(html, /Mod 构建<strong>未运行/); assert.match(html, /游戏实测<strong>未运行/);
  assert.doesNotMatch(html, /id="(?:install|download-mod|compile-mod)"/);
});

test('invalid budgets, an active brief analysis and wrong-origin default credentials cannot start work', async () => {
  for (const invalid of ['-1', '21', '1.5', 'NaN']) {
    const { nodes, calls } = await load(); nodes.get('model-budget').value = invalid; await nodes.get('start-run').dispatch('click');
    assert.ok(calls.every(call => call.method === 'GET'));
  }
  const { nodes, calls } = await load();
  nodes.get('conversion-form').setAttribute('aria-busy', 'true'); await nodes.get('start-run').dispatch('click'); assert.ok(calls.every(call => call.method === 'GET'));
  nodes.get('conversion-form').setAttribute('aria-busy', 'false'); nodes.get('provider-base').value = 'https://other-provider.example'; await nodes.get('start-run').dispatch('click'); assert.ok(calls.every(call => call.method === 'GET'));
});
