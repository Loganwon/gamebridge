import test from 'node:test';
import assert from 'node:assert/strict';
import { getHostCatalog, assessActionHost, HostAssessmentError } from '../src/actions/hosts.mjs';
import { createActionExample, serializeActionProposal } from '../src/actions/spec.mjs';

function proposal(variant) { return serializeActionProposal(createActionExample(variant).blueprint); }
const installed = { platform: 'win32', gameVersion: '1.4.8', toolsVersion: '1.4.8', gameInstalled: true, toolsInstalled: true };
function codes(report) { return report.blockers.map(item => item.code); }
function rejects(input, options) { assert.throws(() => assessActionHost(input, options), error => error instanceof HostAssessmentError && error.code === 'INVALID_HOST_ASSESSMENT'); }

test('host catalogue is detached candidate data with no verified action capabilities or versions', () => {
  const hosts = getHostCatalog();
  assert.equal(hosts.find(item => item.id === 'bannerlord').status, 'candidate');
  assert.equal(hosts.find(item => item.id === 'stardew-valley').status, 'pipeline_only');
  assert.ok(hosts.every(item => item.adapterVersion === null && item.exactGameVersion === null && item.exactToolsVersion === null && item.verifiedCapabilities.length === 0));
  assert.ok(hosts.every(item => item.officialReferences.every(url => url.startsWith('https://'))));
  hosts[0].status = 'verified'; hosts[0].verifiedCapabilities.push('world_hit_detection'); hosts[0].officialReferences.length = 0;
  assert.equal(getHostCatalog()[0].status, 'candidate');
  assert.deepEqual(getHostCatalog()[0].verifiedCapabilities, []);
  assert.ok(getHostCatalog()[0].officialReferences.length > 0);
});

test('an action blueprint without an environment remains blocked with separate unrun game and build states', () => {
  const input = createActionExample().blueprint;
  const before = JSON.stringify(input);
  const report = assessActionHost(input);
  assert.equal(report.scope, 'host-capability-preflight-only');
  assert.equal(report.status, 'blocked'); assert.equal(report.readyToInstall, false);
  assert.equal(report.realModBuild, 'not_run'); assert.equal(report.game, 'not_run');
  assert.equal(report.environment.verification, 'metadata-only'); assert.equal(report.environment.versionValidated, false);
  for (const expected of ['ACTION_ADAPTER_REQUIRED', 'HOST_VERSION_REQUIRED', 'HOST_VERSION_NOT_VERIFIED', 'GAME_ENVIRONMENT_REQUIRED', 'SOURCE_SPEC_REQUIRED', 'SOURCE_FIDELITY_NOT_VERIFIED']) assert.ok(codes(report).includes(expected));
  assert.ok(report.capabilities.every(item => item.required && item.status === 'unverified'));
  assert.equal(JSON.stringify(input), before);
});

test('complete self-reported installation metadata and exact version strings cannot establish compatibility', () => {
  const raw = proposal(); raw.hostVersion = '1.4.8'; raw.source.version = '1.0'; raw.source.references = ['https://example.com/source-spec'];
  const report = assessActionHost(raw, { environment: installed });
  assert.equal(report.status, 'blocked'); assert.equal(report.readyToInstall, false);
  assert.ok(codes(report).includes('ENVIRONMENT_NOT_VERIFIED'));
  assert.ok(codes(report).includes('HOST_VERSION_NOT_VERIFIED'));
  assert.ok(codes(report).includes('SOURCE_FIDELITY_NOT_VERIFIED'));
  assert.ok(!codes(report).includes('HOST_VERSION_REQUIRED'));
  assert.ok(!codes(report).includes('GAME_ENVIRONMENT_REQUIRED'));
  assert.ok(!codes(report).includes('SOURCE_SPEC_REQUIRED'));
  assert.equal(report.environment.versionValidated, false);
  assert.equal(report.host.exactGameVersion, null);
});

test('mismatched platform, game, tool and blueprint versions produce explicit blockers', () => {
  const raw = proposal(); raw.hostVersion = '1.4.8';
  const report = assessActionHost(raw, { environment: { ...installed, platform: 'darwin', gameVersion: '1.4.7' } });
  for (const expected of ['TARGET_PLATFORM_REQUIRED', 'GAME_TOOLS_VERSION_MISMATCH', 'BLUEPRINT_VERSION_MISMATCH']) assert.ok(codes(report).includes(expected));
  for (const value of ['unknown', 'latest', '当前', '*']) {
    const result = assessActionHost(raw, { environment: { ...installed, gameVersion: value } });
    assert.equal(result.status, 'blocked');
  }
  assert.ok(codes(assessActionHost(raw, { environment: {} })).includes('ENVIRONMENT_VERSION_REQUIRED'));
});

test('required host capabilities follow action semantics rather than model support claims', () => {
  const confirmed = assessActionHost(proposal('hit-confirm'));
  const free = assessActionHost(proposal('free-chain'));
  assert.ok(confirmed.capabilities.some(item => item.id === 'hit_confirmation'));
  assert.ok(!free.capabilities.some(item => item.id === 'hit_confirmation'));
  for (const expected of ['input_events', 'action_timing', 'animation_binding', 'world_hit_detection', 'damage_application', 'movement_action', 'stamina_accounting', 'interrupt_handling', 'lifecycle_restore']) assert.ok(confirmed.capabilities.some(item => item.id === expected));
  for (const [field, value] of [['readyToInstall', true], ['game', 'passed'], ['realModBuild', 'passed'], ['claimedStatus', 'verified'], ['hostStatus', 'supported']]) {
    const raw = proposal(); raw[field] = value; rejects(raw);
  }
});

