import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { parseSchematic } from '../src/schematic.js';

// Hand-encoded big-endian NBT fixtures: no converter writer is used to prepare input.
const join = (...parts) => Buffer.concat(parts.flat().map((part) => Buffer.from(typeof part === 'number' ? [part] : part)));
const int = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const short = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const str = (value) => { const b = Buffer.from(value); const length = Buffer.alloc(2); length.writeUInt16BE(b.length); return join(length, b); };
const named = (type, name, payload) => join([type], str(name), payload);
const compound = (name, fields) => named(10, name, join(fields, [0]));
const nint = (name, n) => named(3, name, int(n));
const nshort = (name, n) => named(2, name, short(n));
const array = (name, bytes) => named(7, name, join(int(bytes.length), bytes));
const palette = (entries) => compound('Palette', entries.map(([state, id]) => nint(state, id)));
function fixture({ version = 2, size = [2, 2, 2], states = [['minecraft:air', 0], ['minecraft:stone', 1], ['minecraft:red_wool', 2]], data = [0, 1, 2, 0, 1, 0, 0, 2], extra = [], wrapped = version === 3, dataVersion = 3465, widthType = 2 } = {}) {
  const fields = [
    nint('Version', version), nint('DataVersion', dataVersion),
    widthType === 2 ? nshort('Width', size[0]) : nint('Width', size[0]),
    nshort('Height', size[1]), nshort('Length', size[2]),
  ];
  const blockFields = [palette(states), array(version === 3 ? 'Data' : 'BlockData', data)];
  fields.push(...(version === 3 ? [compound('Blocks', blockFields)] : blockFields), ...extra);
  return wrapped ? compound('', [compound('Schematic', fields)]) : compound('Schematic', fields);
}

test('Sponge v2 reads true NBT palette and x-fastest, then z, then y block order', async () => {
  const scene = await parseSchematic('house.schem', fixture());
  assert.deepEqual(scene, {
    version: 1, name: 'house', size: [2, 2, 2], palette: ['#808080', '#a12722'],
    voxels: [
      { x: 1, y: 0, z: 0, color: 0 }, { x: 0, y: 0, z: 1, color: 1 },
      { x: 0, y: 1, z: 0, color: 0 }, { x: 1, y: 1, z: 1, color: 1 },
    ],
  });
});

test('Sponge v3 uses the official nested Schematic and Blocks/Data structure', async () => {
  const scene = await parseSchematic('v3.schem', fixture({ version: 3 }));
  assert.equal(scene.voxels.length, 4);
  assert.deepEqual(scene.size, [2, 2, 2]);
  assert.deepEqual(scene.voxels[3], { x: 1, y: 1, z: 1, color: 1 });
});

test('gzip v2 and gzip v3 preserve the same static geometry as raw NBT', async () => {
  for (const version of [2, 3]) {
    const bytes = fixture({ version });
    assert.deepEqual(await parseSchematic('a.schem', gzipSync(bytes)), await parseSchematic('a.schem', bytes));
  }
});

test('byteOffset views are read correctly', async () => {
  const bytes = fixture();
  const padded = join([33, 44, 55], bytes, [66]);
  assert.equal((await parseSchematic('a.schem', padded.subarray(3, -1))).voxels.length, 4);
});

test('multi-byte and sparse nonnegative palette indices decode correctly', async () => {
  const scene = await parseSchematic('wide.schem', fixture({ size: [2, 1, 1], states: [['stone', 128], ['minecraft:oak_planks', 16384]], data: [0x80, 0x01, 0x80, 0x80, 0x01] }));
  assert.deepEqual(scene.palette, ['#808080', '#a38450']);
  assert.equal(scene.voxels.length, 2);
});

test('air variants are excluded, and colored glass becomes opaque approximate RGB', async () => {
  const scene = await parseSchematic('glass.schem', fixture({ size: [4, 1, 1], states: [['minecraft:cave_air', 0], ['minecraft:void_air', 1], ['minecraft:air', 2], ['minecraft:light_blue_stained_glass', 3]], data: [0, 1, 2, 3] }));
  assert.deepEqual(scene.palette, ['#3aafd9']);
  assert.deepEqual(scene.voxels, [{ x: 3, y: 0, z: 0, color: 0 }]);
});

