import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TESTS = Object.freeze(['task-protocol', 'adapter-registry', 'run-store', 'scheduler', 'agent-provider', 'agent-runtime', 'run-service']);
const SCOPE = Object.freeze({ scope: 'converter-orchestration-sandbox-only', realModelCalls: 0, realModBuild: 'not_run', game: 'not_run', readyToInstall: false });

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new TypeError('Sandbox paths must be absolute without control characters.');
  return value;
}
function quote(value) { return JSON.stringify(absolute(value)); }

/** A verification profile, not a production runner for model-generated code. */
export function converterSandboxProfile({ root, writableRoot, policyRoot, credentialCanary }) {
  [root, writableRoot, policyRoot, credentialCanary].forEach(absolute);
  if (policyRoot === writableRoot || policyRoot.startsWith(writableRoot + path.sep)) throw new TypeError('Policy must be outside the child writable directory.');
  const protectedPaths = [path.join(root, '.env'), path.join(root, '.tools'), path.join(root, '.git'), path.join(root, '.gamebridge'), credentialCanary, policyRoot, '/Library/Keychains'];
  return ['(version 1)', '(deny default)', '(allow process*)', '(allow signal (target self) (target children))', '(allow sysctl-read)', '(allow file-read-metadata)',
    '(allow mach-lookup (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(allow file-read* (literal "/") (subpath ${quote(root)}) (subpath ${quote(writableRoot)}) (subpath "/usr") (subpath "/System") (subpath "/Library") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev"))`,
    `(allow file-write* (subpath ${quote(writableRoot)}))`,
    `(deny file-read* ${protectedPaths.map(item => `(subpath ${quote(item)})`).join(' ')})`,
    '(deny network*)', ''].join('\n');
}

/** Do not inherit the caller environment, Node options or any cloud/Git keys. */
export function converterSandboxEnvironment(tempRoot) {
  absolute(tempRoot);
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TMPDIR: tempRoot, TMP: tempRoot, TEMP: tempRoot };
}

async function executeSandbox(profile, args, { cwd, env, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0, overflow = false, timedOut = false, finished = false;
    function stop() { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ } }
    function finish(exitCode, signal, spawnError = false) {
      if (finished) return; finished = true; clearTimeout(timer); stop(); child.stdout.destroy(); child.stderr.destroy();
      resolve({ exitCode, signal, timedOut, overflow, spawnError, output: Buffer.concat(chunks).toString('utf8') });
    }
    const timer = setTimeout(() => { timedOut = true; stop(); finish(null, 'SIGKILL'); }, timeoutMs);
    function collect(chunk) { if (finished) return; bytes += chunk.length; if (bytes > 512 * 1024) { overflow = true; stop(); finish(null, 'SIGKILL'); } else chunks.push(chunk); }
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => finish(null, null, true)); child.once('close', finish);
  });
}

function runSummary(result) {
  const summary = { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, overflow: result.overflow, spawnError: result.spawnError };
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
    const match = result.output.match(new RegExp('^# ' + key + ' (\\d+)$', 'm')); if (match) summary[key] = Number(match[1]);
  }
  return summary;
}

const PROBE_SOURCE = String.raw`
import assert from 'node:assert/strict';
import { open, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
const config = JSON.parse(process.argv[1]), results = {};
const configuredNames = ['LANG','LC_ALL','PATH','TEMP','TMP','TMPDIR'];
const runtimeAdded = Object.keys(process.env).filter(name => !configuredNames.includes(name));
assert.ok(configuredNames.every(name => Object.hasOwn(process.env, name)));
assert.ok(runtimeAdded.every(name => name === '__CF_USER_TEXT_ENCODING'));
results.environmentAllowlist = true;
results.runtimeAddedEnvironment = runtimeAdded;
async function denied(name, work) {
  try { await work(); throw new Error('BOUNDARY_NOT_ENFORCED:' + name); }
  catch (error) { if (!['EPERM','EACCES'].includes(error.code)) throw error; results[name] = error.code; }
}
assert.ok((await readFile(config.sourceRead, 'utf8')).includes('validateTaskGraph'));
await writeFile(config.allowedWrite, 'sandbox-write-positive-control', { flag: 'wx' });
assert.equal(await readFile(config.allowedWrite, 'utf8'), 'sandbox-write-positive-control');
results.positiveReadAndWrite = true;
await denied('credentialCanaryRead', () => readFile(config.credentialCanary));
await denied('sourceWrite', () => writeFile(config.sourceWrite, 'must-not-be-created', { flag: 'wx' }));
await denied('policyWrite', async () => { const file = await open(config.policy, 'r+'); await file.close(); });
if (config.actualEnvExists) {
  // Opening alone verifies the rule without ever reading credential bytes,
  // even if a broken profile unexpectedly allows the descriptor.
  await denied('actualEnvOpen', async () => { const file = await open(config.actualEnv, 'r'); await file.close(); });
} else results.actualEnvOpen = 'not_run_missing_file';
function connect(host, port) { return new Promise((resolve, reject) => {
  const socket = net.createConnection({ host, port });
  socket.once('connect', () => { socket.destroy(); resolve(); });
  socket.once('error', reject); socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('NETWORK_PROBE_TIMEOUT')); });
}); }
await denied('loopbackTcpConnect', () => connect('127.0.0.1', config.port));
await denied('outboundTcpConnect', () => connect('203.0.113.1', 443));
console.log(JSON.stringify(results));
`;

