import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readlink, realpath, symlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SUPERTUX_PROBE } from './supertux-probe.mjs';

const INFO = 'Contents/Info.plist', WRAPPER = 'Contents/MacOS/SuperTux', ORIGINAL_EXE = 'Contents/Resources/bin/supertux2';
const FRAMEWORKS = 'Contents/Resources/Frameworks', NATIVE_EXE = 'Contents/MacOS/GameBridgeHostProbe';
const BRIDGE_NAME = 'GameBridgeHostEntry', NATIVE_NAME = 'GameBridgeHostProbe';
const executeFile = promisify(execFile);
const INFO_SHA = '52f6b6eabaeefdafafd274900c684b57cc8dc18d33b8b33070f2914c3b132cd2';
const WRAPPER_SHA = 'ef49c05e70c6dccbc8fc530f0cdb73db8cae8bcdb44d1e7b10fe166dd8dae52e';
const LIMITS = Object.freeze({ entries: 12000, fileBytes: 64 * 1024 * 1024, totalBytes: 768 * 1024 * 1024, depth: 32, pathBytes: 1536 });
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function cancelled(signal) { if (signal?.aborted) fail('HOST_BUNDLE_CANCELLED', 'Probe bundle preparation was cancelled.'); }
function options(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).some(key => !['sourceApp', 'destinationApp', 'signal', 'launchBridge'].includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(raw)).some(item => !item.enumerable || !Object.hasOwn(item, 'value')) ||
      !Object.hasOwn(raw, 'sourceApp') || !Object.hasOwn(raw, 'destinationApp') || (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) ||
      (Object.hasOwn(raw, 'launchBridge') && typeof raw.launchBridge !== 'boolean')) fail('INVALID_HOST_BUNDLE_OPTIONS', 'Bundle preparation accepts only declared local data options.');
  const absolute = value => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) || !path.resolve(value).endsWith('.app')) fail('INVALID_HOST_BUNDLE_PATH', 'Explicit local application bundle paths are required.');
    return path.resolve(value);
  };
  return { sourceApp: absolute(raw.sourceApp), destinationApp: absolute(raw.destinationApp), signal: raw.signal, launchBridge: raw.launchBridge ?? false };
}
function inside(root, item) { return item === root || item.startsWith(root + path.sep); }
function same(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }
async function directory(file) {
  const info = await lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink()) fail('INVALID_HOST_BUNDLE_PATH', 'Bundle directories must be ordinary real directories.');
  return { file: await realpath(file), info };
}
async function ordinaryParents(root, relative, signal) {
  let cursor = root;
  for (const part of relative.split('/').slice(0, -1)) {
    cancelled(signal); cursor = path.join(cursor, part); const info = await lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('HOST_BUNDLE_UNSAFE_LINK', 'Pinned input paths cannot traverse linked or special directories.');
  }
}
function logical(file) {
  if (Buffer.byteLength(file) > LIMITS.pathBytes || file.split('/').length > LIMITS.depth || /[\\\x00-\x1f\x7f]/.test(file) || file.split('/').some(item => item === '.' || item === '..')) fail('HOST_BUNDLE_LIMIT', 'Bundle paths exceed the local copy boundary.');
  return file;
}
async function fileContents(file, { destination, signal, maxBytes = LIMITS.fileBytes } = {}) {
  cancelled(signal);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maxBytes) fail('HOST_BUNDLE_UNSAFE_FILE', 'Bundle inputs must be bounded ordinary files without hard links.');
  const source = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  let target;
  try {
    const opened = await source.stat();
    if (!same(before, opened) || opened.nlink !== 1) fail('HOST_BUNDLE_CHANGED', 'A bundle file changed before reading.');
    if (destination) target = await open(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), opened.mode & 0o111 ? 0o700 : 0o600);
    const hash = createHash('sha256'), buffer = Buffer.alloc(65536), small = maxBytes <= 64 * 1024 ? [] : null;
    let at = 0;
    while (at < opened.size) {
      cancelled(signal);
      const result = await source.read(buffer, 0, Math.min(buffer.length, opened.size - at), at);
      if (!result.bytesRead) fail('HOST_BUNDLE_CHANGED', 'A bundle file was truncated.');
      const chunk = buffer.subarray(0, result.bytesRead); hash.update(chunk); if (small) small.push(Buffer.from(chunk));
      if (target) { let offset = 0; while (offset < chunk.length) { cancelled(signal); const written = await target.write(chunk, offset, chunk.length - offset); if (!written.bytesWritten) fail('HOST_BUNDLE_CHANGED', 'Bundle copy did not advance.'); offset += written.bytesWritten; } }
      at += result.bytesRead;
    }
    const after = await source.stat(), extra = await source.read(Buffer.alloc(1), 0, 1, at);
    if (extra.bytesRead || !same(after, opened) || after.nlink !== 1 || !same(await lstat(file), before)) fail('HOST_BUNDLE_CHANGED', 'A bundle file changed while reading.');
    cancelled(signal);
    return { sha256: hash.digest('hex'), bytes: at, executable: Boolean(opened.mode & 0o111), ...(small ? { contents: Buffer.concat(small) } : {}) };
  } finally { await source.close(); await target?.close(); }
}
async function inventory(root, signal) {
  const entries = []; let bytes = 0;
  async function visit(relative) {
    cancelled(signal); logical(relative);
    if (entries.length >= LIMITS.entries) fail('HOST_BUNDLE_LIMIT', 'Bundle file count exceeds the local copy boundary.');
    const absolute = path.join(root, relative), before = await lstat(absolute);
    if (before.isSymbolicLink()) {
      const target = await readlink(absolute);
      if (path.isAbsolute(target) || /[\\\x00-\x1f\x7f]/.test(target) || !inside(root, await realpath(absolute))) fail('HOST_BUNDLE_UNSAFE_LINK', 'Bundle links must resolve within the selected source bundle.');
      if (relative.startsWith(FRAMEWORKS + '/') && !inside(path.join(root, FRAMEWORKS), await realpath(absolute))) fail('HOST_BUNDLE_UNSAFE_LINK', 'Relocated Frameworks links must remain within that tree.');
      entries.push({ path: relative, type: 'symlink', target });
    } else if (before.isDirectory()) {
      entries.push({ path: relative, type: 'directory' });
      const children = await readdir(absolute); children.sort();
      if (children.length > LIMITS.entries) fail('HOST_BUNDLE_LIMIT', 'Bundle directory entries exceed the local copy boundary.');
      for (const child of children) await visit(relative ? relative + '/' + child : child);
    } else if (before.isFile()) {
      const observed = await fileContents(absolute, { signal }); bytes += observed.bytes;
      if (bytes > LIMITS.totalBytes) fail('HOST_BUNDLE_LIMIT', 'Bundle bytes exceed the local copy boundary.');
      entries.push({ path: relative, type: 'file', sha256: observed.sha256, bytes: observed.bytes, executable: observed.executable });
    } else fail('HOST_BUNDLE_UNSAFE_FILE', 'Bundle special files cannot be copied.');
    const after = await lstat(absolute);
    if (!same(before, after)) fail('HOST_BUNDLE_CHANGED', 'Bundle layout changed during inspection.');
  }
  await visit(''); cancelled(signal);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entries, sha256: digest(JSON.stringify(entries)), bytes, fileCount: entries.filter(item => item.type === 'file').length };
}
async function copyEntries(sourceRoot, destinationRoot, entries, signal, transform = name => name) {
  for (const entry of entries) {
    cancelled(signal); const destination = path.join(destinationRoot, transform(entry.path));
    if (entry.path === '' && transform(entry.path) === '') continue;
    if (entry.type === 'directory') await mkdir(destination, { mode: 0o700 });
    else if (entry.type === 'symlink') await symlink(entry.target, destination);
    else {
      const observed = await fileContents(path.join(sourceRoot, entry.path), { destination, signal });
      if (observed.sha256 !== entry.sha256 || observed.bytes !== entry.bytes || observed.executable !== entry.executable) fail('HOST_BUNDLE_CHANGED', 'Bundle input changed after inspection.');
    }
  }
}
async function replaceOwnedFile(file, bytes, signal) {
  cancelled(signal);
  const before = await lstat(file), output = await open(file, constants.O_WRONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!before.isFile() || before.nlink !== 1 || !same(before, await output.stat())) fail('HOST_BUNDLE_CHANGED', 'Prepared metadata was replaced.');
    cancelled(signal); await output.truncate(0); let at = 0;
    while (at < bytes.length) { cancelled(signal); const part = await output.write(bytes, at, bytes.length - at, at); if (!part.bytesWritten) fail('HOST_BUNDLE_CHANGED', 'Metadata write did not advance.'); at += part.bytesWritten; }
  } finally { await output.close(); }
}
async function inspectAttributeNames(sourceApp, signal) {
  cancelled(signal);
  if (process.platform !== 'darwin') return { status: 'not_checked_non_darwin', quarantine: 'unknown' };
  let result;
  try {
    result = await executeFile('/usr/bin/xattr', ['-r', sourceApp], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
      timeout: 10000, signal, env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } });
  } catch (error) {
    cancelled(signal);
    fail('HOST_BUNDLE_ATTRIBUTE_CHECK_FAILED', 'Bounded source attribute-name inspection did not complete. No preparation was performed.');
  }
  cancelled(signal);
  const lines = result.stdout.split('\n').filter(Boolean);
  if (lines.some(line => line.endsWith(': com.apple.quarantine'))) fail('HOST_BUNDLE_QUARANTINED', 'Source has a quarantine marker; preparation refuses to drop or alter it.');
  if (result.stderr || lines.some(line => !line.startsWith(sourceApp) || line.lastIndexOf(': ') < sourceApp.length)) fail('HOST_BUNDLE_ATTRIBUTE_CHECK_FAILED', 'Source attribute-name inspection returned an unexpected format.');
  return { status: 'checked_names_only', quarantine: 'absent', attributeNameRecords: lines.length,
    outputBytes: Buffer.byteLength(result.stdout), valuesRead: false, attributesRemoved: false };
}

