import test from 'node:test';
import assert from 'node:assert/strict';
import { validateGuiHostInvocation, createGuiHostInvocation, makeGuiHostEntryScript, classifyGuiProcessInspection } from '../src/hosts/gui-launch.mjs';

const options = () => ({ policyFile: '/private/policy/host.sb', policyRoot: '/private/policy', executable: '/trusted/Game.app/Contents/MacOS/Game',
  args: ['--userdir', '/private/work/user'], cwd: '/private/work', env: { PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/private/work' }, timeoutMs: 1000 });
test('GUI launch admission snapshots fixed data and accepts only trusted binding callbacks', () => {
  const input = options(), callback = () => {}; input.verifyBinding = callback;
  const accepted = validateGuiHostInvocation(input); input.args[0] = 'changed'; input.env.LANG = 'changed';
  assert.equal(accepted.args[0], '--userdir'); assert.equal(accepted.env.LANG, 'C'); assert.equal(accepted.verifyBinding, callback);
  assert.throws(() => validateGuiHostInvocation({ ...options(), verifyBinding: 'model-code' }));
  assert.equal(validateGuiHostInvocation({ ...options(), bundleIdentifier: 'dev.gamebridge.probe.supertux070' }).bundleIdentifier, 'dev.gamebridge.probe.supertux070');
  for (const bundleIdentifier of ['no-dot', 'dev..probe', 'dev.gamebridge.123', 'dev.gamebridge.<injection>', 'dev.gamebridge.probe\n', 'x'.repeat(201)]) {
    assert.throws(() => validateGuiHostInvocation({ ...options(), bundleIdentifier }), { code: 'INVALID_GUI_HOST_BUNDLE_IDENTIFIER' });
  }
  const sameBundle = { ...options(), launchAppPath: '/trusted/Game.app', bundleIdentifier: 'dev.gamebridge.probe.test' };
  assert.equal(validateGuiHostInvocation(sameBundle).launchAppPath, '/trusted/Game.app');
  for (const update of [{ launchAppPath: '/outside/Other.app' }, { launchAppPath: '/private/work/Game.app' }, { launchAppPath: 'relative' }, { bundleIdentifier: undefined }]) {
    assert.throws(() => validateGuiHostInvocation({ ...sameBundle, ...update }));
  }
});
test('GUI launch rejects credentials, hooks, custom commands and unsafe path boundaries', () => {
  for (const change of [{ env: { PATH: '/usr/bin:/bin', DEEPSEEK_API_KEY: 'synthetic-canary' } }, { env: { PATH: '/tmp/tools' } },
    { env: { PATH: '/usr/bin:/bin', NODE_OPTIONS: '--eval=unsafe' } }, { command: '/bin/sh' }, { timeoutMs: 180001 }, { policyRoot: '/' },
    { policyFile: '/outside/host.sb' }, { cwd: '/private/policy/work' }, { executable: 'relative' }, { args: ['bad\nargument'] },
    { actualEnv: 'relative' }, { policySha256: 'not-a-fingerprint' }]) {
    assert.throws(() => validateGuiHostInvocation({ ...options(), ...change }));
  }
});
test('GUI launch rejects getters and exotic/sparse lists without evaluating them', () => {
  let invoked = 0; const raw = options(); Object.defineProperty(raw, 'env', { enumerable: true, get() { invoked++; return {}; } });
  assert.throws(() => validateGuiHostInvocation(raw));
  const sparse = []; sparse.length = 1; assert.throws(() => validateGuiHostInvocation({ ...options(), args: sparse }));
  const exotic = []; Object.setPrototypeOf(exotic, { get some() { invoked++; return Array.prototype.some; } });
  assert.throws(() => validateGuiHostInvocation({ ...options(), args: exotic }));
  assert.equal(invoked, 0);
});
test('already cancelled GUI preparation does not inspect filesystem or compile', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createGuiHostInvocation({ ...options(), signal: controller.signal }), { code: 'HOST_PROBE_CANCELLED' });
});
test('the optional shebang entry executes only the fixed helper with inert POSIX path quoting', () => {
  assert.equal(makeGuiHostEntryScript('/private/Probe.app/Contents/MacOS/GameBridgeHostInvocation'), "#!/bin/sh\nexec '/private/Probe.app/Contents/MacOS/GameBridgeHostInvocation'\n");
  const script = makeGuiHostEntryScript("/private/O'Neil $(inert).app/Contents/MacOS/GameBridgeHostInvocation");
  assert.equal(script, "#!/bin/sh\nexec '/private/O'\"'\"'Neil $(inert).app/Contents/MacOS/GameBridgeHostInvocation'\n");
  for (const bad of ['/bin/sh', '/private/Probe.app/Contents/MacOS/Game', 'relative', '/bad\n.app/Contents/MacOS/GameBridgeHostInvocation']) assert.throws(() => makeGuiHostEntryScript(bad));
});

test('a valid process identity is separate from an explicit kernel missing observation', () => {
  const identity = { pid: 4917, pgid: 4917, seconds: 1793840000, micros: 654321 };
  assert.deepEqual(classifyGuiProcessInspection(JSON.stringify(identity), identity.pid), { status: 'observed', identity });
  assert.deepEqual(classifyGuiProcessInspection(JSON.stringify({ status: 'missing', pid: identity.pid, errno: 3, bytes: 0 }), identity.pid), { status: 'missing', pid: identity.pid });
  assert.deepEqual(classifyGuiProcessInspection(JSON.stringify({ ...identity, seconds: identity.seconds + 1 }), identity.pid), { status: 'observed', identity: { ...identity, seconds: identity.seconds + 1 } });
});

test('permission errors, truncated results and mismatched observations never imply process exit', () => {
  const pid = 4917;
  for (const observed of [
    { status: 'inspection-error', pid, errno: 1, bytes: 0 },
    { status: 'inspection-error', pid, errno: 13, bytes: 0 },
    { status: 'missing', pid, errno: 13, bytes: 0 },
    { status: 'missing', pid, errno: 0, bytes: 0 },
    { status: 'missing', pid, errno: 3, bytes: 24 },
    { status: 'missing', pid: pid + 1, errno: 3, bytes: 0 },
    { status: 'missing', pid, errno: 3, bytes: 0, output: 'untrusted-extra' },
    { pid, pgid: pid + 1, seconds: 123, micros: 0 },
    { pid: pid + 1, pgid: pid + 1, seconds: 123, micros: 0 },
    { pid, pgid: pid, seconds: -1, micros: 0 },
    { pid, pgid: pid, seconds: 123, micros: 0, extra: true },
  ]) assert.deepEqual(classifyGuiProcessInspection(JSON.stringify(observed), pid), { status: 'inspection-error' });
});

test('unavailable, malformed and overflowing inspector output fails closed', () => {
  for (const output of [undefined, null, '', '{', 'dyld: failed to load inspector', '{}\n{}', 'x'.repeat(4097), Buffer.from('{}')]) {
    assert.deepEqual(classifyGuiProcessInspection(output, 4917), { status: 'inspection-error' });
  }
  const text = JSON.stringify({ status: 'missing', pid: 4917, errno: 3, bytes: 0 });
  for (const pid of [0, 1, -1, 2147483648, '4917', NaN]) assert.deepEqual(classifyGuiProcessInspection(text, pid), { status: 'inspection-error' });
});
