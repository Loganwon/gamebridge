// Reproducible OS-sandbox acceptance. A contract simulation is not a real game.
import { mkdtemp, realpath, readFile, writeFile, copyFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createExamplePlan, validatePlan } from '../src/ai/plan.mjs';
import { generatePlan } from '../src/ai/provider.mjs';
import { generateModCode, repairModCode, validateModCode } from '../src/ai/code.mjs';
import { generateProject } from '../src/generator/smapi.mjs';
import { inspectBuildEnvironment, compileProject, parseCompilerDiagnostics } from '../src/build/runner.mjs';
import { createPipeline } from '../src/pipeline.mjs';
import { createMacSandbox } from './lib/macos-sandbox.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURE = path.join(ROOT, 'tests/fixtures/smapi-contract-harness');
const digest = source => createHash('sha256').update(source).digest('hex');
const ensure = (condition, message) => { if (!condition) throw new Error(message); };

export async function probeSandbox(sandbox, canaryPath) {
  const script = `import {readFile,writeFile,chmod,unlink,symlink} from 'node:fs/promises';import net from 'node:net';import{spawnSync}from'node:child_process';
const result={allowedWrite:false,outsideReadDenied:false,outsideWriteDenied:false,symlinkReadDenied:false,policyWriteDenied:false,policyChmodDenied:false,policyDeleteDenied:false,networkDenied:false,shellExecDenied:false,noProviderCredential:!process.env.DEEPSEEK_API_KEY};
await writeFile(${JSON.stringify(path.join(sandbox.root, 'allowed-write.txt'))},'ok');result.allowedWrite=true;
try{await readFile(${JSON.stringify(canaryPath)});}catch(error){result.outsideReadDenied=['EACCES','EPERM'].includes(error.code);}
try{await writeFile(${JSON.stringify(canaryPath)},'changed');}catch(error){result.outsideWriteDenied=['EACCES','EPERM'].includes(error.code);}
try{await writeFile(${JSON.stringify(sandbox.profilePath)},'(version 1)(allow default)');}catch(error){result.policyWriteDenied=['EACCES','EPERM'].includes(error.code);}
try{await chmod(${JSON.stringify(sandbox.profilePath)},0o600);}catch(error){result.policyChmodDenied=['EACCES','EPERM'].includes(error.code);}
try{await unlink(${JSON.stringify(sandbox.profilePath)});}catch(error){result.policyDeleteDenied=['EACCES','EPERM'].includes(error.code);}
await symlink(${JSON.stringify(canaryPath)},${JSON.stringify(path.join(sandbox.root, 'outside-link'))});
try{await readFile(${JSON.stringify(path.join(sandbox.root, 'outside-link'))});}catch(error){result.symlinkReadDenied=['EACCES','EPERM'].includes(error.code);}
await new Promise(resolve=>{const socket=net.createConnection({host:'127.0.0.1',port:1});socket.on('error',error=>{result.networkDenied=['EACCES','EPERM'].includes(error.code);resolve();});socket.on('connect',()=>{socket.destroy();resolve();});socket.setTimeout(1000,()=>{socket.destroy();resolve();});});
try{const child=spawnSync('/bin/sh',['-c','exit 0']);result.shellExecDenied=['EACCES','EPERM'].includes(child.error?.code);}catch(error){result.shellExecDenied=['EACCES','EPERM'].includes(error.code);}
console.log(JSON.stringify(result));`;
  const file = path.join(sandbox.root, 'boundary-probe.mjs'); await writeFile(file, script);
  const process = await sandbox.run(sandbox.node, [file], { timeoutMs: 5000, maxOutputBytes: 8192 });
  ensure(process.exitCode === 0 && !process.timedOut && !process.overflow, 'OS sandbox boundary probe could not run.');
  const result = JSON.parse(process.output);
  ensure(Object.values(result).every(value => value === true), 'OS sandbox boundary is incomplete; generated code will not be executed.');
  return result;
}