test('entities, commands, redstone state, block entities and offsets never enter IR', async () => {
  const entity = join(nint('id', 9), named(8, 'Command', str('process.exit(1)')), [0]);
  const extra = [
    named(9, 'Entities', join([10], int(1), entity)),
    named(9, 'BlockEntities', join([10], int(1), entity)),
    named(11, 'Offset', join(int(3), int(-99), int(50), int(10))),
    compound('Metadata', [named(8, 'Name', str('dangerous \" code <script>'))]),
  ];
  const scene = await parseSchematic('circuit.schem', fixture({ size: [1, 1, 1], states: [['minecraft:redstone_wire[power=15,north=side]', 0]], data: [0], extra }));
  assert.deepEqual(scene, { version: 1, name: 'circuit', size: [1, 1, 1], palette: ['#808080'], voxels: [{ x: 0, y: 0, z: 0, color: 0 }] });
  assert.ok(!JSON.stringify(scene).includes('process'));
  assert.ok(!JSON.stringify(scene).includes('redstone'));
});

test('unknown modded blocks use fixed gray and untrusted names cannot alter prototypes', async () => {
  const scene = await parseSchematic('safe\n.schem', fixture({ size: [2, 1, 1], states: [['__proto__', 0], ['custom:stone', 1]], data: [0, 1], extra: [compound('__proto__', [named(8, 'polluted', str('yes'))])] }));
  assert.equal(scene.name, 'safe');
  assert.deepEqual(scene.palette, ['#808080']);
  assert.equal({}.polluted, undefined);
});

test('all-air buildings and unsupported Sponge versions are rejected', async () => {
  await assert.rejects(parseSchematic('air.schem', fixture({ data: [0, 0, 0, 0, 0, 0, 0, 0] })), /没有.*非空气/);
  await assert.rejects(parseSchematic('old.schem', fixture({ version: 1 })), /版本 2 \/ 3/);
});

test('dimension bounds, correct tag types and DataVersion are required', async () => {
  for (const width of [0, -1, 129]) await assert.rejects(parseSchematic('a.schem', fixture({ size: [width, 1, 1], data: [1] })), /尺寸/);
  await assert.rejects(parseSchematic('a.schem', fixture({ widthType: 3 })), /Width/);
  await assert.rejects(parseSchematic('a.schem', fixture({ dataVersion: -1 })), /DataVersion/);
});

test('non-air count is limited independently from full air-padded volume', async () => {
  await assert.rejects(parseSchematic('large.schem', fixture({ size: [33, 32, 32], data: Buffer.alloc(33 * 32 * 32, 1) })), /32768/);
  const data = Buffer.alloc(128 ** 3); data[data.length - 1] = 1;
  const scene = await parseSchematic('sparse.schem', fixture({ size: [128, 128, 128], data }));
  assert.deepEqual(scene.voxels, [{ x: 127, y: 127, z: 127, color: 0 }]);
});

test('malformed varints, undefined palette references and trailing data are rejected', async () => {
  const cases = [
    { data: [], match: /截断/ }, { data: [0x80], match: /截断/ },
    { data: [0xff, 0xff, 0xff, 0xff, 0x08], match: /32 位/ },
    { data: [0x80, 0x80, 0x80, 0x80, 0x80, 0], match: /32 位|5 字节/ },
    { data: [9], match: /不存在/ }, { data: [1, 0], match: /多余/ },
  ];
  for (const { data, match } of cases) await assert.rejects(parseSchematic('bad.schem', fixture({ size: [1, 1, 1], data })), match);
});

