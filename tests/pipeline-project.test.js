// Real deterministic file generation and private-store checks. No cloud model,
// compiler, host game, installable Mod or source-content conversion is executed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validateConversionPlan } from '../src/converter/spec.mjs';
import { validateAgentArtifact } from '../src/agents/provider.mjs';
import { createArtifactStore } from '../src/artifacts/store.mjs';
import { assertRunData } from '../src/orchestration/store.mjs';
import { makeAdapterProjectDraft, ADAPTER_DRAFT_FILES } from '../src/pipeline/project.mjs';

function input() {
  const request = { hostGame: 'Requested Host', hostVersion: '2.4.0', sourceGame: 'Requested Source', sourceVersion: '3.1.0',
    description: '保留来源角色、动作持续及恢复规则，并维持宿主原有世界交互。', contentKinds: ['character', 'moveset', 'rules'] };
  const requirements = [
    { id: 'moves', kind: 'moveset', description: '持续动作以及结束后的状态恢复。', disposition: 'needs_research', reason: '来源时序和宿主接口待核验。' },
    { id: 'character', kind: 'character', description: '完整来源角色、模型和动画。', disposition: 'needs_assets', reason: '需要合法资源与使用范围。' },
    { id: 'rules', kind: 'rules', description: '保留宿主世界交互和现有实体约束。', disposition: 'out_of_scope', reason: '此有界状态规格不能独立表达实体系统。' },
  ];
  const plan = validateConversionPlan({ schemaVersion: 1, title: '完整转换需求', hostGame: request.hostGame, sourceGame: request.sourceGame,
    summary: '分析提案，没有游戏支持或执行证据。', requirements,
    assetNeeds: [{ id: 'character-assets', description: '角色网格、骨骼、动画及合法使用范围。', requirementIds: ['character'] }],
    interfaceNeeds: [{ id: 'host-events', description: '官方宿主事件和实体接口。', requirementIds: ['moves', 'character', 'rules'] }],
    questions: ['角色资源使用范围是什么？'], limitations: ['来源保真和宿主版本尚未验收。'] }, request);
  const upstream = [];
  function artifact(role, analysis) {
    const result = validateAgentArtifact({ schemaVersion: 1, role, scope: 'analysis-only', evidenceScope: 'unverified-proposal',
      hostGame: request.hostGame, sourceGame: request.sourceGame, analysis, realModBuild: 'not_run', game: 'not_run', readyToInstall: false }, { request, upstream });
    upstream.push(result);
  }
  artifact('requirements', plan);
  for (const role of ['source-research', 'host-research', 'conversion-implementation']) artifact(role, { schemaVersion: 1,
    summary: '保留完整资源与接口研究问题。', items: [{ id: 'all', requirementIds: ['moves', 'character', 'rules'], description: '每项必需内容都待核验。', nextStep: '按真实资源、版本和接口调查。' }],
    questions: ['尚待确认的行为边界。'], limitations: ['仅分析建议。'] });
  artifact('independent-validation', { schemaVersion: 1, summary: '独立方案审查，不能证明规格语义。',
    coverage: [{ requirementId: 'moves', assessment: 'addressed_in_plan', reason: '文稿提及动作时序。' },
      { requirementId: 'character', assessment: 'unclear', reason: '缺原始资源。' }, { requirementId: 'rules', assessment: 'missing', reason: '缺实体绑定。' }],
    issues: [{ id: 'missing-assets', requirementIds: ['character', 'rules'], description: '不能忽略角色资源和宿主实体约束。' }], limitations: ['没有审查生成规格或运行游戏。'] });
  const literal = value => ({ op: 'literal', value });
  const variable = id => ({ op: 'variable', id });
  const field = id => ({ op: 'event', id });
  const spec = { schemaVersion: 1, id: 'requested-action', requirementIds: ['moves', 'character', 'rules'], initialState: 'idle', states: ['idle', 'active'],
    variables: [{ id: 'remaining', initial: 0, min: 0, max: 100 }],
    events: [{ id: 'begin', fields: [{ id: 'duration', min: 1, max: 100 }] }, { id: 'tick', fields: [{ id: 'dt', min: 1, max: 100 }] }],
    transitions: [
      { id: 'start', from: 'idle', event: 'begin', to: 'active', priority: 0, requirementIds: ['moves'], guard: literal(true), updates: [{ variable: 'remaining', value: field('duration') }] },
      { id: 'continue', from: 'active', event: 'tick', to: 'active', priority: 0, requirementIds: ['moves'], guard: { op: 'gt', args: [variable('remaining'), field('dt')] }, updates: [{ variable: 'remaining', value: { op: 'sub', args: [variable('remaining'), field('dt')] } }] },
      { id: 'finish', from: 'active', event: 'tick', to: 'idle', priority: 1, requirementIds: ['moves'], guard: literal(true), updates: [{ variable: 'remaining', value: literal(0) }] },
    ], unresolved: [{ requirementId: 'character', reason: '有界状态数据不能表达模型、骨骼或动画。' }, { requirementId: 'rules', reason: '宿主实体接口尚未绑定。' }] };
  return { request, upstream, proposal: { schemaVersion: 1, summary: '部分行为数据提案，非完整需求实现。', spec,
    assumptions: ['时序单位需要来源证据。'], limitations: ['角色资源、实体规则及空间效果均未实现。'] } };
}
const contents = draft => Object.fromEntries(draft.files.map(file => [file.path, file.content]));

