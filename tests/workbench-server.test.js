import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { createExamplePlan } from '../src/ai/plan.mjs';
import { generateProject } from '../src/generator/smapi.mjs';
import { createActionExample } from '../src/actions/spec.mjs';

async function fixture(options,run) {
  const server=createWorkbenchServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,data={},extra={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  try{await run({base,post});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
async function finishJob(base,id) {
  for(let index=0;index<100;index++) {
    const response=await fetch(`${base}/api/jobs/${id}`);assert.equal(response.status,200);
    const job=await response.json();
    if(['generated','passed','failed','blocked','cancelled'].includes(job.status))return job;
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  throw new Error('Test job did not settle.');
}
test('example produces a genuine source ZIP with explicit non-AI and unbuilt provenance',async()=>{
  await fixture({},async({base,post})=>{
    const response=await post('/api/example');assert.equal(response.status,200);
    const plan=await response.json();assert.equal(plan.report.provenance,'example');assert.equal(plan.report.game,'not_run');
    const generated=await post('/api/projects',{planId:plan.id});assert.equal(generated.status,200,await generated.clone().text());
    const project=await generated.json();assert.ok(project.files.some(f=>f.path==='manifest.json'));assert.equal(project.report.build,'not_run');assert.equal(project.report.provenance,'example');
    const download=await fetch(base+project.downloadUrl);assert.equal(download.status,200);assert.match(download.headers.get('content-type'),/application\/zip/);
    const bytes=new Uint8Array(await download.arrayBuffer());assert.deepEqual([...bytes.slice(0,4)],[80,75,3,4]);
  });
});
test('configured provider calls are explicit and keys do not enter responses, plans or projects',async()=>{
  const secret='example-api-secret-123';let calls=0;
  await fixture({apiKey:secret,planGenerator:async(request,options)=>{calls++;assert.equal(options.apiKey,secret);assert.equal(request.hostGame,'stardew-valley');return createExamplePlan();}},async({base,post})=>{
    const config=await(await fetch(base+'/api/config')).text();assert.ok(!config.includes(secret));assert.equal(calls,0);
    const response=await post('/api/plan',{request:{hostGame:'星露谷',sourceGame:'泰拉瑞亚',description:'希望带入动作交互'}});
    const text=await response.text();assert.equal(response.status,200);assert.ok(!text.includes(secret));assert.equal(calls,1);
    assert.equal(JSON.parse(text).report.provenance,'model');
  });
});
test('cross-origin, non-JSON and oversized requests cannot trigger a model call',async()=>{
  let calls=0;
  await fixture({planGenerator:async()=>{calls++;return createExamplePlan();}},async({post})=>{
    assert.equal((await post('/api/example',{}, {Origin:'https://example.com'})).status,403);
    assert.equal((await post('/api/example',{}, {'Content-Type':'text/plain'})).status,415);
    assert.equal((await post('/api/plan',{text:'x'.repeat(100000)})).status,413);
    assert.equal(calls,0);
  });
});
test('missing credentials and unknown jobs fail clearly; provider failures redact transient keys',async()=>{
  await fixture({apiKey:'',planGenerator:async()=>{throw new Error('provider echoed transient-secret');}},async({post})=>{
    const request={hostGame:'星露谷',sourceGame:'泰拉瑞亚',description:'动作交互'};
    assert.equal((await post('/api/plan',{request})).status,400);
    const failed=await post('/api/plan',{request,provider:{apiKey:'transient-secret'}});
    assert.ok(!(await failed.text()).includes('transient-secret'));
    assert.equal((await post('/api/projects',{planId:'unknown'})).status,404);
  });
});

test('successful generator responses cannot expose either environment or transient credentials',async()=>{
  const environmentKey='environment-secret-123';
  const transientKey='transient-secret-456';
  for(const echoedKey of [environmentKey,transientKey]){
    await fixture({apiKey:environmentKey,planGenerator:async()=>{
      const plan=createExamplePlan();plan.summary=`Upstream echoed ${echoedKey}`;return plan;
    }},async({post})=>{
      const failed=await post('/api/plan',{request:{hostGame:'星露谷',sourceGame:'泰拉瑞亚',description:'动作交互'},provider:{apiKey:transientKey}});
      assert.equal(failed.status,502);
      const response=await failed.text();
      assert.ok(!response.includes(environmentKey));assert.ok(!response.includes(transientKey));
      const error=JSON.parse(response);assert.equal(error.error.code,'CREDENTIAL_IN_RESPONSE');
      assert.ok(!Object.hasOwn(error,'id'));assert.ok(!Object.hasOwn(error,'plan'));
    });
  }
});

test('malformed generated file lists fail clearly and static validation precedes ZIP construction',async()=>{
  for(const generated of [null,{files:null},{files:{}},{files:[]},{files:[null]},{files:[{path:'file.txt',content:null}]}]){
    await fixture({projectGenerator:async()=>generated},async({post})=>{
      const plan=await(await post('/api/example')).json();
      const failed=await post('/api/projects',{planId:plan.id});
      assert.equal(failed.status,500);
      const response=await failed.json();assert.equal(response.error.code,'INVALID_GENERATOR');
      assert.ok(!Object.hasOwn(response,'downloadUrl'));
    });
  }
  for(const report of [{staticValidation:{passed:false}},{}]){
    await fixture({projectGenerator:async()=>({files:[{path:'../../invalid.txt',content:'must not reach ZIP construction'}],report})},async({post})=>{
      const plan=await(await post('/api/example')).json();
      const failed=await post('/api/projects',{planId:plan.id});
      assert.equal(failed.status,422);
      const response=await failed.json();assert.equal(response.error.code,'GENERATOR_VALIDATION_FAILED');
      assert.ok(!Object.hasOwn(response,'downloadUrl'));
    });
  }
});

test('HTTP source-only jobs use a provider once and download the accepted source with honest build state',async()=>{
  const secret='test-key-for-http-source';let calls=0;
  const plan=createExamplePlan();
  const source=generateProject(plan).files.find(file=>file.path==='ModEntry.cs');
  await fixture({apiKey:secret,inspectEnvironment:async()=>({ready:false,dotnet:{available:true},game:{available:false},issues:[]}),pipelineDependencies:{generate:async()=>{calls++;return {files:[{...source,content:source.content+'\n// accepted test response\n'}],summary:'Simulated provider for the HTTP contract test.'};}}},async({base,post})=>{
    const environment=await(await fetch(base+'/api/environment')).json();assert.equal(environment.ready,false);
    const entry=await(await post('/api/example')).json();
    const response=await post('/api/jobs',{planId:entry.id,mode:'source',maxRepairs:0});assert.equal(response.status,202);
    const initial=await response.json();assert.ok(!JSON.stringify(initial).includes(secret));
    const job=await finishJob(base,initial.id);
    assert.equal(job.status,'generated');assert.equal(calls,1);assert.equal(job.report.build,'not_run');assert.equal(job.report.game,'not_run');
    assert.equal(job.project.report.codeProvenance,'model');assert.equal(job.project.report.readyToInstall,false);
    assert.ok(job.project.files.some(file=>file.path==='ModEntry.cs'&&file.content.includes('accepted test response')));
    assert.ok(!JSON.stringify(job).includes(secret));
    const download=await fetch(base+job.project.downloadUrl);assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/mod-source.zip/);
    const bytes=Buffer.from(await download.arrayBuffer());assert.ok(!bytes.includes(Buffer.from(secret)));
    const invalid=await post('/api/jobs',{planId:entry.id,mode:'execute-game'});assert.equal(invalid.status,400);
  });
});

test('HTTP build jobs stop on missing game environment without charging a code-generation call',async()=>{
  let calls=0;
  await fixture({apiKey:'test-key-for-blocked-build',inspectEnvironment:async()=>({ready:false,dotnet:{available:true,version:'10.0.403'},game:{available:false},issues:[{code:'GAME_PATH_REQUIRED',message:'Prepare game references.'}]}),pipelineDependencies:{generate:async()=>{calls++;throw new Error('Must not call model.');}}},async({base,post})=>{
    const plan=await(await post('/api/example')).json();
    const start=await post('/api/jobs',{planId:plan.id,mode:'build',maxRepairs:2});assert.equal(start.status,202);
    const job=await finishJob(base,(await start.json()).id);
    assert.equal(job.status,'blocked');assert.equal(job.modelCalls,0);assert.equal(calls,0);assert.equal(job.report.build,'not_run');assert.ok(!job.project);
    assert.equal((await fetch(base+'/api/jobs/00000000-0000-0000-0000-000000000000')).status,404);
    assert.equal((await post('/api/jobs',{planId:plan.id},{Origin:'https://untrusted.example'})).status,403);
  });
});

test('request text containing either configured credential is rejected before a provider call',async()=>{
  const environmentKey='test-environment-credential',transientKey='test-transient-credential';let calls=0;
  await fixture({apiKey:environmentKey,planGenerator:async()=>{calls++;return createExamplePlan();}},async({post})=>{
    for(const secret of [environmentKey,transientKey]) {
      const response=await post('/api/plan',{request:{hostGame:'星露谷',sourceGame:'泰拉瑞亚',description:'Do not send this accidental key: '+secret},provider:{apiKey:transientKey}});
      assert.equal(response.status,502);
      const body=await response.text();assert.ok(!body.includes(environmentKey));assert.ok(!body.includes(transientKey));
    }
    assert.equal(calls,0);
  });
});

test('all paid endpoints reject a new origin without its own credential before invoking a provider', async () => {
  const secret = 'default-origin-http-test-key'; let calls = 0;
  await fixture({ apiKey: secret,
    planGenerator: async () => { calls++; return createExamplePlan(); },
    actionPlanGenerator: async () => { calls++; return createActionExample().blueprint; },
    pipelineDependencies: { generate: async () => { calls++; throw new Error('must not generate'); } },
  }, async ({ post }) => {
    const plan = await (await post('/api/example')).json();
    for (const [route, payload] of [
      ['/api/plan', { request: { hostGame: '星露谷', sourceGame: '泰拉瑞亚', description: '动作交互' } }],
      ['/api/action-plans', { request: createActionExample().request }],
      ['/api/jobs', { planId: plan.id, mode: 'source', maxRepairs: 0 }],
    ]) {
      for (const origin of ['https://other-provider.example', 'https://api.deepseek.com:444']) {
        const response = await post(route, { ...payload, provider: { baseUrl: origin, apiKey: '' } });
        assert.equal(response.status, 400);
        const text = await response.text();
        assert.ok(!text.includes(secret));
        assert.equal(JSON.parse(text).error.code, 'PROVIDER_KEY_REQUIRED_FOR_ORIGIN');
      }
    }
    assert.equal(calls, 0);
  });
});

test('same-origin defaults and explicit replacement keys are selected consistently by all paid endpoints', async () => {
  const defaultKey = 'original-origin-http-test-key', replacementKey = 'replacement-origin-http-test-key';
  const seen = [];
  const note = options => seen.push({ key: options.apiKey, origin: options.baseUrl });
  const source = generateProject(createExamplePlan()).files.find(file => file.path === 'ModEntry.cs');
  await fixture({ apiKey: defaultKey,
    planGenerator: async (_request, options) => { note(options); return createExamplePlan(); },
    actionPlanGenerator: async (_request, options) => { note(options); return createActionExample().blueprint; },
    pipelineDependencies: { generate: async (_input, options) => { note(options); return { files: [source], summary: 'Injected source for credential routing regression.' }; } },
  }, async ({ base, post }) => {
    const plan = await (await post('/api/example')).json();
    for (const provider of [
      { baseUrl: 'https://API.DEEPSEEK.com:443/', apiKey: '' },
      { baseUrl: 'https://other-provider.example', apiKey: replacementKey },
    ]) {
      const legacy = await post('/api/plan', { request: { hostGame: '星露谷', sourceGame: '泰拉瑞亚', description: '动作交互' }, provider });
      assert.equal(legacy.status, 200, await legacy.clone().text()); await legacy.json();
      const action = await post('/api/action-plans', { request: createActionExample().request, provider });
      assert.equal(action.status, 200, await action.clone().text()); await action.json();
      const response = await post('/api/jobs', { planId: plan.id, mode: 'source', maxRepairs: 0, provider });
      assert.equal(response.status, 202);
      const job = await finishJob(base, (await response.json()).id);
      assert.equal(job.status, 'generated');
      const text = JSON.stringify(job);
      assert.ok(!text.includes(defaultKey)); assert.ok(!text.includes(replacementKey));
    }
    assert.deepEqual(seen, [
      ...Array.from({ length: 3 }, () => ({ key: defaultKey, origin: 'https://api.deepseek.com' })),
      ...Array.from({ length: 3 }, () => ({ key: replacementKey, origin: 'https://other-provider.example' })),
    ]);
  });
});

test('disconnected legacy analysis discards late provider results and releases its running slot', async () => {
  let calls = 0, release, markStarted, providerSignal, lateReads = 0;
  const started = new Promise(resolve => { markStarted = resolve; });
  const latePlan = new Proxy(createExamplePlan(), { ownKeys(target) { lateReads++; return Reflect.ownKeys(target); } });
  await fixture({ apiKey: 'legacy-cancel-regression-key', planGenerator: async (_request, options) => {
    calls++;
    if (calls > 1) return createExamplePlan();
    providerSignal = options.signal;
    markStarted();
    await new Promise(resolve => { release = resolve; });
    return latePlan;
  } }, async ({ base, post }) => {
    const request = { hostGame: '星露谷', sourceGame: '泰拉瑞亚', description: '动作交互' };
    const controller = new AbortController();
    const pending = fetch(base + '/api/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request }), signal: controller.signal });
    const rejected = assert.rejects(pending, { name: 'AbortError' });
    await started;
    const observedAbort = once(providerSignal, 'abort');
    controller.abort(); await observedAbort;
    release(); await rejected;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateReads, 0, 'cancelled legacy output must never reach serialization or storage');
    const response = await post('/api/plan', { request });
    assert.equal(response.status, 200, await response.clone().text()); await response.json();
    assert.equal(calls, 2);
  });
});
