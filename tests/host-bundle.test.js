// Admission/negative checks only. These tests never launch, download or modify
// a game; successful real vendor repackaging is separately retained locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareSuperTuxProbeBundle } from '../src/hosts/supertux-bundle.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-bundle-admission-'));
  try {
    const sourceApp = path.join(root, 'Source.app'), destinationApp = path.join(root, 'Prepared.app');
    await mkdir(path.join(sourceApp, 'Contents/Resources/bin'), { recursive: true });
    await mkdir(path.join(sourceApp, 'Contents/MacOS'), { recursive: true });
    await writeFile(path.join(sourceApp, 'Contents/Resources/bin/supertux2'), 'project-owned-invalid-executable', { mode: 0o700 });
    await writeFile(path.join(sourceApp, 'Contents/Info.plist'), '<plist>project-owned-invalid-info</plist>');
    await writeFile(path.join(sourceApp, 'Contents/MacOS/SuperTux'), '#!/bin/sh\n# project-owned-invalid-wrapper\n', { mode: 0o700 });
    await run({ root, sourceApp, destinationApp });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('bundle preparation rejects unknown authority fields and accessors before evaluating paths', async () => {
  let accessed = 0;
  const getter = Object.defineProperty({}, 'sourceApp', { enumerable: true, get() { accessed++; return '/Source.app'; } });
  for (const input of [null, [], getter, Object.create({ sourceApp: '/Source.app' }),
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', command: '/bin/sh' },
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', env: {} },
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', bundleIdentifier: 'caller.selected.identifier' },
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', launchBridge: 'true' },
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', launchBridge: null },
    { sourceApp: '/Source.app', destinationApp: '/Prepared.app', signal: {} }]) {
    await assert.rejects(prepareSuperTuxProbeBundle(input), { code: 'INVALID_HOST_BUNDLE_OPTIONS' });
  }
  assert.equal(accessed, 0);
});

test('cancelled admission does not create a destination or inspect absent source files', async () => {
  await fixture(async ({ root, destinationApp }) => {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp: path.join(root, 'Absent.app'), destinationApp, signal: controller.signal }), { code: 'HOST_BUNDLE_CANCELLED' });
    assert.deepEqual(await readdir(root), ['Source.app']);
  });
});

test('existing destinations are never overwritten, including links', async () => {
  await fixture(async ({ root, sourceApp, destinationApp }) => {
    await mkdir(destinationApp); await writeFile(path.join(destinationApp, 'user-sentinel'), 'keep');
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp }), { code: 'HOST_BUNDLE_DESTINATION_EXISTS' });
    assert.equal(await readFile(path.join(destinationApp, 'user-sentinel'), 'utf8'), 'keep');
    const linked = path.join(root, 'Linked.app'); await symlink(destinationApp, linked);
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp: linked }), { code: 'HOST_BUNDLE_DESTINATION_EXISTS' });
    assert.equal(await readFile(path.join(linked, 'user-sentinel'), 'utf8'), 'keep');
  });
});

test('unverified executable and metadata cannot produce a prepared application', async () => {
  await fixture(async ({ root, sourceApp, destinationApp }) => {
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp }), { code: 'PINNED_SUPERTUX_BUNDLE_REQUIRED' });
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp, launchBridge: true }), { code: 'PINNED_SUPERTUX_BUNDLE_REQUIRED' });
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp, launchBridge: false }), { code: 'PINNED_SUPERTUX_BUNDLE_REQUIRED' });
    assert.deepEqual(await readdir(root), ['Source.app']);
    assert.equal(await readFile(path.join(sourceApp, 'Contents/Resources/bin/supertux2'), 'utf8'), 'project-owned-invalid-executable');
  });
});

test('source aliases, overlapping output and non-bundle paths are rejected without writes', async () => {
  await fixture(async ({ root, sourceApp, destinationApp }) => {
    const alias = path.join(root, 'Alias.app'); await symlink(sourceApp, alias);
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp: alias, destinationApp }), { code: 'INVALID_HOST_BUNDLE_PATH' });
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp: path.join(sourceApp, 'Nested.app') }), { code: 'INVALID_HOST_BUNDLE_PATH' });
    for (const bad of ['relative.app', '/Users', '/bad\npath.app']) {
      await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp: bad, destinationApp }), { code: 'INVALID_HOST_BUNDLE_PATH' });
    }
    assert.deepEqual(await readdir(root), ['Alias.app', 'Source.app']);
  });
});

test('native source entry cannot be a link even when it targets a local file', async () => {
  await fixture(async ({ sourceApp, destinationApp }) => {
    const entry = path.join(sourceApp, 'Contents/Resources/bin/supertux2');
    await rm(entry); await symlink(path.join(sourceApp, 'Contents/MacOS/SuperTux'), entry);
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp }), { code: 'HOST_BUNDLE_UNSAFE_FILE' });
  });
});

test('pinned input ancestors cannot redirect source reads outside the application', async () => {
  await fixture(async ({ root, sourceApp, destinationApp }) => {
    await rm(path.join(sourceApp, 'Contents/Resources'), { recursive: true });
    const outside = path.join(root, 'outside'); await mkdir(path.join(outside, 'bin'), { recursive: true });
    await writeFile(path.join(outside, 'bin/supertux2'), 'outside-canary');
    await symlink(outside, path.join(sourceApp, 'Contents/Resources'));
    await assert.rejects(prepareSuperTuxProbeBundle({ sourceApp, destinationApp }), { code: 'HOST_BUNDLE_UNSAFE_LINK' });
    assert.equal(await readFile(path.join(outside, 'bin/supertux2'), 'utf8'), 'outside-canary');
  });
});
