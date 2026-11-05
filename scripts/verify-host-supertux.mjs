import { mkdir, mkdtemp, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtifactStore } from '../src/artifacts/store.mjs';
import { createHostProbeIsolation } from '../src/hosts/isolation.mjs';
import { assessHostPreflight } from '../src/hosts/preflight.mjs';
import { SUPERTUX_PROBE, makeSuperTuxProbeLevel, makeSuperTuxProbeScript, inspectSuperTuxProbe } from '../src/hosts/supertux-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), interactive = args[1] === '--interactive';
if (process.platform !== 'darwin' || args.length < 1 || args.length > 2 || (args.length === 2 && !interactive) || !path.isAbsolute(args[0])) {
  throw new Error('Usage on macOS: npm run verify:host -- /absolute/path/SuperTux.app [--interactive]');
}
const outputRoot = path.join(root, 'artifacts/host-preflight');
await mkdir(outputRoot, { recursive: true, mode: 0o700 });
const directory = await mkdtemp(path.join(outputRoot, 'attempt-'));
const appRoot = await realpath(args[0]), executable = path.join(appRoot, 'Contents/Resources/bin/supertux2');
const dataRoot = path.join(appRoot, 'Contents/Resources/share/supertux2');
const hash = buffer => createHash('sha256').update(buffer).digest('hex');
const stat = await lstat(executable);
if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('PINNED_OFFICIAL_EXECUTABLE_REQUIRED');
const executableSha256 = hash(await readFile(executable));
const architecture = Object.keys(SUPERTUX_PROBE.executables).find(key => SUPERTUX_PROBE.executables[key] === executableSha256);
if (!architecture) throw new Error('PINNED_OFFICIAL_EXECUTABLE_REQUIRED');
const target = { hostGame: 'SuperTux', hostVersion: '0.7.0', platform: 'darwin', architecture, executableSha256 };
const summary = { schemaVersion: 1, target, scope: 'trusted-native-interface-probe-only', interactive,
  modelCalls: 0, realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false, attempts: [] };
const secrets = Object.entries(process.env).filter(([key]) => /key|token|password|authorization/i.test(key)).map(([, value]) => value).filter(value => value.length >= 8);
const store = await createArtifactStore({ root: path.join(directory, 'private-artifacts'), secrets });
async function save() { await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { mode: 0o600 }); }
await save();
console.log(JSON.stringify({ artifactDirectory: directory, target, interactive }));

