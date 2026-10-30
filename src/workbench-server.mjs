import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { generatePlan, resolveProviderConfig } from './ai/provider.mjs';
import { validateRequest, createExamplePlan } from './ai/plan.mjs';
import { generateProject } from './generator/smapi.mjs';
import { sourceZip } from './zip.mjs';
import { createPipeline } from './pipeline.mjs';
import { inspectBuildEnvironment } from './build/runner.mjs';
import { generateActionBlueprint } from './ai/action-provider.mjs';
import { createActionExample, validateActionBlueprint } from './actions/spec.mjs';
import { createActionScenarios, simulateActionBlueprint } from './actions/runtime.mjs';
import { getHostCatalog, assessActionHost } from './actions/hosts.mjs';

const ROOT=fileURLToPath(new URL('../',import.meta.url));
const TYPES={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.md':'text/markdown; charset=utf-8','.json':'application/json'};
export function createWorkbenchServer({root=path.join(ROOT,'dist'),apiKey=process.env.DEEPSEEK_API_KEY||'',baseUrl=process.env.GAMEBRIDGE_API_BASE||'https://api.deepseek.com',model=process.env.GAMEBRIDGE_MODEL||'deepseek-flash',planGenerator=generatePlan,actionPlanGenerator=generateActionBlueprint,projectGenerator=generateProject,inspectEnvironment=inspectBuildEnvironment,buildOptions={},pipelineDependencies={}}={}) {
  const plans=new Map(),projects=new Map(),actionPlans=new Map();
  let inFlight=0;
  const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
  function fail(status,code,message){const error=new Error(message);error.status=status;error.code=code;throw error;}
  function rejectCredentialEcho(value,secrets){
    const serialized=JSON.stringify(value);
    if(secrets.some(secret=>typeof secret==='string'&&secret&&serialized.includes(JSON.stringify(secret).slice(1,-1))))fail(502,'CREDENTIAL_IN_RESPONSE','模型结果包含凭据，已丢弃且未保存。');
  }
  async function body(req) {
    if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))fail(415,'JSON_REQUIRED','请使用 JSON 请求。');
    let length=0;const chunks=[];
    for await(const chunk of req){length+=chunk.length;if(length>98304)fail(413,'REQUEST_TOO_LARGE','请求不能超过 96 KiB。');chunks.push(chunk);}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail(400,'INVALID_JSON','请求不是有效 JSON。');}
  }
  function remember(map,value){if(map.size>=16)map.delete(map.keys().next().value);map.set(value.id,{...value,created:Date.now()});return value;}
  function get(map,id){const entry=map.get(id);if(!entry||Date.now()-entry.created>3600000){map.delete(id);fail(404,'NOT_FOUND','任务不存在或已过期，请重新生成。');}return entry;}
  async function publishProject({files,report,artifacts=[]}) {
    if(!Array.isArray(files)||files.length>32||files.some(file=>typeof file.path!=='string'||typeof file.content!=='string'))fail(500,'INVALID_PROJECT','工程文件无效。');
    if(!Array.isArray(artifacts)||artifacts.length>2||artifacts.some(file=>!['GameBridge.Generated.dll','GameBridge.Generated.pdb'].includes(file.path)||!Buffer.isBuffer(file.data)))fail(500,'INVALID_ARTIFACT','编译产物无效。');
    const id=randomUUID();
    const archive=sourceZip([...files.map(file=>({name:`GameBridgeMod/${file.path}`,data:Buffer.from(file.content)})),...artifacts.map(file=>({name:`GameBridgeMod/${file.path}`,data:file.data}))],{maxBytes:(artifacts.length?22:2)*1024*1024});
    while(projects.size&&[...projects.values()].reduce((sum,project)=>sum+project.archive.length,archive.length)>64*1024*1024)projects.delete(projects.keys().next().value);
    remember(projects,{id,archive,report});
    return {id,files,report,downloadUrl:`/api/projects/${id}/download`};
  }
  const pipeline=createPipeline({...pipelineDependencies,inspect:inspectEnvironment,buildOptions,publishProject});
  const server=http.createServer(async(req,res)=>{
    const requestSecrets=[apiKey].filter(Boolean);
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host=req.headers.host||'';
      const actualPort=server.address()?.port;
      if(![`127.0.0.1:${actualPort}`,`localhost:${actualPort}`].includes(host))fail(403,'INVALID_HOST','此服务仅接受本机工作台请求。');
      if(req.headers.origin && ![`http://127.0.0.1:${actualPort}`,`http://localhost:${actualPort}`].includes(req.headers.origin))fail(403,'INVALID_ORIGIN','请从本机工作台发起操作。');
      const url=new URL(req.url,`http://${host}`);
      if(url.pathname==='/api/config'&&req.method==='GET')return json(res,200,{local:true,providerConfigured:Boolean(apiKey),defaultProvider:{baseUrl,model},capabilities:{'stardew-valley':{adapter:'smapi-source-draft',mechanics:['speed_burst','melee_modifier'],build:'not_run',game:'not_run'},'gta-v':{adapter:null,status:'needs_adapter'}}});
      if(url.pathname==='/api/environment'&&req.method==='GET')return json(res,200,await inspectEnvironment(buildOptions));
      if(url.pathname==='/api/action-hosts'&&req.method==='GET')return json(res,200,getHostCatalog());
      if(url.pathname==='/api/action-example'&&req.method==='POST') {
        const input=await body(req);
        const {request,blueprint}=createActionExample(input.variant??'hit-confirm');
        const record=remember(actionPlans,{id:randomUUID(),request,blueprint,hostAssessment:assessActionHost(blueprint),report:{artifact:'action-design',provenance:'project-example',model:null,modelCalls:0,scope:'action-rules-design-only',completeRequirementCoverage:false,sourceFidelityVerified:false,realModBuild:'not_run',game:'not_run',readyToInstall:false}});
        return json(res,200,record);
      }
      if(url.pathname==='/api/action-plans'&&req.method==='POST') {
        const input=await body(req),request=validateRequest(input.request);
        if(inFlight>=2||pipeline.activeCount)fail(429,'BUSY','已有模型任务在运行，请稍后再试。');
        const provider=resolveProviderConfig(input.provider,{apiKey,baseUrl,model});
        requestSecrets.push(provider.apiKey);
        rejectCredentialEcho(request,requestSecrets);
        const abort=new AbortController();
        res.once('close',()=>{if(!res.writableEnded)abort.abort();});
        inFlight++;
        let blueprint;
        try {blueprint=await actionPlanGenerator(request,{...provider,signal:abort.signal});}
        finally {inFlight--;}
        if(abort.signal.aborted)fail(409,'PROVIDER_CANCELLED','动作分析已取消，晚到的结果已丢弃。');
        rejectCredentialEcho(blueprint,requestSecrets);
        // Revalidate even injected generators: model status cannot become host support.
        blueprint=validateActionBlueprint(blueprint,request);
        const record={id:randomUUID(),request,blueprint,hostAssessment:assessActionHost(blueprint),report:{artifact:'action-design',provenance:'model',model:provider.model,modelCalls:1,scope:'action-rules-design-only',completeRequirementCoverage:false,sourceFidelityVerified:false,realModBuild:'not_run',game:'not_run',readyToInstall:false}};
        rejectCredentialEcho(record,requestSecrets);
        if(abort.signal.aborted)fail(409,'PROVIDER_CANCELLED','动作分析已取消，未保存结果。');
        return json(res,200,remember(actionPlans,record));
      }
      const actionRoute=url.pathname.match(/^\/api\/action-plans\/([a-f0-9-]{36})\/(simulate|download)$/);
      if(actionRoute&&req.method==='POST'&&actionRoute[2]==='simulate') {
        const entry=get(actionPlans,actionRoute[1]),input=await body(req);
        rejectCredentialEcho(input,requestSecrets);
        const scenarios=Object.hasOwn(input,'scenario')?[input.scenario]:createActionScenarios(entry.blueprint);
        const simulations=scenarios.map(scenario=>({scenario,result:simulateActionBlueprint(entry.blueprint,scenario)}));
        return json(res,200,{scope:'action-rules-simulation-only',provenance:entry.report.provenance,simulations,realModBuild:'not_run',game:'not_run',readyToInstall:false});
      }
      if(actionRoute&&req.method==='GET'&&actionRoute[2]==='download') {
        const entry=get(actionPlans,actionRoute[1]);
        res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="gamebridge-action-design.json"','Cache-Control':'no-store'});
        return res.end(JSON.stringify(entry,null,2)+'\n');
      }
      if(url.pathname==='/api/jobs'&&req.method==='POST') {
        const input=await body(req),entry=get(plans,input.planId);
        if(inFlight)fail(429,'BUSY','模型分析正在运行，请稍后启动制作任务。');
        const provider=resolveProviderConfig(input.provider,{apiKey,baseUrl,model});
        requestSecrets.push(provider.apiKey);
        const job=pipeline.start({plan:entry.plan,provenance:entry.report.provenance,provider,maxRepairs:input.maxRepairs??1,mode:input.mode??'build',secrets:[apiKey]});
        return json(res,202,job);
      }
      const jobRoute=url.pathname.match(/^\/api\/jobs\/([a-f0-9-]{36})(\/cancel)?$/);
      if(jobRoute&&req.method==='GET'&&!jobRoute[2])return json(res,200,pipeline.get(jobRoute[1]));
      if(jobRoute&&req.method==='POST'&&jobRoute[2]){await body(req);return json(res,200,pipeline.cancel(jobRoute[1]));}
      if(url.pathname==='/api/example'&&req.method==='POST') {
        await body(req);
        const plan=createExamplePlan();
        const record=remember(plans,{id:randomUUID(),plan,report:{status:'plan_validated',build:'not_run',game:'not_run',provenance:'example',model:null}});
        return json(res,200,record);
      }
      if(url.pathname==='/api/plan'&&req.method==='POST') {
        const input=await body(req),request=validateRequest(input.request);
        if(inFlight>=2||pipeline.activeCount)fail(429,'BUSY','已有模型任务在运行，请稍后再试。');
        const provider=resolveProviderConfig(input.provider,{apiKey,baseUrl,model});
        requestSecrets.push(provider.apiKey);
        rejectCredentialEcho(request,requestSecrets);
        const abort=new AbortController();
        res.once('close',()=>{if(!res.writableEnded)abort.abort();});
        inFlight++;
        let plan;
        try {plan=await planGenerator(request,{...provider,signal:abort.signal});}
        finally {inFlight--;}
        if(abort.signal.aborted)fail(409,'PROVIDER_CANCELLED','需求分析已取消，晚到的结果已丢弃。');
        const result={id:randomUUID(),plan,report:{status:'plan_validated',build:'not_run',game:'not_run',provenance:'model',model:provider.model}};
        rejectCredentialEcho(result,requestSecrets);
        if(abort.signal.aborted)fail(409,'PROVIDER_CANCELLED','需求分析已取消，未保存结果。');
        const record=remember(plans,result);
        return json(res,200,record);
      }
      if(url.pathname==='/api/projects'&&req.method==='POST') {
        const input=await body(req),entry=get(plans,input.planId);
        const generated=await projectGenerator(entry.plan);
        if(!Array.isArray(generated?.files)||generated.files.length<1||generated.files.length>31||generated.files.some(file=>!file||typeof file.path!=='string'||typeof file.content!=='string'))fail(500,'INVALID_GENERATOR','工程生成器输出无效。');
        if(generated.report?.staticValidation?.passed!==true)fail(422,'GENERATOR_VALIDATION_FAILED','生成工程未通过静态检查，未提供下载。');
        const files=[...generated.files,{path:'generation.json',content:JSON.stringify({provenance:entry.report.provenance,model:entry.report.model,planId:entry.id,artifact:'source-draft',build:'not_run',game:'not_run'},null,2)+'\n'}];
        const report={...generated.report,status:'static_checked',build:'not_run',game:'not_run',provenance:entry.report.provenance,model:entry.report.model};
        return json(res,200,await publishProject({files,report}));
      }
      const download=url.pathname.match(/^\/api\/projects\/([a-f0-9-]{36})\/download$/);
      if(download&&req.method==='GET') {
        const project=get(projects,download[1]);
        res.writeHead(200,{'Content-Type':'application/zip','Content-Disposition':`attachment; filename="${project.report.artifact==='build-package'?'gamebridge-mod-build.zip':'gamebridge-mod-source.zip'}"`,'Content-Length':project.archive.length,'Cache-Control':'no-store'});
        return res.end(project.archive);
      }
      if(url.pathname.startsWith('/api/'))fail(404,'UNKNOWN_API','接口不存在。');
      if(!['GET','HEAD'].includes(req.method))fail(405,'METHOD_NOT_ALLOWED','此资源只支持读取。');
      const publicRoot=await realpath(root);
      const relative=decodeURIComponent(url.pathname);
      const target=await realpath(path.join(publicRoot,relative==='/'?'index.html':relative));
      if(!target.startsWith(publicRoot+path.sep))fail(403,'INVALID_PATH','文件路径不在网站目录内。');
      const data=await readFile(target);
      res.writeHead(200,{'Content-Type':TYPES[path.extname(target)]||'application/octet-stream','Cache-Control':'no-store'});
      res.end(req.method==='HEAD'?undefined:data);
    } catch(error) {
      if(res.writableEnded||res.destroyed)return;
      const providerStatuses={PROVIDER_AUTH:401,PROVIDER_RATE_LIMIT:429,PROVIDER_TIMEOUT:504,PROVIDER_NETWORK:502,PROVIDER_HTTP:502,INVALID_RESPONSE:502,EMPTY_RESPONSE:502,INCOMPLETE_RESPONSE:502,CREDENTIAL_IN_RESPONSE:502,INVALID_PLAN:422,INVALID_ACTION_BLUEPRINT:422};
      const status=error.status||providerStatuses[error.code]||(['ENOENT','JOB_NOT_FOUND'].includes(error.code)?404:error.code==='PIPELINE_BUSY'?429:400);
      // Provider errors are deliberately normalized before they reach this layer.
      let message=error.safeMessage||error.message||'操作失败。';
      for(const secret of requestSecrets)message=message.replaceAll(secret,'[redacted]');
      json(res,status,{error:{code:error.code||'REQUEST_FAILED',message}});
    }
  });
  server.once('close',()=>pipeline.close());
  return server;
}
