import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertRunData } from '../orchestration/store.mjs';

export const ARTIFACT_LIMITS = Object.freeze({ maxFiles: 64, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024, maxManifestBytes: 64 * 1024 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const HANDLE_FIELDS = ['schemaVersion', 'id', 'manifestSha256', 'fileCount', 'totalBytes', 'scope'];
const SCOPE = 'local-tool-artifact';
const RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }
function plain(value, fields, required = fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !fields.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !item.enumerable || !Object.hasOwn(item, 'value')) ||
      required.some(key => !Object.hasOwn(value, key))) fail('ARTIFACT_INVALID_DATA', 'Artifact input must contain only its declared plain data fields.');
}
function dense(value, max) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !value.length || value.length > max || Reflect.ownKeys(value).length !== value.length + 1 ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value')) || Array.from({ length: value.length }, (_, i) => !Object.hasOwn(value, i)).some(Boolean)) fail('ARTIFACT_LIMIT', 'Artifact file lists must be dense, nonempty and bounded.');
  return value;
}
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) fail('ARTIFACT_PATH_UNSAFE', 'An explicit absolute local artifact directory is required.');
  return value;
}
export function validateArtifactPath(value) {
  // Logical generated names deliberately use one portable ASCII namespace.
  // Original asset names/content need a separately evidenced import mapping.
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9._/-]+$/.test(value) || path.posix.isAbsolute(value)) fail('ARTIFACT_PATH_UNSAFE', 'Artifact names must be bounded relative ASCII POSIX paths.');
  const pieces = value.split('/');
  if (pieces.length > 16 || pieces.some(piece => !piece || piece === '.' || piece === '..' || /[. ]$/.test(piece) || RESERVED_NAME.test(piece))) fail('ARTIFACT_PATH_UNSAFE', 'Artifact path components are unsafe or ambiguous.');
  return value;
}
function fileNames(values, max) {
  const result = dense(values, max).map(validateArtifactPath), seen = new Set();
  for (const name of result) {
    const key = name.toLowerCase();
    if (seen.has(key)) fail('ARTIFACT_PATH_UNSAFE', 'Artifact paths collide across supported filesystems.');
    seen.add(key);
  }
  for (const key of seen) if ([...seen].some(other => other !== key && other.startsWith(key + '/'))) fail('ARTIFACT_PATH_UNSAFE', 'An artifact file cannot also be a directory.');
  return result;
}
function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sameIdentity(a, b) { return a.dev === b.dev && a.ino === b.ino; }
function sameFile(a, b) { return sameIdentity(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs; }
function cancelled(signal) { if (signal?.aborted) fail('ARTIFACT_CANCELLED', 'Artifact operation was cancelled before commit.'); }
function options(raw = {}, fields = ['signal']) {
  plain(raw, fields, []);
  if (raw.signal !== undefined && !(raw.signal instanceof AbortSignal)) fail('ARTIFACT_INVALID_DATA', 'Artifact cancellation requires an AbortSignal.');
  return raw;
}
async function privateDirectory(file, { create = false, requirePrivate = true } = {}) {
  if (create) await mkdir(file, { recursive: true, mode: 0o700 });
  const info = await lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink() || (requirePrivate && process.platform !== 'win32' && (info.mode & 0o077))) fail('ARTIFACT_PATH_UNSAFE', 'Artifact directories must be private real directories.');
  return { file: await realpath(file), info, requirePrivate };
}
async function verifyDirectory(entry) {
  const current = await lstat(entry.file);
  if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, entry.info) || (entry.requirePrivate && process.platform !== 'win32' && (current.mode & 0o077))) fail('ARTIFACT_PATH_UNSAFE', 'An artifact directory was replaced or redirected.');
}
async function syncDirectory(file) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY); await handle.sync(); }
  catch (cause) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(cause.code)) throw cause; }
  finally { await handle?.close(); }
}
async function readBounded(file, limit, signal) {
  cancelled(signal);
  const before = await lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > limit) fail('ARTIFACT_CORRUPT', 'Artifact file type, links or size violate its contract.');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit || !sameFile(before, opened)) fail('ARTIFACT_CORRUPT', 'Artifact file changed before observation.');
    const bytes = Buffer.alloc(opened.size); let at = 0;
    while (at < bytes.length) {
      cancelled(signal); const read = await handle.read(bytes, at, Math.min(65536, bytes.length - at), at);
      if (!read.bytesRead) fail('ARTIFACT_CORRUPT', 'Artifact file was truncated.'); at += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, at), after = await handle.stat();
    if (extra.bytesRead || after.nlink !== 1 || !sameFile(opened, after)) fail('ARTIFACT_CORRUPT', 'Artifact file changed during observation.');
    cancelled(signal); return bytes;
  } finally { await handle.close(); }
}

