import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { TARGETS, LIMITS, validateScene, parseSceneFile, transformScene, convertScene, createDemoScene } from '../src/core.js';

const single = (overrides = {}) => ({ version: 1, name: 'Test scene', size: [2, 3, 4], palette: ['#ff0000', '#00ff00'], voxels: [{ x: 1, y: 2, z: 3, color: 0 }], ...overrides });
const encoder = new TextEncoder();
const uint = (value) => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value, true); return bytes; };
const join = (...arrays) => { const result = new Uint8Array(arrays.reduce((size, a) => size + a.length, 0)); let offset = 0; for (const a of arrays) { result.set(a, offset); offset += a.length; } return result; };
const chunk = (id, content, children = new Uint8Array()) => join(encoder.encode(id), uint(content.length), uint(children.length), content, children);
const sizeChunk = (size = [2, 3, 4]) => chunk('SIZE', join(...size.map(uint)));
const cellChunk = (cells = [[1, 2, 3, 1]]) => chunk('XYZI', join(uint(cells.length), ...cells.map((cell) => Uint8Array.from(cell))));
const voxFile = (...chunks) => join(encoder.encode('VOX '), uint(150), chunk('MAIN', new Uint8Array(), join(...chunks)));

test('demo is an original, valid, reasonably sized architectural scene', () => {
  const scene = createDemoScene();
  assert.deepEqual(validateScene(scene), scene);
  assert.deepEqual(scene.size, [20, 14, 20]);
  assert.ok(scene.voxels.length > 900 && scene.voxels.length < 1800);
  assert.equal(TARGETS.length, 4);
});

test('JSON round trip preserves the scene and strips unknown input fields', async () => {
  const scene = createDemoScene();
  const output = convertScene({ ...scene, execute: 'never executed' }, 'json');
  assert.deepEqual(await parseSceneFile('scene.JSON', encoder.encode(output.text)), scene);
  assert.equal(output.filename, 'cloud-gate.json');
  assert.equal(JSON.parse(output.text).execute, undefined);
  assert.deepEqual(output.report.dimensions, scene.size);
});

test('bundled VOX and JSON samples represent the same occupied cells and colors', async () => {
  const json = await parseSceneFile('cloud-gate.json', await readFile(new URL('../samples/cloud-gate.json', import.meta.url)));
  const vox = await parseSceneFile('cloud-gate.vox', await readFile(new URL('../samples/cloud-gate.vox', import.meta.url)));
  assert.deepEqual(vox.size, json.size);
  assert.deepEqual(vox.voxels, json.voxels);
  assert.deepEqual(vox.palette.slice(0, json.palette.length), json.palette);
});

test('validation refuses coordinates, duplicate cells, malformed palettes, and nonfinite input', () => {
  for (const scene of [
    single({ version: 2 }), single({ name: 'a\nsetblock ~ ~ ~ air' }),
    single({ name: '' }), single({ name: 'x'.repeat(81) }), single({ size: [2, 3, 129] }),
    single({ size: [2, 0, 4] }), single({ size: [2, Infinity, 4] }), single({ size: Array(3) }),
    single({ palette: ['red'] }), single({ palette: ['#abc'] }), single({ palette: [] }), single({ palette: Array(1) }),
    single({ voxels: [] }), single({ voxels: Array(1) }), single({ voxels: [{ x: -1, y: 0, z: 0, color: 0 }] }),
    single({ voxels: [{ x: 2, y: 0, z: 0, color: 0 }] }),
    single({ voxels: [{ x: NaN, y: 0, z: 0, color: 0 }] }),
    single({ voxels: [{ x: 0.1, y: 0, z: 0, color: 0 }] }),
    single({ voxels: [{ x: 0, y: 0, z: 0, color: 2 }] }),
    single({ voxels: [{ x: 1, y: 2, z: 3, color: 0 }, { x: 1, y: 2, z: 3, color: 1 }] }),
  ]) assert.throws(() => validateScene(scene));
  const input = single({ palette: ['#FF0000'] });
  const result = validateScene(input);
  assert.equal(result.palette[0], '#ff0000');
  result.voxels[0].x = 0;
  assert.equal(input.voxels[0].x, 1, 'validation must not alias the input voxel records');
});

