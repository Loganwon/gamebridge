import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { inspectTmodloaderEnvironment, readManagedAssemblyMetadata, TMODLOADER_ENVIRONMENT_LIMITS, TMODLOADER_TARGET } from '../src/hosts/tmodloader/environment.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const moduleUrl = new URL('../src/hosts/tmodloader/environment.mjs', import.meta.url).href;
const noSdk = path.join(os.tmpdir(), 'gamebridge-no-such-tml-sdk', 'dotnet');
async function scratch(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-tml-preflight-test-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}
async function installedSdkAssembly() {
  for (const base of ['.tools/dotnet8-x64', '.tools/dotnet']) {
    const dir = path.join(ROOT, base, 'shared/Microsoft.NETCore.App');
    try {
      const versions = await readdir(dir);
      for (const version of versions) {
        const file = path.join(dir, version, 'System.Reflection.Metadata.dll');
        try { await access(file); return file; } catch {}
      }
    } catch {}
  }
  return null;
}
function blocked(report) {
  assert.equal(report.status, 'blocked'); assert.equal(report.readyForProbeBuild, false);
  assert.equal(report.adapterImplemented, false); assert.equal(report.realModBuild, 'not_run');
  assert.equal(report.game, 'not_run'); assert.equal(report.readyToInstall, false);
  assert.equal(report.capabilities.gameExecution, false); assert.equal(report.capabilities.modelGeneration, false);
}

test('preflight locks a research target and keeps missing SDK/game evidence explicit', async () => {
  assert.equal(TMODLOADER_TARGET.release, 'v2026.08.3.0');
  assert.equal(TMODLOADER_TARGET.sdkVersion, '8.0.427');
  assert.equal(TMODLOADER_TARGET.sdkArchitecture, 'x64');
  assert.deepEqual(TMODLOADER_TARGET.requiredReferenceAssemblies, ['FNA', 'ReLogic', 'log4net']);
  assert.ok(Object.isFrozen(TMODLOADER_TARGET.requiredReferenceAssemblies));
  assert.ok(Object.isFrozen(TMODLOADER_TARGET));
  const report = await inspectTmodloaderEnvironment({ dotnetPath: noSdk, installPath: '' });
  blocked(report);
  assert.ok(report.issues.some(item => item.code === 'TML_SDK8_X64_MISSING'));
  assert.ok(report.issues.some(item => item.code === 'TML_INSTALL_PATH_REQUIRED'));
  assert.equal(report.environment.install.versionValidated, false);
  assert.equal(report.environment.install.pathConfigured, false);
  assert.equal(report.environment.sdk.exactSdkMatch, false);
  assert.ok(report.limitations.some(item => /SDK.*self-report.*do not authenticate/.test(item)));
});

test('the probe logging contract requires a real log4net identity and absent references cannot satisfy it', async () => {
  const source = await readFile(path.join(ROOT, 'probes/tmodloader/GameBridgeHostProbe/ProbePlayer.cs'), 'utf8');
  assert.match(source, /Mod\.Logger\.Info\(/);
  assert.ok(TMODLOADER_TARGET.requiredReferenceAssemblies.includes('log4net'));
  await scratch(async dir => {
    await mkdir(path.join(dir, 'Libraries'));
    const report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.equal(report.environment.install.referencesValidated, false);
    assert.ok(report.issues.some(item => item.code === 'TML_REQUIRED_REFERENCE_MISSING'));
  });
});

test('reference enumeration stops at the configured entry limit without accepting a large directory', async () => {
  await scratch(async dir => {
    const libraries = path.join(dir, 'Libraries'); await mkdir(libraries);
    for (let base = 0; base <= TMODLOADER_ENVIRONMENT_LIMITS.directoryEntries; base += 64) {
      const count = Math.min(64, TMODLOADER_ENVIRONMENT_LIMITS.directoryEntries + 1 - base);
      await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(libraries, `entry-${base + index}.txt`), '')));
    }
    const report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.equal(report.environment.install.referencesValidated, false);
    assert.ok(report.issues.some(item => item.code === 'TML_REFERENCE_ENTRY_LIMIT'));
  });
});

