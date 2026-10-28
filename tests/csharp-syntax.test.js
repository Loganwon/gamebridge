import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCSharpSyntax } from '../scripts/check-csharp-syntax.mjs';
import { inspectBuildEnvironment } from '../src/build/runner.mjs';

test('Roslyn syntax verification accepts valid text without resolving unknown game types', async t => {
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  if (!environment.dotnet.available || Number(environment.dotnet.version.split('.')[0]) < 10) { t.skip('Real .NET SDK 10 is not installed.'); return; }
  const report = await checkCSharpSyntax('public class Probe { public UnknownGameType? Value; }');
  assert.equal(report.scope, 'syntax-only'); assert.equal(report.syntaxPassed, true);
  assert.equal(report.build, 'not_run'); assert.equal(report.game, 'not_run');
  assert.equal(report.provenance, 'local-sdk-roslyn');
  assert.ok(!Object.hasOwn(report, 'build_passed'));
});

test('a real Roslyn CS1002 is reported for an injected missing semicolon', async t => {
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  if (!environment.dotnet.available || Number(environment.dotnet.version.split('.')[0]) < 10) { t.skip('Real .NET SDK 10 is not installed.'); return; }
  const report = await checkCSharpSyntax('public class Probe { public int Value = 1 }');
  assert.equal(report.scope, 'syntax-only'); assert.equal(report.syntaxPassed, false);
  assert.ok(report.diagnostics.some(diagnostic => diagnostic.code === 'CS1002' && diagnostic.severity === 'error'));
  assert.equal(report.build, 'not_run'); assert.equal(report.game, 'not_run');
});

test('syntax verification rejects oversized inputs and a missing real SDK', async () => {
  await assert.rejects(checkCSharpSyntax('x'.repeat(65537)), error => error.code === 'INVALID_SOURCE');
  await assert.rejects(checkCSharpSyntax('public class Probe {}', { dotnetPath: '/no/such/dotnet' }), error => error.code === 'SDK_REQUIRED');
});
