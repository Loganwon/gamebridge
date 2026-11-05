// Structure/claim separation fixtures only. No game, model, download or host
// process is run, and placeholder handles do not refer to real artifacts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHostPreflight, assessHostPreflight } from '../src/hosts/preflight.mjs';

const localTarget = () => ({ hostGame: 'contract-host', hostVersion: '1.2.3', platform: 'darwin', architecture: 'arm64', executableSha256: 'a'.repeat(64) });
const handle = () => ({ schemaVersion: 1, id: '00000000-0000-0000-0000-000000000001', manifestSha256: 'b'.repeat(64), fileCount: 1, totalBytes: 42, scope: 'local-tool-artifact' });
function fixture() {
  return { schemaVersion: 1, target: localTarget(), interfaces: [{ id: 'native-input', url: 'https://example.org/host/v1.2.3/input', revision: 'v1.2.3' }],
    evidence: [{ id: 'local-log', artifact: handle() }], probes: [
      { id: 'press-observed', capability: 'probe.input.edge', kind: 'positive', interfaceId: 'native-input', status: 'passed', evidenceIds: ['local-log'], scope: 'One native level and one input; not general gameplay support.' },
      { id: 'invalid-input-rejected', capability: 'probe.input.edge', kind: 'negative-control', interfaceId: 'native-input', status: 'passed', evidenceIds: ['local-log'], scope: 'One native level and one input; not general gameplay support.' },
    ], limitations: ['Contract fixture claims only; no actual game process or artifacts.'] };
}
const options = () => ({ expectedTarget: localTarget() });

test('complete host probe records remain separate from adapter admission and conversion acceptance', () => {
  const raw = fixture(), accepted = validateHostPreflight(raw, options()), report = assessHostPreflight(raw, options());
  raw.target.hostGame = 'mutated'; raw.evidence[0].artifact.totalBytes++;
  assert.equal(accepted.target.hostGame, 'contract-host'); assert.equal(accepted.evidence[0].artifact.totalBytes, 42);
  assert.equal(report.probeRecordStatus, 'recorded'); assert.equal(report.capabilityObservations[0].recordedEvidenceComplete, true);
  assert.equal(report.evidenceAuthenticated, false); assert.equal(report.status, 'blocked'); assert.equal(report.supportRegistered, false);
  assert.equal(report.readyToGenerate, false); assert.equal(report.readyToInstall, false); assert.equal(report.realModBuild, 'not_run'); assert.equal(report.conversionGameAcceptance, 'not_run');
  assert.ok(!JSON.stringify(report).includes('real-game'));
});

