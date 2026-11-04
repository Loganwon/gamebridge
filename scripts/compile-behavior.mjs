import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { readBehaviorCompilationInput } from '../src/execution/input.mjs';
import { probeCSharpBackend } from '../src/execution/csharp-backend.mjs';
import { createBehaviorExecutionRuntime } from '../src/execution/runtime.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export async function compileBehaviorFile({ inputFile, root = path.join(ROOT, 'artifacts', 'behavior-compilation'),
  sdkRoot = path.join(ROOT, '.tools', 'dotnet8-x64'), signal } = {}) {
  // Known credentials are excluded from input/receipts and never passed to the SDK.
  const secrets = [process.env.DEEPSEEK_API_KEY, process.env.OPENAI_API_KEY, process.env.GH_TOKEN, process.env.GITHUB_TOKEN].filter(Boolean);
  const input = await readBehaviorCompilationInput(inputFile, { secrets });
  await mkdir(root, { recursive: true, mode: 0o700 }); root = await mkdtemp(path.join(root, 'attempt-'));
  const backend = await probeCSharpBackend({ sdkRoot, directory: path.join(root, 'sdk-probe'), actualEnv: path.join(ROOT, '.env'), signal });
  const runtime = await createBehaviorExecutionRuntime({ root: path.join(root, 'runtime'), backend, secrets });
  try {
    const created = await runtime.create(input), state = await runtime.run(created.id, { signal });
    await writeFile(path.join(root, 'run.json'), JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    const receipt = { scope: 'portable-behavior-execution-only', status: state.status, runId: state.id, artifactDirectory: path.relative(ROOT, root),
      tasks: state.tasks.map(task => ({ id: task.id, status: task.status, blockers: task.blockers, errors: task.attempts.filter(attempt => attempt.error).map(attempt => attempt.error) })),
      portableVerification: state.tasks.find(task => task.id === 'verify-behavior').result?.data.equivalence,
      realModelCalls: 0, realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
    await writeFile(path.join(root, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } finally { await runtime.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2) throw Object.assign(new Error(), { code: 'INPUT_FILE_REQUIRED' });
    const result = await compileBehaviorFile({ inputFile: path.resolve(args[0]), ...(args[1] ? { sdkRoot: path.resolve(args[1]) } : {}) });
    console.log(JSON.stringify(result, null, 2)); if (result.status !== 'succeeded') process.exitCode = 1;
  } catch (error) { console.error(JSON.stringify({ scope: 'portable-behavior-execution-only', status: 'failed',
    code: error.code || 'BEHAVIOR_COMPILATION_FAILED', message: 'Local behavior compilation did not complete; no game support or installation was recorded.',
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false })); process.exitCode = 1; }
}
