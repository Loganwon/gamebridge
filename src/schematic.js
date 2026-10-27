/**
 * Offline, bounded reader for the static-block subset of Sponge .schem v2/v3.
 * https://github.com/SpongePowered/Schematic-Specification/tree/master/versions
 * Deliberately discards entities, block entities, properties, offsets and logic.
 */
const INPUT_LIMIT = 8 * 1024 * 1024;
const INFLATED_LIMIT = 16 * 1024 * 1024;
const TAG_LIMIT = 131072;
const LIST_LIMIT = 65536;
const DEPTH_LIMIT = 32;
const DIMENSION_LIMIT = 128;
const VOXEL_LIMIT = 32768;
const PALETTE_LIMIT = 65536;
const fail = (message) => { throw new Error(`SCHEM：${message}`); };

async function unpack(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream !== 'function') fail('此环境不支持 gzip 解压，请使用现代浏览器或 Node.js 24。');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > INFLATED_LIMIT) {
        await reader.cancel().catch(() => {});
        fail('gzip 解压后不能超过 16 MiB。');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error.message?.startsWith('SCHEM：')) throw error;
    fail('gzip 数据损坏、截断或校验失败。');
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// Retain only fields used by this converter, but validate and bound every tag.
// Null-prototype compounds and duplicate-key rejection avoid prototype surprises.
function readNbt(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let offset = 0;
  let tags = 0;
  function need(length) {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) fail('NBT 数据截断或长度无效。');
  }
  function u8() { need(1); return view.getUint8(offset++); }
  function i32() { need(4); const n = view.getInt32(offset); offset += 4; return n; }
  function string() {
    need(2);
    const length = view.getUint16(offset); offset += 2;
    need(length);
    let result;
    try { result = decoder.decode(bytes.subarray(offset, offset + length)); }
    catch { fail('NBT 字符串不是有效 UTF-8。'); }
    offset += length;
    return result;
  }
  function childMode(mode, name) {
    if (mode === 'root' && name === 'Schematic') return 'schematic';
    if (mode === 'root' || mode === 'schematic') {
      if (name === 'Blocks') return 'blocks';
      if (name === 'Palette') return 'palette';
      if (['Version', 'DataVersion', 'Width', 'Height', 'Length', 'BlockData', 'PaletteMax'].includes(name)) return 'value';
    }
    if (mode === 'blocks') {
      if (name === 'Palette') return 'palette';
      if (name === 'Data') return 'value';
    }
    if (mode === 'palette') return 'value';
    return null;
  }
  function payload(type, depth, mode) {
    if (++tags > TAG_LIMIT) fail('NBT 标签数量超过安全上限。');
    if (depth > DEPTH_LIMIT) fail('NBT 嵌套深度超过 32。');
    if (type < 1 || type > 12) fail(`不支持或无效的 NBT 类型 ${type}。`);
    if (type === 1) { need(1); const n = view.getInt8(offset); offset++; return n; }
    if (type === 2) { need(2); const n = view.getInt16(offset); offset += 2; return n; }
    if (type === 3) return i32();
    if ([4, 5, 6].includes(type)) { const size = type === 5 ? 4 : 8; need(size); offset += size; return undefined; }
    if (type === 8) return string();
    if ([7, 11, 12].includes(type)) {
      const count = i32();
      const width = type === 7 ? 1 : type === 11 ? 4 : 8;
      if (count < 0 || count > Math.floor(INFLATED_LIMIT / width)) fail('NBT 数组长度超过安全上限或为负数。');
      const length = count * width;
      need(length);
      const result = mode && type === 7 ? bytes.subarray(offset, offset + length) : undefined;
      offset += length;
      return result;
    }
    if (type === 9) {
      const subtype = u8();
      const count = i32();
      if (subtype > 12 || (subtype === 0 && count !== 0)) fail('NBT 列表类型无效。');
      if (count < 0 || count > LIST_LIMIT) fail('NBT 列表数量超过安全上限或为负数。');
      for (let i = 0; i < count; i++) payload(subtype, depth + 1, null);
      return undefined;
    }
    const result = mode ? Object.create(null) : null;
    const names = new Set();
    while (true) {
      const subtype = u8();
      if (subtype === 0) break;
      if (subtype > 12) fail(`不支持或无效的 NBT 类型 ${subtype}。`);
      const name = string();
      if (names.has(name)) fail('NBT compound 包含重复字段。');
      names.add(name);
      const selected = childMode(mode, name);
      const value = payload(subtype, depth + 1, selected);
      if (selected) result[name] = { type: subtype, value };
    }
    return result;
  }
  if (u8() !== 10) fail('NBT 根节点必须为 compound。');
  string(); // Root name differs between tools; v3 uses a nested Schematic compound.
  const root = payload(10, 0, 'root');
  if (offset !== bytes.length) fail('NBT 根节点后存在多余数据。');
  if (Object.hasOwn(root, 'Schematic')) {
    if (Object.hasOwn(root, 'Version')) fail('存在冲突的根节点与 Schematic 版本。');
    return field(root, 'Schematic', 10);
  }
  return root;
}

