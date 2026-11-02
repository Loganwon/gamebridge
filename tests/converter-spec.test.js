import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConversionRequest, validateConversionPlan, serializeConversionProposal, CONVERSION_LIMITS } from '../src/converter/spec.mjs';
import { assessConversion, readAdapterCatalog } from '../src/converter/workflow.mjs';

function fixture() {
  const request = { hostGame: 'Host World', sourceGame: 'Source Actions', description: '保留来源角色、武器和招式，并在宿主原生敌人上验证；不能改成固定加速效果。', contentKinds: ['character', 'weapon', 'moveset'] };
  const proposal = { schemaVersion: 1, title: '跨游戏内容转换分析', hostGame: request.hostGame, sourceGame: request.sourceGame,
    summary: '先核验内容、资源和宿主接口，再生成可验收工程。',
    requirements: [
      { id: 'character', kind: 'character', description: '保留来源角色与武器资源。', disposition: 'needs_assets', reason: '需要核验合法可用资源。' },
      { id: 'moves', kind: 'moveset', description: '保留招式并作用于真实敌人。', disposition: 'needs_research', reason: '需要分析动作和宿主交互接口。' },
    ], assetNeeds: [{ id: 'source-assets', description: '角色、武器与动画的使用范围和导入规格。', requirementIds: ['character'] }],
    interfaceNeeds: [{ id: 'host-events', description: '正式输入、动画与命中接口。', requirementIds: ['moves'] }], questions: ['所选游戏与工具的精确版本是什么？'], limitations: ['接口与资源尚未核验。'],
  };
  return { request, proposal };
}

test('arbitrary game names remain input while original intent and versions are retained', () => {
  const { request, proposal } = fixture();
  const normalized = validateConversionRequest(request);
  assert.equal(normalized.hostGame, request.hostGame); assert.equal(normalized.sourceGame, request.sourceGame);
  assert.equal(normalized.hostVersion, 'unknown'); assert.equal(normalized.sourceVersion, 'unknown');
  const plan = validateConversionPlan(proposal, request);
  assert.equal(plan.originalRequest.description, request.description);
  assert.deepEqual(plan.coverage.unresolvedIds, ['character', 'moves']); assert.equal(plan.coverage.semanticCoverage, 'not_verified');
  assert.equal(plan.readyToGenerate, false); assert.equal(plan.realModBuild, 'not_run'); assert.equal(plan.game, 'not_run'); assert.equal(plan.readyToInstall, false);
  assert.deepEqual(validateConversionPlan(plan), plan);
  assert.deepEqual(validateConversionPlan(JSON.parse(JSON.stringify(plan))), plan);
});

test('request rejects executable fields, getters, duplicate kinds and oversized Unicode input without invoking accessors', () => {
  const { request } = fixture();
  for (const raw of [{ ...request, command: 'do not run' }, { ...request, description: '' }, { ...request, contentKinds: ['moveset', 'moveset'] }, { ...request, contentKinds: ['code'] }, { ...request, description: '界'.repeat(8000) }, { ...request, hostVersion: '\ninvalid' }]) assert.throws(() => validateConversionRequest(raw), { code: 'INVALID_CONVERSION_REQUEST' });
  let called = false;
  const raw = Object.defineProperty({ ...request }, 'description', { enumerable: true, get() { called = true; return 'must not read'; } });
  assert.throws(() => validateConversionRequest(raw)); assert.equal(called, false);
});

test('wrong direction, missing asset dependency, invalid references and unsupported schema claims are rejected', () => {
  for (const mutate of [p => { p.hostGame = p.sourceGame; }, p => { p.requirements[0].disposition = 'supported'; }, p => { p.requirements[0].required = false; }, p => { p.assetNeeds = []; }, p => { p.interfaceNeeds[0].requirementIds = ['missing']; }, p => { p.game = 'passed'; }, p => { p.commands = ['must not run']; }]) {
    const { request, proposal } = fixture(); mutate(proposal);
    assert.throws(() => validateConversionPlan(proposal, request), { code: 'INVALID_CONVERSION_PLAN' });
  }
});

