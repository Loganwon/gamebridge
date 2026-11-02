import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { assertProtocolJson } from './protocol.mjs';

export const RUN_STORE_LIMITS = Object.freeze({ recordBytes: 2 * 1024 * 1024, runs: 32, directoryEntries: 1024, recoveryDepth: 32 });
const RUN_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SECRET_FIELD = /^(?:api[-_]?key|authorization|password|access[-_]?token|refresh[-_]?token|credentials|secrets?)$/i;
function error(code, message) { const result = new Error(message); result.code = code; return result; }
function validId(id) { if (typeof id !== 'string' || !RUN_ID.test(id)) throw error('INVALID_RUN_ID', 'Run IDs must be canonical UUIDs.'); return id; }
function secretValues(secrets) { const values = typeof secrets === 'function' ? secrets() : secrets; if (!Array.isArray(values)) throw error('INVALID_SECRET_GUARD', 'Secret guard must return an array.'); return values.filter(value => typeof value === 'string' && value.length > 0); }

/** Plain bounded data only; known credentials and credential-bearing fields never persist. */
export function assertRunData(value, { secrets = [], maxBytes = RUN_STORE_LIMITS.recordBytes } = {}) {
  try { assertProtocolJson(value, { maxBytes, maxNodes: 100000, maxDepth: 32 }); }
  catch { throw error('INVALID_RUN_DATA', 'Run data violates its finite plain-data or resource contract.'); }
  const pending = [value];
  while (pending.length) {
    const item = pending.pop(); if (!item || typeof item !== 'object') continue;
    for (const [key, child] of Object.entries(item)) { if (SECRET_FIELD.test(key)) throw error('RUN_SECRET_DETECTED', 'Credential fields cannot be retained in a run.'); if (child && typeof child === 'object') pending.push(child); }
  }
  const serialized = JSON.stringify(value);
  if (secretValues(secrets).some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)))) throw error('RUN_SECRET_DETECTED', 'A credential was excluded from run data.');
}
function digest(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
// Renaming a new checkpoint over this pathname can unlink an already-open old
// inode and change ctime without modifying its bytes. Content stability uses
// inode, size and mtime; accepted snapshots additionally require their checksum.
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function boundedRead(file, maxBytes) {
  for (let observed = 0; observed < 4; observed++) {
    const before = await lstat(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 2 || before.size > maxBytes) throw error('RUN_STORE_CORRUPT', 'A run store file is invalid or exceeds its resource limit.');
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size < 2 || opened.size > maxBytes) throw error('RUN_STORE_CORRUPT', 'An opened store file violates its type or size contract.');
      if (!sameFile(before, opened)) continue; // A legitimate atomic checkpoint may have replaced the pathname.
      const bytes = Buffer.alloc(opened.size); let at = 0;
      while (at < bytes.length) { const read = await handle.read(bytes, at, Math.min(65536, bytes.length - at), at); if (!read.bytesRead) throw error('RUN_STORE_CORRUPT', 'A run store file was truncated.'); at += read.bytesRead; }
      const extra = await handle.read(Buffer.alloc(1), 0, 1, at), after = await handle.stat();
      if (extra.bytesRead || !sameFile(opened, after)) throw error('RUN_STORE_CORRUPT', 'Store file bytes changed during observation.');
      try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw error('RUN_STORE_CORRUPT', 'A run store file is not valid JSON.'); }
    } finally { await handle.close(); }
  }
  throw error('RUN_STORE_BUSY', 'Store file changed too often to observe a stable snapshot.');
}
async function directory(file) {
  await mkdir(file, { recursive: true, mode: 0o700 }); const stat = await lstat(file);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('RUN_STORE_PATH_UNSAFE', 'Store directories must be real local directories.');
  return realpath(file);
}
async function syncDirectory(file) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY); await handle.sync(); }
  catch (cause) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM'].includes(cause.code)) throw cause; }
  finally { await handle?.close(); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (cause) { return cause.code !== 'ESRCH'; } }
