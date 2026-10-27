import { TARGETS, LIMITS, parseSceneFile, validateScene, transformScene, convertScene, createDemoScene } from './core.js';

const $ = (id) => document.getElementById(id);
const ui = {
  canvas: $('scene-canvas'), wrap: $('canvas-wrap'), empty: $('preview-empty'), sceneName: $('scene-name'),
  file: $('scene-file'), drop: $('drop-zone'), source: $('source-status'), error: $('error-message'), action: $('action-message'),
  target: $('target-select'), rotation: $('rotation-select'), scale: $('scale-select'), mirror: $('mirror-toggle'),
  count: $('voxel-count'), size: $('scene-size'), materials: $('material-count'), palette: $('palette-swatches'),
  download: $('download-button'), copy: $('copy-button'), code: $('code-preview'), filename: $('export-filename'),
  warnings: $('conversion-warnings'), ready: $('export-status'), readyDot: $('ready-dot'),
};
const targetInfo = {
  minecraft: { label: 'Minecraft', extension: '.mcfunction', description: '导出方块放置指令，通过数据包导入自己的世界。', format: 'MCFUNCTION' },
  roblox: { label: 'Roblox Studio', extension: '.lua', description: '导出 Lua 创建脚本，在自己的 Studio 项目生成模型。', format: 'LUA SCRIPT' },
  godot: { label: 'Godot 4', extension: '.tscn', description: '导出可直接打开的 3D 场景，包含可视几何与颜色。', format: 'GODOT SCENE' },
  json: { label: 'GameBridge', extension: '.json', description: '保留通用体素数据，方便再次编辑或构建新适配器。', format: 'SCENE JSON' },
};
let sourceScene = null;
let currentScene = null;
let currentExport = null;
let sourceLabel = '内置示例';
let orbit = 0;
let loadRevision = 0;
let conversionRevision = 0;
let framePending = false;
const colorCache = new Map();

function announce(message) {
  ui.action.textContent = message;
  ui.action.hidden = !message;
}

function showError(error) {
  ui.error.textContent = error instanceof Error ? error.message : String(error);
  ui.error.hidden = false;
}

function invalidateExport(message = '等待有效场景') {
  currentExport = null;
  ui.download.disabled = true;
  ui.copy.disabled = true;
  ui.ready.textContent = message;
  ui.readyDot.classList.add('not-ready');
  ui.filename.textContent = '—';
  $('code-filename').textContent = '尚无导出文件';
  ui.code.textContent = '有效场景转换完成后，导出内容将在这里显示。';
  $('code-truncated').hidden = true;
  ui.warnings.replaceChildren();
  ui.warnings.hidden = true;
}

function clearScene() {
  currentScene = null;
  ui.sceneName.textContent = '等待场景';
  ui.count.textContent = '—';
  ui.size.textContent = '—';
  ui.materials.textContent = '—';
  ui.palette.replaceChildren();
  $('preview-caption').textContent = '尚无有效场景';
  ui.canvas.setAttribute('aria-label', '尚无有效场景');
  queueRender();
}

function updateTargetInfo() {
  const info = targetInfo[ui.target.value];
  $('target-extension').textContent = info.extension;
  $('target-description').textContent = info.description;
  $('route-target').textContent = info.label;
  $('export-format').textContent = info.format;
}

function updateStats(scene) {
  ui.sceneName.textContent = scene.name || '未命名场景';
  ui.count.textContent = scene.voxels.length.toLocaleString('zh-CN');
  ui.size.textContent = scene.size.join(' × ');
  const usedColors = [...new Set(scene.voxels.map((voxel) => scene.palette[voxel.color]))];
  ui.materials.textContent = String(usedColors.length);
  ui.palette.replaceChildren(...usedColors.slice(0, 12).map((color) => {
    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.style.backgroundColor = color;
    swatch.title = color;
    return swatch;
  }));
  $('palette-caption').textContent = usedColors.length > 12 ? `前 12 / ${usedColors.length} 色` : '场景调色板';
  $('preview-caption').textContent = `${sourceLabel === '内置示例' ? '示例场景' : '已导入场景'} · 方向 ${ui.rotation.value}°${ui.mirror.checked ? ' · 镜像' : ''} · ${ui.scale.value}×`;
  ui.canvas.setAttribute('aria-label', `${scene.name || '当前场景'}，${scene.voxels.length} 个体素，尺寸 ${scene.size.join(' × ')} 的等距三维预览`);
}

