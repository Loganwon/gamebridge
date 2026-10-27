/**
 * GameBridge's dependency-free, offline voxel conversion core.
 * Internal coordinates are right-handed, Y-up, with integer occupied cells.
 * VOX (X, Y, Z-up) becomes (X, Z, sizeY - 1 - Y), a proper rotation.
 */
export const TARGETS = Object.freeze([
  { id: 'minecraft', label: 'Minecraft Java 1.21', extension: '.mcfunction' },
  { id: 'roblox', label: 'Roblox Studio', extension: '.lua' },
  { id: 'godot', label: 'Godot 4', extension: '.tscn' },
  { id: 'json', label: 'GameBridge JSON', extension: '.json' },
]);

export const LIMITS = Object.freeze({ voxels: 32768, dimension: 128, fileBytes: 8 * 1024 * 1024, palette: 256 });
const fail = (message) => { throw new Error(message); };
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value) => Number.isSafeInteger(value);
const coordinateKey = (x, y, z) => `${x},${y},${z}`;

/** Validate and copy untrusted data, preserving only the documented IR fields. */
export function validateScene(raw) {
  if (!isObject(raw)) fail('场景必须是 JSON 对象。');
  if (raw.version !== 1) fail('仅支持 GameBridge JSON version: 1。');
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(raw.name)) {
    fail('场景名称须为 1–80 个字符，且不能包含控制字符或换行。');
  }
  if (!Array.isArray(raw.size) || raw.size.length !== 3 || !Array.from(raw.size).every((n) => integer(n) && n >= 1 && n <= LIMITS.dimension)) {
    fail(`size 必须是三个 1–${LIMITS.dimension} 的整数。`);
  }
  if (!Array.isArray(raw.palette) || raw.palette.length < 1 || raw.palette.length > LIMITS.palette || !Array.from(raw.palette).every((color) => typeof color === 'string' && /^#[\da-f]{6}$/i.test(color))) {
    fail('palette 须包含 1–256 个 #rrggbb 颜色。');
  }
  if (!Array.isArray(raw.voxels) || raw.voxels.length < 1 || raw.voxels.length > LIMITS.voxels) {
    fail(`场景须包含 1–${LIMITS.voxels.toLocaleString('en-US')} 个体素。`);
  }
  const occupied = new Set();
  const voxels = Array.from(raw.voxels, (voxel, index) => {
    if (!isObject(voxel)) fail(`体素 ${index} 必须是对象。`);
    const { x, y, z, color } = voxel;
    if (![x, y, z].every(integer) || x < 0 || y < 0 || z < 0 || x >= raw.size[0] || y >= raw.size[1] || z >= raw.size[2]) {
      fail(`体素 ${index} 的坐标必须是 size 范围内的非负整数。`);
    }
    if (!integer(color) || color < 0 || color >= raw.palette.length) fail(`体素 ${index} 的颜色索引超出 palette 范围。`);
    const key = coordinateKey(x, y, z);
    if (occupied.has(key)) fail(`重复的体素坐标：${key}。`);
    occupied.add(key);
    return { x, y, z, color };
  });
  return { version: 1, name: raw.name.trim(), size: [...raw.size], palette: raw.palette.map((color) => color.toLowerCase()), voxels };
}

// Official MagicaVoxel default palette, generated in the order specified at:
// https://github.com/ephtracy/voxel-model/blob/master/MagicaVoxel-file-format-vox.txt
function defaultVoxPalette() {
  const colors = [];
  const steps = [255, 204, 153, 102, 51, 0];
  for (const r of steps) for (const g of steps) for (const b of steps) {
    if (r || g || b) colors.push(rgbHex(r, g, b));
  }
  const ramp = [238, 221, 187, 170, 136, 119, 85, 68, 34, 17];
  for (const channel of [0, 1, 2, 3]) for (const level of ramp) {
    colors.push(rgbHex(...[0, 1, 2].map((axis) => channel === 3 || axis === channel ? level : 0)));
  }
  return colors;
}

