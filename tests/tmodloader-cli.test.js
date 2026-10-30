import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function run(args) {
  return spawnSync(process.execPath, ['scripts/check-tmodloader.mjs', ...args], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 2 * 1024 * 1024,
    env: { PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  });
}

test('tModLoader preflight CLI help and malformed arguments do not start a game or SDK build', () => {
  const help = run(['--help']); assert.equal(help.status, 0); assert.match(help.stdout, /Read-only/);
  for (const args of [['--unexpected'], ['--install-path'], ['--install-path', 'relative'], ['--dotnet-path', 'relative'], ['--output', 'report.txt'], ['--help', '--output', 'report.json']]) {
    const result = run(args); assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.error.code, 'INVALID_PREFLIGHT_ARGUMENT');
    assert.equal(report.modelCalls, 0); assert.equal(report.game, 'not_run');
  }
});

test('tModLoader preflight CLI records missing real files as blocked and never overwrites a report', async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-tml-cli-'));
  try {
    const file = path.join(scratch, 'report.json');
    const args = ['--install-path', path.join(scratch, 'missing-install'), '--dotnet-path', path.join(scratch, 'missing-sdk', 'dotnet'), '--output', file];
    const result = run(args); assert.equal(result.status, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, 'blocked'); assert.equal(report.readyForProbeBuild, false);
    assert.equal(report.adapterImplemented, false); assert.equal(report.modelCalls, 0);
    assert.equal(report.realModBuild, 'not_run'); assert.equal(report.game, 'not_run');
    assert.equal(report.readyToInstall, false);
    assert.ok(report.issues.length >= 2);
    const original = await readFile(file, 'utf8'); assert.deepEqual(JSON.parse(original), report);
    const repeat = run(args); assert.equal(repeat.status, 2);
    assert.equal(JSON.parse(repeat.stdout).error.code, 'EEXIST');
    assert.equal(await readFile(file, 'utf8'), original);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
