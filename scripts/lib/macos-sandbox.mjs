// Verification-only macOS Seatbelt wrapper. Not a VM or a production game host.
// No user credentials are inherited; model artifacts stay in an owned scratch dir.
import { realpath, mkdir, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCompilerProcess } from '../../src/build/runner.mjs';

const SYSTEM_READS = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/Library/Frameworks', '/Library/Preferences', '/private/etc', '/private/preboot', '/private/var/db', '/dev'];
const quote = value => JSON.stringify(value);
export async function createMacSandbox({ workDir, dotnetPath }) {
  if (process.platform !== 'darwin') throw new Error('OS_SANDBOX_UNAVAILABLE: this verification requires macOS sandbox-exec.');
  const root = await realpath(workDir), temporary = await realpath(os.tmpdir());
  if (path.dirname(root) !== temporary || !path.basename(root).startsWith('gamebridge-sandbox-')) throw new Error('Sandbox requires an owned gamebridge-sandbox-* scratch directory.');
  const dotnet = await realpath(dotnetPath), sdkRoot = path.dirname(dotnet), node = await realpath(process.execPath);
  if (path.basename(dotnet) !== 'dotnet' || sdkRoot === path.parse(sdkRoot).root) throw new Error('Invalid sandbox SDK location.');
  await mkdir(path.join(root, 'home')); await mkdir(path.join(root, 'tmp'));
  // SDK 10 can use its Roslyn apphost rather than `dotnet csc.dll`.
  // Add exact installed compiler paths, never arbitrary SDK-directory execution.
  const compilers = [];
  for (const version of (await readdir(path.join(sdkRoot, 'sdk'))).filter(name => /^\d+\.\d+\.\d+$/.test(name)).slice(0, 16)) {
    try { const compiler = await realpath(path.join(sdkRoot, 'sdk', version, 'Roslyn/bincore/csc')); if (compiler.startsWith(sdkRoot + path.sep)) compilers.push(compiler); } catch { /* SDK may use a hosted compiler. */ }
  }
  const executables = [node, dotnet, ...compilers];
  const profile = `(version 1)
(allow default)
(deny network*)
(deny file-read-data (require-all
  (require-not (literal "/"))
  (require-not (literal ${quote(node)}))
  ${[...SYSTEM_READS, sdkRoot, root].map(dir => `(require-not (subpath ${quote(dir)}))`).join('\n  ')}))
(deny file-write* (require-all (require-not (subpath ${quote(root)})) (require-not (literal "/dev/null"))))
(deny process-exec (require-all ${executables.map(file => `(require-not (literal ${quote(file)}))`).join(' ')}))
`;
  // Policy must stay outside the writable scratch. Otherwise one run could
  // overwrite it and weaken the next sandbox-exec invocation.
  const policyRoot = await realpath(await mkdtemp(path.join(temporary, 'gamebridge-sandbox-policy-')));
  const profilePath = path.join(policyRoot, 'sandbox.sb');
  try { await writeFile(profilePath, profile, { mode: 0o400 }); }
  catch (error) { await rm(policyRoot, { recursive: true, force: true }); throw error; }
  const env = {
    PATH: '/usr/bin:/bin', HOME: path.join(root, 'home'), USERPROFILE: path.join(root, 'home'),
    TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
    DOTNET_ROOT: sdkRoot, DOTNET_CLI_HOME: path.join(root, 'home'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', MSBUILDDISABLENODEREUSE: '1',
    DOTNET_EnableDiagnostics: '0', COMPlus_EnableDiagnostics: '0', DOTNET_PROCESSOR_COUNT: '2',
    NUGET_PACKAGES: path.join(root, 'home', 'nuget'), LANG: 'C', LC_ALL: 'C',
  };
  return {
    root, dotnet, node, profilePath,
    isolation: { provider: 'macOS Seatbelt sandbox-exec', network: 'deny', fileDataReads: 'system-sdk-and-scratch-only', fileWrites: 'scratch-and-dev-null-only', executables: 'node-dotnet-and-exact-sdk-csc-only', credentials: 'not-inherited', policyFile: 'outside-writable-scratch', vm: false },
    async run(command, args, { timeoutMs = 60000, maxOutputBytes = 64 * 1024, signal } = {}) {
      if (![node, dotnet].includes(await realpath(command))) throw new Error('Sandbox command is not a trusted Node or dotnet executable.');
      return runCompilerProcess('/usr/bin/sandbox-exec', ['-f', profilePath, command, ...args], { cwd: root, env, timeoutMs, maxOutputBytes, signal });
    },
    async close() { await rm(policyRoot, { recursive: true, force: true }); },
  };
}
