import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createWorkbenchServer } from '../src/workbench-server.mjs';
import { createExamplePlan } from '../src/ai/plan.mjs';

async function fixture(options,run) {
  const server=createWorkbenchServer(options);server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(route,data={},extra={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data)});
  try{await run({base,post});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
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