test('file parsing rejects bad encoding, wrong extensions, wrong buffers, and oversized files', async () => {
  await assert.rejects(parseSceneFile('scene.json', Uint8Array.from([0xff])), /UTF-8/);
  await assert.rejects(parseSceneFile('scene.json', encoder.encode('{')), /JSON/);
  await assert.rejects(parseSceneFile('scene.obj', new Uint8Array()), /只支持/);
  await assert.rejects(parseSceneFile('scene.json', []), /Uint8Array/);
  await assert.rejects(parseSceneFile('scene.json', new Uint8Array(LIMITS.fileBytes + 1)), /8 MiB/);
});

test('VOX uses the default palette and rotates Z-up into Y-up without reflection', async () => {
  const scene = await parseSceneFile('gate.vox', voxFile(sizeChunk(), cellChunk()));
  assert.deepEqual(scene.size, [2, 4, 3]);
  assert.deepEqual(scene.voxels, [{ x: 1, y: 3, z: 0, color: 0 }]);
  assert.equal(scene.palette.length, 255);
  assert.equal(scene.palette[0], '#ffffff');
  assert.equal(scene.palette[1], '#ffffcc');
  assert.equal(scene.palette[214], '#000033');
  assert.equal(scene.palette[215], '#ee0000');
  assert.equal(scene.palette[254], '#111111');
  // Respect a view's byteOffset, e.g. a Node Buffer slice or browser byte view.
  const file = voxFile(sizeChunk(), cellChunk());
  const padded = join(uint(0), file, uint(0));
  assert.deepEqual(await parseSceneFile('gate.vox', padded.subarray(4, -4)), scene);
});

test('VOX custom RGBA palette uses one-based color indices and rejects used transparent colors', async () => {
  const colors = new Uint8Array(1024);
  for (let index = 0; index < 256; index++) colors.set([index, 77, 99, 255], index * 4);
  const file = (palette) => voxFile(sizeChunk(), cellChunk([[1, 2, 3, 255]]), chunk('RGBA', palette));
  const scene = await parseSceneFile('palette.vox', file(colors));
  assert.equal(scene.palette[254], '#fe4d63');
  assert.equal(scene.voxels[0].color, 254);
  colors[254 * 4 + 3] = 128;
  await assert.rejects(parseSceneFile('transparent.vox', file(colors)), /透明/);
});

test('VOX rejects truncation, invalid chunk lengths, bounds, scene graphs, and multiple models', async () => {
  const valid = voxFile(sizeChunk(), cellChunk());
  for (const file of [
    new Uint8Array(), valid.subarray(0, 19), valid.subarray(0, -1), join(valid, uint(0)),
    voxFile(sizeChunk(), chunk('XYZI', join(uint(2), Uint8Array.from([0, 0, 0, 1])))),
    voxFile(sizeChunk(), cellChunk([[2, 0, 0, 1]])),
    voxFile(sizeChunk(), cellChunk([[0, 0, 0, 0]])),
    voxFile(sizeChunk(), cellChunk([[0, 0, 0, 1], [0, 0, 0, 2]])),
    voxFile(sizeChunk([129, 1, 1]), cellChunk([[0, 0, 0, 1]])),
    voxFile(sizeChunk(), cellChunk(), sizeChunk(), cellChunk()),
    voxFile(chunk('PACK', uint(2)), sizeChunk(), cellChunk()),
    voxFile(cellChunk(), sizeChunk()),
    voxFile(sizeChunk(), cellChunk(), chunk('RGBA', new Uint8Array(1023))),
    voxFile(sizeChunk(), cellChunk(), chunk('nTRN', new Uint8Array())),
    voxFile(sizeChunk(), cellChunk(), chunk('nGRP', new Uint8Array())),
    voxFile(sizeChunk(), cellChunk(), chunk('nSHP', new Uint8Array())),
    voxFile(sizeChunk(), cellChunk(), chunk('TEST', new Uint8Array(), chunk('nTRN', new Uint8Array()))),
  ]) await assert.rejects(parseSceneFile('bad.vox', file));
  const impossibleLength = valid.slice();
  new DataView(impossibleLength.buffer).setUint32(24, 0xffffffff, true);
  await assert.rejects(parseSceneFile('length.vox', impossibleLength), /截断/);
  const wrongVersion = valid.slice();
  new DataView(wrongVersion.buffer).setUint32(4, 999, true);
  await assert.rejects(parseSceneFile('version.vox', wrongVersion), /版本/);
});

