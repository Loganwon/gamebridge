import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../src/artifacts/store.mjs';
import { createHostProbeIsolation } from '../src/hosts/isolation.mjs';
import { assessHostPreflight } from '../src/hosts/preflight.mjs';
import { SUPERTUX_PROBE, makeSuperTuxProbeLevel, makeSuperTuxProbeScript, inspectSuperTuxProbe } from '../src/hosts/supertux-probe.mjs';
import { prepareSuperTuxProbeBundle } from '../src/hosts/supertux-bundle.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), flags = args.slice(1), interactive = flags.includes('--interactive'), nativeBundle = flags.includes('--native-bundle'), guiLaunch = flags.includes('--gui-launch');
if (process.platform !== 'darwin' || args.length < 1 || args.length > 4 || new Set(flags).size !== flags.length || flags.some(flag => !['--interactive', '--native-bundle', '--gui-launch'].includes(flag)) || !path.isAbsolute(args[0])) {
  throw new Error('Usage on macOS: npm run verify:host -- /absolute/path/SuperTux.app [--interactive] [--native-bundle] [--gui-launch]');
}
const outputRoot = path.join(root, 'artifacts/host-preflight');
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(outputRoot, 'attempt-'));
const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const summary = { schemaVersion: 1, target: null, status: 'preparing', phase: 'admission', scope: 'trusted-native-interface-probe-only', interactive, guiLaunch,
  modelCalls: 0, realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false, attempts: [] };