/** Local immutable file artifacts, separate from scheduler JSON. Path and hash
 * checks detect observed replacement; this is not an OS sandbox or an atomic
 * defence against malicious same-user directory races.
 */
export async function createArtifactStore(raw = {}) {
  plain(raw, ['root', 'secrets', 'limits'], ['root']);
  absolute(raw.root);
  const secrets = raw.secrets ?? [], limits = { ...ARTIFACT_LIMITS };
  if (raw.limits !== undefined) {
    plain(raw.limits, Object.keys(ARTIFACT_LIMITS), []);
    for (const [key, value] of Object.entries(raw.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > ARTIFACT_LIMITS[key]) fail('ARTIFACT_LIMIT', 'Artifact limits can only tighten local maximums.'); limits[key] = value;
    }
  }
  function guardValues() {
    const values = typeof secrets === 'function' ? secrets() : secrets;
    if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) fail('ARTIFACT_INVALID_DATA', 'Artifact credential guard must provide strings.');
    return values.filter(Boolean);
  }
  function guardBytes(bytes) {
    if (guardValues().some(secret => bytes.includes(Buffer.from(secret)) || bytes.includes(Buffer.from(JSON.stringify(secret).slice(1, -1))))) fail('ARTIFACT_SECRET_DETECTED', 'Credential content was excluded from an artifact.');
  }
  function metadata(value, maximum = limits.maxManifestBytes) {
    try { assertRunData(value, { secrets: guardValues(), maxBytes: maximum }); }
    catch (cause) { if (cause.code === 'RUN_SECRET_DETECTED') fail('ARTIFACT_SECRET_DETECTED', 'Credential metadata was excluded from an artifact.'); fail('ARTIFACT_INVALID_DATA', 'Artifact metadata violates its bounded plain-data contract.'); }
  }
  guardValues();
  const base = await privateDirectory(raw.root, { create: true });
  const objects = await privateDirectory(path.join(base.file, 'objects'), { create: true });
  const work = await privateDirectory(path.join(base.file, 'work'), { create: true });
  const temporary = await privateDirectory(path.join(base.file, 'temporary'), { create: true });
  const roots = [base, objects, work, temporary], workspaces = new Map();
  async function verifyRoots() { for (const entry of roots) await verifyDirectory(entry); }
  async function workspace(directory) {
    absolute(directory); await verifyRoots();
    const entry = workspaces.get(directory);
    if (!entry) fail('ARTIFACT_WORKSPACE_UNREGISTERED', 'Only a directory issued by this artifact store can be used.');
    await verifyDirectory(entry); return entry;
  }
  async function tree(baseEntry, logicalPath, createDirectories = false) {
    validateArtifactPath(logicalPath); await verifyDirectory(baseEntry);
    const entries = [baseEntry]; let directory = baseEntry.file;
    for (const segment of logicalPath.split('/').slice(0, -1)) {
      directory = path.join(directory, segment);
      if (createDirectories) await mkdir(directory, { mode: 0o700 }).catch(cause => { if (cause.code !== 'EEXIST') throw cause; });
      const entry = await privateDirectory(directory, { requirePrivate: !baseEntry.mutable }); entries.push(entry);
    }
    return { file: path.join(baseEntry.file, ...logicalPath.split('/')), entries };
  }
  async function verifyTree(entries) { await verifyRoots(); for (const entry of entries) await verifyDirectory(entry); }
  function handle(value) {
    plain(value, HANDLE_FIELDS); metadata(value, 2048);
    if (value.schemaVersion !== 1 || value.scope !== SCOPE || !UUID.test(value.id) || !HASH.test(value.manifestSha256) || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 || value.fileCount > limits.maxFiles || !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > limits.maxTotalBytes) fail('ARTIFACT_INVALID_DATA', 'Artifact handle is invalid or outside local limits.');
    return structuredClone(value);
  }
  async function load(rawHandle) {
    const accepted = handle(rawHandle); await verifyRoots();
    let directory;
    try { directory = await privateDirectory(path.join(objects.file, accepted.id)); }
    catch (cause) { if (cause.code === 'ENOENT') fail('ARTIFACT_NOT_FOUND', 'Artifact does not exist.'); throw cause; }
    const fileRoot = await privateDirectory(path.join(directory.file, 'files'));
    const bytes = await readBounded(path.join(directory.file, 'manifest.json'), limits.maxManifestBytes);
    guardBytes(bytes);
    if (digest(bytes) !== accepted.manifestSha256) fail('ARTIFACT_CORRUPT', 'Artifact manifest hash does not match its handle.');
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('ARTIFACT_CORRUPT', 'Artifact manifest is not valid UTF-8 JSON.'); }
    metadata(manifest); plain(manifest, ['schemaVersion', 'id', 'scope', 'fileCount', 'totalBytes', 'files', 'provenance']); metadata(manifest.provenance, 16384);
    if (manifest.schemaVersion !== 1 || manifest.id !== accepted.id || manifest.scope !== SCOPE || manifest.fileCount !== accepted.fileCount || manifest.totalBytes !== accepted.totalBytes) fail('ARTIFACT_CORRUPT', 'Artifact manifest identity or totals changed.');
    const names = fileNames(dense(manifest.files, limits.maxFiles).map(item => { plain(item, ['path', 'sha256', 'bytes', 'mediaType']); return item.path; }), limits.maxFiles);
    let total = 0;
    for (const item of manifest.files) {
      if (!HASH.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > limits.maxFileBytes || typeof item.mediaType !== 'string' || item.mediaType.length > 100 || !/^[a-z0-9][a-z0-9.+/-]*(?:;charset=utf-8)?$/.test(item.mediaType)) fail('ARTIFACT_CORRUPT', 'Artifact manifest file entry is invalid.'); total += item.bytes;
    }
    if (names.length !== accepted.fileCount || total !== accepted.totalBytes || total > limits.maxTotalBytes) fail('ARTIFACT_CORRUPT', 'Artifact manifest file totals are inconsistent.');
    await verifyDirectory(directory); await verifyDirectory(fileRoot); return { manifest, directory, fileRoot };
  }
  async function readAccepted(loaded, logicalPath, signal) {
    const item = loaded.manifest.files.find(file => file.path === logicalPath);
    if (!item) fail('ARTIFACT_PATH_UNSAFE', 'The requested file is not present in the artifact manifest.');
    const target = await tree(loaded.fileRoot, logicalPath), bytes = await readBounded(target.file, Math.min(item.bytes, limits.maxFileBytes), signal);
    if (bytes.length !== item.bytes || digest(bytes) !== item.sha256) fail('ARTIFACT_CORRUPT', 'Artifact bytes do not match their manifest.');
    guardBytes(bytes); await verifyTree(target.entries); await verifyDirectory(loaded.directory); return bytes;
  }
  async function create(input, rawOptions = {}) {
    plain(input, ['files', 'provenance'], ['files']); const { signal } = options(rawOptions); cancelled(signal);
    const rawProvenance = input.provenance ?? {}; metadata(rawProvenance, 16384); const provenance = structuredClone(rawProvenance);
    const files = dense(input.files, limits.maxFiles), names = fileNames(files.map(item => { plain(item, ['path', 'content', 'mediaType'], ['path', 'content']); return item.path; }), limits.maxFiles);
    const accepted = []; let totalBytes = 0;
    for (let index = 0; index < files.length; index++) {
      const file = files[index]; let content;
      if (typeof file.content === 'string') { if (Buffer.byteLength(file.content) > limits.maxFileBytes) fail('ARTIFACT_LIMIT', 'Artifact file exceeds its byte budget.'); content = Buffer.from(file.content); }
      else if (Buffer.isBuffer(file.content) && Object.getPrototypeOf(file.content) === Buffer.prototype) { if (file.content.length > limits.maxFileBytes) fail('ARTIFACT_LIMIT', 'Artifact file exceeds its byte budget.'); content = Buffer.from(file.content); }
      else fail('ARTIFACT_INVALID_DATA', 'Artifact content must be UTF-8 text or a Buffer.');
      totalBytes += content.length; if (totalBytes > limits.maxTotalBytes) fail('ARTIFACT_LIMIT', 'Artifact exceeds its total byte budget.'); guardBytes(content);
      const mediaType = file.mediaType ?? (typeof file.content === 'string' ? 'text/plain;charset=utf-8' : 'application/octet-stream');
      if (typeof mediaType !== 'string' || mediaType.length > 100 || !/^[a-z0-9][a-z0-9.+/-]*(?:;charset=utf-8)?$/.test(mediaType)) fail('ARTIFACT_INVALID_DATA', 'Artifact media type is invalid.');
      accepted.push({ path: names[index], content, mediaType });
    }
    await verifyRoots(); const id = randomUUID(), stagingPath = await mkdtemp(path.join(temporary.file, 'pending-'));
    const target = path.join(objects.file, id);
    let committed = false, renamed = false, staging;
    try {
      staging = await privateDirectory(stagingPath);
      const fileRoot = await privateDirectory(path.join(staging.file, 'files'), { create: true });
      const manifest = { schemaVersion: 1, id, scope: SCOPE, fileCount: accepted.length, totalBytes,
        files: accepted.map(file => ({ path: file.path, sha256: digest(file.content), bytes: file.content.length, mediaType: file.mediaType })), provenance: structuredClone(provenance) };
      metadata(manifest); const bytes = Buffer.from(JSON.stringify(manifest)); guardBytes(bytes);
      for (const file of accepted) {
        cancelled(signal); const target = await tree(fileRoot, file.path, true), writer = await open(target.file, 'wx', 0o600);
        try { await writer.writeFile(file.content); await writer.sync(); } finally { await writer.close(); }
        await verifyTree(target.entries);
      }
      const writer = await open(path.join(staging.file, 'manifest.json'), 'wx', 0o600);
      try { await writer.writeFile(bytes); await writer.sync(); } finally { await writer.close(); }
      cancelled(signal); for (const file of accepted) guardBytes(file.content); metadata(manifest);
      await verifyRoots(); await verifyDirectory(staging); await syncDirectory(staging.file);
      // Cancellation may arrive during directory checks/fsync or while rename
      // is pending. A renamed object is not accepted until the final check;
      // if admission is cancelled, roll back only this newly created object.
      cancelled(signal);
      await rename(staging.file, target); renamed = true;
      cancelled(signal);
      await syncDirectory(objects.file);
      cancelled(signal); committed = true;
      return { schemaVersion: 1, id, manifestSha256: digest(bytes), fileCount: accepted.length, totalBytes, scope: SCOPE };
    } finally {
      if (!committed) {
        if (renamed) {
          await verifyRoots(); await verifyDirectory({ ...staging, file: target });
          await rm(target, { recursive: true, force: true }); await syncDirectory(objects.file);
        } else await rm(stagingPath, { recursive: true, force: true });
      }
    }
  }
  return {
    create,
    async getManifest(rawHandle) { return structuredClone((await load(rawHandle)).manifest); },
    async readFile(rawHandle, logicalPath, rawOptions = {}) { validateArtifactPath(logicalPath); const { signal } = options(rawOptions); return Buffer.from(await readAccepted(await load(rawHandle), logicalPath, signal)); },
    async createWorkDirectory(rawOptions = {}) {
      const { signal } = options(rawOptions); cancelled(signal); await verifyRoots();
      const directory = await mkdtemp(path.join(work.file, 'job-')), entry = await privateDirectory(directory);
      try { cancelled(signal); entry.mutable = true; workspaces.set(directory, entry); return directory; }
      catch (cause) { await rm(directory, { recursive: true, force: true }); throw cause; }
    },
    async materialize(rawHandle, rawOptions) {
      const { directory, allowedPaths, signal } = options(rawOptions, ['directory', 'allowedPaths', 'signal']), allowed = fileNames(allowedPaths, limits.maxFiles), acceptedHandle = handle(rawHandle);
      const entry = await workspace(directory), loaded = await load(acceptedHandle);
      if (allowed.length !== loaded.manifest.files.length || loaded.manifest.files.some(file => !allowed.includes(file.path))) fail('ARTIFACT_PATH_UNSAFE', 'Materialization requires an exact local file allowlist.');
      const created = [];
      try {
        for (const file of loaded.manifest.files) {
          cancelled(signal); const bytes = await readAccepted(loaded, file.path, signal), target = await tree(entry, file.path, true), writer = await open(target.file, 'wx', 0o600);
          created.push(target.file); try { await writer.writeFile(bytes); await writer.sync(); } finally { await writer.close(); }
          await verifyTree(target.entries);
        }
        cancelled(signal); return structuredClone(loaded.manifest);
      } catch (cause) { for (const file of created) await rm(file, { force: true }).catch(() => {}); throw cause; }
    },
    async capture(input, rawOptions = {}) {
      plain(input, ['directory', 'paths', 'provenance'], ['directory', 'paths']); const { signal } = options(rawOptions), directory = input.directory;
      const names = fileNames(input.paths, limits.maxFiles), rawProvenance = input.provenance ?? {}; metadata(rawProvenance, 16384);
      const provenance = structuredClone(rawProvenance), entry = await workspace(directory), files = []; let total = 0;
      for (const name of names) {
        cancelled(signal); const target = await tree(entry, name), content = await readBounded(target.file, limits.maxFileBytes, signal);
        total += content.length; if (total > limits.maxTotalBytes) fail('ARTIFACT_LIMIT', 'Captured artifact exceeds its total byte budget.');
        guardBytes(content); await verifyTree(target.entries); files.push({ path: name, content });
      }
      return create({ files, provenance }, { signal });
    },
    async removeWorkDirectory(directory) { const entry = await workspace(directory); await rm(entry.file, { recursive: true, force: false }); workspaces.delete(directory); },
  };
}
