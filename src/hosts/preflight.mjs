import { assertProtocolJson, protocolObject, protocolText, protocolIdentifier, protocolArray } from '../orchestration/protocol.mjs';

export const HOST_PREFLIGHT_LIMITS = Object.freeze({ bytes: 64 * 1024, interfaces: 16, evidence: 32, probes: 32 });
const TARGET_FIELDS = ['hostGame', 'hostVersion', 'platform', 'architecture', 'executableSha256'];
const HANDLE_FIELDS = ['schemaVersion', 'id', 'manifestSha256', 'fileCount', 'totalBytes', 'scope'];
const HASH = /^[a-f0-9]{64}$/, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const UNPINNED = /^(?:latest|current|unknown|unverified|main|master|head|any|未知|未确定)$/i;
const ARCHITECTURES = ['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'];
function fail(message, code = 'INVALID_HOST_PREFLIGHT') { throw Object.assign(new Error(message), { code }); }
function exact(value, fields, label) {
  protocolObject(value, fields, label);
  if (fields.some(key => !Object.hasOwn(value, key))) fail(`Missing ${label} field.`);
}
function unique(values, label) { if (new Set(values).size !== values.length) fail(`Duplicate ${label}.`); return values; }
function list(value, label, maximum, minimum = 0) {
  const result = protocolArray(value, label, maximum, minimum);
  if (Object.getPrototypeOf(result) !== Array.prototype) fail(`Invalid ${label} prototype.`);
  return result;
}
function ids(value, label) { return unique(list(value, label, 32).map(item => protocolIdentifier(item, label)), label); }
function pinned(value, label) {
  const text = protocolText(value, label, 80);
  if (UNPINNED.test(text) || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(text)) fail(`${label} must identify an exact release or revision.`);
  return text;
}
function target(value) {
  exact(value, TARGET_FIELDS, 'host target');
  const hostGame = protocolText(value.hostGame, 'host game', 80), hostVersion = pinned(value.hostVersion, 'host version');
  if (hostGame === '*' || !['darwin', 'linux', 'win32'].includes(value.platform) || !ARCHITECTURES.includes(value.architecture) ||
      typeof value.executableSha256 !== 'string' || !HASH.test(value.executableSha256)) fail('Host target needs an exact platform, architecture and binary fingerprint.');
  return { hostGame, hostVersion, platform: value.platform, architecture: value.architecture, executableSha256: value.executableSha256 };
}
function artifact(value) {
  exact(value, HANDLE_FIELDS, 'artifact handle');
  if (value.schemaVersion !== 1 || value.scope !== 'local-tool-artifact' || typeof value.id !== 'string' || !UUID.test(value.id) ||
      typeof value.manifestSha256 !== 'string' || !HASH.test(value.manifestSha256) || !Number.isSafeInteger(value.fileCount) || value.fileCount < 1 || value.fileCount > 64 ||
      !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 0 || value.totalBytes > 8 * 1024 * 1024) fail('Evidence requires a bounded private artifact handle.');
  return structuredClone(value);
}
function reference(value) {
  const text = protocolText(value, 'interface URL', 500); let url;
  try { url = new URL(text); } catch { fail('Invalid interface URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname.includes('.') ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) fail('Interface references require public HTTPS documents without credentials.');
  return url.href;
}

/** Structure-only local record contract. expectedTarget is mandatory and must be
 * supplied by the trusted caller's own identity probe, never a model response.
 * This function neither verifies files nor authenticates observations, grants
 * execution permissions, registers adapters, or proves game compatibility.
 */
export function validateHostPreflight(raw, options) {
  try {
    protocolObject(options, ['expectedTarget', 'secrets'], 'preflight options');
    if (!Object.hasOwn(options, 'expectedTarget')) fail('A separately bound local target is required.');
    assertProtocolJson(options.expectedTarget, { maxBytes: 2048 });
    const expectedTarget = target(options.expectedTarget), secrets = list(options.secrets ?? [], 'local credential guards', 64);
    if (secrets.some(item => typeof item !== 'string')) fail('Credential guards require a plain list of local strings.');
    assertProtocolJson(raw, { maxBytes: HOST_PREFLIGHT_LIMITS.bytes, maxDepth: 8, maxNodes: 4096 });
    const serialized = JSON.stringify(raw);
    if (secrets.filter(Boolean).some(secret => serialized.includes(secret) || serialized.includes(JSON.stringify(secret).slice(1, -1)))) fail('Credential content was excluded from a host record.', 'HOST_PREFLIGHT_SECRET_DETECTED');
    exact(raw, ['schemaVersion', 'target', 'interfaces', 'evidence', 'probes', 'limitations'], 'host preflight');
    if (raw.schemaVersion !== 1) fail('Unknown host preflight version.');
    const acceptedTarget = target(raw.target);
    if (TARGET_FIELDS.some(key => acceptedTarget[key] !== expectedTarget[key])) fail('Host record does not match the independently bound target.', 'HOST_PREFLIGHT_TARGET_MISMATCH');
    const interfaces = list(raw.interfaces, 'interfaces', HOST_PREFLIGHT_LIMITS.interfaces, 1).map(item => {
      exact(item, ['id', 'url', 'revision'], 'interface reference');
      return { id: protocolIdentifier(item.id, 'interface ID'), url: reference(item.url), revision: pinned(item.revision, 'interface revision') };
    });
    unique(interfaces.map(item => item.id), 'interface IDs');
    const evidence = list(raw.evidence, 'evidence', HOST_PREFLIGHT_LIMITS.evidence).map(item => {
      exact(item, ['id', 'artifact'], 'probe evidence');
      return { id: protocolIdentifier(item.id, 'evidence ID'), artifact: artifact(item.artifact) };
    });
    unique(evidence.map(item => item.id), 'evidence IDs'); unique(evidence.map(item => item.artifact.id), 'artifact IDs');
    const probes = list(raw.probes, 'probes', HOST_PREFLIGHT_LIMITS.probes, 1).map(item => {
      exact(item, ['id', 'capability', 'kind', 'interfaceId', 'status', 'evidenceIds', 'scope'], 'host probe');
      const id = protocolIdentifier(item.id, 'probe ID'), capability = protocolIdentifier(item.capability, 'probe capability');
      // These are narrow interface observations, not conversion completion claims.
      if (!capability.startsWith('probe.') || /(?:^|[._-])(?:game|mod|support|complete|completion|acceptance|install)(?:$|[._-])/.test(capability)) fail('Probe capabilities must remain narrow probe.* observations.');
      const interfaceId = protocolIdentifier(item.interfaceId, 'probe interface ID'), evidenceIds = ids(item.evidenceIds, 'probe evidence IDs');
      if (!['positive', 'negative-control'].includes(item.kind) || !['passed', 'failed', 'not_run'].includes(item.status) ||
          !interfaces.some(entry => entry.id === interfaceId) || evidenceIds.some(id => !evidence.some(entry => entry.id === id)) ||
          (item.status === 'not_run' ? evidenceIds.length !== 0 : evidenceIds.length === 0)) fail('Observed probes require valid interface and artifact references; unrun probes carry no observations.');
      return { id, capability, kind: item.kind, interfaceId, status: item.status, evidenceIds, scope: protocolText(item.scope, 'probe scope', 1000) };
    });
    unique(probes.map(item => item.id), 'probe IDs');
    const limitations = list(raw.limitations, 'limitations', 16, 1).map(item => protocolText(item, 'preflight limitation', 1000));
    return { schemaVersion: 1, target: acceptedTarget, interfaces, evidence, probes, limitations };
  } catch (error) {
    if (['INVALID_HOST_PREFLIGHT', 'HOST_PREFLIGHT_TARGET_MISMATCH', 'HOST_PREFLIGHT_SECRET_DETECTED'].includes(error.code)) throw error;
    fail('Host preflight violates its bounded plain-data contract.');
  }
}

/** Summarizes recorded claims only. Even complete positive/negative records do
 * not admit a host adapter or establish real conversion/build acceptance.
 * conversionGameAcceptance excludes the separate act of running a host probe.
 */
export function assessHostPreflight(raw, options) {
  const record = validateHostPreflight(raw, options);
  const capabilityObservations = [...new Set(record.probes.map(item => item.capability))].map(capability => {
    const probes = record.probes.filter(item => item.capability === capability);
    const positiveProbeIds = probes.filter(item => item.kind === 'positive' && item.status === 'passed').map(item => item.id);
    const negativeControlIds = probes.filter(item => item.kind === 'negative-control' && item.status === 'passed').map(item => item.id);
    const failedProbeIds = probes.filter(item => item.status === 'failed').map(item => item.id), pendingProbeIds = probes.filter(item => item.status === 'not_run').map(item => item.id);
    return { capability, positiveProbeIds, negativeControlIds, failedProbeIds, pendingProbeIds,
      recordedEvidenceComplete: positiveProbeIds.length > 0 && negativeControlIds.length > 0 && !failedProbeIds.length && !pendingProbeIds.length,
      scopes: [...new Set(probes.map(item => item.scope))] };
  });
  return { schemaVersion: 1, scope: 'host-preflight-record', target: record.target, status: 'blocked',
    probeRecordStatus: record.probes.some(item => item.status === 'failed') ? 'failed' : capabilityObservations.every(item => item.recordedEvidenceComplete) ? 'recorded' : 'incomplete',
    evidenceAuthenticated: false, documentedInterfaces: record.interfaces.map(item => item.id), capabilityObservations,
    blockers: ['HOST_INTERFACE_RECORD_IS_NOT_ADAPTER_ADMISSION'], limitations: record.limitations,
    supportRegistered: false, readyToGenerate: false, realModBuild: 'not_run', conversionGameAcceptance: 'not_run', readyToInstall: false };
}