function checkOwner(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['pid', 'nonce'].includes(key)) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !RUN_ID.test(value.nonce)) throw error('RUN_STORE_CORRUPT', 'Lease owner metadata is invalid.');
  return value;
}

/** Atomic snapshots and per-run single-writer leases. Checksums detect corruption,
 * not publisher authenticity. Same-user filesystem tampering is not an OS sandbox.
 */
export async function createRunStore({ root, secrets = [] } = {}) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root)) throw error('RUN_STORE_PATH_UNSAFE', 'An explicit absolute local store path is required.');
  const base = await directory(root), runs = await directory(path.join(base, 'runs')), locks = await directory(path.join(base, 'locks'));
  const directories = await Promise.all([base, runs, locks].map(async file => ({ file, stat: await lstat(file) })));
  async function verifyDirectories() {
    for (const entry of directories) { const current = await lstat(entry.file); if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== entry.stat.dev || current.ino !== entry.stat.ino) throw error('RUN_STORE_PATH_UNSAFE', 'A store directory was replaced or redirected.'); }
  }
  const held = new WeakSet();
  const runPath = id => path.join(runs, validId(id) + '.json');
  const lockPath = id => path.join(locks, validId(id) + '.lock');
  async function read(id) {
    await verifyDirectories();
    let envelope; try { envelope = await boundedRead(runPath(id), RUN_STORE_LIMITS.recordBytes + 1024); }
    catch (cause) { if (cause.code === 'ENOENT') throw error('RUN_NOT_FOUND', 'Run does not exist.'); throw cause; }
    if (!envelope || envelope.schemaVersion !== 1 || Object.keys(envelope).some(key => !['schemaVersion', 'checksum', 'payload'].includes(key))) throw error('RUN_STORE_CORRUPT', 'Run snapshot envelope is invalid.');
    assertRunData(envelope.payload, { secrets });
    if (envelope.checksum !== digest(envelope.payload)) throw error('RUN_STORE_CORRUPT', 'Run snapshot checksum is invalid.');
    if (envelope.payload.id !== id || !Number.isSafeInteger(envelope.payload.revision) || envelope.payload.revision < 0) throw error('RUN_STORE_CORRUPT', 'Run snapshot identity or revision is invalid.');
    return structuredClone(envelope.payload);
  }
  async function acquire(id) {
    await verifyDirectories();
    validId(id);
    // Complete owner metadata is synced before the atomic hard-link acquisition.
    // Immutable recovery tokens serialize dead-owner takeover, including a
    // reclaimer crashing mid-recovery; an alive PID is never taken over.
    const owner = { pid: process.pid, nonce: randomUUID() }, claim = path.join(locks, 'claim-' + owner.nonce + '.json');
    const handle = await open(claim, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); } finally { await handle.close(); }
    try {
      for (let count = 0; count < RUN_STORE_LIMITS.recoveryDepth; count++) {
        try { await link(claim, lockPath(id)); const lease = { id, nonce: owner.nonce }; held.add(lease); await syncDirectory(locks); return lease; }
        catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
        let old; try { old = checkOwner(await boundedRead(lockPath(id), 1024)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
        if (alive(old.pid)) throw error('RUN_BUSY', 'An active writer owns this run.');
        let anchor = old, authority = false;
        for (let depth = 0; depth < RUN_STORE_LIMITS.recoveryDepth; depth++) {
          const token = path.join(locks, 'reclaim-' + anchor.nonce + '.lock');
          try { await link(claim, token); authority = true; break; }
          catch (cause) { if (cause.code !== 'EEXIST') throw cause; }
          const reclaimer = checkOwner(await boundedRead(token, 1024));
          if (reclaimer.nonce === owner.nonce) { authority = true; break; }
          if (alive(reclaimer.pid)) throw error('RUN_BUSY', 'A live writer is recovering this run.');
          anchor = reclaimer;
        }
        if (!authority) throw error('RUN_LEASE_RECOVERY_LIMIT', 'Lease recovery chain exceeds its bound.');
        let current; try { current = checkOwner(await boundedRead(lockPath(id), 1024)); } catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
        if (current.nonce === old.nonce && !alive(current.pid)) await unlink(lockPath(id));
      }
      throw error('RUN_LEASE_RECOVERY_LIMIT', 'Run lease recovery did not converge.');
    } finally { await unlink(claim).catch(() => {}); }
  }
  async function release(lease) {
    if (!held.has(lease)) return;
    await verifyDirectories();
    held.delete(lease);
    const current = checkOwner(await boundedRead(lockPath(lease.id), 1024));
    if (current.nonce !== lease.nonce) throw error('RUN_LEASE_LOST', 'Run writer lease changed unexpectedly.');
    await unlink(lockPath(lease.id)); await syncDirectory(locks);
  }
  async function withLease(id, work) { const lease = await acquire(id); try { return await work(lease); } finally { await release(lease); } }
  async function writeSnapshot(record, { expectedRevision, lease, create = false } = {}) {
    await verifyDirectories();
    assertRunData(record, { secrets }); validId(record?.id);
    if (!lease) return withLease(record.id, owned => writeSnapshot(record, { expectedRevision, lease: owned, create }));
    if (!held.has(lease) || lease.id !== record.id) throw error('RUN_LEASE_REQUIRED', 'A local run writer lease is required.');
    const owner = checkOwner(await boundedRead(lockPath(record.id), 1024));
    if (owner.nonce !== lease.nonce) throw error('RUN_LEASE_LOST', 'Run writer lease changed unexpectedly.');
    assertRunData(record, { secrets });
    let previous;
    try { previous = await read(record.id); } catch (cause) { if (cause.code !== 'RUN_NOT_FOUND') throw cause; }
    if (create && previous) throw error('RUN_EXISTS', 'Run already exists.');
    if (!create && (!previous || previous.revision !== expectedRevision)) throw error('RUN_REVISION_CONFLICT', 'Run revision changed; stale snapshots cannot replace it.');
    const next = structuredClone({ ...record, revision: create ? 0 : expectedRevision + 1 });
    assertRunData(next, { secrets });
    const envelope = { schemaVersion: 1, checksum: digest(next), payload: next };
    const temporary = path.join(runs, '.' + record.id + '-' + randomUUID() + '.tmp');
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(envelope) + '\n'); await handle.sync(); await handle.close();
      await rename(temporary, runPath(record.id)); await syncDirectory(runs);
    } catch (cause) { await handle.close().catch(() => {}); await unlink(temporary).catch(() => {}); throw cause; }
    return next;
  }
  async function ids() {
    await verifyDirectories();
    const result = [], directory = await opendir(runs, { bufferSize: 1 }); let count = 0;
    for await (const entry of directory) {
      if (++count > RUN_STORE_LIMITS.directoryEntries) throw error('RUN_STORE_LIMIT', 'Store directory entry limit exceeded.');
      if (entry.name.startsWith('.')) continue;
      if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('.json') || !RUN_ID.test(entry.name.slice(0, -5))) throw error('RUN_STORE_CORRUPT', 'Unexpected run store entry.');
      result.push(entry.name.slice(0, -5)); if (result.length > RUN_STORE_LIMITS.runs) throw error('RUN_STORE_LIMIT', 'Run count limit exceeded.');
    }
    return result;
  }
  return {
    root: base, checkData: (value, options = {}) => assertRunData(value, { ...options, secrets }),
    read, get: read, withLease,
    create: async record => { assertRunData(record, { secrets }); validId(record?.id); return withLease('00000000-0000-0000-0000-000000000000', async () => {
      if (record.id === '00000000-0000-0000-0000-000000000000') throw error('INVALID_RUN_ID', 'Reserved store identity cannot be used by a run.');
      if ((await ids()).length >= RUN_STORE_LIMITS.runs) throw error('RUN_STORE_LIMIT', 'Run count limit reached.');
      return writeSnapshot(record, { create: true });
    }); },
    write: (record, options = {}) => writeSnapshot(record, { ...options, create: false }),
    async list() {
      const records = []; for (const id of await ids()) records.push(await read(id));
      return records.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    },
  };
}