test('rotation, mirroring, and integer scale transform occupied cells consistently', () => {
  const scene = single();
  assert.deepEqual(transformScene(scene, { rotation: 90 }).size, [4, 3, 2]);
  assert.deepEqual(transformScene(scene, { rotation: 90 }).voxels[0], { x: 0, y: 2, z: 1, color: 0 });
  assert.deepEqual(transformScene(scene, { rotation: 180 }).voxels[0], { x: 0, y: 2, z: 0, color: 0 });
  assert.deepEqual(transformScene(scene, { rotation: 270 }).voxels[0], { x: 3, y: 2, z: 0, color: 0 });
  assert.deepEqual(transformScene(scene, { rotation: 90, mirrorX: true }).voxels[0], { x: 0, y: 2, z: 0, color: 0 });
  let rotated = scene;
  for (let i = 0; i < 4; i++) rotated = transformScene(rotated, { rotation: 90 });
  assert.deepEqual(rotated, scene);
  assert.deepEqual(transformScene(transformScene(scene, { mirrorX: true }), { mirrorX: true }), scene);
  const scaled = transformScene(scene, { scale: 2 });
  assert.deepEqual(scaled.size, [4, 6, 8]);
  assert.equal(scaled.voxels.length, 8);
  assert.deepEqual(validateScene(scaled), scaled);
  assert.deepEqual(scene, single(), 'transforms must not mutate the source');
});

test('resource limits are checked before expanding a scene', () => {
  const cells = Array.from({ length: 4097 }, (_, index) => ({ x: index % 32, y: Math.floor(index / 32) % 32, z: Math.floor(index / 1024), color: 0 }));
  const scene = single({ size: [32, 32, 32], voxels: cells });
  assert.throws(() => transformScene(scene, { scale: 2 }), /体素数量/);
  assert.throws(() => transformScene(single({ size: [65, 3, 4] }), { scale: 2 }), /尺寸/);
  assert.throws(() => transformScene(single(), { scale: 1.5 }), /倍率/);
  assert.throws(() => transformScene(single(), { rotation: 45 }), /旋转/);
  assert.throws(() => transformScene(single(), { mirrorX: 'yes' }), /布尔/);
  assert.throws(() => validateScene(single({ voxels: Array(LIMITS.voxels + 1).fill(single().voxels[0]) })), /体素/);
});

test('Minecraft emits only safe relative setblock commands and fixed palette block IDs', () => {
  const scene = single({ name: 'quote"; command\\../../x' });
  const result = convertScene(scene, 'minecraft');
  const commands = result.text.split('\n').filter((line) => line && !line.startsWith('#'));
  assert.equal(commands.length, scene.voxels.length);
  assert.match(commands[0], /^setblock ~1 ~2 ~3 minecraft:[a-z_]+$/);
  assert.ok(result.report.warnings.length);
  assert.match(result.filename, /^[a-z0-9_-]+\.mcfunction$/);
  assert.equal(result.report.voxelCount, 1);
  assert.throws(() => convertScene(scene, 'not-a-game'), /未知/);
});

test('Roblox exports data without allowing the scene name to escape its string', () => {
  const name = 'quote"; error("oops") -- \\';
  const result = convertScene(single({ name }), 'roblox');
  assert.ok(result.text.includes('model.Name = "quote\\"; error(\\"oops\\") -- \\\\"'));
  assert.ok(result.text.includes('part.Anchored = true'));
  assert.ok(result.text.includes('Color3.fromRGB(255, 0, 0)'));
  assert.ok(result.text.includes('{1, 2, 3, 1}'));
  assert.ok(result.text.includes('cell[1] + 0.5'));
  assert.ok(!result.text.includes('HttpService'));
});

test('Godot emits shared palette resources and one centered mesh instance per occupied cell', () => {
  const scene = single({ voxels: [{ x: 1, y: 2, z: 3, color: 0 }, { x: 0, y: 0, z: 0, color: 0 }] });
  const result = convertScene(scene, 'godot');
  assert.ok(result.text.startsWith('[gd_scene load_steps=3 format=3]'));
  assert.equal((result.text.match(/type="BoxMesh"/g) || []).length, 1);
  assert.equal((result.text.match(/type="MeshInstance3D"/g) || []).length, 2);
  assert.ok(result.text.includes('position = Vector3(1.5, 2.5, 3.5)'));
  assert.ok(result.text.includes('albedo_color = Color(1, 0, 0, 1)'));
  assert.equal(result.filename, 'test-scene.tscn');
});
