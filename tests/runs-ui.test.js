// Browser controller checks only. No model request, registered worker or game is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const FIRST = '12345678-1234-1234-1234-123456789abc';
const SECOND = '23456789-2345-2345-2345-23456789abcd';
const PROJECT_WORKFLOW = 'gamebridge.conversion-project.v1', ANALYSIS_WORKFLOW = 'gamebridge.multi-agent-analysis.v1';
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
function configuration(enabled = true, unified = false) {
  return { local: true, providerConfigured: true, defaultProvider: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, capabilities: { multiAgentAnalysis: enabled, unifiedConversionWorkflow: unified, behaviorSpecification: unified, adapterProjectDrafts: unified } };
}
function run({ id = FIRST, status = 'blocked', maxModelCalls = 5, tasks, report, workflow = ANALYSIS_WORKFLOW, graph, projectDownloadUrl, description = '保留角色、资源与交互完整要求。' } = {}) {
  return { schemaVersion: 1, id, status, budget: { maxModelCalls, modelCallsReserved: 5 },
    context: { workflow, request: { hostGame: 'host-world', sourceGame: 'source-content', description } },
    graph: graph || [{ id: 'requirements', role: 'requirements', kind: 'analysis', dependsOn: [] }],
    tasks: tasks || [{ id: 'requirements', status: 'succeeded', attemptCount: 1, attempts: [], result: { data: { summary: 'control-flow fixture only' }, artifact: { scope: 'analysis-only' } } }],
    ...(projectDownloadUrl ? { projectDownloadUrl } : {}), report: report || { realModBuild: 'not_run', game: 'not_run', readyToInstall: false } };
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
  Object.assign(nodes.get('model-budget'), { value: '6' });
  Object.assign(nodes.get('workflow-mode'), { value: PROJECT_WORKFLOW });
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
  assert.equal(starts[0].body.workflow, ANALYSIS_WORKFLOW);
  assert.deepEqual(starts[0].body.request, { hostGame: 'host-world', sourceGame: 'source-content', description: '保留角色、资源与交互完整要求。', contentKinds: ['character', 'moveset'] });
  assert.equal(starts[0].body.provider.apiKey, '');
  assert.equal(nodes.get('download-run').href, `/api/runs/${FIRST}/download`);
});

test('the unified flow is selected with six calls only when its local capability is present', async () => {
  const snapshot = run({ workflow: PROJECT_WORKFLOW, maxModelCalls: 6 });
  const { nodes, calls } = await load({ config: configuration(true, true), snapshot });
  assert.equal(nodes.get('workflow-mode').value, PROJECT_WORKFLOW); assert.equal(nodes.get('model-budget').value, '6');
  assert.match(nodes.get('workflow-budget-hint').textContent, /6 次/);
  assert.ok(calls.every(call => call.method === 'GET'));
  await nodes.get('start-run').dispatch('click');
  const sent = calls.find(call => call.method === 'POST' && call.url === '/api/runs').body;
  assert.equal(sent.workflow, PROJECT_WORKFLOW); assert.deepEqual(sent.budget, { maxModelCalls: 6 });
  assert.equal(sent.request.description, '保留角色、资源与交互完整要求。');
});

test('selection keeps the five-call flow available and cannot request an unadvertised unified flow', async () => {
  const ui = await load({ config: configuration(true, true) });
  ui.nodes.get('workflow-mode').value = ANALYSIS_WORKFLOW; await ui.nodes.get('workflow-mode').dispatch('change');
  assert.equal(ui.nodes.get('model-budget').value, '5');
  await ui.nodes.get('start-run').dispatch('click');
  assert.equal(ui.calls.find(call => call.method === 'POST').body.workflow, ANALYSIS_WORKFLOW);
  const older = await load();
  older.nodes.get('workflow-mode').value = PROJECT_WORKFLOW; await older.nodes.get('workflow-mode').dispatch('change');
  assert.equal(older.nodes.get('start-run').disabled, true); await older.nodes.get('start-run').dispatch('click');
  assert.ok(older.calls.every(call => call.method === 'GET')); assert.match(older.nodes.get('run-error').textContent, /尚未提供统一转换流程/);
});

test('loading an older run retains its workflow and existing total budget for explicit resume', async () => {
  const previous = run({ status: 'interrupted', maxModelCalls: 9 });
  const { nodes, calls } = await load({ config: configuration(true, true), history: [previous], snapshot: previous });
  await nodes.get('run-history').children[0].dispatch('click'); await flush();
  assert.equal(nodes.get('workflow-mode').value, ANALYSIS_WORKFLOW); assert.equal(nodes.get('model-budget').value, '9');
  await nodes.get('resume-run').dispatch('click');
  const resumed = calls.find(call => call.url.endsWith('/resume')).body;
  assert.deepEqual(resumed.budget, { maxModelCalls: 9 }); assert.equal(resumed.allowReplay, false); assert.equal(Object.hasOwn(resumed, 'workflow'), false);
});