async function updateConversion() {
  const revision = ++conversionRevision;
  ui.error.hidden = true;
  announce('');
  updateTargetInfo();
  invalidateExport('正在转换…');
  if (!sourceScene) return;
  try {
    const scene = transformScene(sourceScene, { rotation: Number(ui.rotation.value), mirrorX: ui.mirror.checked, scale: Number(ui.scale.value) });
    currentScene = scene;
    updateStats(scene);
    queueRender();
    const result = await convertScene(scene, ui.target.value);
    if (revision !== conversionRevision) return;
    if (!result || typeof result.text !== 'string') throw new Error('转换结果无效，请重试或更换目标格式。');
    currentExport = result;
    ui.filename.textContent = result.filename;
    $('code-filename').textContent = result.filename;
    ui.code.textContent = result.text.slice(0, 24000);
    $('code-truncated').hidden = result.text.length <= 24000;
    const warnings = [...(result.report?.warnings || [])];
    if (/\.schem$/i.test(sourceLabel)) warnings.unshift('Minecraft .schem 仅保留静态建筑和近似颜色；不保留实体、红石逻辑、方块实体及其数据。目标软件的实机导入尚未验收。');
    ui.warnings.replaceChildren(...warnings.map((warning) => {
      const item = document.createElement('li');
      item.textContent = warning;
      return item;
    }));
    ui.warnings.hidden = warnings.length === 0;
    ui.download.disabled = false;
    ui.copy.disabled = false;
    ui.ready.textContent = '转换完成，可以导出';
    ui.readyDot.classList.remove('not-ready');
  } catch (error) {
    if (revision !== conversionRevision) return;
    invalidateExport('请调整设置或重新导入');
    clearScene();
    showError(error);
  }
}

function resetTransforms() {
  ui.rotation.value = '0';
  ui.scale.value = '1';
  ui.mirror.checked = false;
}

async function loadFile(file) {
  if (!file) return;
  const revision = ++loadRevision;
  ++conversionRevision;
  sourceScene = null;
  clearScene();
  invalidateExport('正在读取场景…');
  ui.error.hidden = true;
  announce('');
  ui.source.textContent = `正在读取 ${file.name}…`;
  try {
    if (!/\.(vox|json|schem)$/i.test(file.name)) throw new Error('请选择 Minecraft .schem 建筑、单模型 .vox 或 GameBridge .json 场景文件。');
    if (file.size > LIMITS.fileBytes) throw new Error('场景文件大小不能超过 8 MiB，请先裁剪或简化源场景。');
    const bytes = new Uint8Array(await file.arrayBuffer());
    const parsed = await parseSceneFile(file.name, bytes);
    if (revision !== loadRevision) return;
    sourceScene = validateScene(parsed);
    sourceLabel = file.name;
    resetTransforms();
    orbit = 0;
    ui.source.textContent = `已加载 ${file.name} · ${(file.size / 1024).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} KB · 文件未上传`;
    await updateConversion();
  } catch (error) {
    if (revision !== loadRevision) return;
    sourceScene = null;
    clearScene();
    invalidateExport('导入失败，请重新选择文件');
    ui.source.textContent = `${file.name} 未能导入。可以重新选择文件，或加载示例。`;
    showError(error);
  } finally {
    if (revision === loadRevision) ui.file.value = '';
  }
}

