import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, symlink, link, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createArtifactStore, validateArtifactPath } from '../src/artifacts/store.mjs';

async function fixture(work) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-artifacts-'));
  try { await work({ directory, root: path.join(directory, 'owned') }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const content = () => [
  { path: 'src/Behavior.cs', content: 'namespace GameBridge.Generated { public sealed class Behavior {} }' },
  { path: 'Project.csproj', content: '<Project Sdk="Microsoft.NET.Sdk" />' },
];

test('file artifacts persist opaque handles, detached metadata and copied bytes across store restarts', async () => fixture(async ({ root }) => {
  const store = await createArtifactStore({ root }), source = Buffer.from([0, 1, 2, 255]);
  const handle = await store.create({ files: [...content(), { path: 'data/input.bin', content: source }], provenance: { producer: 'contract-check', scope: 'portable-core-only' } });
  source[0] = 99;
  assert.deepEqual(Object.keys(handle), ['schemaVersion', 'id', 'manifestSha256', 'fileCount', 'totalBytes', 'scope']);
  assert.ok(!JSON.stringify(handle).includes(root)); assert.equal(handle.scope, 'local-tool-artifact'); assert.equal(handle.fileCount, 3);
  const restarted = await createArtifactStore({ root }), manifest = await restarted.getManifest(handle);
  assert.equal(manifest.files[0].path, 'src/Behavior.cs'); manifest.files[0].path = 'forged';
  assert.equal((await restarted.getManifest(handle)).files[0].path, 'src/Behavior.cs');
  const bytes = await restarted.readFile(handle, 'data/input.bin'); assert.deepEqual(bytes, Buffer.from([0, 1, 2, 255])); bytes[1] = 99;
  assert.deepEqual(await restarted.readFile(handle, 'data/input.bin'), Buffer.from([0, 1, 2, 255]));
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(root, 'objects', handle.id))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, 'objects', handle.id, 'manifest.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, 'objects', handle.id, 'files', 'data', 'input.bin'))).mode & 0o777, 0o600);
  }
}));

test('artifact writes snapshot caller data before asynchronous filesystem work', async () => fixture(async ({ root }) => {
  const store = await createArtifactStore({ root }), bytes = Buffer.from('original'), provenance = { label: 'original' };
  const input = { files: [{ path: 'source.txt', content: bytes }], provenance }; let accessed = false;
  const pending = store.create(input);
  bytes.fill(120); provenance.label = 'mutated';
  Object.defineProperty(input, 'files', { get() { accessed = true; throw new Error('must not access after await'); } });
  const artifact = await pending;
  assert.equal(accessed, false); assert.equal((await store.readFile(artifact, 'source.txt')).toString(), 'original');
  assert.equal((await store.getManifest(artifact)).provenance.label, 'original');
  const directory = await store.createWorkDirectory(); await writeFile(path.join(directory, 'output.txt'), 'captured');
  const captureInput = { directory, paths: ['output.txt'], provenance: { label: 'captured' } }, captured = store.capture(captureInput);
  captureInput.paths[0] = '../outside'; captureInput.provenance.label = 'mutated';
  const output = await captured; assert.equal((await store.getManifest(output)).provenance.label, 'captured');
}));

test('registered workspaces materialize exact files and capture real binary output without changing source artifacts', async () => fixture(async ({ directory, root }) => {
  const store = await createArtifactStore({ root }), source = await store.create({ files: content() }), work = await store.createWorkDirectory();
  await assert.rejects(store.materialize(source, { directory: work, allowedPaths: ['Project.csproj'] }), { code: 'ARTIFACT_PATH_UNSAFE' });
  await store.materialize(source, { directory: work, allowedPaths: ['Project.csproj', 'src/Behavior.cs'] });
  assert.match(await readFile(path.join(work, 'src/Behavior.cs'), 'utf8'), /namespace GameBridge/);
  // A real compiler may use 0755 output directories inside the private work root.
  await mkdir(path.join(work, 'bin'), { mode: 0o755 }); await writeFile(path.join(work, 'bin/output.dll'), Buffer.from([77, 90, 0, 255]));
  const output = await store.capture({ directory: work, paths: ['bin/output.dll'], provenance: { producer: 'trusted-compiler-contract-test' } });
  assert.deepEqual(await store.readFile(output, 'bin/output.dll'), Buffer.from([77, 90, 0, 255]));
  assert.equal((await store.getManifest(source)).fileCount, 2);
  await writeFile(path.join(work, 'src/Behavior.cs'), 'changed-in-workspace');
  const changed = await store.capture({ directory: work, paths: ['src/Behavior.cs'] });
  assert.notEqual((await store.getManifest(changed)).files[0].sha256, (await store.getManifest(source)).files[0].sha256);
  assert.match((await store.readFile(source, 'src/Behavior.cs')).toString(), /namespace/);
  await assert.rejects(store.capture({ directory, paths: ['anything'] }), { code: 'ARTIFACT_WORKSPACE_UNREGISTERED' });
  const restarted = await createArtifactStore({ root });
  await assert.rejects(restarted.capture({ directory: work, paths: ['src/Behavior.cs'] }), { code: 'ARTIFACT_WORKSPACE_UNREGISTERED' });
  await store.removeWorkDirectory(work); await assert.rejects(stat(work), { code: 'ENOENT' });
}));

