import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { runBuildProcess } from '../src/build/process.mjs';

test('trusted build process omits provider credentials and normalizes spawn errors', async () => {
  process.env.GAMEBRIDGE_PROCESS_TEST_SECRET = 'local-canary-not-a-credential';
  try {
    const result = await runBuildProcess(process.execPath, ['-e', 'process.stdout.write(process.env.GAMEBRIDGE_PROCESS_TEST_SECRET||"not-inherited")'], { cwd: os.tmpdir() });
    assert.equal(result.exitCode, 0); assert.equal(result.output, 'not-inherited');
  } finally { delete process.env.GAMEBRIDGE_PROCESS_TEST_SECRET; }
  const missing = await runBuildProcess('/gamebridge-not-an-installed-program', [], { cwd: os.tmpdir() });
  assert.equal(missing.spawnError, true); assert.equal(missing.exitCode, null);
});

test('trusted process output, cancellation and observation time stay bounded', async () => {
  const overflow = await runBuildProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000))'], { cwd: os.tmpdir(), maxOutputBytes: 100 });
  assert.equal(overflow.overflow, true); assert.ok(Buffer.byteLength(overflow.output) <= 100);
  const controller = new AbortController(); controller.abort();
  assert.equal((await runBuildProcess(process.execPath, [], { cwd: os.tmpdir(), signal: controller.signal })).cancelled, true);
  const started = Date.now();
  const timed = await runBuildProcess(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { cwd: os.tmpdir(), timeoutMs: 100 });
  assert.equal(timed.timedOut, true); assert.ok(Date.now() - started < 2000);
  await assert.rejects(runBuildProcess('relative-command', [], { cwd: os.tmpdir() }), TypeError);
});
