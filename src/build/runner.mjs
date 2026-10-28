import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createExamplePlan } from '../ai/plan.mjs';
import { generateProject } from '../generator/smapi.mjs';
import { validateModCode } from '../ai/code.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FIXED = Object.fromEntries(generateProject(createExamplePlan()).files.map(file => [file.path, file.content]));
const FILES = new Set([...Object.keys(FIXED), 'generation.json', 'build-report.json', 'pipeline-report.json']);
const REFERENCES = [
  'Stardew Valley.dll', 'StardewValley.GameData.dll', 'MonoGame.Framework.dll',
  'xTile.dll', 'StardewModdingAPI.dll', 'smapi-internal/SMAPI.Toolkit.CoreInterfaces.dll',
];
const MAX_OUTPUT = 64 * 1024;
const MAX_ARTIFACTS = 20 * 1024 * 1024;
const REFERENCES_URL = 'https://www.nuget.org/packages/Pathoschild.Stardew.ModBuildConfig/4.4.0';
const BUILD_URL = 'https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-build';

function problem(code, message) { return { code, message }; }
function minimalEnv(workDir, dotnetPath) {
  // Deliberately omit user credentials, proxy credentials and MSBuild hooks.
  const env = {
    PATH: process.env.PATH || '', HOME: workDir, USERPROFILE: workDir,
    TMPDIR: workDir, TEMP: workDir, TMP: workDir,
    DOTNET_CLI_HOME: workDir, DOTNET_CLI_TELEMETRY_OPTOUT: '1',
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_NOLOGO: '1',
    DOTNET_CLI_WORKLOAD_UPDATE_NOTIFY_DISABLE: 'true',
    MSBUILDDISABLENODEREUSE: '1', DOTNET_MULTILEVEL_LOOKUP: '0',
    NUGET_XMLDOC_MODE: 'skip', LANG: 'C', LC_ALL: 'C',
  };
  if (path.isAbsolute(dotnetPath)) env.DOTNET_ROOT = path.dirname(dotnetPath);
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  if (process.env.WINDIR) env.WINDIR = process.env.WINDIR;
  return env;
}
async function executable(file) {
  try { await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK); return await realpath(file); }
  catch { return null; }
}
async function findDotnet(explicit) {
  if (explicit !== undefined && explicit !== '') {
    if (typeof explicit !== 'string' || explicit.length > 4096 || !path.isAbsolute(explicit) || /[\x00-\x1f]/.test(explicit)) return null;
    return executable(explicit);
  }
  const name = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
  const candidates = [
    path.join(ROOT, '.tools', 'dotnet', name), '/usr/local/share/dotnet/dotnet', '/opt/homebrew/bin/dotnet',
    ...(process.env.PATH || '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)),
  ];
  for (const candidate of candidates) { const found = await executable(candidate); if (found) return found; }
  return null;
}
function stopTree(child, force = false) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { shell: false, windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } });
      killer.on('error', () => child.kill(force ? 'SIGKILL' : 'SIGTERM'));
    }
    else process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch { /* Process already exited. */ }
}

/** Bounded compiler subprocess. Exported to test cancellation and credential isolation without a game. */
export async function runCompilerProcess(command, args, { cwd, signal, timeoutMs = 180000, maxOutputBytes = MAX_OUTPUT, env = minimalEnv(cwd, command) } = {}) {
  if (signal?.aborted) return { exitCode: null, output: '', cancelled: true, timedOut: false, overflow: false };
  return new Promise(resolve => {
    let output = '', size = 0, settled = false, cancelled = false, timedOut = false, overflow = false, spawnError = false, forceTimer;
    const child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stop = () => { stopTree(child); forceTimer ??= setTimeout(() => stopTree(child, true), 750); forceTimer.unref(); };
    const onAbort = () => { cancelled = true; stop(); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    const collect = chunk => {
      if (overflow) return;
      size += chunk.length;
      if (size > maxOutputBytes) { overflow = true; stop(); return; }
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect); child.stderr.on('data', collect);
    const finish = exitCode => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener('abort', onAbort);
      // MSBuild/compilers are forced to avoid server reuse; terminate any residual child processes.
      stopTree(child, true);
      resolve({ exitCode, output, cancelled, timedOut, overflow, spawnError });
    };
    child.once('error', () => { spawnError = true; finish(null); });
    child.once('close', finish);
    if (signal?.aborted) onAbort();
  });
}
function cleanOutput(output, workDir, gamePath) {
  let cleaned = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  for (const [value, label] of [[workDir, '<build>'], [gamePath, '<game>'], [os.homedir(), '~']]) if (value) cleaned = cleaned.replaceAll(value, label);
  return cleaned.slice(0, MAX_OUTPUT);
}