const secrets = Object.entries(process.env).filter(([key]) => /key|token|password|authorization/i.test(key)).map(([, value]) => value).filter(value => value.length >= 8);
async function save() { await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); }
let isolation, store;
try {
  await save();
  store = await createArtifactStore({ root: path.join(directory, 'private-artifacts'), secrets });
  let appRoot = await realpath(args[0]), preparation;
  if (guiLaunch && !nativeBundle) {
    summary.phase = 'bundle-preparation'; await save();
    const payloadRoot = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-host-payload-'));
    preparation = await prepareSuperTuxProbeBundle({ sourceApp: appRoot, destinationApp: path.join(payloadRoot, 'Host.app'), launchBridge: true, signal: controller.signal });
    appRoot = preparation.destinationApp;
  }
  summary.phase = 'host-identity'; await save();
  const executable = path.join(appRoot, nativeBundle || preparation ? 'Contents/MacOS/GameBridgeHostProbe' : 'Contents/Resources/bin/supertux2');
  const dataRoot = path.join(appRoot, 'Contents/Resources/share/supertux2');
  const stat = await lstat(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Object.assign(new Error('PINNED_OFFICIAL_EXECUTABLE_REQUIRED'), { code: 'PINNED_OFFICIAL_EXECUTABLE_REQUIRED' });
  const executableSha256 = hash(await readFile(executable));
  const architecture = Object.keys(SUPERTUX_PROBE.executables).find(key => SUPERTUX_PROBE.executables[key] === executableSha256);
  if (!architecture) throw Object.assign(new Error('PINNED_OFFICIAL_EXECUTABLE_REQUIRED'), { code: 'PINNED_OFFICIAL_EXECUTABLE_REQUIRED' });
  const target = { hostGame: 'SuperTux', hostVersion: '0.7.0', platform: 'darwin', architecture, executableSha256 };
  Object.assign(summary, { target, launchLayout: preparation ? 'fresh-same-bundle-launch-bridge' : nativeBundle ? 'project-owned-native-bundle-copy' : 'official-resources-bin',
    infoPlistSha256: hash(await readFile(path.join(appRoot, 'Contents/Info.plist'))) });
  if (preparation) summary.bundlePreparationArtifact = await store.create({ files: [{ path: 'bundle-provenance.json', content: JSON.stringify(preparation, null, 2), mediaType: 'application/json' }] }, { signal: controller.signal });
  await save(); console.log(JSON.stringify({ artifactDirectory: directory, target, interactive }));
  summary.status = 'running'; summary.phase = 'os-boundary'; await save();
  // A LaunchServices exec may acquire a distinct Documents/TCC identity. Keep
  // the disposable native cwd/config outside user document folders as well as
  // keeping the copied bundle there. Retain its path, never broaden file/TCC
  // permissions to repair a launch. Final diagnostics still use private handles.
  const workRoot = guiLaunch ? await mkdtemp(path.join(os.tmpdir(), 'gamebridge-host-work-')) : path.join(directory, 'work');
  if (!guiLaunch) await mkdir(workRoot, { mode: 0o700 });
  summary.runtimeWorkRoot = await realpath(workRoot); await save();
  isolation = await createHostProbeIsolation({ appRoot, workRoot, executable, actualEnv: path.join(root, '.env'), signal: controller.signal });
  summary.boundary = isolation.evidence; await save();
  const versionUserdir = path.join(workRoot, 'version'); await mkdir(versionUserdir, { mode: 0o700 });
  const version = await isolation.run(['--userdir', versionUserdir, '--datadir', dataRoot, '--version'], { signal: controller.signal, timeoutMs: 15000 });
  if (controller.signal.aborted || version.cancelled) throw Object.assign(new Error('Host probe cancelled.'), { code: 'HOST_PROBE_CANCELLED' });
  const versionArtifact = await store.create({ files: [{ path: 'version.txt', content: version.output, mediaType: 'text/plain' }] }, { signal: controller.signal });
  summary.attempts.push({ kind: 'version', ...version, output: undefined, artifact: versionArtifact }); await save();
  if (version.exitCode !== 0 || !/^supertux2 v0\.7\.0\s*$/.test(version.output)) throw Object.assign(new Error('Host identity probe failed.'), { code: 'HOST_VERSION_PROBE_FAILED' });
  const original = await readFile(path.join(dataRoot, SUPERTUX_PROBE.level), 'utf8');
  // Complete the deliberately malformed, noninteractive control first. Never
  // open a second game window after the user's interactive session finishes.
  for (const mode of ['negative', 'positive']) {
    if (controller.signal.aborted) throw new Error('HOST_PROBE_CANCELLED');
    summary.phase = mode; await save();
    const userdir = path.join(workRoot, mode), leveldir = path.join(userdir, 'levels/world1');
    await mkdir(leveldir, { recursive: true, mode: 0o700 });
    // This setting belongs only to the new probe profile. Background windows
    // must keep advancing game time while the parent observes retained output.
    await writeFile(path.join(userdir, 'config'), '(supertux-config (pause_on_focusloss #f) (disable_network #t) (do_release_check #f) (audio (sound_enabled #f) (music_enabled #f)))\n', { mode: 0o600 });
    const script = makeSuperTuxProbeScript({ interactive: interactive && mode === 'positive', malformed: mode === 'negative' });
    const modified = makeSuperTuxProbeLevel(original, script);
    const level = path.join(leveldir, 'welcome_antarctica.stl');
    await writeFile(level, modified, { mode: 0o600 });
    console.log(JSON.stringify({ phase: mode, nativeLevel: SUPERTUX_PROBE.level, interactive: interactive && mode === 'positive' }));
    if (mode === 'positive') console.log('One timed diagnostic session: it closes when checks finish or at the time limit, and never restarts automatically. Click the window, use Return for LevelIntro, release all keys, then follow READY before left Control. No visible window means this check remains blocked.');
    // The userdir overlay contains only a project-owned extension of this exact
    // official level; native scripts/resources, enemies and physics stay in use.
    // Negative syntax failure leaves the game open; bounded timeout is expected.
    // SuperTux's official null backend does not create a rendering window. The
    // negative script is compiled during level activation before intro waits.
    const nativeArgs = ['--userdir', userdir, '--datadir', dataRoot, '--window', '--geometry', '800x600', '--renderer', mode === 'negative' ? 'null' : 'sdl', '--disable-sound', '--disable-music', level];
    const options = { signal: controller.signal, timeoutMs: mode === 'negative' ? 15000 : interactive ? 180000 : 45000 };
    let result, guiProvenance, captureGuiDiagnostics;
    if (guiLaunch && mode === 'positive') {
      const invocation = await isolation.prepareGuiRun(nativeArgs, options);
      guiProvenance = invocation.provenance;
      captureGuiDiagnostics = invocation.captureDiagnostics;
      summary.guiAppPath = invocation.appPath; await save();
      console.log(JSON.stringify({ phase: 'launch-through-desktop-controller', appPath: invocation.appPath, bundleIdentifier: invocation.provenance.bundleIdentifier }));
      result = await invocation.completion;
    } else result = await isolation.run(nativeArgs, options);
    if (controller.signal.aborted || result.cancelled) throw Object.assign(new Error('Host probe cancelled.'), { code: 'HOST_PROBE_CANCELLED' });
    const guiFiles = captureGuiDiagnostics ? await captureGuiDiagnostics() : [];
    if (hash(await readFile(level)) !== hash(Buffer.from(modified)) || hash(await readFile(path.join(dataRoot, SUPERTUX_PROBE.level))) !== SUPERTUX_PROBE.levelSha256) throw new Error('HOST_PROBE_INPUT_CHANGED');
    const artifact = await store.create({ files: [
      { path: 'probe.nut', content: script, mediaType: 'text/plain' },
      { path: 'native-output.txt', content: result.output, mediaType: 'text/plain' },
      ...guiFiles,
    ], provenance: { scope: 'local-host-interface-probe', target, mode, originalLevelSha256: SUPERTUX_PROBE.levelSha256 } }, { signal: controller.signal });
    const observed = inspectSuperTuxProbe(result.output);
    const syntaxRejected = !result.cancelled && !result.overflow && !result.spawnError &&
      /\[SCRIPTING\] init-script line = \(1\) column = \(18\) : error expression expected/.test(result.output) &&
      /Squirrel exception: Source cannot be compiled! \(expression expected\)/.test(result.output) &&
      !/GB_UNREACHABLE|GB_PROBE_BEGIN/.test(result.output);
    summary.attempts.push({ kind: mode, ...result, output: undefined, artifact, observed, ...(guiProvenance ? { guiProvenance } : {}), ...(mode === 'negative' ? { syntaxRejected } : {}) });
    await save();
    if (mode === 'negative' && !syntaxRejected) throw Object.assign(new Error('The native syntax control failed; no interactive session was started.'), { code: 'HOST_SYNTAX_CONTROL_FAILED' });
  }
  const positive = summary.attempts.find(item => item.kind === 'positive'), negative = summary.attempts.find(item => item.kind === 'negative');
  const completedProcess = (positive.exitCode === 0 || (guiLaunch && positive.exitObserved && positive.launchObserved && !positive.cancelled && !positive.timedOut && !positive.overflow && !positive.bindingFailed)) &&
    (!guiLaunch || positive.nativeBoundary?.status === 'passed');
  const interfaceId = 'native-script';
  const record = { schemaVersion: 1, target,
    interfaces: [{ id: interfaceId, url: 'https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/object/player.cpp', revision: 'v0.7.0' }],
    evidence: [{ id: 'positive-log', artifact: positive.artifact }, { id: 'negative-log', artifact: negative.artifact }],
    probes: [
      { id: 'native-vectors', capability: 'probe.native-script', kind: 'positive', interfaceId,
        status: completedProcess && positive.observed.vectorsMatched && positive.observed.cleanCompletion ? 'passed' : 'failed', evidenceIds: ['positive-log'], scope: 'Four project-owned data machines; 40 explicit vectors; no source-game conversion.' },
      { id: 'syntax-rejection', capability: 'probe.native-script', kind: 'negative-control', interfaceId,
        status: negative.syntaxRejected ? 'passed' : 'failed', evidenceIds: ['negative-log'], scope: 'One deliberately malformed sector initialization script; timeout closes the game after rejection.' },
    ], limitations: ['Specified original level only; no globally admitted host adapter.', 'No source-game asset, character, animation, collision or hit verification.', 'Local trusted probe and deterministic generator only; no arbitrary model source.', 'Probe records and hashes do not authenticate observations or establish conversion acceptance.'] };
  summary.preflight = assessHostPreflight(record, { expectedTarget: target, secrets });
  await writeFile(path.join(directory, 'preflight.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  summary.status = completedProcess && positive.observed.vectorsMatched && positive.observed.protocolValid && positive.observed.timingObserved && positive.observed.automaticRecoveryObserved && positive.observed.stateWriteObserved && positive.observed.displacementObserved && positive.observed.stateRestored && positive.observed.recoveryObserved && positive.observed.cleanCompletion && negative.syntaxRejected &&
    (!interactive || (positive.observed.inputCycleObserved && positive.observed.heldObserved)) ? 'passed' : 'failed';
  if (summary.status !== 'passed' && positive.timedOut && positive.observed.vectorsMatched && negative.syntaxRejected) {
    summary.status = 'blocked'; summary.blockers = ['NATIVE_TIMING_AND_COMPLETION_NOT_OBSERVED'];
  }
} catch (error) {
  summary.status = controller.signal.aborted ? 'cancelled' : 'failed'; summary.errorCode = typeof error.code === 'string' ? error.code : 'HOST_PREFLIGHT_FAILED';
  try {
    if (store && !controller.signal.aborted && error.boundaryDiagnostic?.output) {
      summary.boundaryFailureArtifact = await store.create({ files: [{ path: 'boundary-failure.txt', content: error.boundaryDiagnostic.output, mediaType: 'text/plain' }] }, { signal: controller.signal });
    }
    if (store && !controller.signal.aborted && error.guiDiagnosticFiles?.length) summary.guiFailureArtifact = await store.create({ files: error.guiDiagnosticFiles }, { signal: controller.signal });
  } catch (diagnosticError) {
    if (!controller.signal.aborted) summary.diagnosticErrorCode = typeof diagnosticError.code === 'string' ? diagnosticError.code : 'HOST_DIAGNOSTIC_SAVE_FAILED';
  }
  if (controller.signal.aborted) summary.status = 'cancelled';
  await save(); console.error('Host preflight failed; retained local attempt:', directory);
} finally {
  await isolation?.close();
  if (controller.signal.aborted) summary.status = 'cancelled';
  process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await save();
}
console.log(JSON.stringify({ artifactDirectory: directory, ...summary }, null, 2));
if (summary.status !== 'passed') process.exitCode = 1;
