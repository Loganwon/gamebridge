import { constants } from 'node:fs';
import { access, lstat, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCompilerProcess } from '../../build/runner.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const TMODLOADER_TARGET = Object.freeze({
  release: 'v2026.08.3.0', version: '2026.8.3.0', terrariaContentVersion: '1.4.4.9',
  commit: 'c9545cf27d56c456321e1896274c02adf67d0140', framework: 'net8.0', sdkMajor: 8, sdkVersion: '8.0.427',
  sdkArchitecture: 'x64', platform: 'darwin',
  requiredReferenceAssemblies: Object.freeze(['FNA', 'ReLogic', 'log4net']),
  targetsTemplateSha256: '2f6cb2de1214e7d210507d5d34ec24dabba58bd4274d7ab0d6802789cfccc07c',
});
export const TMODLOADER_ENVIRONMENT_LIMITS = Object.freeze({
  assemblyBytes: 128 * 1024 * 1024, metadataBytes: 64 * 1024 * 1024,
  configurationBytes: 256 * 1024, targetsBytes: 16 * 1024, metadataRows: 250_000,
  referenceFiles: 512, directoryEntries: 4096, directoryDepth: 8,
  referencePathBytes: 768, absolutePathBytes: 4096,
  totalReferenceBytes: 384 * 1024 * 1024, sdkProbeTimeoutMs: 10000, sdkOutputBytes: 32768,
  inspectionTimeoutMs: 30000,
});
const SOURCES = Object.freeze([
  'https://github.com/tModLoader/tModLoader/releases/tag/v2026.08.3.0',
  'https://github.com/tModLoader/tModLoader/wiki/Developing-with-Visual-Studio-Code',
  'https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/BuildInfo.cs',
  'https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/ModLoader/Mod.cs',
  'https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/Terraria/Terraria/Terraria.csproj.patch',
  'https://raw.githubusercontent.com/tModLoader/tModLoader/v2026.08.3.0/patches/tModLoader/Terraria/release_extras/tMLMod.targets',
]);
const REQUIRED_TYPES = ['Terraria.Main', 'Terraria.Player', 'Terraria.ModLoader.Mod', 'Terraria.ModLoader.ModPlayer', 'Terraria.ModLoader.ModItem', 'Terraria.ModLoader.ModProjectile', 'Terraria.ModLoader.GlobalItem', 'Terraria.ModLoader.ModSystem'];
const UNSAFE_BUILD_PATH = /[\x00-\x1f\x7f;,$%@\\]/;
function safeBuildPath(value, maxBytes) {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes && !UNSAFE_BUILD_PATH.test(value);
}
function issue(code, message) { return { code, message }; }
function invalid(message = 'Invalid managed assembly metadata.') { const error = new Error(message); error.code = 'INVALID_MANAGED_METADATA'; throw error; }
function cancelled(signal) { if (signal?.aborted) { const error = new Error('Preflight cancelled.'); error.code = 'CANCELLED'; throw error; } }
function versionParts(value) { return typeof value === 'string' && /^\d+(?:\.\d+){1,3}$/.test(value) ? value.split('.').map(Number).join('.') : null; }

