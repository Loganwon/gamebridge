import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../scripts/convert.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

test('CLI creates a Java 1.21 datapack with correct namespace and no automatic execution', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gamebridge-cli-'));
  try {
    const destination = path.join(temp, 'pack');
    const result = run(['--demo', '--datapack', destination]);
    assert.equal(result.status, 0, result.stderr);
    const metadata = JSON.parse(await readFile(path.join(destination, 'pack.mcmeta'), 'utf8'));
    assert.equal(metadata.pack.pack_format, 48);
    const text = await readFile(path.join(destination, 'data/gamebridge/function/build.mcfunction'), 'utf8');
    assert.match(text, /^setblock ~/m);
    const lines = text.split('\n').filter(line => line && !line.startsWith('#'));
    assert.ok(lines.length <= 32768);
    assert.ok(lines.every(line => line.startsWith('setblock ')));
    assert.notEqual(run(['--demo', '--datapack', destination]).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('CLI preserves existing output and rejects contradictory arguments', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gamebridge-cli-'));
  try {
    const output = path.join(temp, 'scene.json');
    await writeFile(output, 'keep me');
    assert.notEqual(run(['--demo', '--target', 'json', '--out', output]).status, 0);
    assert.equal(await readFile(output, 'utf8'), 'keep me');
    assert.notEqual(run(['--demo', 'source.vox', '--out', output]).status, 0);
    assert.notEqual(run(['--demo', '--out', output, '--rotation', '45']).status, 0);
    assert.notEqual(run(['--demo', '--target', 'godot', '--datapack', path.join(temp, 'bad')]).status, 0);
    assert.notEqual(run(['--demo', '--out', output, '--surprise']).status, 0);
  } finally { await rm(temp, { recursive: true, force: true }); }
});

test('CLI exports all targets and transforms user input', async () => {
  const temp = await mkdtemp(path.join(tmpdir(), 'gamebridge-cli-'));
  try {
    const source = path.join(temp, 'tiny.json');
    await writeFile(source, JSON.stringify({ version: 1, name: 'tiny', size: [2, 1, 1], palette: ['#123456'], voxels: [{ x: 1, y: 0, z: 0, color: 0 }] }));
    for (const target of ['minecraft', 'roblox', 'godot', 'json']) {
      const output = path.join(temp, `${target}.txt`);
      const result = run([source, '--target', target, '--rotation', '90', '--scale', '2', '--out', output]);
      assert.equal(result.status, 0, result.stderr);
      const text = await readFile(output, 'utf8');
      assert.ok(text.length > 20);
      if (target === 'json') {
        const scene = JSON.parse(text);
        assert.deepEqual(scene.size, [2, 2, 4]);
        assert.equal(scene.voxels.length, 8);
      }
    }
  } finally { await rm(temp, { recursive: true, force: true }); }
});