/** Compiler diagnostics are data, not instructions. Absolute machine paths are excluded. */
export function parseCompilerDiagnostics(output) {
  const diagnostics = [], seen = new Set();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/\b(error|warning)\s+([A-Z]+\d+)\s*:\s*(.*?)(?:\s+\[[^\]]*\])?$/i);
    if (!match) continue;
    const location = line.slice(0, match.index).match(/(?:^|[/\\])([^/\\]+\.(?:cs|csproj))\((\d+)(?:,\d+){0,3}\)\s*:\s*$/i);
    const diagnostic = { code: match[2].toUpperCase(), severity: match[1].toLowerCase(), message: match[3].slice(0, 2000) };
    if (location && ['ModEntry.cs', 'ModConfig.cs', 'GameBridge.Generated.csproj'].includes(location[1])) { diagnostic.file = location[1]; diagnostic.line = Number(location[2]); }
    const key = JSON.stringify(diagnostic);
    if (!seen.has(key)) { seen.add(key); diagnostics.push(diagnostic); }
    if (diagnostics.length === 50) break;
  }
  return diagnostics;
}

export function isRepairableDiagnostics(diagnostics) {
  // These C# codes indicate missing references, I/O/resources or compiler failure,
  // which a model restricted to ModEntry.cs cannot repair honestly.
  const environmentCodes = new Set(['CS0001', 'CS0003', 'CS0006', 'CS0009', 'CS0012', 'CS0016', 'CS0041', 'CS0518', 'CS1069', 'CS1569', 'CS2001', 'CS2012', 'CS7069']);
  const errors = diagnostics.filter(diagnostic => diagnostic.severity === 'error');
  return errors.length > 0 && errors.every(diagnostic => /^CS\d{4}$/.test(diagnostic.code) && !environmentCodes.has(diagnostic.code) && (!diagnostic.file || diagnostic.file === 'ModEntry.cs'));
}

async function managedAssembly(file, root) {
  try {
    const resolved = await realpath(file);
    if (!resolved.startsWith(root + path.sep)) return false;
    const stat = await lstat(resolved);
    if (!stat.isFile() || stat.size < 256 || stat.size > 256 * 1024 * 1024) return false;
    const handle = await open(resolved, 'r');
    try {
      const header = Buffer.alloc(64); await handle.read(header, 0, 64, 0);
      if (header.readUInt16LE(0) !== 0x5a4d) return false;
      const peOffset = header.readUInt32LE(0x3c);
      if (peOffset > stat.size - 4) return false;
      const signature = Buffer.alloc(4); await handle.read(signature, 0, 4, peOffset);
      return signature.readUInt32LE(0) === 0x00004550;
    } finally { await handle.close(); }
  } catch { return false; }
}