function field(compound, name, type) {
  if (!compound || !Object.hasOwn(compound, name) || compound[name].type !== type) fail(`缺少 ${name} 或 NBT 类型错误。`);
  return compound[name].value;
}

const DYES = Object.freeze({
  white: '#e9ecec', orange: '#f07613', magenta: '#bd44b3', light_blue: '#3aafd9',
  yellow: '#f8c627', lime: '#70b919', pink: '#ed8dac', gray: '#3e4447',
  light_gray: '#8e8e86', cyan: '#158991', purple: '#792aac', blue: '#35399d',
  brown: '#724728', green: '#546d1b', red: '#a12722', black: '#141519',
});
const WOODS = Object.freeze({ oak: '#a38450', spruce: '#735531', birch: '#c2b176', jungle: '#a87850', acacia: '#ad5d32', dark_oak: '#4f3218', mangrove: '#76392c', cherry: '#dca3a1', bamboo: '#b7a651', crimson: '#793b55', warped: '#397e78' });

function blockColor(state) {
  const id = state.split('[', 1)[0];
  const qualified = id.includes(':') ? id : `minecraft:${id}`;
  if (['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'].includes(qualified)) return null;
  if (!qualified.startsWith('minecraft:')) return '#808080';
  const block = qualified.slice('minecraft:'.length);
  for (const [dye, color] of Object.entries(DYES)) {
    if ([`${dye}_wool`, `${dye}_concrete`, `${dye}_concrete_powder`, `${dye}_terracotta`, `${dye}_stained_glass`, `${dye}_stained_glass_pane`].includes(block)) return color;
  }
  for (const wood of Object.keys(WOODS).sort((a, b) => b.length - a.length)) {
    if (new RegExp(`^(stripped_)?${wood}_(planks|log|wood|stem|hyphae|stairs|slab|fence|fence_gate|door|trapdoor)$`).test(block)) return WOODS[wood];
  }
  // Coarse colors deliberately do not carry block identity or state into IR.
  if (block.includes('glass') || block === 'ice' || block === 'packed_ice') return '#b7d9e8';
  if (block.includes('leaves') || ['grass_block', 'moss_block', 'moss_carpet'].includes(block)) return '#618a3f';
  if (block.includes('dirt') || ['mud', 'farmland', 'rooted_dirt'].includes(block)) return '#866043';
  if (block.includes('sandstone') || block === 'sand') return '#d9cc91';
  if (block === 'red_sand') return '#bf6b35';
  if (block.includes('snow') || block === 'quartz_block' || block === 'quartz_bricks') return '#e9ecec';
  if (block === 'water') return '#3f76e4';
  if (block === 'lava' || block === 'magma_block') return '#db7026';
  if (block === 'bricks' || block === 'brick_slab' || block === 'brick_stairs') return '#a45c4b';
  if (block.includes('deepslate') || block.includes('blackstone') || block === 'obsidian') return '#44434b';
  if (block.includes('stone') || block === 'gravel' || block === 'andesite') return '#808080';
  if (block === 'gold_block') return '#f8c627';
  if (block === 'iron_block') return '#c5c5c5';
  if (block === 'copper_block') return '#ba7254';
  if (block === 'diamond_block') return '#59d7cf';
  return '#808080';
}