test('negative and duplicate palette indices and inconsistent PaletteMax fail', async () => {
  await assert.rejects(parseSchematic('bad.schem', fixture({ states: [['stone', -1]] })), /调色板索引/);
  await assert.rejects(parseSchematic('bad.schem', fixture({ states: [['stone', 1], ['dirt', 1]] })), /调色板索引/);
  await assert.rejects(parseSchematic('bad.schem', fixture({ extra: [nint('PaletteMax', 2)] })), /PaletteMax/);
});

test('unknown well-formed fields of all numeric and array types are skipped', async () => {
  const extra = [named(1, 'byte', [1]), named(4, 'long', Buffer.alloc(8)), named(5, 'float', Buffer.alloc(4)), named(6, 'double', Buffer.alloc(8)), named(11, 'ints', join(int(2), Buffer.alloc(8))), named(12, 'longs', join(int(2), Buffer.alloc(16))), named(9, 'empty', join([0], int(0)))];
  assert.equal((await parseSchematic('a.schem', fixture({ extra }))).voxels.length, 4);
});

test('truncated NBT, duplicate fields, invalid root and trailing bytes fail', async () => {
  const bytes = fixture();
  await assert.rejects(parseSchematic('a.schem', bytes.subarray(0, -1)), /截断/);
  await assert.rejects(parseSchematic('a.schem', join(bytes, [0])), /多余数据/);
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [nint('Version', 2)] })), /重复字段/);
  await assert.rejects(parseSchematic('a.schem', Buffer.from([1, 0, 0, 0])), /根节点/);
});

test('unknown NBT types are rejected even in ignored fields and empty lists', async () => {
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(13, 'unknown', [])] })), /NBT 类型/);
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(9, 'unknown', join([13], int(0)))] })), /列表类型/);
});

test('fatal UTF-8 decoding applies to ignored strings too', async () => {
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(8, 'note', join([0, 2], [0xc0, 0xaf]))] })), /UTF-8/);
});

test('negative array lengths, oversized array/list counts and excessive nesting fail', async () => {
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(7, 'bad', int(-1))] })), /数组长度/);
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(12, 'bad', int(0x7fffffff))] })), /数组长度/);
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [named(9, 'bad', join([1], int(65537)))] })), /列表数量/);
  let nested = compound('nested', []);
  for (let i = 0; i < 34; i++) nested = compound('nested', [nested]);
  await assert.rejects(parseSchematic('a.schem', fixture({ extra: [nested] })), /嵌套深度/);
});

test('input and decompression budgets reject oversized files and gzip bombs', async () => {
  await assert.rejects(parseSchematic('a.schem', Buffer.alloc(8 * 1024 * 1024 + 1)), /8 MiB/);
  await assert.rejects(parseSchematic('a.schem', gzipSync(Buffer.alloc(16 * 1024 * 1024 + 1))), /16 MiB/);
});

test('gzip checksum corruption and truncation fail', async () => {
  const bytes = gzipSync(fixture());
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 8] ^= 0xff;
  await assert.rejects(parseSchematic('a.schem', corrupt), /gzip.*校验/);
  await assert.rejects(parseSchematic('a.schem', bytes.subarray(0, -2)), /gzip.*截断/);
});

test('total tag budget applies across individually valid ignored lists', async () => {
  const extra = ['first', 'second'].map((name) => named(9, name, join([1], int(65536), Buffer.alloc(65536))));
  await assert.rejects(parseSchematic('a.schem', fixture({ extra })), /标签数量/);
});

test('checked-in original gzip building retains its asymmetric markers', async () => {
  const bytes = await readFile(new URL('../samples/tiny-building.schem', import.meta.url));
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  const scene = await parseSchematic('tiny-building.schem', bytes);
  assert.deepEqual(scene.size, [4, 3, 3]);
  assert.equal(scene.voxels.length, 18);
  const red = scene.voxels.find((v) => v.x === 3 && v.y === 2 && v.z === 0);
  const blue = scene.voxels.find((v) => v.x === 0 && v.y === 1 && v.z === 1);
  assert.equal(scene.palette[red.color], '#a12722');
  assert.equal(scene.palette[blue.color], '#35399d');
});