function textContent(value) { return [value.textContent || '', ...value.children.map(textContent)].join(' '); }
function draftRun(projectDownloadUrl = `/api/runs/${FIRST}/project`) {
  const proposal = { summary: '受限状态机提案', spec: { states: ['idle', 'active'], events: [{ id: 'begin' }], transitions: [{ id: 'begin-action' }], requirementIds: ['req-1', 'req-2'], unresolved: [{ requirementId: 'req-2', reason: '角色模型与动画不在整数状态机范围内。' }] }, assumptions: ['时序值需要来源证据。'], limitations: ['尚未绑定宿主输入或实体接口。'] };
  const metadata = { scope: 'adapter-project-draft', filePaths: ['Behavior.g.cs', 'HostBridge.g.cs', 'binding-requirements.json'], requirementIds: ['req-1', 'req-2'], unresolvedRequirementIds: ['req-2'], blockers: [{ code: 'HOST_BINDING_REQUIRED', requirementIds: ['req-1', 'req-2'], message: '宿主事件与实体效果尚未实现。' }] };
  const task = (id, data, kind) => ({ definition: { id, kind, role: 'conversion-implementation', dependsOn: [] }, state: { id, status: 'succeeded', attemptCount: 1, attempts: [], result: { data, artifact: { scope: 'tool-execution' } } } });
  const entries = [task('specify-behavior', { proposal }, 'planning'), task('validate-behavior', { proposal, requirementIds: proposal.spec.requirementIds, unresolvedRequirementIds: ['req-2'] }, 'validation'), task('generate-adapter-project', { metadata, project: { scope: 'local-tool-artifact', id: SECOND, manifestSha256: 'a'.repeat(64) } }, 'generation')];
  return run({ workflow: PROJECT_WORKFLOW, maxModelCalls: 6, projectDownloadUrl, description: '完整原始需求：' + '保留角色、武器和全部动作交互。'.repeat(300), graph: entries.map(item => item.definition), tasks: entries.map(item => item.state) });
}

test('unified output shows spec gaps and project files while preserving the full brief and raw data', async () => {
  const snapshot = draftRun();
  const { nodes, html } = await load({ config: configuration(true, true), snapshot }); await nodes.get('start-run').dispatch('click');
  const rendered = textContent(nodes.get('run-tasks'));
  for (const text of ['AI 行为规格提案', '行为规格结构校验', '生成适配工程草稿', '角色模型与动画不在整数状态机范围内', 'HostBridge.g.cs', '宿主事件与实体效果尚未实现', '不能直接安装进游戏']) assert.ok(rendered.includes(text), text);
  assert.equal(nodes.get('run-brief').children[0].children[2].textContent, snapshot.context.request.description);
  assert.equal(nodes.get('download-project').hidden, false); assert.equal(nodes.get('download-project').href, `/api/runs/${FIRST}/project`);
  assert.equal(nodes.get('run-status').textContent, '工程草稿已生成 · 等待宿主适配');
  assert.match(nodes.get('run-summary').textContent, /适配工程草稿已保存/); assert.match(nodes.get('run-summary').textContent, /真实 Mod 构建和游戏仍未运行/);
  const last = nodes.get('run-tasks').children.at(-1).children.at(-1);
  assert.equal(last.children[1].textContent, JSON.stringify({ artifact: snapshot.tasks.at(-1).result.artifact, data: snapshot.tasks.at(-1).result.data }, null, 2));
  assert.doesNotMatch(html, /id="(?:install|download-mod|compile-mod)"/);
});

test('draft status wording preserves failures and gives active recovery priority', async () => {
  const failed = draftRun(); failed.status = 'failed';
  const failure = await load({ config: configuration(true, true), snapshot: failed }); await failure.nodes.get('start-run').dispatch('click');
  assert.equal(failure.nodes.get('run-status').textContent, '失败');
  const recovering = draftRun(); recovering.observation = { active: true };
  const active = await load({ config: configuration(true, true), snapshot: recovering }); await active.nodes.get('start-run').dispatch('click');
  assert.equal(active.nodes.get('run-status').textContent, '正在调度恢复');
});

test('project links require a succeeded private draft and the exact current-run local endpoint', async () => {
  for (const url of ['https://untrusted.example/project.zip', `/api/runs/${SECOND}/project`, `/api/runs/${FIRST}/project?key=forged`]) {
    const { nodes } = await load({ config: configuration(true, true), snapshot: draftRun(url) }); await nodes.get('start-run').dispatch('click');
    assert.equal(nodes.get('download-project').hidden, true); assert.equal(nodes.get('download-project').href, undefined);
  }
  const incomplete = draftRun(); incomplete.tasks.at(-1).status = 'failed';
  const { nodes } = await load({ config: configuration(true, true), snapshot: incomplete }); await nodes.get('start-run').dispatch('click');
  assert.equal(nodes.get('download-project').hidden, true);
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