test('target must be independently provided and match all five pinned identity fields', () => {
  for (const option of [undefined, {}, { expectedTarget: undefined }]) assert.throws(() => validateHostPreflight(fixture(), option), { code: 'INVALID_HOST_PREFLIGHT' });
  for (const [key, value] of Object.entries({ hostGame: 'other-host', hostVersion: '1.2.4', platform: 'linux', architecture: 'x64', executableSha256: 'c'.repeat(64) })) {
    const expectedTarget = { ...localTarget(), [key]: value };
    assert.throws(() => validateHostPreflight(fixture(), { expectedTarget }), { code: 'HOST_PREFLIGHT_TARGET_MISMATCH' });
  }
  for (const version of ['latest', 'main', '*', '^1.2.3', '1.2.*', 'unknown']) {
    const raw = fixture(); raw.target.hostVersion = version;
    assert.throws(() => validateHostPreflight(raw, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  }
});

test('documents and pending/failed probes cannot become complete runtime observation records', () => {
  const pending = fixture(); pending.probes[1].status = 'not_run'; pending.probes[1].evidenceIds = [];
  assert.equal(assessHostPreflight(pending, options()).probeRecordStatus, 'incomplete');
  const failed = fixture(); failed.probes[1].status = 'failed';
  assert.equal(assessHostPreflight(failed, options()).probeRecordStatus, 'failed');
  const noControl = fixture(); noControl.probes.pop();
  assert.equal(assessHostPreflight(noControl, options()).capabilityObservations[0].recordedEvidenceComplete, false);
  const documented = fixture(); documented.probes.forEach(probe => { probe.status = 'not_run'; probe.evidenceIds = []; }); documented.evidence = [];
  const report = assessHostPreflight(documented, options());
  assert.deepEqual(report.documentedInterfaces, ['native-input']); assert.deepEqual(report.capabilityObservations[0].positiveProbeIds, []);
  assert.equal(report.probeRecordStatus, 'incomplete'); assert.equal(report.status, 'blocked');
});

test('observed outcomes require referenced private handles and never accept embedded files or permission claims', () => {
  const mutations = [
    raw => { raw.probes[0].evidenceIds = []; }, raw => { raw.probes[0].evidenceIds = ['missing']; },
    raw => { raw.probes[0].interfaceId = 'missing'; }, raw => { raw.probes[0].status = 'not_run'; },
    raw => { raw.evidence[0].artifact.path = '/private/user-file'; }, raw => { raw.evidence[0].artifact.content = 'embedded source'; },
    raw => { raw.evidence[0].artifact.fileCount = 65; }, raw => { raw.evidence[0].artifact.totalBytes = 8 * 1024 * 1024 + 1; },
    raw => { raw.evidence[0].artifact.manifestSha256 = 'invalid'; }, raw => { raw.evidence[0].artifact.scope = 'real-game'; },
    raw => { raw.target.executableSha256 = ['a'.repeat(64)]; },
    raw => { raw.probes[0].capability = 'host.input.edge'; }, raw => { raw.probes[0].capability = 'probe.mod.complete'; },
    raw => { raw.probes[0].capability = 'probe.game.acceptance'; }, raw => { raw.probes[0].capability = 'probe.support'; },
    raw => { raw.supportRegistered = true; }, raw => { raw.command = 'execute'; }, raw => { raw.probes[0].status = 'supported'; },
    raw => { raw.interfaces[0].revision = 'main'; }, raw => { raw.interfaces[0].url = 'https://user:secret@example.org/private'; },
    raw => { raw.interfaces[0].url = 'http://example.org/plain'; }, raw => { raw.interfaces[0].url = 'https://localhost.local/private'; },
    raw => { raw.probes.push(structuredClone(raw.probes[0])); }, raw => { raw.probes[0].evidenceIds.push('local-log'); },
  ];
  for (const mutate of mutations) { const raw = fixture(); mutate(raw); assert.throws(() => validateHostPreflight(raw, options()), { code: 'INVALID_HOST_PREFLIGHT' }); }
});

test('finite plain-data boundary rejects accessors, prototypes, sparse lists and oversized data without invoking getters', () => {
  let accessed = 0;
  const getter = fixture(); Object.defineProperty(getter.target, 'hostVersion', { enumerable: true, get() { accessed++; return '1.2.3'; } });
  assert.throws(() => validateHostPreflight(getter, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  const optionGetter = Object.defineProperty({}, 'expectedTarget', { enumerable: true, get() { accessed++; return localTarget(); } });
  assert.throws(() => validateHostPreflight(fixture(), optionGetter), { code: 'INVALID_HOST_PREFLIGHT' });
  const secretGetter = []; Object.defineProperty(secretGetter, 0, { enumerable: true, get() { accessed++; return 'canary'; } });
  assert.throws(() => validateHostPreflight(fixture(), { ...options(), secrets: secretGetter }), { code: 'INVALID_HOST_PREFLIGHT' });
  const listGetter = fixture(); Object.setPrototypeOf(listGetter.probes, { get map() { accessed++; return Array.prototype.map; } });
  assert.throws(() => validateHostPreflight(listGetter, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  assert.equal(accessed, 0);
  const inherited = fixture(); Object.setPrototypeOf(inherited.probes[0], { readyToInstall: true });
  assert.throws(() => validateHostPreflight(inherited, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  const sparse = fixture(); delete sparse.probes[0]; assert.throws(() => validateHostPreflight(sparse, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  const sparseSecrets = []; sparseSecrets.length = 1; sparseSecrets.extra = 'canary';
  assert.throws(() => validateHostPreflight(fixture(), { ...options(), secrets: sparseSecrets }), { code: 'INVALID_HOST_PREFLIGHT' });
  const large = fixture(); large.limitations = ['x'.repeat(65537)]; assert.throws(() => validateHostPreflight(large, options()), { code: 'INVALID_HOST_PREFLIGHT' });
  const hugeList = fixture(); hugeList.probes = Array.from({ length: 33 }, (_, i) => ({ ...structuredClone(hugeList.probes[0]), id: 'input-' + i }));
  assert.throws(() => validateHostPreflight(hugeList, options()), { code: 'INVALID_HOST_PREFLIGHT' });
});

test('known local credentials are excluded from text and escaped JSON while no credential is needed', () => {
  const secret = 'synthetic-private-preflight-canary';
  const raw = fixture(); raw.limitations[0] = secret;
  assert.throws(() => validateHostPreflight(raw, { ...options(), secrets: [secret] }), { code: 'HOST_PREFLIGHT_SECRET_DETECTED' });
  const escaped = fixture(), quotedSecret = 'canary-"quoted"-value'; escaped.probes[0].scope = quotedSecret;
  assert.throws(() => validateHostPreflight(escaped, { ...options(), secrets: [quotedSecret] }), { code: 'HOST_PREFLIGHT_SECRET_DETECTED' });
  assert.equal(validateHostPreflight(fixture(), { ...options(), secrets: [] }).schemaVersion, 1);
});
