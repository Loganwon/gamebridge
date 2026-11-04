import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile, rm, open, lstat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';

function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function quoted(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_TOOL_PATH', 'Tool paths must be explicit absolute local paths.');
  return JSON.stringify(value);
}
export function compilerSandboxProfile({ sdkRoot, workRoot, policyRoot, protectedPaths = [] }) {
  [sdkRoot, workRoot, policyRoot, ...protectedPaths].forEach(quoted);
  if (workRoot === '/' || policyRoot === workRoot || policyRoot.startsWith(workRoot + path.sep)) fail('INVALID_TOOL_PATH', 'Compiler policy must remain outside its writable workspace.');
  return ['(version 1)', '(deny default)', '(allow process*)', '(allow signal (target self) (target children))',
    '(allow sysctl-read)', '(allow file-read-metadata)',
    '(allow mach-lookup (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read* (literal "/") (subpath ' + quoted(sdkRoot) + ') (subpath ' + quoted(workRoot) + ') (subpath "/usr") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev"))',
    '(allow file-write* (subpath ' + quoted(workRoot) + '))',
    '(deny file-read* ' + [policyRoot, '/Library/Keychains', ...protectedPaths].map(p => '(subpath ' + quoted(p) + ')').join(' ') + ')',
    '(deny network*)', ''].join('\n');
}
export function compilerEnvironment(workRoot, sdkRoot) {
  quoted(workRoot); quoted(sdkRoot);
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: workRoot, TMP: workRoot, TEMP: workRoot,
    DOTNET_ROOT: sdkRoot, DOTNET_CLI_HOME: workRoot, NUGET_PACKAGES: path.join(workRoot, '.packages'),
    DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1',
    DOTNET_MULTILEVEL_LOOKUP: '0', DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true', MSBuildEnableWorkloadResolver: 'false' };
}
export function validateCompilerRunOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
      Reflect.ownKeys(options).some(key => !['signal', 'timeoutMs'].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(options)).some(item => !Object.hasOwn(item, 'value')) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal)) ||
      (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 50 || options.timeoutMs > 180000))) fail('INVALID_TOOL_OPTIONS', 'Compiler environment and working directory are locally locked.');
  return { signal: options.signal, timeoutMs: options.timeoutMs };
}
async function runIsolated(policy, executable, args, { cwd, env, signal, timeoutMs = 90000 } = {}) {
  if (!Array.isArray(args) || args.length > 32 || args.some(x => typeof x !== 'string' || x.length > 16384 || x.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 180000) fail('INVALID_TOOL_OPTIONS', 'Invalid bounded compiler invocation.');
  const result = { exitCode: null, output: '', cancelled: false, timedOut: false, overflow: false, spawnError: false };
  if (signal?.aborted) return { ...result, cancelled: true };
  return new Promise(resolve => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false, count = 0; const chunks = [];
    function kill() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    function finish(code) {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      kill(); child.stdout.destroy(); child.stderr.destroy();
      result.exitCode = result.cancelled || result.timedOut || result.overflow ? null : code;
      result.output = Buffer.concat(chunks).toString('utf8'); resolve(result);
    }
    function cancel() { result.cancelled = true; finish(null); }
    const timer = setTimeout(() => { result.timedOut = true; finish(null); }, timeoutMs);
    function collect(chunk) { if (settled) return; count += chunk.length; if (count > 256 * 1024) { result.overflow = true; finish(null); } else chunks.push(chunk); }
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { result.spawnError = true; finish(null); }); child.once('close', finish);
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
  });
}
const BOUNDARIES = String.raw`
import assert from 'node:assert/strict';
import { open, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
const c=JSON.parse(process.argv[1]), out={};
assert.ok(!Object.keys(process.env).some(k=>/key|token|password|authorization|node_options|startup_hooks/i.test(k)));
async function denied(name,fn){try{await fn();throw new Error('BOUNDARY_NOT_ENFORCED');}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;out[name]=e.code;}}
await writeFile(c.positive,'bounded-write');assert.equal(await readFile(c.positive,'utf8'),'bounded-write');
await denied('credentialRead',()=>readFile(c.canary));
await denied('outsideWrite',()=>writeFile(c.outside,'denied',{flag:'wx'}));
await denied('policyWrite',async()=>{const f=await open(c.policy,'r+');await f.close();});
if(c.actualEnv)await denied('actualEnvOpen',async()=>{const f=await open(c.actualEnv,'r');await f.close();});
function connect(host,port){return new Promise((resolve,reject)=>{const s=net.createConnection({host,port});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);s.setTimeout(1500,()=>{s.destroy();reject(new Error('PROBE_TIMEOUT'));});});}
await denied('localNetwork',()=>connect('127.0.0.1',c.port));
await denied('externalNetwork',()=>connect('203.0.113.1',443));
console.log(JSON.stringify({environment:'credential-free',positiveReadWrite:true,...out}));
`;