/** Reads ECMA-335 metadata as bounded bytes. Never loads or invokes the assembly. */
export function readManagedAssemblyMetadata(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 512 || bytes.length > TMODLOADER_ENVIRONMENT_LIMITS.assemblyBytes) invalid();
  const range = (offset, length) => { if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) invalid(); };
  const u16 = offset => { range(offset, 2); return bytes.readUInt16LE(offset); };
  const u32 = offset => { range(offset, 4); return bytes.readUInt32LE(offset); };
  if (u16(0) !== 0x5a4d) invalid();
  const pe = u32(0x3c);
  if (u32(pe) !== 0x00004550) invalid();
  const machine = u16(pe + 4), sectionCount = u16(pe + 6), optionalSize = u16(pe + 20), optional = pe + 24;
  // ReadyToRun assemblies can use OS-specific machine values. This is a
  // metadata reader, not an executable architecture/safety authenticator.
  if (sectionCount < 1 || sectionCount > 96) invalid();
  const magic = u16(optional), dataDirectory = magic === 0x10b ? optional + 96 : magic === 0x20b ? optional + 112 : -1;
  if (dataDirectory < 0 || dataDirectory + 15 * 8 > optional + optionalSize) invalid();
  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const at = optional + optionalSize + index * 40; range(at, 40);
    sections.push({ virtualSize: u32(at + 8), rva: u32(at + 12), size: u32(at + 16), offset: u32(at + 20) });
  }
  function fromRva(rva, length) {
    const section = sections.find(item => rva >= item.rva && rva - item.rva < Math.max(item.size, item.virtualSize));
    if (!section || rva - section.rva + length > section.size) invalid();
    const offset = section.offset + rva - section.rva; range(offset, length); return offset;
  }
  const cli = fromRva(u32(dataDirectory + 14 * 8), 72);
  if (u32(cli) < 72) invalid();
  const metadataSize = u32(cli + 12);
  if (metadataSize < 32 || metadataSize > TMODLOADER_ENVIRONMENT_LIMITS.metadataBytes) invalid();
  const metadata = fromRva(u32(cli + 8), metadataSize), metadataEnd = metadata + metadataSize;
  if (u32(metadata) !== 0x424a5342) invalid();
  const versionLength = u32(metadata + 12);
  if (versionLength > 256) invalid();
  let cursor = metadata + 16 + versionLength;
  cursor = Math.ceil(cursor / 4) * 4;
  range(cursor, 4); const streamCount = u16(cursor + 2); cursor += 4;
  if (streamCount < 2 || streamCount > 16) invalid();
  const streams = new Map();
  for (let index = 0; index < streamCount; index++) {
    const offset = u32(cursor), length = u32(cursor + 4); cursor += 8;
    let end = cursor;
    while (end < Math.min(cursor + 32, metadataEnd) && bytes[end] !== 0) end++;
    if (end >= Math.min(cursor + 32, metadataEnd)) invalid();
    const name = bytes.toString('ascii', cursor, end);
    cursor += Math.ceil((end - cursor + 1) / 4) * 4;
    if (offset + length > metadataSize || streams.has(name)) invalid();
    streams.set(name, { offset: metadata + offset, length });
  }
  const tableStream = streams.get('#~') || streams.get('#-'), strings = streams.get('#Strings'), blobs = streams.get('#Blob');
  if (!tableStream || !strings || !blobs || tableStream.length < 24) invalid();
  const tables = tableStream.offset;
  const heapSizes = bytes[tables + 6];
  if (heapSizes & ~7) invalid('Unsupported managed metadata heap format.');
  const stringSize = heapSizes & 1 ? 4 : 2, guidSize = heapSizes & 2 ? 4 : 2, blobSize = heapSizes & 4 ? 4 : 2;
  const valid = bytes.readBigUInt64LE(tables + 8), rows = new Array(64).fill(0), offsets = new Array(64).fill(0), widths = new Array(64).fill(0);
  cursor = tables + 24;
  for (let id = 0; id < 64; id++) if (valid & (1n << BigInt(id))) {
    if (cursor + 4 > tables + tableStream.length) invalid();
    rows[id] = u32(cursor); cursor += 4;
    if (rows[id] > TMODLOADER_ENVIRONMENT_LIMITS.metadataRows) invalid();
  }
  const tableIndex = id => rows[id] < 65536 ? 2 : 4;
  const coded = (ids, bits) => Math.max(...ids.map(id => rows[id])) < 2 ** (16 - bits) ? 2 : 4;
  const typeDefOrRef = coded([2, 1, 27], 2), resolutionScope = coded([0, 26, 35, 1], 2);
  const memberRefParent = coded([2, 1, 26, 6, 27], 3);
  const hasCustomAttribute = coded([6, 4, 1, 2, 8, 9, 10, 0, 14, 23, 20, 17, 26, 27, 32, 35, 38, 39, 40, 42, 44, 43], 5);
  const customAttributeType = coded([6, 10], 3);
  const sizes = [
    2 + stringSize + 3 * guidSize, resolutionScope + 2 * stringSize,
    4 + 2 * stringSize + typeDefOrRef + tableIndex(4) + tableIndex(6), tableIndex(4),
    2 + stringSize + blobSize, tableIndex(6), 8 + stringSize + blobSize + tableIndex(8), tableIndex(8),
    4 + stringSize, tableIndex(2) + typeDefOrRef, memberRefParent + stringSize + blobSize,
    2 + coded([4, 8, 23], 2) + blobSize, hasCustomAttribute + customAttributeType + blobSize,
    coded([4, 8], 1) + blobSize, 2 + coded([2, 6, 32], 2) + blobSize,
    6 + tableIndex(2), 4 + tableIndex(4), blobSize, tableIndex(2) + tableIndex(20), tableIndex(20),
    2 + stringSize + typeDefOrRef, tableIndex(2) + tableIndex(23), tableIndex(23), 2 + stringSize + blobSize,
    2 + tableIndex(6) + coded([20, 23], 1), tableIndex(2) + 2 * coded([6, 10], 1), stringSize, blobSize,
    2 + coded([4, 6], 1) + stringSize + tableIndex(26), 4 + tableIndex(4), 8, 4,
    16 + blobSize + 2 * stringSize,
  ];
  for (let id = 0; id <= 32; id++) {
    widths[id] = sizes[id]; offsets[id] = cursor;
    cursor += rows[id] * widths[id];
    if (cursor > tables + tableStream.length) invalid();
  }
  if (rows[32] !== 1) invalid('Expected one assembly definition.');
  function indexAt(offset, size) { return size === 2 ? u16(offset) : u32(offset); }
  function stringAt(index) {
    if (index >= strings.length) invalid();
    const start = strings.offset + index; let end = start;
    while (end < strings.offset + strings.length && end - start <= 1024 && bytes[end] !== 0) end++;
    if (end >= strings.offset + strings.length || end - start > 1024) invalid();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end)); } catch { invalid(); }
  }
  function compressed(offset, end) {
    if (offset >= end) invalid(); const first = bytes[offset];
    if (first < 0x80) return { value: first, length: 1 };
    if ((first & 0xc0) === 0x80 && offset + 2 <= end) return { value: ((first & 0x3f) << 8) | bytes[offset + 1], length: 2 };
    if ((first & 0xe0) === 0xc0 && offset + 4 <= end) return { value: (first & 0x1f) * 2 ** 24 + bytes[offset + 1] * 65536 + bytes[offset + 2] * 256 + bytes[offset + 3], length: 4 };
    invalid();
  }
  function attributeString(index) {
    if (index >= blobs.length) invalid();
    const length = compressed(blobs.offset + index, blobs.offset + blobs.length);
    const start = blobs.offset + index + length.length, end = start + length.value;
    if (end > blobs.offset + blobs.length || length.value > 4096 || u16(start) !== 1) invalid();
    const textLength = compressed(start + 2, end), textStart = start + 2 + textLength.length;
    if (textLength.value > 512 || textStart + textLength.value + 2 > end) invalid();
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(textStart, textStart + textLength.value));
  }
  const assembly = offsets[32];
  const assemblyVersion = [u16(assembly + 4), u16(assembly + 6), u16(assembly + 8), u16(assembly + 10)].join('.');
  const name = stringAt(indexAt(assembly + 16 + blobSize, stringSize));
  const typeNames = new Set();
  for (let rid = 0; rid < rows[2]; rid++) {
    const at = offsets[2] + rid * widths[2];
    const shortName = stringAt(indexAt(at + 4, stringSize)), namespace = stringAt(indexAt(at + 4 + stringSize, stringSize));
    if (REQUIRED_TYPES.includes(namespace + '.' + shortName)) typeNames.add(namespace + '.' + shortName);
  }
  let informationalVersion = null;
  for (let rid = 0; rid < rows[12]; rid++) {
    const at = offsets[12] + rid * widths[12];
    if (indexAt(at, hasCustomAttribute) !== (1 << 5 | 14)) continue; // Assembly row 1.
    const attribute = indexAt(at + hasCustomAttribute, customAttributeType);
    if ((attribute & 7) !== 3) continue; // MemberRef constructor.
    const memberRid = attribute >> 3;
    if (memberRid < 1 || memberRid > rows[10]) invalid();
    const member = offsets[10] + (memberRid - 1) * widths[10];
    const parent = indexAt(member, memberRefParent);
    if ((parent & 7) !== 1 || stringAt(indexAt(member + memberRefParent, stringSize)) !== '.ctor') continue;
    const typeRid = parent >> 3;
    if (typeRid < 1 || typeRid > rows[1]) invalid();
    const type = offsets[1] + (typeRid - 1) * widths[1];
    if (stringAt(indexAt(type + resolutionScope, stringSize)) !== 'AssemblyInformationalVersionAttribute' ||
        stringAt(indexAt(type + resolutionScope + stringSize, stringSize)) !== 'System.Reflection') continue;
    if (informationalVersion !== null) invalid('Duplicate assembly informational version.');
    informationalVersion = attributeString(indexAt(at + hasCustomAttribute + customAttributeType, blobSize));
  }
  return { name, assemblyVersion, informationalVersion, requiredTypesPresent: REQUIRED_TYPES.every(type => typeNames.has(type)),
    observedRequiredTypes: [...typeNames].sort(), machine, metadataOnly: true };
}

