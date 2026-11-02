import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, symlink, mkdir, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRunStore, RUN_STORE_LIMITS } from '../src/orchestration/store.mjs';

async function fixture(fn) { const dir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-store-')); try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); } }
function record(id = randomUUID()) { return { id, revision: 0, createdAt: Date.now(), context: { scope: 'contract-test-only' } }; }

test('run snapshots survive a new store instance, detect stale revisions and preserve atomic valid data', async () => fixture(async dir => {
  const store = await createRunStore({ root: dir }), initial = await store.create(record());
  const persisted = await (await createRunStore({ root: dir })).read(initial.id);
  assert.deepEqual(persisted, initial);
  const updated = await store.write({ ...initial, note: 'updated' }, { expectedRevision: 0 });
  assert.equal(updated.revision, 1); assert.equal((await store.list()).length, 1);
  await assert.rejects(store.write(initial, { expectedRevision: 0 }), { code: 'RUN_REVISION_CONFLICT' });
  assert.equal((await store.read(initial.id)).note, 'updated');
  const envelope = JSON.parse(await readFile(path.join(dir, 'runs', initial.id + '.json'), 'utf8'));
  envelope.payload.note = 'corrupt'; await writeFile(path.join(dir, 'runs', initial.id + '.json'), JSON.stringify(envelope));
  await assert.rejects(store.read(initial.id), { code: 'RUN_STORE_CORRUPT' });
}));

test('run store rejects credentials, unsafe data, symlinks and oversized snapshots before retaining them', async () => fixture(async dir => {
  const secrets = []; const store = await createRunStore({ root: dir, secrets: () => secrets });
  const initial = await store.create(record()); secrets.push('transient-test-canary-not-a-real-key');
  await assert.rejects(store.write({ ...initial, note: secrets[0] }, { expectedRevision: 0 }), { code: 'RUN_SECRET_DETECTED' });
  await assert.rejects(store.create({ ...record(), context: { apiKey: 'excluded' } }), { code: 'RUN_SECRET_DETECTED' });
  let accessed = false; const getter = { ...record() }; Object.defineProperty(getter, 'bad', { enumerable: true, get() { accessed = true; return 'bad'; } });
  await assert.rejects(store.create(getter), { code: 'INVALID_RUN_DATA' }); assert.equal(accessed, false);
  await assert.rejects(store.create({ ...record(), context: { text: 'x'.repeat(RUN_STORE_LIMITS.recordBytes) } }), { code: 'INVALID_RUN_DATA' });
  await assert.rejects(store.read('../outside'), { code: 'INVALID_RUN_ID' });
  const outside = path.join(dir, 'outside.json'); await writeFile(outside, '{}');
  const linkedId = randomUUID(); await symlink(outside, path.join(dir, 'runs', linkedId + '.json'));
  await assert.rejects(store.read(linkedId), { code: 'RUN_STORE_CORRUPT' });
}));

test('two store instances cannot concurrently write the same run under an active lease', async () => fixture(async dir => {
  const a = await createRunStore({ root: dir }), b = await createRunStore({ root: dir }); const initial = await a.create(record());
  let release; const gate = new Promise(resolve => { release = resolve; }); let acquired;
  const ready = new Promise(resolve => { acquired = resolve; });
  const held = a.withLease(initial.id, async lease => { acquired(); await gate; return a.write({ ...initial, note: 'only-writer' }, { lease, expectedRevision: 0 }); });
  await ready;
  await assert.rejects(b.write(initial, { expectedRevision: 0 }), { code: 'RUN_BUSY' });
  release(); await held; assert.equal((await b.read(initial.id)).note, 'only-writer');
}));

test('a real crashed process lease is recovered without taking over a live process', async () => fixture(async dir => {
  const store = await createRunStore({ root: dir }), initial = await store.create(record());
  const source = `import {createRunStore} from ${JSON.stringify(new URL('../src/orchestration/store.mjs', import.meta.url).href)};const s=await createRunStore({root:${JSON.stringify(dir)}});await s.withLease(${JSON.stringify(initial.id)},async()=>{console.log('LEASE_READY');setInterval(()=>{},1000);await new Promise(()=>{});});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: '/usr/bin:/bin' } });
  // Keep the child alive deliberately while holding the lease, then simulate a crash.
  let text = ''; const ready = new Promise((resolve, reject) => { child.stdout.on('data', bytes => { text += bytes; if (text.includes('LEASE_READY')) resolve(); }); child.once('error', reject); child.once('exit', code => { if (!text.includes('LEASE_READY')) reject(new Error('Lease fixture exited: ' + code)); }); });
  await ready;
  if (child.exitCode === null) await assert.rejects(store.write(initial, { expectedRevision: 0 }), { code: 'RUN_BUSY' });
  const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
  const recovered = await store.write({ ...initial, note: 'after-crash' }, { expectedRevision: 0 });
  assert.equal(recovered.revision, 1); assert.equal((await store.read(initial.id)).note, 'after-crash');
}));

test('run count is capped before new snapshots and directory replacement cannot redirect later I/O', async () => fixture(async dir => {
  const store = await createRunStore({ root: dir }); let initial;
  for (let index = 0; index < RUN_STORE_LIMITS.runs; index++) initial = await store.create(record());
  await assert.rejects(store.create(record()), { code: 'RUN_STORE_LIMIT' });
  assert.equal((await store.list()).length, RUN_STORE_LIMITS.runs);
  await rename(path.join(dir, 'runs'), path.join(dir, 'retired-runs'));
  const elsewhere = path.join(dir, 'elsewhere'); await mkdir(elsewhere); await symlink(elsewhere, path.join(dir, 'runs'));
  await assert.rejects(store.read(initial.id), { code: 'RUN_STORE_PATH_UNSAFE' });
  await assert.rejects(store.create(record()), { code: 'RUN_STORE_PATH_UNSAFE' });
}));

test('readers observe complete old or new snapshots while atomic checkpoints replace the pathname', async () => fixture(async dir => {
  const store = await createRunStore({ root: dir }); let state = await store.create(record());
  let writing = true, reads = 0;
  const observer = (async () => { while (writing) { const snapshot = await store.read(state.id); assert.equal(snapshot.revision, snapshot.value ?? 0); reads++; } })();
  try {
    for (let index = 1; index <= 20; index++) state = await store.write({ ...state, value: index }, { expectedRevision: state.revision });
  } finally { writing = false; await observer; }
  assert.ok(reads > 10); assert.equal((await store.read(state.id)).value, 20);
}));
