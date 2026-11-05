import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createGuiHostInvocation } from './gui-launch.mjs';

const MAX_OUTPUT = 256 * 1024, MAX_EXECUTABLE = 512 * 1024 * 1024;
const GUI_SERVICES = Object.freeze(['com.apple.windowserver.active', 'com.apple.windowserver',
  // Observed native SDL/OpenGL service lookups, not arbitrary GUI IPC access.
  // No preference-userdata, POSIX shared-memory, file or network grant follows.
  'com.apple.CARenderServer', 'com.apple.cvmsServ', 'com.apple.windowmanager.server', 'com.apple.dock.server',
  // Native AppKit registration/window bridge endpoints observed in launch logs.
  // This does not grant Apple Events automation/TCC consent to another app.
  'com.apple.CoreServices.coreservicesd', 'com.apple.coreservices.appleevents', 'com.apple.window_proxies', 'com.apple.ViewBridgeAuxiliary',
  // Native accessibility authorization queries. This grants no TCC consent
  // and does not permit edits to system privacy databases or another app.
  'com.apple.tccd', 'com.apple.tccd.system',
  'com.apple.cfprefsd.daemon', 'com.apple.cfprefsd.agent', 'com.apple.FontObjectsServer',
  'com.apple.fonts', 'com.apple.system.notification_center', 'com.apple.system.opendirectoryd.libinfo',
  'com.apple.lsd.mapdb', 'com.apple.coreservices.launchservicesd', 'com.apple.hiservices-xpcservice']);