const controller = new AbortController();
const cancel = () => controller.abort();
process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
let isolation;
try {
  const workRoot = path.join(directory, 'work'); await mkdir(workRoot, { mode: 0o700 });
  isolation = await createHostProbeIsolation({ appRoot, workRoot, executable, actualEnv: path.join(root, '.env'), signal: controller.signal });
  summary.boundary = isolation.evidence; await save();
  const versionUserdir = path.join(workRoot, 'version'); await mkdir(versionUserdir, { mode: 0o700 });
  const version = await isolation.run(['--userdir', versionUserdir, '--datadir', dataRoot, '--version'], { signal: controller.signal, timeoutMs: 15000 });
  if (controller.signal.aborted || version.cancelled) throw Object.assign(new Error('Host probe cancelled.'), { code: 'HOST_PROBE_CANCELLED' });
  const versionArtifact = await store.create({ files: [{ path: 'version.txt', content: version.output, mediaType: 'text/plain' }] });
  summary.attempts.push({ kind: 'version', ...version, output: undefined, artifact: versionArtifact }); await save();
  if (version.exitCode !== 0 || !/^supertux2 v0\.7\.0\s*$/.test(version.output)) throw Object.assign(new Error('Host identity probe failed.'), { code: 'HOST_VERSION_PROBE_FAILED' });
  const original = await readFile(path.join(dataRoot, SUPERTUX_PROBE.level), 'utf8');
  for (const mode of ['positive', 'negative']) {
    if (controller.signal.aborted) throw new Error('HOST_PROBE_CANCELLED');
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
    if (mode === 'positive') console.log('The native LevelIntro requires Space/Return in the actual probe window. Interactive mode then requires left Control press/release. No visible window means this check remains blocked.');
    // The userdir overlay contains only a project-owned extension of this exact
    // official level; native scripts/resources, enemies and physics stay in use.
    // Negative syntax failure leaves the game open; bounded timeout is expected.
    const result = await isolation.run(['--userdir', userdir, '--datadir', dataRoot, '--window', '--geometry', '800x600', '--renderer', 'sdl',
      '--disable-sound', '--disable-music', level], { signal: controller.signal, timeoutMs: mode === 'negative' ? 15000 : interactive ? 150000 : 45000 });
    if (controller.signal.aborted || result.cancelled) throw Object.assign(new Error('Host probe cancelled.'), { code: 'HOST_PROBE_CANCELLED' });
    if (hash(await readFile(level)) !== hash(Buffer.from(modified)) || hash(await readFile(path.join(dataRoot, SUPERTUX_PROBE.level))) !== SUPERTUX_PROBE.levelSha256) throw new Error('HOST_PROBE_INPUT_CHANGED');
    const artifact = await store.create({ files: [
      { path: 'probe.nut', content: script, mediaType: 'text/plain' },
      { path: 'native-output.txt', content: result.output, mediaType: 'text/plain' },
    ], provenance: { scope: 'local-host-interface-probe', target, mode, originalLevelSha256: SUPERTUX_PROBE.levelSha256 } });
    const observed = inspectSuperTuxProbe(result.output);
    const syntaxRejected = !result.cancelled && !result.overflow && !result.spawnError &&
      /\[SCRIPTING\] init-script line = \(1\) column = \(18\) : error expression expected/.test(result.output) &&
      /Squirrel exception: Source cannot be compiled! \(expression expected\)/.test(result.output) &&
      !/GB_UNREACHABLE|GB_PROBE_BEGIN/.test(result.output);
    summary.attempts.push({ kind: mode, ...result, output: undefined, artifact, observed, ...(mode === 'negative' ? { syntaxRejected } : {}) });
    await save();
  }
  const positive = summary.attempts.find(item => item.kind === 'positive'), negative = summary.attempts.find(item => item.kind === 'negative');
  const interfaceId = 'native-script';
  const record = { schemaVersion: 1, target,
    interfaces: [{ id: interfaceId, url: 'https://raw.githubusercontent.com/SuperTux/supertux/v0.7.0/src/object/player.cpp', revision: 'v0.7.0' }],
    evidence: [{ id: 'positive-log', artifact: positive.artifact }, { id: 'negative-log', artifact: negative.artifact }],
    probes: [
      { id: 'native-vectors', capability: 'probe.native-script', kind: 'positive', interfaceId,
        status: positive.exitCode === 0 && positive.observed.vectorsMatched && positive.observed.cleanCompletion ? 'passed' : 'failed', evidenceIds: ['positive-log'], scope: 'Four project-owned data machines; 40 explicit vectors; no source-game conversion.' },
      { id: 'syntax-rejection', capability: 'probe.native-script', kind: 'negative-control', interfaceId,
        status: negative.syntaxRejected ? 'passed' : 'failed', evidenceIds: ['negative-log'], scope: 'One deliberately malformed sector initialization script; timeout closes the game after rejection.' },
    ], limitations: ['Specified original level only; no globally admitted host adapter.', 'No source-game asset, character, animation, collision or hit verification.', 'Local trusted probe and deterministic generator only; no arbitrary model source.', 'Probe records and hashes do not authenticate observations or establish conversion acceptance.'] };
  summary.preflight = assessHostPreflight(record, { expectedTarget: target, secrets });
  await writeFile(path.join(directory, 'preflight.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  summary.status = positive.exitCode === 0 && positive.observed.vectorsMatched && positive.observed.stateWriteObserved && positive.observed.displacementObserved && positive.observed.cleanCompletion && negative.syntaxRejected &&
    (!interactive || positive.observed.inputCycleObserved) ? 'passed' : 'failed';
  if (summary.status !== 'passed' && positive.timedOut && positive.observed.vectorsMatched && negative.syntaxRejected) {
    summary.status = 'blocked'; summary.blockers = ['NATIVE_TIMING_AND_COMPLETION_NOT_OBSERVED'];
  }
} catch (error) {
  summary.status = 'failed'; summary.errorCode = typeof error.code === 'string' ? error.code : 'HOST_PREFLIGHT_FAILED';
  if (error.boundaryDiagnostic?.output) {
    summary.boundaryFailureArtifact = await store.create({ files: [{ path: 'boundary-failure.txt', content: error.boundaryDiagnostic.output, mediaType: 'text/plain' }] });
  }
  await save(); console.error('Host preflight failed; retained local attempt:', directory);
} finally {
  await isolation?.close(); process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); await save();
}
console.log(JSON.stringify({ artifactDirectory: directory, ...summary }, null, 2));
if (summary.status !== 'passed') process.exitCode = 1;