test('adapter draft is deterministic generated code and bindings with full analysis, not a Mod', async () => {
  const raw = input(), draft = makeAdapterProjectDraft(raw), files = contents(draft);
  assert.deepEqual(draft.files.map(file => file.path), [...ADAPTER_DRAFT_FILES]);
  assert.deepEqual(makeAdapterProjectDraft(input()), draft);
  assert.equal(draft.metadata.scope, 'adapter-project-draft'); assert.equal(draft.metadata.hostBindingStatus, 'blocked');
  assert.equal(draft.metadata.semanticCompleteness, false); assert.equal(draft.metadata.realModBuild, 'not_run');
  assert.equal(draft.metadata.game, 'not_run'); assert.equal(draft.metadata.readyToInstall, false);
  assertRunData(draft.metadata, { maxBytes: 128 * 1024 });
  assert.match(files['Behavior.g.cs'], /public sealed class BehaviorMachine/);
  assert.match(files['HostBridge.g.cs'], /return machine\.Step\(eventId, fields\)/);
  assert.match(files['GameBridge.AdapterDraft.csproj'], /<OutputType>Library<\/OutputType><TargetFramework>net8\.0/);
  assert.ok(!/PackageReference|ProjectReference|HintPath|<Exec\b/.test(files['GameBridge.AdapterDraft.csproj']));
  assert.match(files['NuGet.Config'], /<clear\s*\/>/);
  assert.ok(!/System\.IO|System\.Net|Process\.Start|Stardew|SuperTux|Terraria|Minecraft|GTA/.test(files['HostBridge.g.cs']));
  assert.equal(JSON.parse(files['request.json']).description, raw.request.description);
  assert.equal(JSON.parse(files['request.json']).hostGame, raw.request.hostGame);
  assert.equal(JSON.parse(files['request.json']).sourceGame, raw.request.sourceGame);
  assert.equal(JSON.parse(files['analysis.json']).upstream.length, 5);
  const root = await mkdtemp(path.join(os.tmpdir(), 'gamebridge-adapter-draft-test-'));
  try {
    const store = await createArtifactStore({ root });
    const handle = await store.create({ files: draft.files, provenance: { producer: 'test-deterministic-generator' } });
    assert.equal(handle.fileCount, 9);
    const manifest = await store.getManifest(handle);
    assert.ok(manifest.files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
    assert.equal((await store.readFile(handle, 'Behavior.g.cs')).toString(), files['Behavior.g.cs']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('every mandatory item retains effects, assets, out-of-scope status, review gaps and unresolved reasons', () => {
  const raw = input(), draft = makeAdapterProjectDraft(raw), binding = JSON.parse(contents(draft)['binding-requirements.json']);
  assert.deepEqual(draft.metadata.requirementIds, ['moves', 'character', 'rules']);
  assert.deepEqual(draft.metadata.unresolvedRequirementIds, ['character', 'rules']);
  assert.deepEqual(binding.requirements.map(item => item.requirement.description), raw.upstream[0].analysis.requirements.map(item => item.description));
  for (const entry of binding.requirements) {
    assert.equal(entry.hostEvents.status, 'unbound'); assert.equal(entry.hostState.status, 'unbound');
    assert.equal(entry.hostEffects.status, 'unbound'); assert.equal(entry.sourceFidelity.status, 'unverified'); assert.equal(entry.acceptance.status, 'not_run');
  }
  const character = binding.requirements.find(item => item.requirement.id === 'character');
  assert.equal(character.resources.needs[0].description, raw.upstream[0].analysis.assetNeeds[0].description);
  assert.equal(character.representation.unresolved[0].reason, raw.proposal.spec.unresolved[0].reason);
  assert.equal(binding.requirements.find(item => item.requirement.id === 'rules').requirement.disposition, 'out_of_scope');
  assert.equal(binding.review.issues[0].description, raw.upstream[4].analysis.issues[0].description);
  assert.equal(binding.proposal.assumptions[0], raw.proposal.assumptions[0]);
  for (const code of ['HOST_ADAPTER_REQUIRED', 'BEHAVIOR_REQUIREMENTS_UNRESOLVED', 'ASSETS_UNVERIFIED', 'OUT_OF_SCOPE_REQUIREMENTS', 'PLAN_REVIEW_GAPS', 'OPEN_ANALYSIS_QUESTIONS']) {
    assert.ok(draft.metadata.blockers.some(item => item.code === code));
  }
});

test('a changed behavior produces different code while paths, bridge authority and dependencies remain fixed', () => {
  const first = input(), second = input(); second.proposal.spec.variables[0].initial = 1;
  const one = contents(makeAdapterProjectDraft(first)), two = contents(makeAdapterProjectDraft(second));
  assert.notEqual(one['Behavior.g.cs'], two['Behavior.g.cs']); assert.notEqual(one['behavior.spec.json'], two['behavior.spec.json']);
  for (const file of ['HostBridge.g.cs', 'GameBridge.AdapterDraft.csproj', 'NuGet.Config', 'README.md']) assert.equal(one[file], two[file]);
  const draft = makeAdapterProjectDraft(first); first.proposal.spec.states[0] = 'changed'; first.request.description = 'changed';
  assert.equal(contents(draft)['Behavior.g.cs'], one['Behavior.g.cs']);
  assert.deepEqual(draft.metadata.requirementIds, ['moves', 'character', 'rules']);
});

test('empty unresolved data never promotes host bindings, source fidelity or semantic completeness', () => {
  const raw = input(); raw.proposal.spec.unresolved = [];
  raw.proposal.spec.transitions[0].requirementIds.push('character', 'rules');
  const draft = makeAdapterProjectDraft(raw), binding = JSON.parse(contents(draft)['binding-requirements.json']);
  assert.deepEqual(draft.metadata.unresolvedRequirementIds, []);
  assert.equal(draft.metadata.semanticCompleteness, false); assert.equal(draft.metadata.hostBindingStatus, 'blocked');
  assert.ok(binding.requirements.every(item => item.hostEffects.status === 'unbound' && item.acceptance.status === 'not_run'));
  assert.ok(draft.metadata.blockers.some(item => item.code === 'ASSETS_UNVERIFIED'));
  assert.ok(draft.metadata.blockers.some(item => item.code === 'PLAN_REVIEW_GAPS'));
});

test('inputs cannot select paths, code, dependencies or forged status, and getters do not execute', () => {
  for (const [field, value] of [['files', [{ path: '../escape', content: 'unsafe' }]], ['commands', ['unsafe']], ['supported', true]]) {
    const raw = input(); raw.proposal[field] = value; assert.throws(() => makeAdapterProjectDraft(raw));
  }
  const unknown = input(); unknown.files = []; assert.throws(() => makeAdapterProjectDraft(unknown), { code: 'INVALID_ADAPTER_PROJECT_INPUT' });
  const forged = input(); forged.upstream[1].game = 'passed'; assert.throws(() => makeAdapterProjectDraft(forged));
  let called = 0; const getter = Object.defineProperty({}, 'request', { enumerable: true, get() { called++; return input().request; } });
  assert.throws(() => makeAdapterProjectDraft(getter));
  const optionGetter = Object.defineProperty({}, 'secrets', { enumerable: true, get() { called++; return []; } });
  assert.throws(() => makeAdapterProjectDraft(input(), optionGetter)); assert.equal(called, 0);
  const invalid = input(); invalid.proposal.spec.variables[0].id = 'x\");unsafe'; assert.throws(() => makeAdapterProjectDraft(invalid));
});

test('credential guards exclude echoes without returning source or credential-bearing diagnostics', () => {
  const raw = input(), secret = 'draft-test-key-canary-not-real'; raw.proposal.assumptions.push(secret);
  assert.throws(() => makeAdapterProjectDraft(raw, { secrets: [secret] }), error => {
    assert.ok(!JSON.stringify(error).includes(secret)); assert.ok(!error.message.includes(secret)); return true;
  });
});