test('path traversal, cross-platform collisions, unknown handles and getter inputs are rejected before writes', async () => fixture(async ({ root }) => {
  const store = await createArtifactStore({ root });
  for (const value of ['../outside', '/absolute', 'C:/outside', 'src\\outside', 'a//b', 'a/./b', 'a/../b', 'a.', 'a ', 'NUL.cs', 'com1', 'x\u0000y', 'e\u0301.txt', 'unicode-角色.bin', 'a?.cs', 'a*.cs', 'a|b.cs']) assert.throws(() => validateArtifactPath(value), { code: 'ARTIFACT_PATH_UNSAFE' });
  for (const files of [[{ path: 'A.cs', content: '' }, { path: 'a.cs', content: '' }], [{ path: 'src', content: '' }, { path: 'src/a.cs', content: '' }]]) await assert.rejects(store.create({ files }), { code: 'ARTIFACT_PATH_UNSAFE' });
  let accessed = false; const unsafe = { path: 'a.cs' }; Object.defineProperty(unsafe, 'content', { enumerable: true, get() { accessed = true; return 'bad'; } });
  await assert.rejects(store.create({ files: [unsafe] }), { code: 'ARTIFACT_INVALID_DATA' }); assert.equal(accessed, false);
  const handle = await store.create({ files: [{ path: 'a.cs', content: 'safe' }] });
  await assert.rejects(store.readFile(handle, 'unlisted.cs'), { code: 'ARTIFACT_PATH_UNSAFE' });
  await assert.rejects(store.getManifest({ ...handle, absolutePath: root }), { code: 'ARTIFACT_INVALID_DATA' });
  await assert.rejects(store.getManifest({ ...handle, fileCount: 99 }), { code: 'ARTIFACT_INVALID_DATA' });
}));

test('known credentials and credential metadata are excluded from text, binary and captured outputs', async () => fixture(async ({ root }) => {
  const values = ['artifact-test-private-canary'], store = await createArtifactStore({ root, secrets: () => values });
  for (const secret of [values[0], Buffer.from('binary-prefix:' + values[0])]) await assert.rejects(store.create({ files: [{ path: 'bad.bin', content: secret }] }), { code: 'ARTIFACT_SECRET_DETECTED' });
  await assert.rejects(store.create({ files: [{ path: 'safe.cs', content: 'safe' }], provenance: { apiKey: 'excluded' } }), { code: 'ARTIFACT_SECRET_DETECTED' });
  const work = await store.createWorkDirectory(); await writeFile(path.join(work, 'echo.bin'), values[0]);
  await assert.rejects(store.capture({ directory: work, paths: ['echo.bin'] }), { code: 'ARTIFACT_SECRET_DETECTED' });
  const handle = await store.create({ files: [{ path: 'later.txt', content: 'new-private-canary' }] }); values.push('new-private-canary');
  await assert.rejects(store.readFile(handle, 'later.txt'), { code: 'ARTIFACT_SECRET_DETECTED' });
  assert.equal((await readdir(path.join(root, 'objects'))).length, 1);
}));