function rgbHex(r, g, b) {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function parseVox(filename, bytes) {
  if (bytes.byteLength < 20) fail('VOX 文件过短或已截断。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  const uint32 = (offset) => view.getUint32(offset, true);
  if (ascii(0) !== 'VOX ') fail('无效的 VOX 文件标识。');
  const version = uint32(4);
  if (version !== 150 && version !== 200) fail(`不支持 VOX 版本 ${version}；仅支持 150 / 200。`);
  if (ascii(8) !== 'MAIN' || uint32(12) !== 0) fail('VOX 文件必须具有空内容的 MAIN 根块。');
  const mainEnd = 20 + uint32(16);
  if (mainEnd !== bytes.byteLength) fail('VOX MAIN 长度与文件长度不符。');
  let size = null;
  let voxels = null;
  let palette = null;
  let alpha = null;
  let packSeen = false;
  let chunkCount = 0;
  let offset = 20;
  while (offset < mainEnd) {
    if (++chunkCount > 4096) fail('VOX 包含过多数据块。');
    if (offset + 12 > mainEnd) fail('VOX 数据块头已截断。');
    const id = ascii(offset);
    const length = uint32(offset + 4);
    const children = uint32(offset + 8);
    const start = offset + 12;
    const end = start + length;
    if (end > mainEnd || end + children > mainEnd) fail(`VOX ${id} 数据块已截断。`);
    if (['nTRN', 'nGRP', 'nSHP'].includes(id)) fail('暂不支持 VOX 场景图、节点变换或多模型；请导出单一模型。');
    if (children !== 0) fail('暂不支持嵌套 VOX 数据块；请导出单一模型。');
    if (id === 'PACK') {
      if (packSeen || length !== 4 || uint32(start) !== 1) fail('暂不支持多模型 VOX；PACK 必须仅包含一个模型。');
      packSeen = true;
    } else if (id === 'SIZE') {
      if (size || length !== 12 || voxels) fail('VOX 必须仅包含一对 SIZE / XYZI 数据块。');
      size = [uint32(start), uint32(start + 4), uint32(start + 8)];
      if (!size.every((n) => n >= 1 && n <= LIMITS.dimension)) fail(`VOX 每个方向的尺寸须为 1–${LIMITS.dimension}。`);
    } else if (id === 'XYZI') {
      if (!size || voxels || length < 4) fail('VOX XYZI 缺少 SIZE，或包含多个模型。');
      const count = uint32(start);
      if (count < 1 || count > LIMITS.voxels) fail(`VOX 体素数量须为 1–${LIMITS.voxels}。`);
      if (length !== 4 + count * 4) fail('VOX XYZI 长度与体素数量不符。');
      voxels = [];
      for (let index = 0; index < count; index++) {
        const p = start + 4 + index * 4;
        const [x, y, z, color] = bytes.subarray(p, p + 4);
        if (x >= size[0] || y >= size[1] || z >= size[2] || color === 0) fail('VOX 包含越界坐标或无效的零颜色索引。');
        voxels.push({ x, y: z, z: size[1] - 1 - y, color: color - 1 });
      }
    } else if (id === 'RGBA') {
      if (palette || length !== 1024) fail('VOX RGBA 必须是单一 256 色数据块。');
      palette = [];
      alpha = [];
      for (let index = 0; index < 255; index++) {
        const p = start + index * 4;
        palette.push(rgbHex(bytes[p], bytes[p + 1], bytes[p + 2]));
        alpha.push(bytes[p + 3]);
      }
    }
    offset = end;
  }
  if (!size || !voxels) fail('VOX 缺少 SIZE / XYZI 模型数据。');
  if (alpha && voxels.some((voxel) => alpha[voxel.color] !== 255)) fail('暂不支持使用透明色的 VOX；请先将颜色设为完全不透明。');
  return validateScene({
    version: 1,
    name: nameFromFile(filename),
    size: [size[0], size[2], size[1]],
    palette: palette || defaultVoxPalette(),
    voxels,
  });
}

function nameFromFile(filename) {
  return filename.split(/[\\/]/).pop().replace(/\.[^.]+$/, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/gu, '').trim().slice(0, 80) || 'Imported scene';
}

export async function parseSceneFile(filename, bytes) {
  if (typeof filename !== 'string') fail('文件名必须是字符串。');
  if (!(bytes instanceof Uint8Array)) fail('文件内容必须是 Uint8Array。');
  if (bytes.byteLength > LIMITS.fileBytes) fail('文件大小不能超过 8 MiB。');
  if (/\.vox$/i.test(filename)) return parseVox(filename, bytes);
  if (/\.schem$/i.test(filename)) {
    const { parseSchematic } = await import('./schematic.js');
    return validateScene(await parseSchematic(filename, bytes));
  }
  if (!/\.json$/i.test(filename)) fail('目前只支持 .schem、.vox 单模型和 GameBridge .json 文件。');
  let raw;
  try {
    raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('无法读取 JSON：请确认文件为有效的 UTF-8 JSON。');
  }
  return validateScene(raw);
}

/** Mirror X first, rotate clockwise when viewed from above, then replicate cells. */
export function transformScene(raw, options = {}) {
  const scene = validateScene(raw);
  if (!isObject(options)) fail('变换选项必须是对象。');
  const { rotation = 0, mirrorX = false, scale = 1 } = options;
  if (![0, 90, 180, 270].includes(rotation)) fail('旋转角度须为 0、90、180 或 270。');
  if (typeof mirrorX !== 'boolean') fail('mirrorX 必须是布尔值。');
  if (![1, 2, 3, 4].includes(scale)) fail('缩放倍率须为 1、2、3 或 4。');
  const [width, height, depth] = scene.size;
  const rotatedSize = rotation % 180 === 0 ? [width, height, depth] : [depth, height, width];
  const size = rotatedSize.map((n) => n * scale);
  if (size.some((n) => n > LIMITS.dimension)) fail(`变换后的尺寸不能超过 ${LIMITS.dimension}。`);
  if (scene.voxels.length * scale ** 3 > LIMITS.voxels) fail(`变换后体素数量超过 ${LIMITS.voxels}；请降低缩放倍率。`);
  const voxels = [];
  for (const voxel of scene.voxels) {
    let x = mirrorX ? width - 1 - voxel.x : voxel.x;
    let z = voxel.z;
    if (rotation === 90) [x, z] = [depth - 1 - z, x];
    else if (rotation === 180) [x, z] = [width - 1 - x, depth - 1 - z];
    else if (rotation === 270) [x, z] = [z, width - 1 - x];
    for (let dx = 0; dx < scale; dx++) for (let dy = 0; dy < scale; dy++) for (let dz = 0; dz < scale; dz++) {
      voxels.push({ x: x * scale + dx, y: voxel.y * scale + dy, z: z * scale + dz, color: voxel.color });
    }
  }
  return { ...scene, size, voxels };
}

// Average diffuse RGB approximations of full blocks. No scripts or block IDs
// from input files can reach the output commands.
const MINECRAFT_BLOCKS = [
  ['white_concrete', '#cfd5d6'], ['orange_concrete', '#e06101'],
  ['magenta_concrete', '#a9309f'], ['light_blue_concrete', '#2389c6'],
  ['yellow_concrete', '#f0af15'], ['lime_concrete', '#5ea818'],
  ['pink_concrete', '#d5658e'], ['gray_concrete', '#36393d'],
  ['light_gray_concrete', '#7d7d73'], ['cyan_concrete', '#157788'],
  ['purple_concrete', '#64209c'], ['blue_concrete', '#2c2e8f'],
  ['brown_concrete', '#603b1f'], ['green_concrete', '#495b24'],
  ['red_concrete', '#8e2020'], ['black_concrete', '#080a0f'],
  ['stone', '#7d7d7d'], ['smooth_stone', '#9e9e9e'],
  ['oak_planks', '#a2834e'], ['spruce_planks', '#735531'],
  ['birch_planks', '#c0af79'], ['dark_oak_planks', '#422b14'],
  ['terracotta', '#985e43'], ['sandstone', '#d8ca9b'],
  ['red_sandstone', '#ba6321'], ['bricks', '#966153'],
  ['moss_block', '#596d2e'], ['quartz_block', '#e8e4da'],
  ['polished_blackstone', '#353039'], ['sea_lantern', '#acccc5'],
];
const rgb = (hex) => [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
const BLOCK_COLORS = MINECRAFT_BLOCKS.map(([name, hex]) => ({ name, color: rgb(hex) }));

function nearestMinecraftBlock(hex) {
  const color = rgb(hex);
  let best = BLOCK_COLORS[0];
  let bestDistance = Infinity;
  for (const block of BLOCK_COLORS) {
    const distance = block.color.reduce((sum, channel, i) => sum + (channel - color[i]) ** 2, 0);
    if (distance < bestDistance) { best = block; bestDistance = distance; }
  }
  return `minecraft:${best.name}`;
}

function exportMinecraft(scene) {
  const blocks = scene.palette.map(nearestMinecraftBlock);
  const lines = [
    '# GameBridge - Minecraft Java 1.21',
    '# Import only into a local world or a server you are allowed to edit.',
    '# Relative coordinates: execution position is the minimum scene corner.',
    '# Existing blocks at occupied cells will be replaced. Empty cells are unchanged.',
    ...scene.voxels.map(({ x, y, z, color }) => `setblock ~${x} ~${y} ~${z} ${blocks[color]}`),
  ];
  return { text: `${lines.join('\n')}\n`, warnings: [
    '颜色将映射为 30 种预设 Minecraft 实心方块，外观会有差异。',
    '执行会覆盖占用位置的现有方块；空体素不清空。请先备份世界，并在有编辑权限的区域导入。',
    '需要在 Java 1.21 数据包中安装函数并使用有权限的命令执行；不支持基岩版。',
  ] };
}

function luaString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function exportRoblox(scene) {
  const palette = scene.palette.map((hex) => `    Color3.fromRGB(${rgb(hex).join(', ')})`).join(',\n');
  const cells = scene.voxels.map(({ x, y, z, color }) => `    {${x}, ${y}, ${z}, ${color + 1}}`).join(',\n');
  const text = `-- GameBridge: run in the Roblox Studio Command Bar in an owned/editable place.
-- Offline import only. No game client injection or network requests.
-- One voxel = one stud. Change origin to move the entire imported scene.
local origin = Vector3.new(0, 0, 0)
local colors = {
${palette}
}
local cells = {
${cells}
}
local model = Instance.new("Model")
model.Name = ${luaString(scene.name)}
for index, cell in ipairs(cells) do
    local part = Instance.new("Part")
    part.Name = "Voxel_" .. index
    part.Size = Vector3.new(1, 1, 1)
    part.Position = origin + Vector3.new(cell[1] + 0.5, cell[2] + 0.5, cell[3] + 0.5)
    part.Anchored = true
    part.CanCollide = true
    part.Material = Enum.Material.SmoothPlastic
    part.TopSurface = Enum.SurfaceType.Smooth
    part.BottomSurface = Enum.SurfaceType.Smooth
    part.Color = colors[cell[4]]
    part.Parent = model
end
model.Parent = workspace
print("GameBridge: imported " .. #cells .. " voxels")
`;
  return { text, warnings: [
    '仅在 Roblox Studio 中对有编辑权限的 Place 执行。每个体素生成一个 Anchored Part；大场景可能影响性能。',
    '只保留体素几何和 RGB 颜色；不包含原游戏的脚本、材质、交互或角色。',
  ] };
}

function exportGodot(scene) {
  const used = [...new Set(scene.voxels.map((voxel) => voxel.color))].sort((a, b) => a - b);
  const lines = [`[gd_scene load_steps=${used.length * 2 + 1} format=3]`, ''];
  for (const index of used) {
    const channels = rgb(scene.palette[index]).map((n) => Number((n / 255).toFixed(6)));
    lines.push(`[sub_resource type="StandardMaterial3D" id="Material_${index}"]`, `albedo_color = Color(${channels.join(', ')}, 1)`, 'roughness = 0.9', '',
      `[sub_resource type="BoxMesh" id="Mesh_${index}"]`, `material = SubResource("Material_${index}")`, 'size = Vector3(1, 1, 1)', '');
  }
  lines.push('[node name="GameBridgeScene" type="Node3D"]', '');
  scene.voxels.forEach(({ x, y, z, color }, index) => {
    lines.push(`[node name="Voxel_${index}" type="MeshInstance3D" parent="."]`, `position = Vector3(${x + 0.5}, ${y + 0.5}, ${z + 0.5})`, `mesh = SubResource("Mesh_${color}")`, '');
  });
  return { text: lines.join('\n'), warnings: [
    'Godot 4 场景只包含网格和共享材质，未生成碰撞体、灯光、相机或游戏逻辑。',
    '每个体素生成一个 MeshInstance3D；大场景应进一步合并网格或使用 MultiMesh 优化。',
  ] };
}

function fileStem(name) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'gamebridge-scene';
}

export function convertScene(raw, target) {
  const scene = validateScene(raw);
  const definition = TARGETS.find((entry) => entry.id === target);
  if (!definition) fail('未知的导出格式。');
  let output;
  if (target === 'minecraft') output = exportMinecraft(scene);
  else if (target === 'roblox') output = exportRoblox(scene);
  else if (target === 'godot') output = exportGodot(scene);
  else output = { text: `${JSON.stringify(scene, null, 2)}\n`, warnings: [] };
  return {
    filename: `${fileStem(scene.name)}${definition.extension}`,
    text: output.text,
    mime: target === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8',
    report: {
      voxelCount: scene.voxels.length,
      dimensions: [...scene.size],
      warnings: ['只保留静态体素和 RGB 颜色；原方块身份、方块状态、实体、脚本与游戏逻辑不保留。', ...output.warnings],
    },
  };
}

/** A small original gateway and suspended garden, created for this project. */
export function createDemoScene() {
  const palette = ['#91b78c', '#557a62', '#c3c9bb', '#e5d9b9', '#e9a979', '#6c808e', '#b2dce0', '#d4bd92'];
  const occupied = new Map();
  const put = (x, y, z, color) => occupied.set(coordinateKey(x, y, z), { x, y, z, color });
  const box = (x0, y0, z0, x1, y1, z1, color) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) put(x, y, z, color);
  };
  // An irregular floating island with a grass top and exposed limestone.
  for (let x = 1; x < 19; x++) for (let z = 1; z < 19; z++) {
    const distance = ((x - 9.5) / 9) ** 2 + ((z - 9.5) / 8.8) ** 2;
    if (distance < 1) {
      put(x, 3, z, (x + z) % 7 === 0 ? 1 : 0);
      put(x, 2, z, 2);
      if (distance < 0.73) put(x, 1, z, 5);
      if (distance < 0.30) put(x, 0, z, 2);
    }
  }
  // A broad path and monumental gate: columns, stepped lintel, inlay.
  box(8, 3, 1, 11, 3, 17, 3);
  box(5, 4, 9, 6, 10, 10, 3);
  box(13, 4, 9, 14, 10, 10, 3);
  box(4, 4, 8, 7, 4, 11, 2);
  box(12, 4, 8, 15, 4, 11, 2);
  box(4, 10, 8, 15, 11, 11, 4);
  box(3, 11, 8, 16, 11, 11, 4);
  box(5, 12, 8, 14, 12, 11, 7);
  box(7, 13, 9, 12, 13, 10, 3);
  box(7, 10, 9, 12, 10, 10, 6);
  // Low garden walls with cyan lanterns.
  for (const x of [4, 15]) {
    box(x, 4, 3, x, 4, 6, 3);
    box(x, 4, 13, x, 4, 15, 3);
    for (const z of [3, 6, 13, 15]) { put(x, 5, z, 5); put(x, 6, z, 6); }
  }
  for (const [x, z] of [[3, 10], [16, 7], [6, 15]]) {
    put(x, 4, z, 7);
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) put(x + dx, 5, z + dz, 1);
    put(x, 6, z, 0);
  }
  return validateScene({ version: 1, name: 'Cloud Gate', size: [20, 14, 20], palette, voxels: [...occupied.values()] });
}