test('malformed or cross-platform metadata and paths cannot declare a Mac environment ready', async () => {
  for (const installPath of ['relative/game', '/games/$(Injected)', '/games/@(Injected)', '/games/Game;Run=true', '/games/Game,Other=true', '/games/%24(Injected)', '/games/a\\b', 'x'.repeat(4097)]) {
    const report = await inspectTmodloaderEnvironment({ installPath, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_INSTALL_PATH_INVALID'));
  }
  for (const [platform, arch] of [['not-a-platform', 'x64'], ['darwin', 'unknown'], ['win32', 'ia32']]) {
    const report = await inspectTmodloaderEnvironment({ platform, arch, dotnetPath: noSdk });
    blocked(report);
    assert.ok(report.issues.some(item => /PLATFORM|ARCH|METADATA/.test(item.code)));
  }
  const foreign = process.platform === 'darwin' ? 'linux' : 'darwin';
  const report = await inspectTmodloaderEnvironment({ platform: foreign, arch: process.arch, dotnetPath: noSdk });
  blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_MACHINE_METADATA_MISMATCH'));
});

test('reference paths with MSBuild syntax, separators or control characters stay blocked before metadata can be accepted', async t => {
  if (process.platform === 'win32') { t.skip('Some owned malformed filename probes are unavailable on Windows.'); return; }
  for (const name of ['$(Unsafe).dll', '@(Unsafe).dll', '%24Unsafe.dll', 'one;two.dll', 'one,two.dll', 'one\\two.dll', 'one\ntwo.dll']) {
    await scratch(async dir => {
      await mkdir(path.join(dir, 'Libraries'));
      await writeFile(path.join(dir, 'Libraries', name), 'invalid owned negative fixture; never a game assembly');
      const report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
      blocked(report); assert.equal(report.environment.install.referencesValidated, false);
      assert.ok(report.issues.some(item => item.code === 'TML_REFERENCE_PATH_UNSAFE'), name);
    });
  }
  await scratch(async dir => {
    let nested = path.join(dir, 'Libraries'); await mkdir(nested);
    for (let depth = 0; depth < 3; depth++) { nested = path.join(nested, 'a'.repeat(250)); await mkdir(nested); }
    await writeFile(path.join(nested, 'b'.repeat(60) + '.dll'), 'oversized relative path negative fixture');
    const report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_REFERENCE_PATH_UNSAFE'));
  });
});

test('text, forged PE headers and oversized files cannot stand in for a real tModLoader assembly', async () => {
  await scratch(async dir => {
    const file = path.join(dir, 'tModLoader.dll');
    await writeFile(file, 'tModLoader 2026.08.3.0 Stable ' + TMODLOADER_TARGET.commit);
    let report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_ASSEMBLY_INVALID'));
    const forged = Buffer.alloc(1024);
    forged.write('MZ'); forged.writeUInt32LE(128, 0x3c); forged.write('PE\0\0', 128);
    forged.writeUInt16LE(0x14c, 132); forged.writeUInt16LE(1, 134); forged.writeUInt16LE(224, 148); forged.writeUInt16LE(0x10b, 152);
    await writeFile(file, forged);
    report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.equal(report.environment.install.versionValidated, false);
    assert.ok(report.issues.some(item => item.code === 'TML_ASSEMBLY_INVALID'));
    await truncate(file, TMODLOADER_ENVIRONMENT_LIMITS.assemblyBytes + 1);
    report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_ASSEMBLY_INVALID'));
  });
});

test('managed metadata reader rejects amplification and does not execute string or header lookalikes', () => {
  for (const bytes of [null, 'MZ', Buffer.from('MZ'), Buffer.alloc(512), Buffer.from('MZPE AssemblyInformationalVersionAttribute 1.4.4.9+2026.8.3.0')]) {
    assert.throws(() => readManagedAssemblyMetadata(bytes), { code: 'INVALID_MANAGED_METADATA' });
  }
  const invalid = Buffer.alloc(1024); invalid.write('MZ'); invalid.writeUInt32LE(0xffffffff, 0x3c);
  assert.throws(() => readManagedAssemblyMetadata(invalid), { code: 'INVALID_MANAGED_METADATA' });
});

test('a real unrelated SDK assembly is parsed as metadata and cannot impersonate tModLoader by renaming', async t => {
  const file = await installedSdkAssembly();
  if (!file) { t.skip('No existing vendor SDK metadata assembly available.'); return; }
  const bytes = await readFile(file), metadata = readManagedAssemblyMetadata(bytes);
  assert.equal(metadata.name, 'System.Reflection.Metadata');
  assert.match(metadata.assemblyVersion, /^\d+\.\d+\.\d+\.\d+$/);
  assert.ok(metadata.informationalVersion);
  assert.equal(metadata.metadataOnly, true); assert.equal(metadata.requiredTypesPresent, false);
  await scratch(async dir => {
    // Negative boundary only: a vendor SDK DLL keeps its genuine identity. No
    // game-named test assembly is compiled or used to satisfy production checks.
    await writeFile(path.join(dir, 'tModLoader.dll'), bytes);
    const report = await inspectTmodloaderEnvironment({ installPath: dir, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_VERSION_IDENTITY_UNVERIFIED'));
    assert.equal(report.environment.install.versionValidated, false);
  });
});

test('symbolic roots and assembly links are rejected rather than reading outside the configured installation', async t => {
  if (process.platform === 'win32') { t.skip('This boundary probe uses POSIX symbolic links.'); return; }
  await scratch(async dir => {
    const install = path.join(dir, 'install'), outside = path.join(dir, 'outside');
    await mkdir(install); await mkdir(outside);
    await writeFile(path.join(outside, 'private'), 'must-not-be-read');
    const linkedRoot = path.join(dir, 'linked-root'); await symlink(install, linkedRoot);
    let report = await inspectTmodloaderEnvironment({ installPath: linkedRoot, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_INSTALL_DIRECTORY_UNAVAILABLE'));
    await symlink(path.join(outside, 'private'), path.join(install, 'tModLoader.dll'));
    report = await inspectTmodloaderEnvironment({ installPath: install, dotnetPath: noSdk });
    blocked(report); assert.ok(report.issues.some(item => item.code === 'TML_ASSEMBLY_INVALID'));
    assert.ok(!JSON.stringify(report).includes('must-not-be-read'));
  });
});

test('pre-cancelled inspection stops before SDK or installation observation', async () => {
  const controller = new AbortController(); controller.abort();
  const report = await inspectTmodloaderEnvironment({ signal: controller.signal });
  blocked(report); assert.deepEqual(report.issues.map(item => item.code), ['CANCELLED']);
  assert.equal(report.environment.sdk.path, undefined); assert.equal(report.environment.install.path, undefined);
  for (const timeoutMs of [0, 49, 30001, NaN, '100']) await assert.rejects(inspectTmodloaderEnvironment({ timeoutMs }), { code: 'INVALID_TML_ENVIRONMENT_OPTIONS' });
});

async function fakeSdk(dir, kind) {
  const file = path.join(dir, 'dotnet');
  const content = `#!${process.execPath}\n${kind === 'hang' ? 'setInterval(()=>{},1000);' : `
if(process.env.DEEPSEEK_API_KEY||process.env.GITHUB_TOKEN||process.env.HTTP_PROXY)process.exit(29);
if(process.argv[2]==='--list-sdks')console.log('8.0.427 [/test-owned-sdk]');
else console.log('.NET SDK:\\n Version: 8.0.427\\n Runtime Environment:\\n RID: osx-x64\\n Host:\\n Architecture: x64\\n.NET runtimes installed:\\n Microsoft.NETCore.App 8.0.33 [/test-owned-sdk]');
`}`;
  await writeFile(file, content); await chmod(file, 0o700); return file;
}

test('SDK subprocesses receive only a minimal environment, and self-reported tool metadata alone never makes a game ready', async t => {
  if (process.platform === 'win32') { t.skip('This owned fake tool uses a POSIX shebang.'); return; }
  await scratch(async dir => {
    const dotnetPath = await fakeSdk(dir, 'metadata');
    const script = `import {inspectTmodloaderEnvironment} from ${JSON.stringify(moduleUrl)};const r=await inspectTmodloaderEnvironment({dotnetPath:${JSON.stringify(dotnetPath)}});console.log(JSON.stringify({status:r.status,sdk:r.environment.sdk,game:r.game,issues:r.issues}));`;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, shell: false, env: { PATH: process.env.PATH || '', DEEPSEEK_API_KEY: 'isolated-test-canary-not-a-real-key', GITHUB_TOKEN: 'isolated-test-token', HTTP_PROXY: 'isolated-test-proxy' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error('Owned SDK child failed: ' + stderr)));
    });
    assert.ok(!output.includes('isolated-test-canary'));
    const report = JSON.parse(output);
    assert.equal(report.sdk.available, true); assert.equal(report.sdk.exactSdkMatch, true);
    assert.equal(report.status, 'blocked'); assert.equal(report.game, 'not_run');
    assert.ok(report.issues.some(item => item.code === 'TML_INSTALL_PATH_REQUIRED'));
  });
});

test('active cancellation and a hard deadline return blocked without accepting late SDK output', async t => {
  if (process.platform === 'win32') { t.skip('This owned fake tool uses a POSIX shebang.'); return; }
  await scratch(async dir => {
    const dotnetPath = await fakeSdk(dir, 'hang');
    const controller = new AbortController();
    const pending = inspectTmodloaderEnvironment({ dotnetPath, signal: controller.signal });
    setTimeout(() => controller.abort(), 40);
    const cancelled = await pending;
    blocked(cancelled); assert.ok(cancelled.issues.some(item => item.code === 'CANCELLED'));
    const started = Date.now();
    const timedOut = await inspectTmodloaderEnvironment({ dotnetPath, timeoutMs: 80 });
    blocked(timedOut); assert.ok(timedOut.issues.some(item => item.code === 'TML_PREFLIGHT_TIMEOUT'));
    assert.ok(Date.now() - started < 1500);
    const snapshot = JSON.stringify(timedOut);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(JSON.stringify(timedOut), snapshot, 'late observations cannot mutate returned blocked reports');
  });
});

test('the actual project SDK can be observed without fabricating game references', async t => {
  const executable = path.join(ROOT, '.tools/dotnet8-x64/dotnet');
  try { await access(executable); } catch { t.skip('No project-specific x64 SDK installed.'); return; }
  const report = await inspectTmodloaderEnvironment({ dotnetPath: executable });
  blocked(report); assert.equal(report.environment.install.available, false);
  if (report.environment.sdk.available) {
    assert.equal(report.environment.sdk.version, '8.0.427'); assert.equal(report.environment.sdk.architecture, 'x64');
    assert.equal(report.environment.sdk.rid, 'osx-x64'); assert.equal(report.environment.sdk.exactSdkMatch, true);
  }
  assert.ok(report.issues.some(item => item.code === 'TML_INSTALL_PATH_REQUIRED'));
});