function safeName(filename) {
  return filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim().slice(0, 80) || 'Imported schematic';
}

/** Parse uncompressed NBT or gzip Sponge v2/v3; return only the IR data fields. */
export async function parseSchematic(filename, bytes) {
  if (typeof filename !== 'string' || !(bytes instanceof Uint8Array)) fail('需要文件名与 Uint8Array 内容。');
  if (bytes.byteLength > INPUT_LIMIT) fail('输入文件不能超过 8 MiB。');
  if (bytes.byteLength === 0) fail('文件为空。');
  const schematic = readNbt(await unpack(bytes));
  const version = field(schematic, 'Version', 3);
  if (version !== 2 && version !== 3) fail(`仅支持 Sponge 版本 2 / 3，收到 ${version}。`);
  const dataVersion = field(schematic, 'DataVersion', 3);
  if (dataVersion < 0) fail('DataVersion 必须为非负整数。');
  const size = ['Width', 'Height', 'Length'].map((name) => field(schematic, name, 2) & 0xffff);
  if (size.some((n) => n < 1 || n > DIMENSION_LIMIT)) fail('每个方向的尺寸须为 1–128。');
  const blocks = version === 3 ? field(schematic, 'Blocks', 10) : schematic;
  const sourcePalette = field(blocks, 'Palette', 10);
  const entries = Object.entries(sourcePalette);
  if (entries.length < 1 || entries.length > PALETTE_LIMIT) fail('方块调色板数量须为 1–65536。');
  const colorsById = new Map();
  for (const [state, tag] of entries) {
    if (tag.type !== 3 || tag.value < 0 || colorsById.has(tag.value)) fail('调色板索引须为互不重复的非负 NBT Int。');
    colorsById.set(tag.value, blockColor(state));
  }
  if (version === 2 && Object.hasOwn(schematic, 'PaletteMax')) {
    const maximum = field(schematic, 'PaletteMax', 3);
    if (maximum < 1 || [...colorsById.keys()].some((index) => index >= maximum)) fail('PaletteMax 与调色板索引不符。');
  }
  const data = field(blocks, version === 3 ? 'Data' : 'BlockData', 7);
  const [width, height, length] = size;
  const volume = width * height * length;
  const palette = [];
  const paletteIds = new Map();
  const voxels = [];
  let offset = 0;
  for (let index = 0; index < volume; index++) {
    let value = 0;
    let complete = false;
    for (let byteIndex = 0; byteIndex < 5; byteIndex++) {
      if (offset >= data.length) fail('BlockData/Data 的 varint 或方块数量已截断。');
      const byte = data[offset++];
      if (byteIndex === 4 && byte > 7) fail('方块 varint 超过非负 32 位整数范围。');
      value += (byte & 0x7f) * (2 ** (byteIndex * 7));
      if ((byte & 0x80) === 0) { complete = true; break; }
    }
    if (!complete) fail('方块 varint 超过 5 字节。');
    if (!colorsById.has(value)) fail(`方块引用了不存在的调色板索引 ${value}。`);
    const hex = colorsById.get(value);
    if (hex === null) continue;
    if (voxels.length >= VOXEL_LIMIT) fail('非空气方块不能超过 32768 个。');
    if (!paletteIds.has(hex)) { paletteIds.set(hex, palette.length); palette.push(hex); }
    voxels.push({ x: index % width, y: Math.floor(index / (width * length)), z: Math.floor(index / width) % length, color: paletteIds.get(hex) });
  }
  if (offset !== data.length) fail('BlockData/Data 包含多余方块或尾随字节。');
  if (voxels.length === 0) fail('建筑没有可转换的非空气方块。');
  return { version: 1, name: safeName(filename), size, palette, voxels };
}
