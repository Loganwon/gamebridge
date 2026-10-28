import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectBuildEnvironment, compileProject, parseCompilerDiagnostics, isRepairableDiagnostics, runCompilerProcess } from '../src/build/runner.mjs';
import { generateProject } from '../src/generator/smapi.mjs';
import { createExamplePlan } from '../src/ai/plan.mjs';

const project = () => generateProject(createExamplePlan()).files;
async function scratch(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-runner-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('missing SDK and game configuration remain explicit environment blockers', async () => {
  const report = await inspectBuildEnvironment({ dotnetPath: path.join(os.tmpdir(), 'gamebridge-nonexistent-dotnet'), gamePath: '' });
  assert.equal(report.ready, false); assert.equal(report.dotnet.available, false); assert.equal(report.game.available, false);
  assert.ok(report.issues.some(issue => issue.code === 'SDK_MISSING'));
  assert.ok(report.issues.some(issue => issue.code === 'GAME_PATH_REQUIRED'));
  assert.equal(report.game.versionValidated, false);
});

test('game path expressions and non-assembly files never count as prepared game references', async () => {
  for (const gamePath of ['relative/path', '/games/Game;EnableModDeploy=true', '/games/Game,EnableModDeploy=true', '/games/$(Secret)', '/games/%24(Secret)']) {
    const report = await inspectBuildEnvironment({ dotnetPath: '/not/a/dotnet', gamePath });
    assert.ok(report.issues.some(issue => issue.code === 'INVALID_GAME_PATH'));
    assert.equal(report.ready, false);
  }
  await scratch(async dir => {
    await writeFile(path.join(dir, 'Stardew Valley.dll'), 'not a game assembly');
    const report = await inspectBuildEnvironment({ dotnetPath: '/not/a/dotnet', gamePath: dir });
    assert.equal(report.game.available, false);
    assert.ok(report.game.missing.includes('Stardew Valley.dll'));
    assert.ok(report.game.missing.includes('StardewModdingAPI.dll'));
  });
});

test('altered build configuration, extra scripts and duplicate filenames stop before compilation', async () => {
  for (const mutate of [
    files => { files.find(file => file.path.endsWith('.csproj')).content += '<Target Name="Injected" />'; },
    files => { files.find(file => file.path === 'ModConfig.cs').content += '\npublic class Other {}'; },
    files => { files.find(file => file.path === 'config.json').content = '{"Enabled":true}'; },
    files => { files.push({ path: 'Directory.Build.targets', content: '<Project />' }); },
    files => { files.push({ ...files[0] }); },
    files => { files.push({ path: '../escape.cs', content: 'class Escape {}' }); },
    files => { files.find(file => file.path === 'README.md').content = 'a'.repeat(129 * 1024); },
  ]) {
    const files = project(); mutate(files);
    const result = await compileProject({ files, dotnetPath: '/not/a/dotnet', gamePath: '' });
    assert.equal(result.status, 'blocked'); assert.equal(result.repairable, false);
    assert.equal(result.diagnostics[0].code, 'INVALID_PROJECT'); assert.deepEqual(result.artifacts, []);
    assert.equal(result.environment, undefined, 'invalid model-controlled projects must not reach environment/process execution');
  }
});

test('unprepared environment cannot produce a DLL or trigger a code-repair recommendation', async () => {
  const result = await compileProject({ files: project(), dotnetPath: '/not/a/dotnet', gamePath: '' });
  assert.equal(result.status, 'blocked'); assert.equal(result.repairable, false); assert.deepEqual(result.artifacts, []);
  assert.ok(result.diagnostics.some(diagnostic => diagnostic.code === 'GAME_PATH_REQUIRED'));
});

test('cancelled compilation returns without starting environment or compiler work', async () => {
  const controller = new AbortController(); controller.abort();
  const result = await compileProject({ files: project(), signal: controller.signal });
  assert.equal(result.status, 'cancelled'); assert.equal(result.repairable, false); assert.deepEqual(result.artifacts, []);
});

test('compiler diagnostics preserve bounded code locations and deduplicate repeated build summaries', () => {
  const output = [
    '/private/tmp/project/ModEntry.cs(24,12): error CS1061: Type has no member Foo [/private/tmp/project/GameBridge.Generated.csproj]',
    '/private/tmp/project/ModEntry.cs(24,12): error CS1061: Type has no member Foo [/private/tmp/project/GameBridge.Generated.csproj]',
    '/private/tmp/project/GameBridge.Generated.csproj : error NU1301: Unable to load the service index.',
    '/private/tmp/project/unexpected.cs(1,1): warning CS0168: Unused variable.',
  ].join('\n');
  const diagnostics = parseCompilerDiagnostics(output);
  assert.equal(diagnostics.length, 3);
  assert.deepEqual(diagnostics[0], { code: 'CS1061', severity: 'error', message: 'Type has no member Foo', file: 'ModEntry.cs', line: 24 });
  assert.equal(diagnostics[1].code, 'NU1301'); assert.equal(diagnostics[1].file, undefined);
  assert.equal(diagnostics[2].file, undefined, 'unknown paths are never used as editable model file locations');
  const large = parseCompilerDiagnostics(Array.from({ length: 100 }, (_, index) => `error CS${1000 + index}: ${'x'.repeat(3000)}`).join('\n'));
  assert.equal(large.length, 50); assert.ok(large.every(diagnostic => diagnostic.message.length <= 2000));
});

test('missing references and locked configuration errors cannot spend model calls on source repair', () => {
  const codeError = { severity: 'error', code: 'CS1061', message: 'No such method.', file: 'ModEntry.cs' };
  assert.equal(isRepairableDiagnostics([codeError]), true);
  for (const diagnostic of [
    { ...codeError, code: 'NU1301' }, { ...codeError, code: 'CS0006' },
    { ...codeError, code: 'CS0012' }, { ...codeError, code: 'CS2012' },
    { ...codeError, file: 'ModConfig.cs' },
  ]) assert.equal(isRepairableDiagnostics([codeError, diagnostic]), false);
  assert.equal(isRepairableDiagnostics([{ ...codeError, severity: 'warning' }]), false);
});

test('compiler subprocess uses an explicit minimal environment without API credentials', async () => {
  await scratch(async dir => {
    const key = 'canary-never-in-compiler';
    const previous = process.env.DEEPSEEK_API_KEY; process.env.DEEPSEEK_API_KEY = key;
    try {
      const result = await runCompilerProcess(process.execPath, ['-e', 'console.log(JSON.stringify({key:process.env.DEEPSEEK_API_KEY,home:process.env.HOME,argv:process.argv.slice(1)}))', 'literal;echo should-not-run'], { cwd: dir });
      assert.equal(result.exitCode, 0); assert.ok(!result.output.includes(key));
      const output = JSON.parse(result.output); assert.equal(output.key, undefined); assert.equal(output.home, dir);
      assert.deepEqual(output.argv, ['literal;echo should-not-run']);
    } finally { if (previous === undefined) delete process.env.DEEPSEEK_API_KEY; else process.env.DEEPSEEK_API_KEY = previous; }
  });
});

test('compiler process timeout, output limits and active cancellation all settle and stop work', async () => {
  await scratch(async dir => {
    const timedOut = await runCompilerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, timeoutMs: 40 });
    assert.equal(timedOut.timedOut, true); assert.notEqual(timedOut.exitCode, 0);
    const overflow = await runCompilerProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000));setInterval(()=>{},1000)'], { cwd: dir, maxOutputBytes: 1000 });
    assert.equal(overflow.overflow, true); assert.ok(overflow.output.length <= 1000);
    const controller = new AbortController();
    const pending = runCompilerProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: dir, signal: controller.signal });
    controller.abort(); const cancelled = await pending;
    assert.equal(cancelled.cancelled, true); assert.notEqual(cancelled.exitCode, 0);
  });
});