function fail(code, message, extra = {}) { throw Object.assign(new Error(message), { code, ...extra }); }
function plain(value, fields, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !Object.hasOwn(item, 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) fail('INVALID_HOST_PROBE_OPTIONS', 'Host probe options must contain only declared local data fields.');
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_HOST_PROBE_PATH', 'Host probe paths must be bounded explicit absolute paths.');
  return path.resolve(value);
}
function inside(root, candidate) { return candidate === root || candidate.startsWith(root + path.sep); }
function quoted(value) { return JSON.stringify(absolute(value)); }
function dense(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum ||
      Reflect.ownKeys(value).length !== value.length + 1 || Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value')) ||
      Array.from({ length: value.length }, (_, i) => !Object.hasOwn(value, i)).some(Boolean)) fail('INVALID_HOST_PROBE_OPTIONS', 'Probe lists must be dense, plain and bounded.');
  return value;
}
function checkSignal(signal) { if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_HOST_PROBE_OPTIONS', 'Probe cancellation requires an AbortSignal.'); }
function cancelled(signal) { if (signal?.aborted) fail('HOST_PROBE_CANCELLED', 'Host probe was cancelled before dispatch.'); }

export function hostProbeSandboxProfile(raw) {
  plain(raw, ['appRoot', 'workRoot', 'policyRoot', 'protectedPaths'], ['appRoot', 'workRoot', 'policyRoot']);
  const appRoot = absolute(raw.appRoot), workRoot = absolute(raw.workRoot), policyRoot = absolute(raw.policyRoot);
  const protectedPaths = dense(raw.protectedPaths ?? [], 16).map(absolute);
  if (!appRoot.endsWith('.app') || [appRoot, workRoot, policyRoot].includes('/') || inside(workRoot, policyRoot) || inside(workRoot, appRoot) || inside(appRoot, workRoot)) fail('INVALID_HOST_PROBE_PATH', 'A dedicated application bundle and policy must remain outside the writable probe directory.');
  return ['(version 1)', '(deny default)', '(allow process*)', '(allow signal (target self) (target children))',
    '(allow sysctl-read)', '(allow file-read-metadata)',
    // Per-process native GUI services; not global service registration.
    '(allow mach-register (local-name "com.apple.axserver") (local-name "com.apple.tsm.portname") (local-name "com.apple.coredrag"))',
    '(allow ipc-posix-shm-read* (ipc-posix-name "apple.shm.notification_center"))',
    // Exact render/presentation clients observed denied by the native game.
    // No general IOKit, HID, display capture or framebuffer grant.
    '(allow iokit-open-user-client (iokit-user-client-class "IOSurfaceRootUserClient" "AGXDeviceUserClient" "IOGPUGLDrawableUserClient" "IOGPUSurfaceMTL"))',
    '(allow mach-lookup ' + GUI_SERVICES.map(name => '(global-name ' + JSON.stringify(name) + ')').join(' ') + ')',
    '(allow mach-lookup (xpc-service-name "com.apple.MTLCompilerService"))',
    '(allow file-read* (literal "/") (subpath ' + quoted(appRoot) + ') (subpath ' + quoted(workRoot) + ') (subpath "/usr") (subpath "/System") (subpath "/Library/Fonts") (subpath "/Library/ColorSync") (subpath "/Library/Apple/usr/libexec/oah") (subpath "/private/etc") (subpath "/private/var/db") (subpath "/dev"))',
    '(allow file-write* (subpath ' + quoted(workRoot) + '))',
    '(deny file-read* ' + [policyRoot, '/Library/Keychains', path.join(os.homedir(), 'Library/Keychains'), ...protectedPaths].map(file => '(subpath ' + quoted(file) + ')').join(' ') + ')',
    '(deny network*)', ''].join('\n');
}
export function hostProbeEnvironment(workRoot) {
  workRoot = absolute(workRoot);
  return { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: workRoot,
    SDL_MAC_BACKGROUND_APP: '0', SDL_RENDER_DRIVER: 'software',
    TMPDIR: workRoot, TMP: workRoot, TEMP: workRoot,
    XDG_CONFIG_HOME: workRoot, XDG_DATA_HOME: workRoot, XDG_CACHE_HOME: workRoot };
}
export function validateHostProbeRunOptions(raw = {}) {
  plain(raw, ['signal', 'timeoutMs']); checkSignal(raw.signal);
  const timeoutMs = raw.timeoutMs ?? 90000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > 180000) fail('INVALID_HOST_PROBE_OPTIONS', 'Host probe timeout must be between 50 and 180000 milliseconds.');
  return { signal: raw.signal, timeoutMs };
}
export function validateHostProbeArguments(raw) {
  const args = dense(raw, 32);
  if (args.some(item => typeof item !== 'string' || item.length > 4096 || /[\x00-\x1f\x7f]/.test(item)) ||
      args.reduce((total, item) => total + Buffer.byteLength(item), 0) > 16384) fail('INVALID_HOST_PROBE_OPTIONS', 'Host arguments must be bounded local strings.');
  return [...args];
}
function identity(info) { return { dev: info.dev, ino: info.ino }; }
function sameIdentity(info, expected) { return info.dev === expected.dev && info.ino === expected.ino; }
async function realDirectory(raw, { privateOnly = false } = {}) {
  const file = absolute(raw), info = await lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink() || (privateOnly && (info.mode & 0o077))) fail('INVALID_HOST_PROBE_PATH', 'Probe directories must be real; the writable directory must be private.');
  return { path: await realpath(file), ...identity(info) };
}
async function executableFingerprint(appRoot, executable, signal) {
  cancelled(signal);
  if (!inside(appRoot, executable) || executable === appRoot) fail('INVALID_HOST_PROBE_EXECUTABLE', 'The fixed host executable must be inside its application directory.');
  let cursor = appRoot;
  for (const segment of path.relative(appRoot, executable).split(path.sep)) {
    cursor = path.join(cursor, segment); const info = await lstat(cursor);
    if (info.isSymbolicLink()) fail('INVALID_HOST_PROBE_EXECUTABLE', 'Host executable paths cannot traverse symbolic links.');
  }
  const before = await lstat(executable);
  if (!before.isFile() || before.nlink !== 1 || !(before.mode & 0o111) || before.size < 1 || before.size > MAX_EXECUTABLE) fail('INVALID_HOST_PROBE_EXECUTABLE', 'Host executable must be an ordinary bounded executable file.');
  const file = await open(executable, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await file.stat();
    if (!sameIdentity(opened, before) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail('HOST_PROBE_IDENTITY_CHANGED', 'Host executable identity changed.');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let at = 0;
    while (at < opened.size) {
      cancelled(signal); const next = await file.read(buffer, 0, Math.min(buffer.length, opened.size - at), at);
      if (!next.bytesRead) fail('HOST_PROBE_IDENTITY_CHANGED', 'Host executable was truncated.');
      digest.update(buffer.subarray(0, next.bytesRead)); at += next.bytesRead;
    }
    const after = await file.stat();
    if (!sameIdentity(after, opened) || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail('HOST_PROBE_IDENTITY_CHANGED', 'Host executable changed during hashing.');
    return { sha256: digest.digest('hex'), ...identity(after), bytes: after.size, mtimeMs: after.mtimeMs };
  } finally { await file.close(); }
}
async function bundleMetadata(appRoot, signal) {
  cancelled(signal);
  const file = path.join(appRoot, 'Contents/Info.plist'), before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 65536) fail('INVALID_HOST_PROBE_BUNDLE', 'A bounded ordinary bundle metadata file is required.');
  const opened = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await opened.stat();
    if (!sameIdentity(info, before) || info.size !== before.size || info.mtimeMs !== before.mtimeMs) fail('HOST_PROBE_IDENTITY_CHANGED', 'Bundle metadata changed.');
    const bytes = Buffer.alloc(info.size); let at = 0;
    while (at < bytes.length) { cancelled(signal); const next = await opened.read(bytes, at, bytes.length-at, at); if (!next.bytesRead) fail('HOST_PROBE_IDENTITY_CHANGED', 'Bundle metadata was truncated.'); at += next.bytesRead; }
    const xml = bytes.toString('utf8'), matches = [...xml.matchAll(/<key>CFBundleIdentifier<\/key>\s*<string>([A-Za-z0-9][A-Za-z0-9.-]{2,127})<\/string>/g)];
    const names = [...xml.matchAll(/<key>CFBundleExecutable<\/key>\s*<string>([A-Za-z0-9._-]{1,80})<\/string>/g)];
    if (!Buffer.from(xml).equals(bytes) || matches.length !== 1 || names.length !== 1 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(matches[0][1])) fail('INVALID_HOST_PROBE_BUNDLE', 'This backend requires explicit XML bundle identity fields.');
    const after = await opened.stat(), named = await lstat(file);
    if (!sameIdentity(after, info) || after.size !== info.size || after.mtimeMs !== info.mtimeMs || !sameIdentity(named, info) || named.isSymbolicLink()) fail('HOST_PROBE_IDENTITY_CHANGED', 'Bundle metadata changed.');
    cancelled(signal); return { identifier: matches[0][1], executableName: names[0][1], sha256: createHash('sha256').update(bytes).digest('hex'), ...identity(info), bytes: info.size, mtimeMs: info.mtimeMs };
  } finally { await opened.close(); }
}
const emptyResult = () => ({ exitCode: null, output: '', cancelled: false, timedOut: false, overflow: false, spawnError: false, termSignal: null });
function runIsolated(policy, executable, args, { cwd, env, signal, timeoutMs }) {
  if (signal.aborted) return Promise.resolve({ ...emptyResult(), cancelled: true });
  return new Promise(resolve => {
    const result = emptyResult(), chunks = []; let bytes = 0, settled = false, force;
    const child = spawn('/usr/bin/sandbox-exec', ['-f', policy, executable, ...args], { cwd, env, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    function kill() { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* Already stopped. */ } }
    function finish(code, termSignal) {
      if (settled) return; settled = true; clearTimeout(timer); clearTimeout(force); signal.removeEventListener('abort', cancel);
      kill(); child.stdout.destroy(); child.stderr.destroy();
      result.exitCode = result.cancelled || result.timedOut || result.overflow ? null : code;
      result.termSignal = termSignal ?? null; result.output = Buffer.concat(chunks).toString('utf8'); resolve(result);
    }
    function stop() { kill(); force ??= setTimeout(() => finish(null, 'SIGKILL'), 750); }
    function cancel() { result.cancelled = true; stop(); }
    const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
    function collect(chunk) {
      if (settled) return;
      const remaining = MAX_OUTPUT - bytes; if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining) { result.overflow = true; stop(); }
    }
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    child.once('error', () => { result.spawnError = true; finish(null, null); }); child.once('close', finish);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
const BOUNDARIES = String.raw`
import assert from 'node:assert/strict';
import { open, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
const c=JSON.parse(process.argv[1]),out={};
assert.ok(!Object.keys(process.env).some(k=>/key|token|password|authorization|node_options|startup_hooks/i.test(k)));
async function denied(name,fn){try{await fn();throw new Error('BOUNDARY_NOT_ENFORCED');}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e;out[name]=e.code;}}
await writeFile(c.positive,'bounded-write');assert.equal(await readFile(c.positive,'utf8'),'bounded-write');
const app=await open(c.executable,'r');try{assert.equal((await app.read(Buffer.alloc(1),0,1,0)).bytesRead,1);}finally{await app.close();}
await denied('credentialRead',()=>readFile(c.canary));
await denied('outsideWrite',()=>writeFile(c.outside,'denied',{flag:'wx'}));
await denied('policyWrite',async()=>{const f=await open(c.policy,'r+');await f.close();});
if(c.actualEnv)await denied('actualEnvOpen',async()=>{const f=await open(c.actualEnv,'r');await f.close();});
function connect(host,port){return new Promise((resolve,reject)=>{const s=net.createConnection({host,port});s.once('connect',()=>{s.destroy();resolve();});s.once('error',reject);s.setTimeout(1500,()=>{s.destroy();reject(new Error('PROBE_TIMEOUT'));});});}
await denied('localNetwork',()=>connect('127.0.0.1',c.port));
await denied('externalNetwork',()=>connect('203.0.113.1',443));
console.log(JSON.stringify({environment:'credential-free',positiveReadWrite:true,applicationRead:true,...out}));
`;

/** Mac-only boundary for a locally selected trusted official host and this
 * project's own probes. This is not an arbitrary/model-source execution API.
 * GUI IPC is limited to the named services above; file/network boundaries never
 * widen on launch failure. Process-group cleanup cannot guarantee containment of
 * escaped descendants, and observed hashes are not atomic/supply-chain proofs.
 */
export async function createHostProbeIsolation(raw = {}) {
  plain(raw, ['appRoot', 'workRoot', 'executable', 'actualEnv', 'signal'], ['appRoot', 'workRoot', 'executable']);
  checkSignal(raw.signal); cancelled(raw.signal);
  if (process.platform !== 'darwin') fail('HOST_PROBE_ISOLATION_UNAVAILABLE', 'Host probes require the tested macOS OS sandbox.');
  // Snapshot local options before asynchronous identity binding.
  const selected = { appRoot: absolute(raw.appRoot), workRoot: absolute(raw.workRoot), executable: absolute(raw.executable),
    actualEnv: raw.actualEnv === undefined ? undefined : absolute(raw.actualEnv), signal: raw.signal };
  const lifecycle = new AbortController(), pending = new Set(); let closed = false, opened = false, server, policyRoot, closePromise;
  function abortAll() { lifecycle.abort(); for (const item of pending) item.controller.abort(); }
  selected.signal?.addEventListener('abort', abortAll, { once: true }); if (selected.signal?.aborted) abortAll();
  try {
    const app = await realDirectory(selected.appRoot), work = await realDirectory(selected.workRoot, { privateOnly: true });
    if (!app.path.endsWith('.app') || inside(app.path, work.path) || inside(work.path, app.path) || app.path === '/' || work.path === '/') fail('INVALID_HOST_PROBE_PATH', 'Probe writes must remain outside a dedicated application bundle.');
    const executable = path.join(app.path, path.relative(selected.appRoot, selected.executable));
    const fingerprint = await executableFingerprint(app.path, executable, lifecycle.signal);
    const metadata = await bundleMetadata(app.path, lifecycle.signal);
    const protectedPaths = []; let actualEnv;
    if (selected.actualEnv) {
      const info = await lstat(selected.actualEnv).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (info) { actualEnv = await realpath(selected.actualEnv); protectedPaths.push(selected.actualEnv, actualEnv); }
    }
    cancelled(lifecycle.signal);
    policyRoot = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-host-policy-'));
    policyRoot = await realpath(policyRoot);
    const policy = path.join(policyRoot, 'host.sb'), canary = path.join(policyRoot, 'credential-canary');
    const outside = path.join(path.dirname(work.path), '.deny-host-write-' + randomUUID());
    const profile = hostProbeSandboxProfile({ appRoot: app.path, workRoot: work.path, policyRoot, protectedPaths: [...new Set(protectedPaths)] });
    await writeFile(canary, 'SYNTHETIC-HOST-BOUNDARY-CANARY', { mode: 0o600 });
    await writeFile(policy, profile, { mode: 0o600 });
    const env = hostProbeEnvironment(work.path); let connections = 0;
    server = net.createServer(socket => { connections++; socket.destroy(); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const config = { executable, positive: path.join(work.path, '.host-boundary-control'), canary, outside, policy, actualEnv, port: server.address().port };
    const probes = await runIsolated(policy, process.execPath, ['--input-type=module', '-e', BOUNDARIES, JSON.stringify(config)], { cwd: work.path, env, signal: lifecycle.signal, timeoutMs: 15000 });
    await rm(outside, { force: true });
    if (probes.cancelled || lifecycle.signal.aborted) fail('HOST_PROBE_CANCELLED', 'Host boundary probing was cancelled.');
    if (probes.exitCode !== 0 || connections !== 0) fail('HOST_PROBE_BOUNDARY_FAILED', 'Host OS boundary controls did not pass. The host was not run.', { boundaryDiagnostic: probes });
    let boundaries; try { boundaries = JSON.parse(probes.output); } catch { fail('HOST_PROBE_BOUNDARY_FAILED', 'Host boundary controls returned invalid evidence.', { boundaryDiagnostic: probes }); }
    await new Promise(resolve => server.close(resolve)); server = undefined; cancelled(lifecycle.signal);
    async function verifyBinding(signal) {
      cancelled(signal);
      for (const entry of [app, work]) {
        const info = await lstat(entry.path);
        if (!info.isDirectory() || info.isSymbolicLink() || !sameIdentity(info, entry)) fail('HOST_PROBE_IDENTITY_CHANGED', 'A bound host directory changed.');
      }
      const current = await executableFingerprint(app.path, executable, signal);
      if (JSON.stringify(current) !== JSON.stringify(fingerprint)) fail('HOST_PROBE_IDENTITY_CHANGED', 'The pinned host executable changed.');
      if (JSON.stringify(await bundleMetadata(app.path, signal)) !== JSON.stringify(metadata)) fail('HOST_PROBE_IDENTITY_CHANGED', 'The pinned bundle metadata changed.');
      cancelled(signal);
    }
    const evidence = Object.freeze({ scope: 'trusted-official-host-probe-only', platform: process.platform, boundaries: Object.freeze(boundaries),
      executableSha256: fingerprint.sha256, policySha256: createHash('sha256').update(profile).digest('hex'),
      bundleIdentifier: metadata.identifier, infoPlistSha256: metadata.sha256,
      guiMachLookup: 'explicit-service-list', arbitraryModelSourceAllowed: false, realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false });
    opened = true;
    return {
      evidence,
      async prepareGuiRun(rawArgs, rawOptions = {}) {
        if (closed) fail('HOST_PROBE_CLOSED', 'Host isolation is closed.');
        const args = validateHostProbeArguments(rawArgs), options = validateHostProbeRunOptions(rawOptions), controller = new AbortController();
        const item = { controller, done: null }; pending.add(item);
        const onAbort = () => controller.abort(); options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted || lifecycle.signal.aborted) controller.abort();
        const preparation = (async () => {
          await verifyBinding(controller.signal); if (closed) controller.abort(); cancelled(controller.signal);
          return createGuiHostInvocation({ policyFile: policy, policyRoot, executable, args, cwd: work.path, env, bundleIdentifier: metadata.identifier,
            ...(actualEnv ? { actualEnv } : {}), policySha256: evidence.policySha256,
            ...(['GameBridgeHostInvocation', 'GameBridgeHostEntry'].includes(metadata.executableName) ? { launchAppPath: app.path } : {}),
            signal: controller.signal, timeoutMs: options.timeoutMs, verifyBinding: () => verifyBinding(controller.signal) });
        })();
        item.done = preparation.then(invocation => invocation.completion).finally(() => {
          options.signal?.removeEventListener('abort', onAbort); pending.delete(item);
        });
        // Keep a preparation rejection observed while the caller awaits it.
        item.done.catch(() => {});
        const invocation = await preparation;
        if (closed || controller.signal.aborted) { await invocation.close(); cancelled(controller.signal); }
        return { appPath: invocation.appPath, completion: item.done, provenance: invocation.provenance, captureDiagnostics: invocation.captureDiagnostics };
      },
      async run(rawArgs, rawOptions = {}) {
        if (closed) fail('HOST_PROBE_CLOSED', 'Host isolation is closed.');
        const args = validateHostProbeArguments(rawArgs), options = validateHostProbeRunOptions(rawOptions), controller = new AbortController();
        const item = { controller, done: null }; pending.add(item);
        const onAbort = () => controller.abort(); options.signal?.addEventListener('abort', onAbort, { once: true });
        if (options.signal?.aborted || lifecycle.signal.aborted) controller.abort();
        item.done = (async () => {
          try {
            await verifyBinding(controller.signal); if (closed) controller.abort(); cancelled(controller.signal);
            const result = await runIsolated(policy, executable, args, { cwd: work.path, env, signal: controller.signal, timeoutMs: options.timeoutMs });
            if (!result.cancelled) await verifyBinding(controller.signal);
            return result;
          } catch (error) { if (error.code === 'HOST_PROBE_CANCELLED') return { ...emptyResult(), cancelled: true }; throw error; }
          finally { options.signal?.removeEventListener('abort', onAbort); pending.delete(item); }
        })();
        return item.done;
      },
      close() {
        closePromise ??= (async () => {
          closed = true; abortAll(); selected.signal?.removeEventListener('abort', abortAll);
          await Promise.allSettled([...pending].map(item => item.done)); await rm(policyRoot, { recursive: true, force: true });
        })();
        return closePromise;
      },
    };
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    if (!opened) { abortAll(); selected.signal?.removeEventListener('abort', abortAll); if (policyRoot) await rm(policyRoot, { recursive: true, force: true }); }
  }
}
