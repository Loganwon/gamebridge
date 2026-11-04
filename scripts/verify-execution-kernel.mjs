import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createBehaviorVerificationCases } from '../src/behavior/verification-fixtures.mjs';
import { probeCSharpBackend } from '../src/execution/csharp-backend.mjs';
import { createBehaviorExecutionRuntime } from '../src/execution/runtime.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
/** No model calls or real game references. This compiles project-owned behavior
 * specifications through the actual admitted local SDK and tests the DLL in an
 * OS sandbox. It is not Mod compilation or a game acceptance test.
 */
export async function verifyExecutionKernel({ root = path.join(ROOT, 'artifacts', 'execution-kernel'),
  sdkRoot = path.join(ROOT, '.tools', 'dotnet8-x64') } = {}) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  root = await mkdtemp(path.join(root, 'attempt-'));
  const backend = await probeCSharpBackend({ sdkRoot, directory: path.join(root, 'sdk-probe'), actualEnv: path.join(ROOT, '.env') });
  const runtimeRoot = path.join(root, 'runtime'), runtime = await createBehaviorExecutionRuntime({ root: runtimeRoot, backend });
  const summary = { scope: 'portable-behavior-execution-only', sdk: backend.evidence, realModelCalls: 0,
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false, artifactDirectory: path.relative(ROOT, root), cases: [] };
  try {
    for (const fixture of createBehaviorVerificationCases()) {
      const created = await runtime.create({ spec: fixture.spec, requirementIds: fixture.spec.requirementIds, steps: fixture.steps });
      const state = await runtime.run(created.id);
      await writeFile(path.join(root, fixture.id + '.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
      const verification = state.tasks.find(task => task.id === 'verify-behavior').result?.data;
      const sourceProject = state.tasks.find(task => task.id === 'lower-project').result?.data.project;
      const sourceManifest = sourceProject ? await runtime.artifacts.getManifest(sourceProject) : null;
      const assemblyManifest = verification ? await runtime.artifacts.getManifest(verification.assembly) : null;
      summary.cases.push({ id: fixture.id, runId: state.id, status: state.status, budget: state.budget, tasks: state.tasks.map(task => ({
        id: task.id, status: task.status, errors: task.attempts.filter(attempt => attempt.error).map(attempt => attempt.error), blockers: task.blockers,
      })), equivalence: verification?.equivalence, assembly: verification?.assembly,
      sourceSha256: sourceManifest?.files.find(file => file.path === 'Behavior.cs')?.sha256,
      dllSha256: assemblyManifest?.files.find(file => file.path === 'compiled/GameBridge.BehaviorKernelVerification.dll')?.sha256 });
      // Persist failures too, before asserting or starting another case.
      await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
      if (state.status !== 'succeeded') {
        for (const task of state.tasks) for (const attempt of task.attempts) if (attempt.error?.failureArtifact) {
          await writeFile(path.join(root, fixture.id + '-diagnostic.txt'), await runtime.artifacts.readFile(attempt.error.failureArtifact, 'tool-output.txt'), { mode: 0o600 });
        }
        throw Object.assign(new Error('Portable execution verification stopped at ' + fixture.id), { code: 'EXECUTION_VERIFICATION_FAILED', artifactDirectory: path.relative(ROOT, root) });
      }
      const resumed = await runtime.resume(created.id, { allowReplay: false });
      assert.deepEqual(resumed.tasks, state.tasks); assert.equal(resumed.budget.modelCallsReserved, 0);
    }
  } finally { await runtime.close(); }
  const observer = await createBehaviorExecutionRuntime({ root: runtimeRoot });
  try {
    for (const item of summary.cases) {
      const reopened = await observer.get(item.runId);
      assert.equal(reopened.status, 'succeeded'); assert.equal(reopened.budget.modelCallsReserved, 0);
    }
    summary.readAfterRestart = 'passed';
  } finally { await observer.close(); }
  summary.totalSteps = summary.cases.reduce((n, item) => n + item.equivalence.steps, 0);
  summary.rejectedSteps = summary.cases.reduce((n, item) => n + item.equivalence.rejected, 0);
  summary.distinctGeneratedSources = new Set(summary.cases.map(item => item.sourceSha256)).size;
  summary.distinctCompiledLibraries = new Set(summary.cases.map(item => item.dllSha256)).size;
  assert.equal(summary.distinctGeneratedSources, 4); assert.equal(summary.distinctCompiledLibraries, 4);
  summary.status = 'passed';
  await writeFile(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 });
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await verifyExecutionKernel(), null, 2)); }
  catch (error) { console.error(JSON.stringify({ scope: 'portable-behavior-execution-only', status: 'failed',
    code: error.code || 'EXECUTION_VERIFICATION_FAILED', message: error.message, artifactDirectory: error.artifactDirectory,
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false })); process.exitCode = 1; }
}