async function loadDemo() {
  ++loadRevision;
  ++conversionRevision;
  try {
    const scene = createDemoScene();
    sourceScene = validateScene(scene);
    sourceLabel = '内置示例';
    resetTransforms();
    orbit = 0;
    ui.source.textContent = '正在使用内置示例 · 可直接调整、导出，也可替换为自己的场景';
    await updateConversion();
  } catch (error) {
    sourceScene = null;
    clearScene();
    invalidateExport('示例场景暂时不可用');
    showError(error);
  }
}

function shade(hex, multiplier) {
  const key = `${hex}:${multiplier}`;
  if (!colorCache.has(key)) {
    const rgb = hex.slice(1).match(/.{2}/g).map((value) => Math.max(0, Math.min(255, Math.round(parseInt(value, 16) * multiplier))));
    colorCache.set(key, `rgb(${rgb.join(',')})`);
  }
  return colorCache.get(key);
}

function queueRender() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => {
    framePending = false;
    renderScene();
  });
}

function renderScene() {
  const rect = ui.wrap.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!width || !height) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ui.canvas.width = Math.round(width * dpr);
  ui.canvas.height = Math.round(height * dpr);
  const ctx = ui.canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ui.empty.hidden = Boolean(currentScene);
  if (!currentScene) return;
  const originalSize = currentScene.size;
  const size = orbit % 2 ? [originalSize[2], originalSize[1], originalSize[0]] : originalSize;
  const voxels = currentScene.voxels.map((voxel) => {
    let { x, y, z } = voxel;
    if (orbit === 1) [x, z] = [originalSize[2] - 1 - z, x];
    if (orbit === 2) [x, z] = [originalSize[0] - 1 - x, originalSize[2] - 1 - z];
    if (orbit === 3) [x, z] = [z, originalSize[0] - 1 - x];
    return { x, y, z, color: voxel.color };
  });
  const unit = Math.max(.1, Math.min((width - 85) / (size[0] + size[2]), (height - 100) / ((size[0] + size[2]) * .48 + size[1]), 17));
  const side = unit * .48;
  const topWidth = (size[0] + size[2]) * unit;
  const topHeight = (size[0] + size[2]) * side + size[1] * unit;
  const originX = (width - topWidth) / 2 + size[2] * unit;
  const originY = (height - topHeight) / 2 + size[1] * unit + 3;
  const point = (x, y, z) => [originX + (x - z) * unit, originY + (x + z) * side - y * unit];
  const line = (a, b) => { ctx.beginPath(); ctx.moveTo(...a); ctx.lineTo(...b); ctx.stroke(); };
  ctx.strokeStyle = 'rgba(154,181,151,.085)';
  ctx.lineWidth = .6;
  const gridExtent = Math.max(size[0], size[2]) + 8;
  const gridStep = Math.max(1, Math.ceil(gridExtent / 30));
  for (let n = -8; n <= gridExtent; n += gridStep) {
    line(point(n, -.04, -8), point(n, -.04, gridExtent));
    line(point(-8, -.04, n), point(gridExtent, -.04, n));
  }
  const shadowCenter = point(size[0] / 2, -.1, size[2] / 2);
  ctx.save();
  ctx.translate(...shadowCenter);
  ctx.scale(1, .38);
  const shadowRadius = Math.max(size[0], size[2]) * unit * .83;
  const shadow = ctx.createRadialGradient(0, 0, 0, 0, 0, shadowRadius);
  shadow.addColorStop(0, '#101b13a0');
  shadow.addColorStop(1, '#101b1300');
  ctx.fillStyle = shadow;
  ctx.beginPath();
  ctx.arc(0, 0, shadowRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  const occupied = new Set(voxels.map((v) => `${v.x},${v.y},${v.z}`));
  const has = (x, y, z) => occupied.has(`${x},${y},${z}`);
  voxels.sort((a, b) => (a.x + a.z + a.y) - (b.x + b.z + b.y) || a.y - b.y || a.x - b.x);
  const face = (vertices, color) => {
    ctx.beginPath();
    ctx.moveTo(...vertices[0]);
    for (let index = 1; index < vertices.length; index++) ctx.lineTo(...vertices[index]);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    if (unit > 3) { ctx.strokeStyle = 'rgba(18,32,18,.12)'; ctx.lineWidth = .4; ctx.stroke(); }
  };
  for (const { x, y, z, color } of voxels) {
    const base = currentScene.palette[color];
    if (!has(x + 1, y, z)) face([point(x + 1, y + 1, z), point(x + 1, y + 1, z + 1), point(x + 1, y, z + 1), point(x + 1, y, z)], shade(base, .72));
    if (!has(x, y, z + 1)) face([point(x + 1, y + 1, z + 1), point(x, y + 1, z + 1), point(x, y, z + 1), point(x + 1, y, z + 1)], shade(base, .86));
    if (!has(x, y + 1, z)) face([point(x, y + 1, z), point(x + 1, y + 1, z), point(x + 1, y + 1, z + 1), point(x, y + 1, z + 1)], shade(base, 1.08));
  }
}