test('an actual installed SDK can be probed but no game install is fabricated for compilation', async t => {
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  if (!environment.dotnet.available) { t.skip('No real SDK is installed in this test environment.'); return; }
  assert.match(environment.dotnet.version, /^\d+\.\d+\.\d+/);
  assert.equal(environment.ready, false); assert.equal(environment.game.available, false);
  const result = await compileProject({ files: project(), gamePath: '' });
  assert.equal(result.status, 'blocked'); assert.deepEqual(result.artifacts, []);
});

test('the real SDK compiles an isolated plain .NET probe and reports a real syntax error', async t => {
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  if (!environment.dotnet.available) { t.skip('No real SDK is installed in this test environment.'); return; }
  await scratch(async dir => {
    const framework = 'net' + environment.dotnet.version.split('.')[0] + '.0';
    await writeFile(path.join(dir, 'CompilerProbe.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>${framework}</TargetFramework><UseSharedCompilation>false</UseSharedCompilation></PropertyGroup></Project>`);
    await writeFile(path.join(dir, 'NuGet.Config'), '<configuration><packageSources><clear/></packageSources></configuration>');
    const source = path.join(dir, 'CompilerProbe.cs');
    await writeFile(source, 'public static class CompilerProbe { public static int Answer => 42; }');
    const args = ['build', 'CompilerProbe.csproj', '--disable-build-servers', '--nologo', '--verbosity', 'minimal', '--configfile', path.join(dir, 'NuGet.Config'), '-p:NuGetAudit=false', '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false'];
    const compiled = await runCompilerProcess(environment.dotnet.path, args, { cwd: dir, timeoutMs: 30000 });
    assert.equal(compiled.exitCode, 0, compiled.output);
    const bytes = await readFile(path.join(dir, 'bin', 'Debug', framework, 'CompilerProbe.dll'));
    assert.equal(bytes.subarray(0, 2).toString('ascii'), 'MZ');
    await writeFile(source, 'public static class CompilerProbe { public static int Answer => ; }');
    const failed = await runCompilerProcess(environment.dotnet.path, args, { cwd: dir, timeoutMs: 30000 });
    assert.notEqual(failed.exitCode, 0);
    assert.ok(parseCompilerDiagnostics(failed.output).some(diagnostic => /^CS\d+$/.test(diagnostic.code) && diagnostic.severity === 'error'));
    // This probe has no SMAPI/game references. It verifies the compiler tool only,
    // and must never be reported as a compiled or playable game Mod.
  });
});
