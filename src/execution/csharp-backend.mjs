import { readFile, lstat, realpath, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { validateBehaviorSpec, createBehaviorMachine, emitCSharpBehavior } from '../behavior/index.mjs';
import { createCompilerIsolation } from './isolation.mjs';
import { assertProtocolJson } from '../orchestration/protocol.mjs';

export const PROJECT_FILES = Object.freeze(['Behavior.cs', 'Program.cs', 'GameBridge.BehaviorKernel.csproj', 'NuGet.Config', 'global.json', 'vectors.json']);
export const COMPILED_FILES = Object.freeze(['compiled/GameBridge.BehaviorKernelVerification.dll', 'compiled/GameBridge.BehaviorKernelVerification.deps.json', 'compiled/GameBridge.BehaviorKernelVerification.runtimeconfig.json', 'vectors.json']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = value => createHash('sha256').update(value).digest('hex');
const HARNESS = String.raw`
using System;
using System.Collections.Generic;
using System.Text.Json;
using System.IO;
using GameBridge.Generated;
public static class Program {
  static object View(StepResult r) => new { state=r.State, variables=r.Variables, transitionId=r.TransitionId };
  public static void Main() {
    using var input=JsonDocument.Parse(File.ReadAllText("vectors.json"));
    var machine=new BehaviorMachine(); var initial=View(machine.Snapshot());
    var observations=new List<object>();
    foreach(var step in input.RootElement.EnumerateArray()) {
      try {
        var fields=new Dictionary<string,long>(StringComparer.Ordinal);
        foreach(var field in step.GetProperty("fields").EnumerateObject()) fields.Add(field.Name,field.Value.GetInt64());
        observations.Add(new { accepted=true, snapshot=View(machine.Step(step.GetProperty("eventId").GetString()!,fields)) });
      }
      catch(ArgumentException) { observations.Add(new { accepted=false, snapshot=View(machine.Snapshot()) }); }
      catch(InvalidOperationException) { observations.Add(new { accepted=false, snapshot=View(machine.Snapshot()) }); }
      catch(OverflowException) { observations.Add(new { accepted=false, snapshot=View(machine.Snapshot()) }); }
      catch(FormatException) { observations.Add(new { accepted=false, snapshot=View(machine.Snapshot()) }); }
    }
    Console.WriteLine(JsonSerializer.Serialize(new { initial, observations }));
  }
}
`;

/** Explicit backend admission. This probes only the actual .NET SDK; it admits
 * no game, does not download packages, and cannot promote Mod/game evidence.
 */
export async function probeCSharpBackend({ sdkRoot, directory, actualEnv, signal } = {}) {
  sdkRoot = await realpath(sdkRoot);
  const executable = path.join(sdkRoot, 'dotnet'), info = await lstat(executable);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) fail('SDK_IDENTITY_INVALID', 'Invalid local SDK identity.');
  const executableSha256 = hash(await readFile(executable));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const isolation = await createCompilerIsolation({ sdkRoot, workRoot: directory, actualEnv, signal });
  try {
    const result = await isolation.runDotnet(['--version'], { signal, timeoutMs: 30000 });
    if (result.exitCode !== 0 || !/^(?:8|10)\.\d+\.\d+$/.test(result.output.trim())) fail('SDK_PROBE_FAILED', 'An admitted offline .NET 8 or 10 SDK is required.');
    const version = result.output.trim(), targetFramework = 'net' + version.split('.')[0] + '.0';
    const compiler = path.join(sdkRoot, 'sdk', version, 'Roslyn', 'bincore', 'csc.dll'), compilerInfo = await lstat(compiler);
    if (!compilerInfo.isFile() || compilerInfo.isSymbolicLink() || compilerInfo.size > 64 * 1024 * 1024) fail('SDK_IDENTITY_INVALID', 'A real locally selected C# compiler is required.');
    const compilerSha256 = hash(await readFile(compiler));
    const identity = Object.freeze({ id: 'dotnet', version, platform: process.platform });
    async function unchanged() {
      if (hash(await readFile(executable)) !== executableSha256 || hash(await readFile(compiler)) !== compilerSha256) fail('SDK_IDENTITY_CHANGED', 'Selected compiler identity changed after its local probe.');
    }
    return {
      identity, targetFramework,
      evidence: { toolchain: identity, executableSha256, compilerSha256, isolation: isolation.evidence, scope: 'portable-behavior-tool-only', realModBuild: 'not_run', game: 'not_run' },
      async compile(directory, { signal } = {}) {
        await unchanged(); const boundary = await createCompilerIsolation({ sdkRoot, workRoot: directory, actualEnv, signal });
        try {
          const result = await boundary.runDotnet(['build', 'GameBridge.BehaviorKernel.csproj', '--configuration', 'Release', '--output', 'compiled',
            '--no-dependencies', '--disable-build-servers', '--nologo', '--verbosity', 'minimal', '-p:UseSharedCompilation=false',
            '-p:RunAnalyzers=false', '-p:EnableNETAnalyzers=false', '-p:NuGetAudit=false'], { signal, timeoutMs: 120000 });
          if (result.exitCode !== 0) {
            const error = Object.assign(new Error('The isolated portable behavior compilation did not pass.'), {
              code: result.cancelled ? 'TOOL_CANCELLED' : result.timedOut ? 'TOOL_TIMEOUT' : 'PORTABLE_COMPILE_FAILED',
              toolDiagnostic: { operation: 'dotnet-build', ...result },
            });
            throw error;
          }
          await unchanged(); return { scope: 'portable-library-build', toolchain: identity, isolation: boundary.evidence, exitCode: 0, realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
        } finally { await boundary.close(); }
      },
      async executeVerification(directory, { signal } = {}) {
        await unchanged(); const boundary = await createCompilerIsolation({ sdkRoot, workRoot: directory, actualEnv, signal });
        try {
          const result = await boundary.runDotnet(['compiled/GameBridge.BehaviorKernelVerification.dll'], { signal, timeoutMs: 30000 });
          if (result.exitCode !== 0) fail('PORTABLE_VERIFICATION_FAILED', 'The isolated compiled behavior verifier did not complete.');
          let data; try { data = JSON.parse(result.output); } catch { fail('PORTABLE_VERIFICATION_FAILED', 'The compiled verifier did not return its bounded result contract.'); }
          return { data, isolation: boundary.evidence };
        } finally { await boundary.close(); }
      },
    };
  } finally { await isolation.close(); }
}
export function evaluateBehaviorVectors(rawSpec, steps, { requirementIds } = {}) {
  const spec = validateBehaviorSpec(rawSpec, { requirementIds });
  assertProtocolJson(steps, { maxBytes: 64 * 1024, maxDepth: 16 });
  const pending = [steps];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && Object.is(value, -0)) fail('INVALID_BEHAVIOR_VECTORS', 'Negative zero cannot be preserved by the verification JSON contract.');
    if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 256) fail('INVALID_BEHAVIOR_VECTORS', 'Verification requires 1..256 explicit input steps.');
  const machine = createBehaviorMachine(spec), initial = machine.snapshot(), observations = [];
  for (const step of steps) {
    // The spec validates every event field; vectors never carry paths or commands.
    if (!step || typeof step !== 'object' || Array.isArray(step) || Object.keys(step).some(key => !['eventId', 'fields', 'expected', 'error'].includes(key)) ||
        typeof step.eventId !== 'string' || !step.fields || typeof step.fields !== 'object' ||
        (Object.hasOwn(step, 'error') && typeof step.error !== 'boolean')) fail('INVALID_BEHAVIOR_VECTORS', 'Invalid behavior input vector.');
    let observation;
    try { observation = { accepted: true, snapshot: machine.step(step.eventId, step.fields) }; }
    catch { observation = { accepted: false, snapshot: machine.snapshot() }; }
    if ((step.expected !== undefined && (!isDeepStrictEqual(observation.snapshot, step.expected) || observation.accepted === Boolean(step.error))) ||
        (Object.hasOwn(step, 'error') && observation.accepted === step.error)) fail('BEHAVIOR_EXPECTATION_FAILED', 'A behavior fixture disagreed with its explicit expected state or rejection.');
    observations.push(observation);
  }
  return { initial, observations };
}
export function makeBehaviorProject(rawSpec, steps, backend, { requirementIds } = {}) {
  const spec = validateBehaviorSpec(rawSpec, { requirementIds });
  if (spec.unresolved.length) fail('BEHAVIOR_REQUIREMENTS_UNRESOLVED', 'Unrepresented requirements block portable implementation verification.');
  evaluateBehaviorVectors(spec, steps, { requirementIds });
  if (!backend || !/^net(?:8|10)\.0$/.test(backend.targetFramework) || !/^(?:8|10)\.\d+\.\d+$/.test(backend.identity?.version)) fail('SDK_PROBE_REQUIRED', 'A locally probed backend is required.');
  const project = [
    '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>',
    '<OutputType>Exe</OutputType><TargetFramework>' + backend.targetFramework + '</TargetFramework>',
    '<AssemblyName>GameBridge.BehaviorKernelVerification</AssemblyName><Nullable>enable</Nullable><ImplicitUsings>disable</ImplicitUsings>',
    '<EnableDefaultCompileItems>false</EnableDefaultCompileItems><EnableNETAnalyzers>false</EnableNETAnalyzers><RunAnalyzers>false</RunAnalyzers>',
    '<UseSharedCompilation>false</UseSharedCompilation><UseAppHost>false</UseAppHost><NuGetAudit>false</NuGetAudit>',
    '<GenerateAssemblyInfo>false</GenerateAssemblyInfo><GenerateTargetFrameworkAttribute>false</GenerateTargetFrameworkAttribute>',
    '<EnableSourceControlManagerQueries>false</EnableSourceControlManagerQueries><EnableSourceLink>false</EnableSourceLink>',
    '<PublishRepositoryUrl>false</PublishRepositoryUrl><EmbedUntrackedSources>false</EmbedUntrackedSources>',
    '<RestoreConfigFile>NuGet.Config</RestoreConfigFile><Deterministic>true</Deterministic>',
    '</PropertyGroup><ItemGroup><Compile Include="Behavior.cs"/><Compile Include="Program.cs"/></ItemGroup></Project>',
  ].join('');
  const values = {
    'Behavior.cs': emitCSharpBehavior(spec, { requirementIds }), 'Program.cs': HARNESS,
    'GameBridge.BehaviorKernel.csproj': project, 'NuGet.Config': '<configuration><packageSources><clear/></packageSources></configuration>',
    'global.json': JSON.stringify({ sdk: { version: backend.identity.version, rollForward: 'disable' } }),
    'vectors.json': JSON.stringify(steps.map(step => ({ eventId: step.eventId, fields: step.fields }))),
  };
  return PROJECT_FILES.map(name => ({ path: name, content: values[name] }));
}
export function compareBehaviorTrace(expected, actual, { declaredExpectedSteps = 0 } = {}) {
  if (!isDeepStrictEqual(expected, actual)) fail('BEHAVIOR_BACKEND_MISMATCH', 'Compiled behavior differed from the declared input/output contract.');
  return { scope: 'portable-behavior-equivalence', steps: expected.observations.length,
    accepted: expected.observations.filter(item => item.accepted).length, rejected: expected.observations.filter(item => !item.accepted).length,
    matchesDeclaredVectors: declaredExpectedSteps === expected.observations.length, matchesJavaScript: true, realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
}