export async function verifyConverterSandbox({ artifactRoot = path.join(ROOT, 'artifacts', 'converter-sandbox') } = {}) {
  absolute(artifactRoot);
  if (process.platform !== 'darwin') return { ...SCOPE, status: 'unavailable', reason: 'macOS sandbox-exec verification requires darwin; no simulation was substituted.' };
  await stat('/usr/bin/sandbox-exec');
  await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
  const output = await mkdtemp(path.join(await realpath(artifactRoot), 'run-'));
  const writableRoot = path.join(output, 'work'), tempRoot = path.join(writableRoot, 'tmp');
  const policyRoot = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-converter-sandbox-policy-'));
  const policy = path.join(policyRoot, 'verification.sb'), token = randomUUID();
  const credentialCanary = path.join(ROOT, '.env.sandbox-canary-' + token), sourceWrite = path.join(ROOT, 'src', '.sandbox-write-canary-' + token);
  const env = converterSandboxEnvironment(tempRoot);
  let server, socketCount = 0;
  try {
    await mkdir(tempRoot, { recursive: true, mode: 0o700 });
    await writeFile(credentialCanary, 'SYNTHETIC-TEST-CANARY-NOT-A-CREDENTIAL\n', { mode: 0o600, flag: 'wx' });
    const profile = converterSandboxProfile({ root: await realpath(ROOT), writableRoot, policyRoot: await realpath(policyRoot), credentialCanary });
    await writeFile(policy, profile, { mode: 0o600, flag: 'wx' });
    const initialPolicyHash = createHash('sha256').update(profile).digest('hex');
    server = net.createServer(socket => { socketCount++; socket.destroy(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const actualEnv = path.join(ROOT, '.env'), actualEnvExists = await stat(actualEnv).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    const config = { sourceRead: path.join(ROOT, 'src/orchestration/protocol.mjs'), sourceWrite, allowedWrite: path.join(writableRoot, 'positive-control.txt'), credentialCanary, policy, actualEnv, actualEnvExists, port: server.address().port };
    const probes = await executeSandbox(policy, ['--input-type=module', '-e', PROBE_SOURCE, JSON.stringify(config)], { cwd: ROOT, env, timeoutMs: 15000 });
    await writeFile(path.join(output, 'boundary-probes.log'), probes.output, { mode: 0o600 });
    const result = { ...SCOPE, status: 'failed', node: process.version, platform: process.platform, arch: process.arch,
      policyOutsideWritableRoot: true, environmentAllowlist: Object.keys(env), policySha256: initialPolicyHash,
      probes: runSummary(probes), fixtures: { status: 'not_run' }, artifactDirectory: path.relative(ROOT, output) };
    if (probes.exitCode === 0 && !probes.timedOut && !probes.overflow) {
      result.boundaries = JSON.parse(probes.output.trim());
      assert.equal(socketCount, 0, 'A denied network probe reached the parent server.');
      assert.equal(createHash('sha256').update(await readFile(policy)).digest('hex'), initialPolicyHash, 'Sandbox changed its policy.');
      assert.equal(await stat(sourceWrite).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; }), false, 'Sandbox wrote project source.');
      const fixtures = await executeSandbox(policy, ['--test', '--test-reporter=tap', ...TESTS.map(name => path.join(ROOT, 'tests', name + '.test.js'))], { cwd: ROOT, env, timeoutMs: 120000 });
      await writeFile(path.join(output, 'fixtures.tap'), fixtures.output, { mode: 0o600 });
      result.fixtures = { ...runSummary(fixtures), files: TESTS.map(name => 'tests/' + name + '.test.js') };
      if (fixtures.exitCode === 0 && result.fixtures.fail === 0 && result.fixtures.tests > 0 && !fixtures.timedOut && !fixtures.overflow) result.status = 'passed';
    }
    await writeFile(path.join(output, 'summary.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return result;
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await rm(policyRoot, { recursive: true, force: true });
    await rm(credentialCanary, { force: true });
    await rm(sourceWrite, { force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await verifyConverterSandbox(); console.log(JSON.stringify(result, null, 2)); if (result.status !== 'passed') process.exitCode = 1; }
  catch (error) { console.error(JSON.stringify({ ...SCOPE, status: 'failed', code: error.code || 'SANDBOX_VERIFICATION_FAILED', message: 'Sandbox verification did not complete. No model or game task was substituted.' })); process.exitCode = 1; }
}