/** Local preparation only: no launch, signing, xattr removal, downloads, model
 * source, shell command interpolation or system changes. The copied native entry
 * keeps its vendor bytes; the bundle identity/layout is explicitly derivative.
 * This is not publisher authentication or protection against a same-user racer.
 * Failed/cancelled partial destinations are retained and never marked prepared.
 */
export async function prepareSuperTuxProbeBundle(raw) {
  const selected = options(raw); cancelled(selected.signal);
  if (await lstat(selected.destinationApp).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) fail('HOST_BUNDLE_DESTINATION_EXISTS', 'A new destination is required; existing bundles are never overwritten.');
  const source = await directory(selected.sourceApp), parent = await directory(path.dirname(selected.destinationApp));
  const destinationApp = path.join(parent.file, path.basename(selected.destinationApp));
  if (inside(source.file, destinationApp) || inside(destinationApp, source.file) || !source.file.endsWith('.app')) fail('INVALID_HOST_BUNDLE_PATH', 'Source and prepared bundles must remain separate.');
  for (const pinned of [ORIGINAL_EXE, INFO, WRAPPER]) await ordinaryParents(source.file, pinned, selected.signal);
  const executable = await fileContents(path.join(source.file, ORIGINAL_EXE), { signal: selected.signal });
  const info = await fileContents(path.join(source.file, INFO), { maxBytes: 64 * 1024, signal: selected.signal });
  const wrapper = await fileContents(path.join(source.file, WRAPPER), { maxBytes: 64 * 1024, signal: selected.signal });
  if (executable.sha256 !== SUPERTUX_PROBE.executables.x64 || info.sha256 !== INFO_SHA || wrapper.sha256 !== WRAPPER_SHA) fail('PINNED_SUPERTUX_BUNDLE_REQUIRED', 'Only the inspected official 0.7.0 x64 bundle layout is admitted.');
  const original = await inventory(source.file, selected.signal), byPath = new Map(original.entries.map(item => [item.path, item]));
  if (byPath.get(INFO)?.sha256 !== INFO_SHA || byPath.get(WRAPPER)?.sha256 !== WRAPPER_SHA || byPath.get(ORIGINAL_EXE)?.sha256 !== SUPERTUX_PROBE.executables.x64 ||
      byPath.get(FRAMEWORKS)?.type !== 'directory' || byPath.has('Contents/Frameworks') || byPath.has(NATIVE_EXE) || byPath.has('Contents/MacOS/' + BRIDGE_NAME) || byPath.has('Contents/MacOS/GameBridgeHostInvocation')) fail('PINNED_SUPERTUX_BUNDLE_REQUIRED', 'The selected vendor layout changed or collides with prepared files.');
  const attributeInspection = await inspectAttributeNames(source.file, selected.signal);
  const declaredExecutableName = selected.launchBridge ? BRIDGE_NAME : NATIVE_NAME;
  const entryLayout = selected.launchBridge ? 'script-launch-bridge-pending' : 'native-direct';
  const bundleIdentifier = 'dev.gamebridge.probe.supertux070' + (selected.launchBridge ? '.run' + randomUUID().replaceAll('-', '') : '');
  let xml = info.contents.toString('utf8');
  for (const [key, before, after] of [['CFBundleExecutable', 'SuperTux', declaredExecutableName], ['CFBundleIdentifier', 'com.googlecode.supertux2', bundleIdentifier], ['CFBundleName', 'SuperTux', 'GameBridge SuperTux Probe']]) {
    const old = '<key>' + key + '</key>\n\t<string>' + before + '</string>';
    if (xml.split(old).length !== 2) fail('PINNED_SUPERTUX_BUNDLE_REQUIRED', 'Metadata is not the inspected vendor XML.');
    xml = xml.replace(old, '<key>' + key + '</key>\n\t<string>' + after + '</string>');
  }
  cancelled(selected.signal); await mkdir(destinationApp, { mode: 0o700 });
  await copyEntries(source.file, destinationApp, original.entries, selected.signal);
  const dependencies = original.entries.filter(item => item.path === FRAMEWORKS || item.path.startsWith(FRAMEWORKS + '/'));
  const relocated = name => 'Contents/Frameworks' + name.slice(FRAMEWORKS.length);
  await copyEntries(source.file, destinationApp, dependencies, selected.signal, relocated);
  const native = await fileContents(path.join(source.file, ORIGINAL_EXE), { destination: path.join(destinationApp, NATIVE_EXE), signal: selected.signal });
  if (native.sha256 !== executable.sha256) fail('HOST_BUNDLE_CHANGED', 'Native executable bytes changed during preparation.');
  await replaceOwnedFile(path.join(destinationApp, INFO), Buffer.from(xml), selected.signal);
  const expected = original.entries.map(item => item.path === INFO ? { ...item, sha256: digest(xml), bytes: Buffer.byteLength(xml) } : { ...item });
  expected.push(...dependencies.map(item => ({ ...item, path: relocated(item.path) })), { path: NATIVE_EXE, type: 'file', sha256: native.sha256, bytes: native.bytes, executable: native.executable });
  expected.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const prepared = await inventory(destinationApp, selected.signal), sourceAfter = await inventory(source.file, selected.signal);
  if (prepared.sha256 !== digest(JSON.stringify(expected)) || sourceAfter.sha256 !== original.sha256 || !same(source.info, await lstat(source.file))) fail('HOST_BUNDLE_CHANGED', 'Prepared or original bundle content changed.');
  const parentAfter = await lstat(parent.file);
  if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() || parentAfter.dev !== parent.info.dev || parentAfter.ino !== parent.info.ino) fail('HOST_BUNDLE_CHANGED', 'The preparation parent was replaced.');
  cancelled(selected.signal);
  return { schemaVersion: 1, scope: 'local-repacked-host-probe-only', destinationApp, executable: path.join(destinationApp, NATIVE_EXE),
    bundleIdentifier, prepared: true, entryLayout, declaredExecutableName, declaredEntryPresent: !selected.launchBridge,
    provenance: { hostGame: 'SuperTux', hostVersion: '0.7.0', architecture: 'x64',
      originalExecutableSha256: executable.sha256, nativeExecutableSha256: native.sha256,
      originalWrapperSha256: wrapper.sha256, originalInfoSha256: info.sha256, preparedInfoSha256: digest(xml),
      sourceTree: { sha256: original.sha256, entryCount: original.entries.length, fileCount: original.fileCount, bytes: original.bytes },
      preparedTree: { sha256: prepared.sha256, entryCount: prepared.entries.length, fileCount: prepared.fileCount, bytes: prepared.bytes },
      dependencies: dependencies.map(item => ({ ...item, sourcePath: item.path, path: relocated(item.path) })),
      bundleIdentifier, entryLayout, declaredExecutableName, declaredEntryPresent: !selected.launchBridge, attributeInspection,
      sourceUnchanged: true, nativeExecutableBytesUnchanged: true, signingPerformed: false, securitySettingsChanged: false },
    realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false };
}