test('local task graph is deterministic, acyclic and covers every requirement through real validation stages', () => {
  const { request, proposal } = fixture(), plan = validateConversionPlan(proposal, request);
  const seen = new Set();
  for (const task of plan.workflow.tasks) {
    assert.ok(task.dependsOn.every(id => seen.has(id))); seen.add(task.id);
    assert.equal(task.status, task.kind === 'analysis' ? 'validated' : 'blocked');
  }
  assert.equal(plan.workflow.executable, false);
  for (const req of plan.requirements) assert.ok(plan.workflow.tasks.some(task => task.kind === 'interactionMapping' && task.requirementIds.includes(req.id)));
  for (const kind of ['sourceResearch', 'hostInspection', 'assetMapping', 'generation', 'build', 'game']) assert.ok(plan.workflow.tasks.some(task => task.kind === kind));
  const assessment = assessConversion(plan);
  assert.equal(assessment.status, 'blocked'); assert.equal(assessment.readyToGenerate, false); assert.equal(assessment.game, 'not_run');
  assert.ok(assessment.blockers.some(item => item.code === 'HOST_ADAPTER_REQUIRED'));
  assert.deepEqual(readAdapterCatalog(), []);
  const catalog = readAdapterCatalog(); catalog.push({ id: 'forged' }); assert.deepEqual(readAdapterCatalog(), []);
});

test('model success flags and forged local workflow/evidence never become execution permission', () => {
  const { request, proposal } = fixture(); const plan = validateConversionPlan(proposal, request);
  for (const mutate of [p => { p.evidence.game = 'passed'; }, p => { p.workflow.executable = true; }, p => { p.readyToGenerate = true; }, p => { p.readyToInstall = true; }, p => { p.coverage.unresolvedIds = []; }]) {
    const raw = structuredClone(plan); mutate(raw); assert.throws(() => validateConversionPlan(raw), { code: 'INVALID_CONVERSION_PLAN' });
  }
  assert.deepEqual(serializeConversionProposal(plan), proposal);
});

test('malformed and amplification inputs are bounded with safe contract-only diagnostics', () => {
  const { request, proposal } = fixture();
  const raw = structuredClone(proposal); raw.requirements[0].description = { privateMarker: 'not-in-error' };
  assert.throws(() => validateConversionPlan(raw, request), error => {
    assert.equal(error.code, 'INVALID_CONVERSION_PLAN'); assert.ok(!JSON.stringify(error).includes('not-in-error')); assert.ok(Object.isFrozen(error.diagnostics[0])); return true;
  });
  const repeated = structuredClone(proposal); repeated.requirements.push(repeated.requirements[0]); assert.throws(() => validateConversionPlan(repeated, request));
  const unsafe = JSON.parse(JSON.stringify(proposal)); unsafe.requirements[0] = JSON.parse('{"__proto__":{"bad":true}}'); assert.throws(() => validateConversionPlan(unsafe, request));
  assert.equal(CONVERSION_LIMITS.normalizedBytes > CONVERSION_LIMITS.proposalBytes, true);
});

test('maximal requirement/dependency counts do not amplify duplicated links or truncate descriptions', () => {
  const { request, proposal } = fixture();
  proposal.requirements = Array.from({ length: 32 }, (_, i) => ({ id: `req-${i}`, kind: 'other', description: '完整保留需求。'.repeat(60), disposition: 'needs_research', reason: '需要核验接口。' }));
  const ids = proposal.requirements.map(item => item.id);
  proposal.assetNeeds = Array.from({ length: 32 }, (_, i) => ({ id: `asset-${i}`, description: '需要核验的资源。', requirementIds: [...ids] }));
  proposal.interfaceNeeds = [];
  const plan = validateConversionPlan(proposal, request);
  assert.equal(plan.requirements.length, 32); assert.equal(plan.requirements[0].description, proposal.requirements[0].description);
  assert.equal(plan.workflow.tasks.find(task => task.id === 'resolve-assets').requirementIds.length, 32);
  assert.deepEqual(validateConversionPlan(plan), plan);
});
