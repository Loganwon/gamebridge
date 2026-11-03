// Pure configuration checks. OS probes run explicitly, never as npm test side effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { converterSandboxEnvironment, converterSandboxProfile } from '../scripts/verify-converter-sandbox.mjs';

test('sandbox subprocesses use an explicit environment without inherited credentials or Node hooks', () => {
  const env = converterSandboxEnvironment('/isolated/tmp');
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'LC_ALL', 'PATH', 'TEMP', 'TMP', 'TMPDIR']);
  assert.equal(env.TMPDIR, '/isolated/tmp');
  for (const name of ['NODE_OPTIONS', 'DEEPSEEK_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'HOME']) assert.ok(!Object.hasOwn(env, name));
});

test('verification profile isolates writable output from policy and denies project credential paths and all network', () => {
  const options = { root: '/project', writableRoot: '/artifacts/work', policyRoot: '/policy-readonly', credentialCanary: '/project/.env.test-canary' };
  const profile = converterSandboxProfile(options);
  assert.match(profile, /\(deny default\)/); assert.match(profile, /\(deny network\*\)/);
  assert.match(profile, /\(allow file-write\* \(subpath "\/artifacts\/work"\)\)/);
  for (const protectedPath of ['/project/.env', '/project/.tools', '/project/.gamebridge', '/policy-readonly']) assert.ok(profile.includes(JSON.stringify(protectedPath)));
  assert.throws(() => converterSandboxProfile({ ...options, policyRoot: '/artifacts/work/mutable-policy' }), /outside/);
  assert.throws(() => converterSandboxProfile({ ...options, root: '/bad\npath' }), /control/);
  assert.throws(() => converterSandboxEnvironment('relative/path'), /absolute/);
});