ui.file.addEventListener('change', (event) => loadFile(event.target.files?.[0]));
let dragDepth = 0;
ui.drop.addEventListener('dragenter', (event) => { event.preventDefault(); dragDepth++; ui.drop.classList.add('drag-over'); });
ui.drop.addEventListener('dragover', (event) => { event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'; });
ui.drop.addEventListener('dragleave', (event) => { event.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; ui.drop.classList.remove('drag-over'); } });
ui.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  ui.drop.classList.remove('drag-over');
  const files = event.dataTransfer?.files;
  if (files?.length > 1) {
    ++loadRevision;
    ++conversionRevision;
    sourceScene = null;
    clearScene();
    invalidateExport('请重新选择单个场景文件');
    showError(new Error('每次请只导入一个场景文件。'));
    return;
  }
  loadFile(files?.[0]);
});
window.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
window.addEventListener('drop', (event) => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
for (const control of [ui.target, ui.rotation, ui.scale, ui.mirror]) control.addEventListener('change', updateConversion);
$('demo-button').addEventListener('click', loadDemo);
$('reset-button').addEventListener('click', () => { resetTransforms(); updateConversion(); });
$('orbit-button').addEventListener('click', () => { orbit = (orbit + 1) % 4; queueRender(); announce('已旋转预览视角；导出场景的方向保持当前设置。'); });
ui.download.addEventListener('click', () => {
  if (!currentExport) return;
  const blob = new Blob([currentExport.text], { type: currentExport.mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = currentExport.filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  announce(`已生成 ${currentExport.filename}，并请求浏览器下载。点击“查看说明”了解导入步骤。`);
});
ui.copy.addEventListener('click', async () => {
  if (!currentExport) return;
  const text = currentExport.text;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText(text);
    announce('完整导出内容已复制到剪贴板。');
  } catch {
    $('code-panel').open = true;
    ui.code.textContent = text;
    $('code-truncated').hidden = true;
    const range = document.createRange();
    range.selectNodeContents(ui.code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    announce('浏览器未允许自动复制。已选中完整内容，请按 Ctrl+C 或 ⌘C 复制，或直接下载文件。');
  }
});
const helpDialog = $('help-dialog');
$('help-button').addEventListener('click', () => helpDialog.showModal());
$('close-help').addEventListener('click', () => helpDialog.close());
helpDialog.addEventListener('click', (event) => {
  if (event.target !== helpDialog) return;
  const rect = helpDialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) helpDialog.close();
});
if ('ResizeObserver' in window) new ResizeObserver(queueRender).observe(ui.wrap);
else window.addEventListener('resize', queueRender);

// The connector list is owned by the conversion engine. Keep the interface in sync.
if (Array.isArray(TARGETS)) {
  const supported = new Set(TARGETS.map((target) => target.id));
  for (const option of ui.target.options) option.disabled = !supported.has(option.value);
}
loadDemo();