function contractFor(plan) {
  const [speed, melee] = plan.mechanics;
  ensure(speed?.type === 'speed_burst' && melee?.type === 'melee_modifier' && speed.durationTicks === melee.durationTicks && speed.cooldownTicks === melee.cooldownTicks, 'This explicit contract harness only accepts speed then melee, with matching durations/cooldowns.');
  return { SpeedKey: speed.key, MeleeKey: melee.key, SpeedAmount: speed.amount, MeleeMultiplier: melee.amount, DurationTicks: speed.durationTicks, CooldownTicks: speed.cooldownTicks };
}
async function readProvidedPlan(planPath) {
  const raw = JSON.parse(await readFile(planPath, 'utf8'));
  const original = raw.requirements.find(requirement => requirement.id === 'original-request');
  return validatePlan(raw, { hostGame: raw.hostGame, sourceGame: raw.sourceGame, description: original?.description });
}
async function compileContract(sandbox) {
  const args = ['build', 'ContractHarness.csproj', '--configuration', 'Release', '--nologo', '--disable-build-servers', '--no-incremental', '--verbosity', 'minimal', '--configfile', path.join(sandbox.root, 'NuGet.Config'),
    `-p:ModSource=${path.join(sandbox.root, 'ModEntry.cs')}`, '-p:NuGetAudit=false', '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:UseSharedCompilation=false', '-p:RunAnalyzers=false', '-nodeReuse:false'];
  const result = await sandbox.run(sandbox.dotnet, args, { timeoutMs: 60000 });
  return { ...result, diagnostics: parseCompilerDiagnostics(result.output) };
}
async function executeContract(sandbox) {
  const executable = path.join(sandbox.root, 'bin/Release/net10.0/GameBridge.ContractSimulation.dll');
  const result = await sandbox.run(sandbox.dotnet, [executable, path.join(sandbox.root, 'contract.json')], { timeoutMs: 10000 });
  ensure(!result.timedOut && !result.overflow && [0, 1].includes(result.exitCode), 'Sandboxed contract executable did not complete within its limits.');
  const report = JSON.parse(result.output);
  ensure(report.scope === 'contract-simulation-only' && report.realModBuild === 'not_run' && report.game === 'not_run' && report.readyToInstall === false, 'Contract fixture returned an invalid scope.');
  return report;
}

