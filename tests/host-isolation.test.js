// Configuration and admission rejection checks only. npm test does not launch
// any host, run OS boundary probes or claim GUI/native gameplay verification.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostProbeSandboxProfile, hostProbeEnvironment, validateHostProbeArguments, validateHostProbeRunOptions, createHostProbeIsolation } from '../src/hosts/isolation.mjs';

const profileOptions = () => ({ appRoot: '/trusted/Host.app', workRoot: '/private/probe-work', policyRoot: '/private/probe-policy', protectedPaths: ['/project/.env'] });
test('host profile keeps app read-only, policy and credentials denied and network unavailable', () => {
  const profile = hostProbeSandboxProfile(profileOptions());
  assert.match(profile, /\(deny default\)/); assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/private\/probe-work"\)\)/);
  assert.ok(profile.includes('(subpath "/trusted/Host.app")')); assert.ok(profile.includes('(global-name "com.apple.windowserver.active")'));
  for (const service of ['com.apple.CARenderServer', 'com.apple.cvmsServ', 'com.apple.windowmanager.server', 'com.apple.dock.server']) assert.ok(profile.includes('(global-name ' + JSON.stringify(service) + ')'));
  assert.ok(!profile.includes('(allow mach-lookup)')); assert.ok(!profile.includes('(subpath "/Users")'));
  assert.ok(!profile.includes('allow ipc-posix-shm')); assert.ok(!profile.includes('apple.cfprefs.501v1'));
  assert.match(profile, /\(deny file-read\*[^\n]*\/private\/probe-policy[^\n]*\/Library\/Keychains[^\n]*\/project\/\.env/);
  assert.ok(!profile.includes('(subpath "/Library")'));
  assert.ok(profile.includes('(subpath "/Library/Apple/usr/libexec/oah")'));
});
test('host, policy and writable roots cannot overlap or accept relative/control paths', () => {
  for (const update of [{ appRoot: '/' }, { workRoot: '/' }, { policyRoot: '/' }, { policyRoot: '/private/probe-work/policy' },
    { appRoot: '/private/probe-work/Host.app' }, { workRoot: '/trusted/Host.app/save' }, { appRoot: '/Users' }, { appRoot: 'relative' }, { workRoot: '/bad\npath' }]) {
    assert.throws(() => hostProbeSandboxProfile({ ...profileOptions(), ...update }), { code: 'INVALID_HOST_PROBE_PATH' });
  }
});
test('host environment is fixed and excludes inherited keys and interpreter hooks', () => {
  const keys = ['DEEPSEEK_API_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES'], previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = 'synthetic-host-credential-canary';
    const env = hostProbeEnvironment('/private/probe-work');
    assert.equal(env.PATH, '/usr/bin:/bin'); assert.equal(env.HOME, '/private/probe-work'); assert.equal(env.TMPDIR, '/private/probe-work');
    assert.equal(env.XDG_CONFIG_HOME, '/private/probe-work'); assert.ok(!JSON.stringify(env).includes('synthetic-host-credential-canary'));
    for (const key of keys) assert.equal(Object.hasOwn(env, key), false);
  } finally { for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
});
test('run arguments are detached, dense and bounded local strings', () => {
  const args = ['--userdir', '/private/probe-work/user', 'levels/native.stl'], accepted = validateHostProbeArguments(args); args[0] = 'changed';
  assert.equal(accepted[0], '--userdir');
  const sparse = []; sparse.length = 1;
  for (const bad of [undefined, {}, sparse, [true], ['bad\0arg'], ['bad\narg'], ['x'.repeat(4097)], Array(33).fill('arg'), Array(5).fill('x'.repeat(4096))]) {
    assert.throws(() => validateHostProbeArguments(bad), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  }
});
test('run options cannot replace environment, cwd, executable, output cap or timeout bounds', () => {
  const signal = new AbortController().signal;
  assert.deepEqual(validateHostProbeRunOptions({ signal, timeoutMs: 1000 }), { signal, timeoutMs: 1000 });
  assert.equal(validateHostProbeRunOptions().timeoutMs, 90000);
  for (const bad of [null, [], { env: {} }, { cwd: '/outside' }, { executable: '/bin/sh' }, { maxOutputBytes: 9999999 },
    { signal: {} }, { timeoutMs: 49 }, { timeoutMs: 180001 }, { timeoutMs: Infinity }, { timeoutMs: 1.5 }]) {
    assert.throws(() => validateHostProbeRunOptions(bad), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  }
});
test('admission and helpers reject accessors, custom prototypes and unknown fields before evaluation', async () => {
  let accessed = 0;
  const getter = Object.defineProperty({}, 'appRoot', { enumerable: true, get() { accessed++; return '/app'; } });
  await assert.rejects(createHostProbeIsolation(getter), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  const optionsGetter = Object.defineProperty({}, 'timeoutMs', { enumerable: true, get() { accessed++; return 1000; } });
  assert.throws(() => validateHostProbeRunOptions(optionsGetter), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  const argsGetter = []; Object.defineProperty(argsGetter, 0, { enumerable: true, get() { accessed++; return '--arg'; } });
  assert.throws(() => validateHostProbeArguments(argsGetter), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  const inherited = Object.create({ timeoutMs: 1000 }); assert.throws(() => validateHostProbeRunOptions(inherited), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  const customArray = []; Object.setPrototypeOf(customArray, { get some() { accessed++; return Array.prototype.some; } });
  assert.throws(() => validateHostProbeArguments(customArray), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  assert.throws(() => hostProbeSandboxProfile({ ...profileOptions(), allowNetwork: true }), { code: 'INVALID_HOST_PROBE_OPTIONS' });
  assert.equal(accessed, 0);
});
test('an already cancelled creation cannot inspect paths or start boundary/host subprocesses', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createHostProbeIsolation({ appRoot: '/nonexistent/app', workRoot: '/nonexistent/work', executable: '/nonexistent/app/run', signal: controller.signal }), { code: 'HOST_PROBE_CANCELLED' });
});