function validateBuildIdentity(metadata) {
  if (metadata.name !== 'tModLoader' || metadata.assemblyVersion !== TMODLOADER_TARGET.terrariaContentVersion || !metadata.requiredTypesPresent || !metadata.informationalVersion) return null;
  const plus = metadata.informationalVersion.indexOf('+');
  if (plus < 0 || versionParts(metadata.informationalVersion.slice(0, plus)) !== TMODLOADER_TARGET.terrariaContentVersion) return null;
  const parts = metadata.informationalVersion.slice(plus + 1).split('|');
  if (parts.length !== 6 || versionParts(parts[0]) !== TMODLOADER_TARGET.version || !versionParts(parts[1]) ||
      parts[2] !== 'stable' || parts[3].toLowerCase() !== 'stable' ||
      parts[4].toLowerCase() !== TMODLOADER_TARGET.commit || !/^-?\d{1,19}$/.test(parts[5])) return null;
  return { version: versionParts(parts[0]), stableVersion: versionParts(parts[1]), branch: parts[2], purpose: 'Stable', commit: parts[4].toLowerCase(),
    versionValidated: true, validationKind: 'managed-metadata-and-pinned-source-profile', publisherSignatureValidated: false };
}

async function checkedFile(root, relative, maxBytes, signal) {
  cancelled(signal);
  if (!safeBuildPath(relative, TMODLOADER_ENVIRONMENT_LIMITS.referencePathBytes) ||
      !safeBuildPath(path.join(root, relative), TMODLOADER_ENVIRONMENT_LIMITS.absolutePathBytes)) throw new Error('unsafe-build-path');
  let current = root;
  for (const segment of relative.split('/')) {
    if (!segment || ['.', '..'].includes(segment)) throw new Error('unsafe');
    current = path.join(current, segment);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('symlink');
  }
  const resolved = await realpath(current), stat = await lstat(resolved);
  if (!resolved.startsWith(root + path.sep) || !stat.isFile() || stat.size < 1 || stat.size > maxBytes) throw new Error('file-limit');
  // Read from one non-following handle, bounded by its checked size. A file
  // growing after stat must not cause readFile to allocate beyond the budget.
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat(); cancelled(signal);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.size > maxBytes) throw new Error('file-changed');
    const bytes = Buffer.allocUnsafe(opened.size); let offset = 0;
    while (offset < bytes.length) {
      cancelled(signal);
      const { bytesRead } = await handle.read(bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
      if (!bytesRead) throw new Error('file-changed');
      offset += bytesRead;
    }
    const extra = await handle.read(Buffer.allocUnsafe(1), 0, 1, offset), after = await handle.stat(); cancelled(signal);
    if (extra.bytesRead || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('file-changed');
    return bytes;
  } finally { await handle.close(); }
}
async function references(root, signal) {
  const files = []; let entries = 0, total = 0;
  async function visit(relative, depth) {
    cancelled(signal);
    if (depth > TMODLOADER_ENVIRONMENT_LIMITS.directoryDepth) throw new Error('depth-limit');
    const dir = path.join(root, relative);
    const dirStat = await lstat(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('unsafe-directory');
    const directory = await opendir(dir, { bufferSize: 1 });
    for await (const item of directory) {
      cancelled(signal);
      if (++entries > TMODLOADER_ENVIRONMENT_LIMITS.directoryEntries) throw new Error('entry-limit');
      const next = relative + '/' + item.name;
      if (!safeBuildPath(next, TMODLOADER_ENVIRONMENT_LIMITS.referencePathBytes) ||
          !safeBuildPath(path.join(root, next), TMODLOADER_ENVIRONMENT_LIMITS.absolutePathBytes)) throw new Error('unsafe-build-path');
      if (['Native', 'tModCodeAssist'].includes(item.name) || /^runtime/i.test(item.name) || item.name.endsWith('.resources.dll')) continue;
      if (item.isSymbolicLink()) throw new Error('symlink');
      if (item.isDirectory()) await visit(next, depth + 1);
      else if (item.isFile() && item.name.toLowerCase().endsWith('.dll')) {
        if (files.length >= TMODLOADER_ENVIRONMENT_LIMITS.referenceFiles) throw new Error('reference-count');
        const bytes = await checkedFile(root, next, Math.min(TMODLOADER_ENVIRONMENT_LIMITS.assemblyBytes, TMODLOADER_ENVIRONMENT_LIMITS.totalReferenceBytes - total), signal);
        total += bytes.length;
        if (total > TMODLOADER_ENVIRONMENT_LIMITS.totalReferenceBytes) throw new Error('reference-bytes');
        const metadata = readManagedAssemblyMetadata(bytes);
        files.push({ relativePath: next, name: metadata.name, assemblyVersion: metadata.assemblyVersion, bytes: bytes.length });
      }
    }
  }
  await visit('Libraries', 0);
  if (!files.length || !TMODLOADER_TARGET.requiredReferenceAssemblies.every(name => files.some(file => file.name === name))) throw new Error('required-reference-missing');
  return { files, totalBytes: total };
}

async function inspectInstall(installPath, issues, signal) {
  const result = { available: false, pathConfigured: Boolean(installPath), versionValidated: false, publisherSignatureValidated: false, referencesValidated: false };
  if (!installPath) { issues.push(issue('TML_INSTALL_PATH_REQUIRED', '请指定真实 tModLoader 安装目录；当前没有读取或扫描游戏目录。')); return result; }
  if (!safeBuildPath(installPath, TMODLOADER_ENVIRONMENT_LIMITS.absolutePathBytes) || !path.isAbsolute(installPath)) {
    issues.push(issue('TML_INSTALL_PATH_INVALID', '安装目录必须是无构建表达式的绝对路径。')); return result;
  }
  let root;
  try {
    const stat = await lstat(installPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-root');
    root = await realpath(installPath);
    if (!safeBuildPath(root, TMODLOADER_ENVIRONMENT_LIMITS.absolutePathBytes)) throw new Error('unsafe-build-path');
  } catch { issues.push(issue('TML_INSTALL_DIRECTORY_UNAVAILABLE', '指定安装目录不存在、不是目录或使用了符号链接。')); return result; }
  result.path = root;
  let metadata;
  try {
    const bytes = await checkedFile(root, 'tModLoader.dll', TMODLOADER_ENVIRONMENT_LIMITS.assemblyBytes, signal);
    metadata = readManagedAssemblyMetadata(bytes);
    result.assembly = { ...metadata, sha256: createHash('sha256').update(bytes).digest('hex') };
    const identity = validateBuildIdentity(metadata);
    if (!identity) issues.push(issue('TML_VERSION_IDENTITY_UNVERIFIED', '程序集未能证明固定 tModLoader 稳定版本、提交与必需类型；名称或版本文本不足以就绪。'));
    else Object.assign(result, identity);
  } catch (error) {
    if (signal?.aborted) throw error;
    issues.push(issue('TML_ASSEMBLY_INVALID', 'tModLoader.dll 缺失、越界、超限或不是可识别的受管程序集。'));
  }
  try {
    const bytes = await checkedFile(root, 'tMLMod.targets', TMODLOADER_ENVIRONMENT_LIMITS.targetsBytes, signal);
    const targets = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n/g, '\n');
    const marker = '<DefineConstants>$(DefineConstants);TML_2026_08</DefineConstants>';
    if (targets.split(marker).length !== 2 || createHash('sha256').update(targets.replace(marker, '<!-- TML stable version define placeholder -->')).digest('hex') !== TMODLOADER_TARGET.targetsTemplateSha256) throw new Error('profile');
    result.targetsProfileValidated = true;
    result.buildTargetsExecuteTool = true; result.buildTargetsIncludeAnalyzers = true;
  } catch (error) {
    if (signal?.aborted) throw error;
    issues.push(issue('TML_TARGETS_PROFILE_UNVERIFIED', '官方构建目标缺失或与固定发布配置不一致；预检不会执行目标文件。'));
  }
  try {
    const config = JSON.parse((await checkedFile(root, 'tModLoader.runtimeconfig.json', TMODLOADER_ENVIRONMENT_LIMITS.configurationBytes, signal)).toString('utf8'));
    const options = config?.runtimeOptions, frameworks = options?.framework ? [options.framework] : options?.frameworks;
    if (options?.tfm !== 'net8.0' || !Array.isArray(frameworks) || frameworks.length > 4 || !frameworks.some(item => item?.name === 'Microsoft.NETCore.App' && /^8\.\d+\.\d+$/.test(item.version))) throw new Error('runtime');
    const deps = JSON.parse((await checkedFile(root, 'tModLoader.deps.json', TMODLOADER_ENVIRONMENT_LIMITS.configurationBytes, signal)).toString('utf8'));
    if (!/^\.NETCoreApp,Version=v8\.0(?:\/[-A-Za-z0-9.]+)?$/.test(deps?.runtimeTarget?.name || '')) throw new Error('deps');
    result.runtimeConfigurationValidated = true;
  } catch (error) {
    if (signal?.aborted) throw error;
    issues.push(issue('TML_RUNTIME_CONFIGURATION_INVALID', '缺少匹配 net8.0 的实际运行时配置或依赖清单。'));
  }
  try { result.references = await references(root, signal); result.referencesValidated = true; }
  catch (error) {
    if (signal?.aborted) throw error;
    const code = { 'unsafe-build-path': 'TML_REFERENCE_PATH_UNSAFE', 'entry-limit': 'TML_REFERENCE_ENTRY_LIMIT', 'required-reference-missing': 'TML_REQUIRED_REFERENCE_MISSING' }[error.message] || 'TML_REFERENCES_UNVERIFIED';
    issues.push(issue(code, '配套库缺失、含不允许链接或构建表达式路径、超限或不是可识别受管程序集；探针至少要求 FNA、ReLogic 和 log4net 受管身份。'));
  }
  result.available = result.versionValidated && result.targetsProfileValidated === true && result.runtimeConfigurationValidated === true && result.referencesValidated;
  return result;
}

async function inspectSdk(dotnetPath, issues, signal) {
  const result = { available: false, versionValidated: false, exactSdkMatch: false, architectureValidated: false, runtimeValidated: false };
  const candidate = dotnetPath || path.join(ROOT, '.tools', 'dotnet8-x64', 'dotnet');
  if (typeof candidate !== 'string' || candidate.length > 4096 || !path.isAbsolute(candidate) || /[\x00-\x1f]/.test(candidate) || !['dotnet', 'dotnet.exe'].includes(path.basename(candidate))) {
    issues.push(issue('TML_SDK_PATH_INVALID', '需要显式可信的 dotnet 可执行文件绝对路径。')); return result;
  }
  let command;
  try {
    const stat = await lstat(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe-sdk');
    await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    command = await realpath(candidate);
  } catch { issues.push(issue('TML_SDK8_X64_MISSING', '未找到项目专用 .NET 8 x64 SDK；现有 SDK 10 不算 tModLoader 环境就绪。')); return result; }
  result.path = command;
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-tml-sdk-'));
  try {
    const options = { cwd: scratch, signal, timeoutMs: TMODLOADER_ENVIRONMENT_LIMITS.sdkProbeTimeoutMs, maxOutputBytes: TMODLOADER_ENVIRONMENT_LIMITS.sdkOutputBytes };
    const list = await runCompilerProcess(command, ['--list-sdks'], options);
    cancelled(signal);
    if (list.timedOut || list.overflow || list.spawnError || list.exitCode !== 0) {
      issues.push(issue('TML_SDK_PROBE_FAILED', '无法在有界时间与输出内探测 SDK。')); return result;
    }
    const versions = list.output.split(/\r?\n/).map(line => line.match(/^(8\.\d+\.\d+) \[[^\r\n]+\]$/)?.[1]).filter(Boolean);
    versions.sort((a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); return y[1] - x[1] || y[2] - x[2]; });
    result.observedSdkVersions = versions;
    if (!versions.length) { issues.push(issue('TML_SDK8_REQUIRED', '指定 dotnet 安装中没有稳定 .NET 8 SDK。')); return result; }
    if (!versions.includes(TMODLOADER_TARGET.sdkVersion)) { issues.push(issue('TML_EXACT_SDK_REQUIRED', '固定探针要求精确 .NET SDK 8.0.427，其他 SDK 版本需另行验收。')); return result; }
    await writeFile(path.join(scratch, 'global.json'), JSON.stringify({ sdk: { version: TMODLOADER_TARGET.sdkVersion, rollForward: 'disable', allowPrerelease: false } }));
    const info = await runCompilerProcess(command, ['--info'], options);
    cancelled(signal);
    if (info.timedOut || info.overflow || info.spawnError || info.exitCode !== 0) { issues.push(issue('TML_SDK_PROBE_FAILED', 'SDK 信息探测失败、超时或输出超限。')); return result; }
    const version = info.output.match(/\.NET SDK:\s*\r?\n\s*Version:\s*(8\.\d+\.\d+)\b/)?.[1];
    const architecture = info.output.match(/^\s*Architecture:\s*(x64|arm64|x86)\s*$/m)?.[1];
    result.version = version || null; result.architecture = architecture || null;
    result.rid = info.output.match(/^\s*RID:\s*([-A-Za-z0-9.]+)\s*$/m)?.[1] || null;
    result.versionValidated = version === TMODLOADER_TARGET.sdkVersion; result.exactSdkMatch = result.versionValidated; result.architectureValidated = architecture === 'x64';
    result.runtimeValidated = /Microsoft\.NETCore\.App\s+8\.\d+\.\d+\s+\[/.test(info.output);
    if (!result.versionValidated) issues.push(issue('TML_SDK8_VERSION_UNVERIFIED', '无法确认选中的稳定 .NET 8 SDK。'));
    if (!result.architectureValidated) issues.push(issue('TML_SDK_X64_REQUIRED', 'tModLoader 开发目标要求 x64 SDK，当前 dotnet 架构不匹配或未知。'));
    if (!result.runtimeValidated) issues.push(issue('TML_RUNTIME8_REQUIRED', '指定 x64 安装中未确认 .NET 8 运行时。'));
    if (result.rid !== 'osx-x64') issues.push(issue('TML_SDK_MAC_RID_REQUIRED', '固定 Mac 探针需要 osx-x64 SDK 运行环境。'));
    result.available = result.versionValidated && result.architectureValidated && result.runtimeValidated && result.rid === 'osx-x64';
    return result;
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

/** Explicit-directory, metadata-only preflight. No game/targets/DLL execution. */
async function inspectEnvironment({ installPath, dotnetPath, platform = process.platform, arch = process.arch, signal } = {}) {
  const issues = [];
  const report = { schemaVersion: 1, scope: 'tmodloader-environment-preflight-only', status: 'blocked', readyForProbeBuild: false,
    adapterImplemented: false, realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
    environment: { platform, arch, sdk: { available: false }, install: { available: false, versionValidated: false } },
    targets: TMODLOADER_TARGET, capabilities: { metadataInspection: true, gameExecution: false, targetsExecution: false, modelGeneration: false }, issues,
    references: [...SOURCES], limitations: [
      'Environment metadata and source-profile checks do not prove publisher authenticity, safety, licensing or game behavior.',
      'The configured SDK must already be trusted: its information commands self-report metadata and do not authenticate its publisher.',
      'Symbolic links in inspected installation/reference paths are conservatively rejected.',
      'Metadata parsing is synchronous and non-preemptive within the file/row limits; the observation deadline is not OS-level CPU isolation.',
      'The upstream targets contain analyzers and a packaging tool invocation; this inspector never imports or runs them.',
      'readyForProbeBuild only means version/reference/tool conditions for a trusted probe; it is not Mod compilation or gameplay success.',
    ] };
  if (!['darwin', 'win32', 'linux'].includes(platform) || !['arm64', 'x64', 'ia32'].includes(arch)) {
    issues.push(issue('TML_PLATFORM_METADATA_INVALID', '平台与架构元数据无效。')); return report;
  }
  if (signal?.aborted) { issues.push(issue('CANCELLED', '预检已取消。')); return report; }
  if (platform !== process.platform || arch !== process.arch) issues.push(issue('TML_MACHINE_METADATA_MISMATCH', '自报平台或架构与当前进程不匹配，不能据此声明本机环境就绪。'));
  if (platform !== 'darwin') issues.push(issue('TML_MAC_PROBE_TARGET_REQUIRED', '当前准入配置仅用于 macOS；其他系统需单独验收。'));
  if (!['arm64', 'x64'].includes(arch)) issues.push(issue('TML_MAC_ARCH_UNSUPPORTED', '当前 Mac 探针只研究 arm64 主机上的 x64 路线或原生 x64 主机。'));
  try {
    report.environment.sdk = await inspectSdk(dotnetPath, issues, signal);
    cancelled(signal);
    report.environment.install = await inspectInstall(installPath, issues, signal);
    cancelled(signal);
  } catch {
    if (signal?.aborted) issues.push(issue('CANCELLED', '预检已取消，未启动模型、编译或游戏。'));
    else issues.push(issue('TML_PREFLIGHT_FAILED', '本地只读预检未完成，未开放构建。'));
  }
  report.readyForProbeBuild = issues.length === 0 && report.environment.sdk.available && report.environment.install.available;
  report.status = report.readyForProbeBuild ? 'environment_ready' : 'blocked';
  return report;
}

/** Async observation deadline; bounded synchronous metadata parsing is non-preemptive. Late work cannot mutate the returned report. */
export async function inspectTmodloaderEnvironment(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.signal !== undefined && !(options.signal instanceof AbortSignal))) {
    const error = new TypeError('Invalid tModLoader preflight options.'); error.code = 'INVALID_TML_ENVIRONMENT_OPTIONS'; throw error;
  }
  const timeoutMs = options.timeoutMs ?? TMODLOADER_ENVIRONMENT_LIMITS.inspectionTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 50 || timeoutMs > TMODLOADER_ENVIRONMENT_LIMITS.inspectionTimeoutMs) {
    const error = new TypeError('Invalid tModLoader preflight timeout.'); error.code = 'INVALID_TML_ENVIRONMENT_OPTIONS'; throw error;
  }
  if (options.signal?.aborted) return inspectEnvironment(options);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onParentAbort, { once: true });
  let timedOut = false, onAbort;
  const interrupted = new Promise(resolve => {
    onAbort = async () => {
      const report = await inspectEnvironment({ ...options, signal: controller.signal });
      if (timedOut) report.issues = [issue('TML_PREFLIGHT_TIMEOUT', '预检达到硬截止，未开放模型、构建或游戏执行。')];
      resolve(report);
    };
    controller.signal.addEventListener('abort', onAbort, { once: true });
  });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const work = inspectEnvironment({ ...options, signal: controller.signal });
  try { return structuredClone(await Promise.race([work, interrupted])); }
  finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onParentAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}