test('asset, unsupported and optional requirement gaps remain visible', () => {
  const raw = proposal();
  raw.assetRequirements.push('用户提供且可使用的动画素材');
  raw.requirements.push({ id: 'character', description: '来源角色外观', required: true, disposition: 'needs_assets', actionIds: [] });
  raw.requirements.push({ id: 'optional-mode', description: '额外模式', required: false, disposition: 'unsupported', actionIds: [] });
  const report = assessActionHost(raw);
  assert.ok(codes(report).includes('ASSETS_NOT_VERIFIED'));
  assert.deepEqual(report.blockers.find(item => item.requirementId === 'character'), { code: 'REQUIREMENT_ASSETS_REQUIRED', message: '必需需求仍有素材或适配缺口，不能标为完成。', requirementId: 'character', required: true, disposition: 'needs_assets' });
  assert.equal(report.blockers.find(item => item.requirementId === 'optional-mode').required, false);
  assert.equal(report.blockers.find(item => item.requirementId === 'optional-mode').code, 'REQUIREMENT_UNSUPPORTED');
});

test('an unexpressible request keeps an empty rule set and its missing requirements blocked', () => {
  const raw = proposal(); raw.actions = []; raw.entryActions = [];
  raw.requirements = [{ id: 'projectile', description: '需要现有规则尚不能表达的远程招式。', required: true, disposition: 'needs_adapter', actionIds: [] }];
  const report = assessActionHost(raw);
  assert.equal(report.status, 'blocked');
  assert.ok(codes(report).includes('RULES_NOT_EXPRESSED'));
  assert.equal(report.blockers.find(item => item.requirementId === 'projectile').code, 'REQUIREMENT_ADAPTER_REQUIRED');
  assert.ok(!report.capabilities.some(item => item.id === 'world_hit_detection' || item.id === 'animation_binding'));
});

test('host assessment accepts the full sixteen-action schema limit without inventing support', () => {
  const raw = proposal();
  const template = raw.actions[0];
  raw.actions = Array.from({ length: 16 }, (_, index) => ({ ...JSON.parse(JSON.stringify(template)), id: `action-${index}`,
    transitions: index === 15 ? [] : [{ input: 'attack', to: `action-${index + 1}`, windowStartTick: 5, windowEndTick: 10, condition: 'always' }] }));
  raw.entryActions = [{ input: 'attack', actionId: 'action-0' }];
  raw.requirements = [{ id: 'chain', description: '十六段规则测试。', required: true, disposition: 'rule', actionIds: raw.actions.map(item => item.id) }];
  const report = assessActionHost(raw);
  assert.equal(report.status, 'blocked'); assert.equal(report.readyToInstall, false);
  assert.ok(report.capabilities.some(item => item.id === 'conditional_transitions'));
});

test('unknown and prototype-named hosts cannot acquire catalogue entries; SMAPI buffs do not grant action support', () => {
  for (const name of ['gta-v', '__proto__', 'constructor', 'prototype']) {
    const raw = proposal(); raw.hostGame = name;
    const report = assessActionHost(raw);
    assert.equal(report.host.status, 'unknown'); assert.equal(report.status, 'blocked');
    assert.ok(codes(report).includes('HOST_UNKNOWN'));
    assert.ok(report.capabilities.every(item => item.status === 'missing'));
  }
  const raw = proposal(); raw.hostGame = 'stardew-valley';
  const report = assessActionHost(raw);
  assert.equal(report.host.status, 'pipeline_only');
  assert.match(report.blockers.find(item => item.code === 'ACTION_ADAPTER_REQUIRED').message, /Buff/);
  assert.ok(report.capabilities.every(item => item.status !== 'passed' && item.status !== 'verified'));
});

test('malformed, amplified and executable assessment inputs fail without invoking getters', () => {
  for (const input of [null, [], {}, 'blueprint']) rejects(input);
  for (const mutate of [
    raw => { raw.actions = []; }, raw => { raw.hostVersion = ''; },
    raw => { raw.actions[0].transitions[0].condition = 'arbitrary_code'; },
    raw => { raw.actions[0].staminaCost = Infinity; },
    raw => { raw.assetRequirements = new Array(17).fill('asset'); },
    raw => { raw.actions = new Array(17).fill(raw.actions[0]); },
    raw => { raw.cycle = raw; }, raw => { raw.source.references = new Array(10); },
    raw => { raw.extra = 'a'.repeat(128 * 1024); },
    raw => { raw.extra = JSON.parse('{"__proto__":{"verified":true}}'); },
    raw => { raw.extra = () => true; },
  ]) { const raw = proposal(); mutate(raw); rejects(raw); }
  let invoked = false;
  const raw = proposal(); Object.defineProperty(raw, 'hostGame', { enumerable: true, get() { invoked = true; return 'bannerlord'; } });
  rejects(raw); assert.equal(invoked, false);
  const deep = proposal(); let tail = deep; for (let i = 0; i < 15; i++) { tail.extra = {}; tail = tail.extra; } rejects(deep);
});

test('environment preflight accepts only bounded metadata and never trusted verification or filesystem paths', () => {
  const raw = proposal();
  for (const environment of [null, [], { ...installed, verified: true }, { ...installed, gamePath: '/private/game' },
    { gameInstalled: 'yes' }, { platform: 'windows' }, { gameVersion: '' }, { toolsVersion: 'x'.repeat(81) },
    JSON.parse('{"__proto__":{"verified":true}}')]) rejects(raw, { environment });
  const env = { ...installed }; const before = JSON.stringify(env);
  assessActionHost(raw, { environment: env }); assert.equal(JSON.stringify(env), before);
});
