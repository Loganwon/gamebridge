import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifySandbox } from '../scripts/verify-sandbox.mjs';
import { inspectBuildEnvironment } from '../src/build/runner.mjs';
import { createMacSandbox } from '../scripts/lib/macos-sandbox.mjs';

test('OS sandbox checks boundaries, runs actual C# behavior contracts and rejects an incorrect effect', async t => {
  if (process.platform !== 'darwin') { t.skip('This is a real macOS Seatbelt test, not a simulated sandbox.'); return; }
  const environment = await inspectBuildEnvironment({ gamePath: '' });
  if (!environment.dotnet.available || Number(environment.dotnet.version.split('.')[0]) < 10) { t.skip('A real SDK 10 is required.'); return; }
  const output = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-sandbox-report-'));
  try {
    const reportPath = path.join(output, 'report.json');
    const report = await verifySandbox({ reportPath });
    assert.equal(report.passed, true, JSON.stringify(report.error));
    assert.equal(report.sourceProvenance, 'fixed-example-no-ai'); assert.equal(report.modelCalls, 0);
    assert.ok(Object.values(report.boundaryProbes).every(value => value === true));
    assert.equal(report.behavior.cases, 21); assert.ok(report.behavior.assertions >= 70);
    assert.equal(report.behavior.passed, true); assert.equal(report.negativeControl.observedFailure, true);
    assert.ok(report.negativeControl.failedCases.includes('speed_value_duration_and_suppression'));
    assert.equal(report.realModBuild, 'not_run'); assert.equal(report.game, 'not_run'); assert.equal(report.readyToInstall, false);
    assert.equal(report.productionPipeline.status, 'blocked'); assert.equal(report.productionPipeline.modelCalls, 0);
    assert.deepEqual(JSON.parse(await readFile(reportPath, 'utf8')), report);
  } finally { await rm(output, { recursive: true, force: true }); }
});

test('sandbox wrapper refuses ordinary project directories instead of granting them write access', async t => {
  if (process.platform !== 'darwin') { t.skip('macOS-specific verification wrapper.'); return; }
  await assert.rejects(createMacSandbox({ workDir: process.cwd(), dotnetPath: '/not/a/dotnet' }), /owned gamebridge-sandbox/);
});
