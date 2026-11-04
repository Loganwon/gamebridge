import assert from 'node:assert/strict';
import path from 'node:path';
import { appendFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';
import { probeCSharpBackend } from '../src/execution/csharp-backend.mjs';
import { createBehaviorExecutionRuntime } from '../src/execution/runtime.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCOPE = Object.freeze({ scope: 'controlled-csharp-fault-only', realModelCalls: 0, realModBuild: 'not_run', game: 'not_run', readyToInstall: false });
// Deliberate project-owned syntax failure in a disposable materialized source.
// No model text, SDK files or admitted source artifacts are changed.
const CONTROLLED_FAULT = '\nnamespace GameBridge.ControlledCompilerFault { public sealed class ExpectedSyntaxFailure { public int Broken = ; } }\n';

/** One real compiler call verifies diagnostic retention and downstream blocking.
 * It never retries, repairs, loads the generated DLL or runs a game.
 */
export async function verifyCompilerDiagnostics({ root = path.join(ROOT, 'artifacts', 'compiler-diagnostics'),
  sdkRoot = path.join(ROOT, '.tools', 'dotnet8-x64') } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || /[\x00-\x1f\x7f]/.test(root)) throw new TypeError('An absolute private diagnostic output directory is required.');
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await mkdtemp(path.join(root, 'attempt-'));
  let runtime, compileCalls = 0, executeVerificationCalls = 0;
  const summary = { ...SCOPE, status: 'failed', artifactDirectory: path.relative(ROOT, root),
    controlledFault: 'project-owned-csharp-syntax-error', automaticRetries: 0 };
  const saveSummary = () => writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  try {
    const backend = await probeCSharpBackend({ sdkRoot, directory: path.join(root, 'sdk-probe'), actualEnv: path.join(ROOT, '.env') });
    summary.sdk = backend.evidence;
    const controlled = {
      identity: backend.identity, targetFramework: backend.targetFramework, evidence: backend.evidence,
      async compile(directory, options) {
        compileCalls++;
        if (compileCalls !== 1) throw Object.assign(new Error('Controlled diagnostic verification forbids compiler retries.'), { code: 'DIAGNOSTIC_CALL_LIMIT' });
        await appendFile(path.join(directory, 'Behavior.cs'), CONTROLLED_FAULT, 'utf8');
        return backend.compile(directory, options);
      },
      async executeVerification(directory, options) { executeVerificationCalls++; return backend.executeVerification(directory, options); },
    };
    runtime = await createBehaviorExecutionRuntime({ root: path.join(root, 'runtime'), backend: controlled });
    const fixture = createBehaviorVerificationCases()[0];
    const created = await runtime.create({ spec: fixture.spec, requirementIds: fixture.spec.requirementIds, steps: fixture.steps });
    const state = await runtime.run(created.id);
    await writeFile(path.join(root, 'run.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const compilation = state.tasks.find(task => task.id === 'compile-library'), verification = state.tasks.find(task => task.id === 'verify-behavior');
    const error = compilation?.attempts.at(-1)?.error;
    Object.assign(summary, { runId: state.id, runStatus: state.status, compileCalls, executeVerificationCalls,
      budget: state.budget, report: state.report,
      tasks: state.tasks.map(task => ({ id: task.id, status: task.status, attemptCount: task.attemptCount, blockers: task.blockers,
        errors: task.attempts.filter(attempt => attempt.error).map(attempt => attempt.error) })),
      failureArtifact: error?.failureArtifact });
    // Preserve the entire observed failure before checking its expected category.
    await saveSummary();
    assert.equal(compileCalls, 1); assert.equal(executeVerificationCalls, 0);
    assert.equal(state.status, 'failed'); assert.equal(state.budget.modelCallsReserved, 0);
    assert.equal(compilation?.status, 'failed'); assert.equal(compilation?.attemptCount, 1);
    assert.equal(error?.code, 'PORTABLE_COMPILE_FAILED'); assert.ok(error?.failureArtifact);
    assert.equal(verification?.status, 'blocked'); assert.equal(verification?.attemptCount, 0);
    assert.ok(verification.blockers.includes('DEPENDENCY_NOT_SUCCEEDED'));
    const output = await runtime.artifacts.readFile(error.failureArtifact, 'tool-output.txt');
    await writeFile(path.join(root, 'tool-output.txt'), output, { mode: 0o600 });
    const text = output.toString('utf8'), diagnosticCodes = [...new Set([...text.matchAll(/\berror (CS\d+)\b/g)].map(match => match[1]))];
    const errorLines = text.split(/\r?\n/).filter(line => /\berror\s*(?::|[A-Z])/i.test(line));
    summary.diagnosticCodes = diagnosticCodes;
    summary.diagnosticBytes = output.byteLength;
    summary.errorLinesAreCSharpDiagnostics = errorLines.length > 0 && errorLines.every(line => /\berror CS\d+\b/.test(line));
    await saveSummary();
    assert.ok(diagnosticCodes.length > 0, 'The retained output must contain real C# compiler diagnostics.');
    assert.ok(summary.errorLinesAreCSharpDiagnostics, 'Infrastructure failures must not substitute for the controlled C# error.');
    summary.status = 'passed'; summary.expectedFailureObserved = true;
    await saveSummary();
    return summary;
  } catch (error) {
    Object.assign(summary, { status: 'failed', compileCalls, executeVerificationCalls, code: error.code || 'COMPILER_DIAGNOSTIC_VERIFICATION_FAILED' });
    await saveSummary();
    error.artifactDirectory = summary.artifactDirectory;
    throw error;
  } finally { await runtime?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyCompilerDiagnostics(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ ...SCOPE, status: 'failed', code: error.code || 'COMPILER_DIAGNOSTIC_VERIFICATION_FAILED',
    artifactDirectory: error.artifactDirectory, message: 'Controlled C# diagnostic verification did not pass; no compiler retry or repair was started.' })); process.exitCode = 1; }
}