/** Offline OS boundary for the locally generated behavior verification library.
 * No game loading or arbitrary model-authored code is admitted through this API.
 */
export async function createCompilerIsolation({ sdkRoot, workRoot, actualEnv, signal } = {}) {
  if (process.platform !== 'darwin') fail('COMPILER_ISOLATION_UNAVAILABLE', 'This verification backend requires the tested macOS OS sandbox.');
  if (actualEnv !== undefined) {
    quoted(actualEnv);
    const exists = await lstat(actualEnv).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (!exists) actualEnv = undefined;
  }
  sdkRoot = await realpath(sdkRoot); workRoot = await realpath(workRoot);
  const sdkStat = await lstat(path.join(sdkRoot, 'dotnet'));
  if (!sdkStat.isFile() || sdkStat.isSymbolicLink()) fail('SDK_IDENTITY_INVALID', 'A real, locally selected SDK executable is required.');
  const policyRoot = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-compiler-policy-'));
  const policy = path.join(policyRoot, 'compiler.sb'), canary = path.join(policyRoot, 'credential-canary');
  const outside = path.join(path.dirname(workRoot), '.deny-write-' + randomUUID());
  let server, opened = false;
  try {
    await writeFile(canary, 'SYNTHETIC-COMPILER-BOUNDARY-CANARY', { mode: 0o600 });
    const profile = compilerSandboxProfile({ sdkRoot, workRoot, policyRoot, protectedPaths: actualEnv ? [actualEnv] : [] });
    await writeFile(policy, profile, { mode: 0o600 });
    const env = compilerEnvironment(workRoot, sdkRoot);
    let connections = 0; server = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = { positive: path.join(workRoot, '.boundary-control'), canary, outside, policy, actualEnv,
      port: server.address().port };
    const probes = await runIsolated(policy, process.execPath, ['--input-type=module', '-e', BOUNDARIES, JSON.stringify(config)], { cwd: workRoot, env, signal, timeoutMs: 15000 });
    if (probes.exitCode !== 0 || connections !== 0) fail('COMPILER_BOUNDARY_FAILED', 'Compiler OS boundary controls did not pass. No compiler or generated library was run.');
    const boundaries = JSON.parse(probes.output);
    await new Promise(resolve => server.close(resolve)); server = null;
    opened = true;
    return {
      evidence: { scope: 'portable-behavior-tool-only', boundaries, policySha256: createHash('sha256').update(profile).digest('hex'),
        realModBuild: 'not_run', game: 'not_run', readyToInstall: false },
      runDotnet: (args, options = {}) => {
        return runIsolated(policy, path.join(sdkRoot, 'dotnet'), args, { cwd: workRoot, env, ...validateCompilerRunOptions(options) });
      },
      close: () => rm(policyRoot, { recursive: true, force: true }),
    };
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(outside, { force: true }); if (!opened) await rm(policyRoot, { recursive: true, force: true });
  }
}