export async function verifySandbox({ live = false, repairLive = false, sourcePath, planPath, reportPath = path.join(ROOT, 'artifacts/sandbox-verification/report.json'), provider = {}, log = () => {} } = {}) {
  ensure(process.platform === 'darwin', 'OS_SANDBOX_UNAVAILABLE: macOS sandbox-exec is required; no simulation fallback.');
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  ensure(environment.dotnet.available && Number(environment.dotnet.version.split('.')[0]) >= 10, 'A real .NET SDK 10+ is required.');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gamebridge-sandbox-')));
  const outside = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gamebridge-canary-')));
  const canary = path.join(outside, 'canary.txt'); await writeFile(canary, 'untouched-canary');
  const report = { scope: 'os-sandbox-contract-verification', createdAt: new Date().toISOString(), timeZone: 'Asia/Shanghai', modelCalls: 0, sdkVersion: environment.dotnet.version, realModBuild: 'not_run', game: 'not_run', readyToInstall: false, completeRequirementCoverage: false };
  const key = provider.apiKey || '';
  let sandbox;
  try {
    sandbox = await createMacSandbox({ workDir: root, dotnetPath: environment.dotnet.path });
    report.isolation = sandbox.isolation;
    report.boundaryProbes = await probeSandbox(sandbox, canary);
    ensure((await readFile(canary, 'utf8')) === 'untouched-canary', 'Outside canary was modified.');
    log({ stage: 'sandbox-boundaries', passed: true });
    for (const file of ['Host.cs', 'Program.cs', 'ModConfig.cs', 'ContractHarness.csproj', 'NuGet.Config']) await copyFile(path.join(FIXTURE, file), path.join(root, file));
    let plan, source;
    if (live) {
      ensure(key, 'Live mode needs the local DeepSeek credential.');
      if (planPath) { plan = await readProvidedPlan(planPath); report.planProvenance = 'provided-previous-plan-not-reanalyzed'; }
      else {
        const request = { hostGame: 'Stardew Valley', sourceGame: 'Terraria', description: '这是独立沙盒契约验收：请规划 V 键短时加速（amount=2）与 B 键持近战武器短时强化（amount=1.5），两项都持续120ticks、冷却300ticks，mechanics顺序为加速再近战。完整泰拉瑞亚角色、武器和招式保持未实现，不宣称真实游戏兼容。' };
        report.modelCalls++; plan = await generatePlan(request, provider); report.planProvenance = 'live-deepseek';
      }
      report.sourceProvenance = 'live-deepseek';
      report.modelCalls++;
      const generated = await generateModCode({ plan, files: generateProject(plan).files }, provider);
      source = generated.files[0].content;
      await mkdir(path.dirname(reportPath), { recursive: true });
      await writeFile(reportPath.replace(/\.json$/, '') + '.ModEntry.cs', source);
      await writeFile(reportPath.replace(/\.json$/, '') + '.plan.json', JSON.stringify(plan, null, 2) + '\n');
    } else if (sourcePath) {
      ensure(planPath, 'Recorded source requires its explicit plan JSON.');
      source = await readFile(sourcePath, 'utf8');
      plan = await readProvidedPlan(planPath);
      report.sourceProvenance = 'provided-source';
      report.planProvenance = 'provided-plan-not-reanalyzed';
    } else {
      plan = createExamplePlan(); source = generateProject(plan).files.find(file => file.path === 'ModEntry.cs').content;
      report.sourceProvenance = 'fixed-example-no-ai';
    }
    validateModCode({ files: [{ path: 'ModEntry.cs', content: source }], summary: 'Explicit sandbox input.' }, { apiKey: key });
    report.sourceSha256 = digest(source);
    await writeFile(path.join(root, 'ModEntry.cs'), source);
    await writeFile(path.join(root, 'contract.json'), JSON.stringify(contractFor(plan)));
    const initial = await compileContract(sandbox);
    report.initialContractCompile = { passed: initial.exitCode === 0, diagnostics: initial.diagnostics };
    ensure(initial.exitCode === 0, 'Source did not compile against the explicit test-double contract.');
    report.behavior = await executeContract(sandbox);
    ensure(report.behavior.passed, 'Generated source failed a sandbox behavior contract.');
    log({ stage: 'contract-behavior', passed: true, cases: report.behavior.cases, assertions: report.behavior.assertions });

    // Negative control: valid C# with deliberately incorrect behavior must fail.
    const baseline = generateProject(createExamplePlan()).files.find(file => file.path === 'ModEntry.cs').content;
    const incorrect = baseline.replace('effects.Speed.Value = (int)mechanic.Amount;', 'effects.Speed.Value = (int)mechanic.Amount + 1;');
    ensure(incorrect !== baseline, 'Negative-control mutation could not be applied.');
    await writeFile(path.join(root, 'ModEntry.cs'), incorrect);
    await writeFile(path.join(root, 'contract.json'), JSON.stringify(contractFor(createExamplePlan())));
    ensure((await compileContract(sandbox)).exitCode === 0, 'Negative control did not compile.');
    const negative = await executeContract(sandbox);
    report.negativeControl = { expectedFailure: true, observedFailure: !negative.passed, failedCases: negative.results.filter(item => !item.Passed).map(item => item.Id) };
    ensure(report.negativeControl.observedFailure, 'Behavior harness accepted an intentionally incorrect speed bonus.');

    if (live || repairLive) {
      ensure(key, 'Live repair needs the local DeepSeek credential.');
      const broken = source.replace(/(\bprivate\s+ModConfig\s+Config\s*=\s*new(?:\s+ModConfig)?\s*\(\s*\))\s*;/, '$1');
      ensure(broken !== source, 'Controlled compiler fault location was unavailable.');
      await writeFile(path.join(root, 'ModEntry.cs'), broken);
      await writeFile(path.join(root, 'contract.json'), JSON.stringify(contractFor(plan)));
      const failed = await compileContract(sandbox);
      const diagnostics = failed.diagnostics.filter(item => /^CS\d{4}$/.test(item.code));
      ensure(failed.exitCode !== 0 && diagnostics.some(item => item.code === 'CS1002'), 'Expected real compiler CS1002 was not observed.');
      report.modelCalls++;
      const repaired = await repairModCode({ plan, files: generateProject(plan).files.map(file => file.path === 'ModEntry.cs' ? { ...file, content: broken } : file), diagnostics, attempt: 1 }, provider);
      await writeFile(reportPath.replace(/\.json$/, '') + '.repaired.cs', repaired.files[0].content);
      await writeFile(path.join(root, 'ModEntry.cs'), repaired.files[0].content);
      const rebuilt = await compileContract(sandbox);
      ensure(rebuilt.exitCode === 0, 'Model repair did not restore the test-contract compilation.');
      const behavior = await executeContract(sandbox);
      ensure(behavior.passed, 'Model repair compiled but failed the behavior contract.');
      report.repair = { scope: 'controlled-contract-compile-fault', compilerErrorsBefore: diagnostics.map(item => item.code), compilerErrorsAfter: rebuilt.diagnostics, behaviorPassed: behavior.passed, modelCalls: 1, sourceSha256: digest(repaired.files[0].content) };
      log({ stage: 'real-compiler-model-repair', passed: true });
    }

    // Use the production environment path without fake game references or SDK shims.
    const files = generateProject(plan).files.map(file => file.path === 'ModEntry.cs' ? { ...file, content: source } : file);
    const blocked = await compileProject({ files, gamePath: '' });
    ensure(blocked.status === 'blocked' && blocked.artifacts.length === 0, 'Production Mod build must remain blocked without the game.');
    report.productionBuild = { status: blocked.status, diagnostics: blocked.diagnostics.map(item => item.code), artifacts: 0 };
    const pipeline = createPipeline({ buildOptions: { gamePath: '' } });
    const job = pipeline.start({ plan, provider: { apiKey: 'sandbox-probe-not-a-provider-key' }, maxRepairs: 2 });
    let current = job;
    const deadline = Date.now() + 15000;
    while (pipeline.activeCount && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 25)); current = pipeline.get(job.id); }
    if (pipeline.activeCount) pipeline.close();
    ensure(current.status === 'blocked' && current.modelCalls === 0, 'Production pipeline must stop before a paid call when game references are missing.');
    report.productionPipeline = { status: current.status, modelCalls: current.modelCalls, build: current.report.build, game: current.report.game };
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.error = { code: error.code || 'SANDBOX_VERIFICATION_FAILED', message: String(error.message).replaceAll(root, '<sandbox>').replaceAll(outside, '<canary>').replaceAll(ROOT, '<project>').slice(0, 1600) };
    if (key) report.error.message = report.error.message.replaceAll(key, '[redacted]');
  } finally {
    await sandbox?.close();
    await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true });
    ensure(!key || !JSON.stringify(report).includes(JSON.stringify(key).slice(1, -1)), 'Credential detected in the report; no report was saved.');
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live') options.live = true;
    else if (args[index] === '--repair-live') options.repairLive = true;
    else if (['--source', '--plan', '--report'].includes(args[index]) && args[index + 1] && !args[index + 1].startsWith('--')) { const option = args[index]; options[{'--source':'sourcePath','--plan':'planPath','--report':'reportPath'}[option]] = path.resolve(args[++index]); }
    else throw new Error('Usage: verify-sandbox.mjs [--live | --source file.cs --plan plan.json [--repair-live]] [--report report.json]');
  }
    const report = await verifySandbox({ ...options, provider: { apiKey: process.env.DEEPSEEK_API_KEY, baseUrl: process.env.GAMEBRIDGE_API_BASE, model: process.env.GAMEBRIDGE_MODEL }, log: value => console.log(JSON.stringify(value)) });
    console.log(JSON.stringify({ scope: report.scope, passed: report.passed, sourceProvenance: report.sourceProvenance, modelCalls: report.modelCalls, behaviorCases: report.behavior?.cases, assertions: report.behavior?.assertions, negativeControl: report.negativeControl?.observedFailure, repair: report.repair?.behaviorPassed, realModBuild: report.realModBuild, game: report.game, error: report.error }, null, 2));
    process.exitCode = report.passed ? 0 : 1;
  } catch (error) { console.log(JSON.stringify({ passed: false, error: String(error.message), realModBuild: 'not_run', game: 'not_run' })); process.exitCode = 1; }
}
