// HTTP/control-flow checks only. The analyzer is injected; no real model,
// executable adapter, Mod build or game execution is exercised by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchServer } from '../src/workbench-server.mjs';

const KEY = 'default-server-test-credential';
const REQUEST = { hostGame: 'Requested Host', sourceGame: 'Requested Source', description: '把来源的动作交互带入宿主真实世界，保留完整请求。', contentKinds: ['moveset'] };
function proposal(request) {
  return { schemaVersion: 1, title: '通用转换分析', hostGame: request.hostGame, sourceGame: request.sourceGame, summary: '保留原始需求并列出接口缺口。',
    requirements: [{ id: 'interactions', kind: 'moveset', description: request.description, disposition: 'needs_research', reason: '需要核验正式接口与映射。' }],
    assetNeeds: [], interfaceNeeds: [{ id: 'events', description: '需要核验宿主输入与动作接口。', requirementIds: ['interactions'] }], questions: ['需要精确版本。'], limitations: ['尚无已验收适配器。'] };
}
async function withServer(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-converter-http-'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>converter-test-only</title>');
  const server = createWorkbenchServer({ root, apiKey: KEY, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run({ server, base }); }
  finally {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true });
  }
}
function post(base, value, options = {}) { return fetch(base + '/api/conversions', { method: 'POST', headers: { 'Content-Type': 'application/json', ...options.headers }, body: JSON.stringify(value), signal: options.signal }); }
async function waitFor(predicate) {
  for (let i = 0; i < 50; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected bounded asynchronous state transition.');
}

test('conversion HTTP analysis preserves direction and downloads only a blocked analysis JSON', async () => {
  let calls = 0;
  await withServer({ analyzer: async (request, provider) => { calls++; assert.equal(provider.apiKey, KEY); return proposal(request); } }, async ({ base }) => {
    const configText = await (await fetch(base + '/api/config')).text(), config = JSON.parse(configText);
    assert.ok(!configText.includes(KEY)); assert.equal(config.capabilities.conversionPlanning, true);
    for (const name of ['projectGeneration', 'compilation', 'gameExecution']) assert.equal(config.capabilities[name], false);
    assert.deepEqual(config.adapters, []); assert.deepEqual(await (await fetch(base + '/api/adapters')).json(), []);
    const response = await post(base, { request: REQUEST }); assert.equal(response.status, 200);
    const record = await response.json();
    assert.equal(calls, 1); assert.equal(record.request.hostGame, REQUEST.hostGame); assert.equal(record.plan.sourceGame, REQUEST.sourceGame);
    assert.equal(record.plan.originalRequest.description, REQUEST.description); assert.equal(record.assessment.status, 'blocked');
    assert.equal(record.report.analysis, 'schema_validated'); assert.equal(record.report.modelCalls, 1);
    assert.equal(record.report.readyToGenerate, false); assert.equal(record.report.realModBuild, 'not_run'); assert.equal(record.report.game, 'not_run'); assert.equal(record.report.readyToInstall, false);
    const download = await fetch(base + record.downloadUrl);
    assert.equal(download.status, 200); assert.match(download.headers.get('content-type'), /application\/json/);
    assert.match(download.headers.get('content-disposition'), /gamebridge-conversion-plan\.json/);
    const downloaded = await download.json(); assert.deepEqual(downloaded, record);
    assert.ok(!JSON.stringify(downloaded).includes(KEY)); assert.equal(downloaded.plan.workflow.executable, false);
  });
});

test('Host, Origin, request shape and body limits stop invalid traffic before analysis', async () => {
  let calls = 0;
  await withServer({ analyzer: async request => { calls++; return proposal(request); } }, async ({ base, server }) => {
    const wrongHost = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/config', headers: { Host: 'attacker.example' } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', data => { body += data; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
      }); req.on('error', reject); req.end();
    });
    assert.equal(wrongHost.status, 403); assert.equal(wrongHost.body.error.code, 'INVALID_HOST');
    const origin = await post(base, { request: REQUEST }, { headers: { Origin: 'https://attacker.example' } }); assert.equal(origin.status, 403);
    const text = await fetch(base + '/api/conversions', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' }); assert.equal(text.status, 415);
    const extra = await post(base, { request: REQUEST, command: 'must not execute' }); assert.equal(extra.status, 400);
    const big = await post(base, { request: { ...REQUEST, description: 'x'.repeat(32769) } }); assert.equal(big.status, 413);
    const missing = await post(base, {}); assert.equal(missing.status, 400);
    assert.equal(calls, 0);
  });
});