export async function inspectBuildEnvironment({ dotnetPath = process.env.GAMEBRIDGE_DOTNET_PATH, gamePath = process.env.GAMEBRIDGE_GAME_PATH, signal } = {}) {
  const issues = [];
  const dotnet = { available: false };
  const game = { available: false, missing: [], versionValidated: false };
  if (signal?.aborted) return { ready: false, dotnet, game, issues: [problem('CANCELLED', '环境检查已取消。')] };
  const command = await findDotnet(dotnetPath);
  if (command) {
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-sdk-'));
    try {
      const result = await runCompilerProcess(command, ['--version'], { cwd: scratch, signal, timeoutMs: 10000, maxOutputBytes: 16384 });
      const version = result.output.trim().match(/^(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/)?.[0];
      if (result.cancelled) issues.push(problem('CANCELLED', '环境检查已取消。'));
      else if (version && result.exitCode === 0 && Number(version.split('.')[0]) >= 8) Object.assign(dotnet, { available: true, version, path: command });
      else issues.push(problem('SDK_UNAVAILABLE', '需要可运行的 .NET SDK 8 或更高版本（推荐 10 LTS），工程仍以 net6.0 为目标。'));
    } finally { await rm(scratch, { recursive: true, force: true }); }
  } else issues.push(problem('SDK_MISSING', '未找到 .NET SDK。可设置 GAMEBRIDGE_DOTNET_PATH，或安装到项目的 .tools/dotnet。'));
  if (!gamePath) issues.push(problem('GAME_PATH_REQUIRED', '请在本地配置 GAMEBRIDGE_GAME_PATH，指向已安装 Stardew Valley 和 SMAPI 的程序集目录。'));
  else if (typeof gamePath !== 'string' || gamePath.length > 4096 || !path.isAbsolute(gamePath) || /[\x00-\x1f;,$%]/.test(gamePath)) issues.push(problem('INVALID_GAME_PATH', '游戏目录必须为绝对路径，且不能含 MSBuild 表达式或分隔符。'));
  else {
    try {
      const resolved = await realpath(gamePath);
      if (!(await lstat(resolved)).isDirectory()) throw new Error('Not a directory');
      game.path = resolved;
      game.missing = (await Promise.all(REFERENCES.map(async name => await managedAssembly(path.join(resolved, name), resolved) ? null : name))).filter(Boolean);
      game.available = game.missing.length === 0;
      if (!game.available) issues.push(problem('GAME_REFERENCES_MISSING', `游戏/SMAPI 引用缺失或不是有效 PE 文件：${game.missing.join('、')}。`));
    } catch { game.missing = [...REFERENCES]; issues.push(problem('GAME_PATH_MISSING', '配置的游戏程序集目录不存在或无法读取。')); }
  }
  return { ready: dotnet.available && game.available && !signal?.aborted, dotnet, game, issues, targets: { framework: 'net6.0', stardewValley: '1.6.14+', smapi: '4.5.2+', modBuildConfig: '4.4.0' }, references: [REFERENCES_URL, BUILD_URL] };
}

function validateFiles(files) {
  if (!Array.isArray(files) || files.length < 4 || files.length > 16) throw new Error('INVALID_PROJECT: 工程文件数量无效。');
  const map = new Map(); let total = 0;
  for (const file of files) {
    if (!file || !FILES.has(file.path) || typeof file.content !== 'string' || file.content.includes('\0') || map.has(file.path)) throw new Error('INVALID_PROJECT: 工程包含未知、重复或无效的文件。');
    total += Buffer.byteLength(file.content);
    if (total > 2 * 1024 * 1024 || Buffer.byteLength(file.content) > 128 * 1024) throw new Error('INVALID_PROJECT: 工程超出资源限制。');
    map.set(file.path, file.content);
  }
  for (const fixed of ['GameBridge.Generated.csproj', 'ModConfig.cs', 'config.json']) if (map.get(fixed) !== FIXED[fixed]) throw new Error('INVALID_PROJECT: 受信任的构建或配置模板被更改。');
  if (!map.get('ModEntry.cs')?.trim()) throw new Error('INVALID_PROJECT: 缺少 ModEntry.cs。');
  validateModCode({ files: [{ path: 'ModEntry.cs', content: map.get('ModEntry.cs') }], summary: 'Local compiler input validation.' });
  // Only these files enter the compiler. Metadata and free-form documentation never do.
  return map;
}
function blocked(environment) { return { status: 'blocked', repairable: false, diagnostics: environment.issues.map(issue => ({ ...issue, severity: 'error' })), output: '', artifacts: [], environment }; }

export async function compileProject({ files, dotnetPath, gamePath, signal } = {}) {
  let source;
  try { source = validateFiles(files); }
  catch (error) { return { status: 'blocked', repairable: false, diagnostics: [{ code: 'INVALID_PROJECT', severity: 'error', message: error.message.replace(/^INVALID_PROJECT:\s*/, '') }], output: '', artifacts: [] }; }
  if (signal?.aborted) return { status: 'cancelled', repairable: false, diagnostics: [], output: '', artifacts: [] };
  const environment = await inspectBuildEnvironment({ dotnetPath, gamePath, signal });
  if (signal?.aborted) return { ...blocked(environment), status: 'cancelled' };
  if (!environment.ready) return blocked(environment);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-build-'));
  try {
    await writeFile(path.join(workDir, 'GameBridge.Generated.csproj'), FIXED['GameBridge.Generated.csproj']);
    await writeFile(path.join(workDir, 'ModConfig.cs'), FIXED['ModConfig.cs']);
    await writeFile(path.join(workDir, 'ModEntry.cs'), source.get('ModEntry.cs'));
    for (const fixed of ['manifest.json', 'config.json']) await writeFile(path.join(workDir, fixed), FIXED[fixed]);
    await writeFile(path.join(workDir, 'NuGet.Config'), '<?xml version="1.0" encoding="utf-8"?><configuration><packageSources><clear/><add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3"/></packageSources></configuration>');
    await mkdir(path.join(workDir, 'home'), { recursive: true });
    const cache = path.join(ROOT, '.tools', 'build-cache', 'nuget'); await mkdir(cache, { recursive: true });
    const env = minimalEnv(path.join(workDir, 'home'), environment.dotnet.path); env.NUGET_PACKAGES = await realpath(cache);
    const args = ['build', 'GameBridge.Generated.csproj', '--configuration', 'Release', '--nologo', '--disable-build-servers', '--no-incremental', '--verbosity', 'minimal', '--output', path.join(workDir, 'out'), '--configfile', path.join(workDir, 'NuGet.Config'),
      `-p:GamePath=${environment.game.path}`, '-p:EnableModDeploy=false', '-p:EnableModZip=false', '-p:EnableGameDebugging=false', '-p:EnableHarmony=false', '-p:BundleExtraAssemblies=',
      '-p:ImportDirectoryBuildProps=false', '-p:ImportDirectoryBuildTargets=false', '-p:UseSharedCompilation=false', '-p:RunAnalyzers=false', '-p:BuildInParallel=false', '-p:NuGetAudit=false', '-nodeReuse:false'];
    const result = await runCompilerProcess(environment.dotnet.path, args, { cwd: workDir, signal, env });
    const output = cleanOutput(result.output, workDir, environment.game.path);
    const diagnostics = parseCompilerDiagnostics(output);
    const common = { output, diagnostics, artifacts: [], environment, repairable: false };
    if (result.cancelled || signal?.aborted) return { ...common, status: 'cancelled' };
    if (result.timedOut || result.overflow || result.spawnError) return { ...common, status: 'blocked', diagnostics: [...diagnostics, { code: result.timedOut ? 'BUILD_TIMEOUT' : result.overflow ? 'BUILD_OUTPUT_LIMIT' : 'SDK_UNAVAILABLE', severity: 'error', message: result.timedOut ? '构建超过三分钟，已终止。' : result.overflow ? '构建日志超出 64 KiB，已终止。' : '无法启动编译器。' }] };
    if (result.exitCode !== 0) {
      const repairable = isRepairableDiagnostics(diagnostics);
      return { ...common, status: repairable ? 'failed' : 'blocked', repairable, diagnostics: diagnostics.length ? diagnostics : [{ code: 'BUILD_FAILED', severity: 'error', message: '构建失败，未取得可自动修复的 C# 诊断。' }] };
    }
    const artifacts = []; let artifactSize = 0;
    for (const name of ['GameBridge.Generated.dll', 'GameBridge.Generated.pdb']) {
      const file = path.join(workDir, 'out', name);
      let stat;
      try { stat = await lstat(file); } catch { if (name.endsWith('.pdb')) continue; return { ...common, status: 'blocked', diagnostics: [{ code: 'BUILD_ARTIFACT_MISSING', severity: 'error', message: '编译器未生成预期的 Mod DLL。' }] }; }
      artifactSize += stat.size;
      if (!stat.isFile() || stat.isSymbolicLink() || artifactSize > MAX_ARTIFACTS) return { ...common, status: 'blocked', diagnostics: [{ code: 'BUILD_ARTIFACT_LIMIT', severity: 'error', message: '编译产物无效或超过 20 MiB。' }] };
      if (name.endsWith('.dll') && !await managedAssembly(file, workDir)) return { ...common, status: 'blocked', diagnostics: [{ code: 'BUILD_ARTIFACT_INVALID', severity: 'error', message: '编译器产物不是有效的 PE 程序集。' }] };
      artifacts.push({ path: name, data: await readFile(file) });
    }
    return { ...common, status: 'passed', artifacts, game: 'not_run' };
  } finally { await rm(workDir, { recursive: true, force: true }); }
}

export const BUILD_LIMITS = Object.freeze({ timeoutMs: 180000, outputBytes: MAX_OUTPUT, artifactBytes: MAX_ARTIFACTS, references: [...REFERENCES] });