test('symlinks, hardlinks, directories and replaced roots/workspaces cannot redirect artifact reads', async () => fixture(async ({ directory, root }) => {
  const store = await createArtifactStore({ root }), work = await store.createWorkDirectory(), outside = path.join(directory, 'outside');
  await mkdir(outside, { mode: 0o700 }); await writeFile(path.join(outside, 'private.txt'), 'private-canary-not-for-capture');
  await symlink(path.join(outside, 'private.txt'), path.join(work, 'linked.txt'));
  await symlink(outside, path.join(work, 'linked-directory'));
  await link(path.join(outside, 'private.txt'), path.join(work, 'hardlink.txt'));
  for (const paths of [['linked.txt'], ['hardlink.txt'], ['linked-directory']]) await assert.rejects(store.capture({ directory: work, paths }), { code: 'ARTIFACT_CORRUPT' });
  await assert.rejects(store.capture({ directory: work, paths: ['linked-directory/private.txt'] }), { code: 'ARTIFACT_PATH_UNSAFE' });
  await rename(work, work + '-retired'); await mkdir(work, { mode: 0o700 });
  await assert.rejects(store.capture({ directory: work, paths: ['file.txt'] }), { code: 'ARTIFACT_PATH_UNSAFE' });
  const artifact = await store.create({ files: [{ path: 'safe.txt', content: 'safe' }] });
  await rename(path.join(root, 'objects'), path.join(root, 'old-objects')); await mkdir(path.join(root, 'objects'), { mode: 0o700 });
  await assert.rejects(store.getManifest(artifact), { code: 'ARTIFACT_PATH_UNSAFE' });
}));

test('manifest or data corruption is detected and cannot be accepted using caller-supplied metadata', async () => fixture(async ({ root }) => {
  const store = await createArtifactStore({ root }), artifact = await store.create({ files: [{ path: 'safe.txt', content: 'safe' }] });
  const base = path.join(root, 'objects', artifact.id);
  await writeFile(path.join(base, 'files/safe.txt'), 'evil');
  await assert.rejects(store.readFile(artifact, 'safe.txt'), { code: 'ARTIFACT_CORRUPT' });
  await writeFile(path.join(base, 'manifest.json'), '{}');
  await assert.rejects(store.getManifest(artifact), { code: 'ARTIFACT_CORRUPT' });
}));

test('byte/file limits, cancellation and partial materialization failures leave no completed artifact', async () => fixture(async ({ root }) => {
  const store = await createArtifactStore({ root, limits: { maxFiles: 2, maxFileBytes: 16, maxTotalBytes: 20 } });
  await assert.rejects(store.create({ files: [{ path: 'a', content: 'x'.repeat(17) }] }), { code: 'ARTIFACT_LIMIT' });
  await assert.rejects(store.create({ files: [{ path: 'a', content: 'x'.repeat(11) }, { path: 'b', content: 'x'.repeat(11) }] }), { code: 'ARTIFACT_LIMIT' });
  await assert.rejects(store.create({ files: [{ path: 'a', content: '' }, { path: 'b', content: '' }, { path: 'c', content: '' }] }), { code: 'ARTIFACT_LIMIT' });
  await assert.rejects(store.create({ files: [{ path: 'a', content: 'safe' }] }, { signal: AbortSignal.abort() }), { code: 'ARTIFACT_CANCELLED' });
  assert.deepEqual(await readdir(path.join(root, 'objects')), []); assert.deepEqual(await readdir(path.join(root, 'temporary')), []);
  const source = await store.create({ files: [{ path: 'a', content: 'source-a' }, { path: 'b', content: 'source-b' }] }), work = await store.createWorkDirectory();
  await writeFile(path.join(work, 'b'), 'preexisting');
  await assert.rejects(store.materialize(source, { directory: work, allowedPaths: ['a', 'b'] }), { code: 'EEXIST' });
  await assert.rejects(stat(path.join(work, 'a')), { code: 'ENOENT' }); assert.equal(await readFile(path.join(work, 'b'), 'utf8'), 'preexisting');
  await writeFile(path.join(work, 'too-big'), 'x'.repeat(17));
  await assert.rejects(store.capture({ directory: work, paths: ['too-big'] }), { code: 'ARTIFACT_CORRUPT' });
  await assert.rejects(store.capture({ directory: work, paths: ['b'] }, { signal: AbortSignal.abort() }), { code: 'ARTIFACT_CANCELLED' });
  assert.equal((await readdir(path.join(root, 'objects'))).length, 1);
}));