test('default provider credentials stay origin-bound and an explicit new key is isolated', async () => {
  const seen = [];
  await withServer({ analyzer: async (request, provider) => { seen.push({ ...provider }); return proposal(request); } }, async ({ base }) => {
    const denied = await post(base, { request: REQUEST, provider: { baseUrl: 'https://other-model.example' } });
    assert.equal(denied.status, 400); assert.equal((await denied.json()).error.code, 'PROVIDER_KEY_REQUIRED_FOR_ORIGIN'); assert.equal(seen.length, 0);
    const explicit = await post(base, { request: REQUEST, provider: { apiKey: 'explicit-transient-credential', baseUrl: 'https://other-model.example', model: 'other-model' } });
    assert.equal(explicit.status, 200); assert.deepEqual(seen[0], { apiKey: 'explicit-transient-credential', baseUrl: 'https://other-model.example', model: 'other-model', signal: seen[0].signal });
    assert.ok(seen[0].signal instanceof AbortSignal); assert.ok(!(await explicit.text()).includes('explicit-transient-credential'));
    const normal = await post(base, { request: REQUEST }); assert.equal(normal.status, 200); assert.equal(seen[1].apiKey, KEY);
  });
});

test('credential-bearing requests and returned model text are discarded, not saved', async () => {
  let calls = 0;
  await withServer({ analyzer: async request => { calls++; const raw = proposal(request); raw.summary = `must discard ${KEY}`; return raw; } }, async ({ base }) => {
    const input = await post(base, { request: { ...REQUEST, description: KEY } });
    assert.equal(input.status, 502); assert.equal((await input.json()).error.code, 'CREDENTIAL_IN_REQUEST'); assert.equal(calls, 0);
    const model = await post(base, { request: REQUEST }); assert.equal(model.status, 502);
    const errorText = await model.text(); assert.equal(JSON.parse(errorText).error.code, 'CREDENTIAL_IN_RESPONSE'); assert.ok(!errorText.includes(KEY)); assert.equal(calls, 1);
  });
});

test('injected model success claims cannot bypass the local workflow or enable retired execution APIs', async () => {
  await withServer({ analyzer: async request => ({ ...proposal(request), game: 'passed', readyToInstall: true }) }, async ({ base }) => {
    const response = await post(base, { request: REQUEST }); assert.equal(response.status, 422);
    assert.equal((await response.json()).error.code, 'INVALID_CONVERSION_PLAN');
    for (const old of ['/api/jobs', '/api/plan', '/api/action-plans', '/api/projects', '/api/xonotic/jobs', '/api/environment']) {
      const denied = await fetch(base + old, { method: old === '/api/environment' ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, body: old === '/api/environment' ? undefined : '{}' });
      assert.equal(denied.status, 404, old); assert.equal((await denied.json()).error.code, 'UNKNOWN_API');
    }
  });
});

test('cancelled client discards late analysis and frees capacity even when analyzer ignores abort', async () => {
  let calls = 0, firstSignal, finishFirst;
  await withServer({ analyzer: (request, { signal }) => {
    calls++;
    if (calls === 1) { firstSignal = signal; return new Promise(resolve => { finishFirst = () => resolve(proposal(request)); }); }
    return new Promise(resolve => setTimeout(() => resolve(proposal(request)), 20));
  } }, async ({ base }) => {
    const controller = new AbortController();
    const pending = post(base, { request: REQUEST }, { signal: controller.signal }).catch(error => error);
    await waitFor(() => Boolean(firstSignal)); controller.abort(); await pending;
    await waitFor(() => firstSignal.aborted);
    const results = await Promise.all([post(base, { request: REQUEST }), post(base, { request: REQUEST })]);
    assert.deepEqual(results.map(result => result.status), [200, 200]); assert.equal(calls, 3);
    finishFirst(); await new Promise(resolve => setTimeout(resolve, 5));
    for (const response of results) assert.equal((await response.json()).report.game, 'not_run');
  });
});

test('closing the service aborts active analysis without retaining an executable job', async () => {
  let firstSignal;
  await withServer({ analyzer: (_request, { signal }) => { firstSignal = signal; return new Promise(() => {}); } }, async ({ server, base }) => {
    const pending = post(base, { request: REQUEST }); await waitFor(() => Boolean(firstSignal));
    const closed = new Promise(resolve => server.close(resolve));
    const response = await pending; assert.equal(response.status, 409); assert.equal((await response.json()).error.code, 'ANALYSIS_CANCELLED');
    assert.equal(firstSignal.aborted, true); await closed;
  });
});
