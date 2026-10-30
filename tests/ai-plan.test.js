import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, validatePlan, createExamplePlan, PLAN_STATUSES, PLAN_PROPOSAL_SCHEMA } from '../src/ai/plan.mjs';

const request = { hostGame: 'stardew-valley', sourceGame: 'terraria', description: '把来源玩法带进宿主，先生成加速与近战增强的源码草稿。' };
function proposal() {
  return {
    schemaVersion: 1, title: '动作扩展草稿', hostGame: request.hostGame, sourceGame: request.sourceGame,
    summary: '生成两项受支持的源码草稿。',
    requirements: [{ id: 'speed', description: '短时加速', capability: 'speed_burst', status: 'passed', reason: 'Model claims verified.' },
      { id: 'melee', description: '短时近战增强', capability: 'melee_modifier' }],
    mechanics: [{ type: 'speed_burst', key: 'V', amount: 2 }, { type: 'melee_modifier', key: 'B', amount: 1.5 }],
    assetRequirements: [], limitations: [], status: 'verified',
  };
}

test('plan status comes from local capabilities and preserves original host/source request', () => {
  const plan = validatePlan(proposal(), request);
  assert.equal(plan.status, 'draft_supported');
  assert.equal(plan.hostGame, request.hostGame);
  assert.equal(plan.sourceGame, request.sourceGame);
  assert.deepEqual(plan.requirements[0], {
    id: 'original-request', description: request.description, capability: 'request_scope', status: 'draft_supported',
    reason: '保留用户原始需求供逐项核对；当前状态只反映本地生成能力，不代表完整需求已实现或已实机验证。',
  });
  assert.ok(plan.requirements.every(item => item.status === 'draft_supported'));
  assert.ok(plan.requirements.every(item => !item.reason.includes('Model claims')));
  assert.ok(plan.limitations.some(item => item.includes('源码草稿')));
});

test('unknown hosts stay blocked despite model claims that their adapters are verified', () => {
  const input = { ...request, hostGame: 'gta-v', sourceGame: 'counter-strike' };
  const raw = proposal(); raw.hostGame = input.hostGame; raw.sourceGame = input.sourceGame;
  const plan = validatePlan(raw, input);
  assert.equal(plan.status, 'needs_adapter');
  assert.ok(plan.requirements.every(item => item.status === 'needs_adapter'));
});

test('requirements for missing capabilities and source assets remain visible', () => {
  const raw = proposal();
  raw.requirements.push({ id: 'character', description: '带入原角色', capability: 'character_model', status: 'draft_supported' });
  raw.requirements.push({ id: 'combo', description: '带入完整连招', capability: 'full_combo' });
  raw.assetRequirements = ['需要有权使用的角色资源'];
  const plan = validatePlan(raw, request);
  assert.equal(plan.status, 'needs_adapter');
  assert.equal(plan.requirements.find(item => item.id === 'character').status, 'needs_assets');
  assert.equal(plan.requirements.find(item => item.id === 'combo').description, '带入完整连招');
  assert.equal(plan.requirements.find(item => item.id === 'combo').status, 'needs_adapter');
  const onlyAssets = proposal(); onlyAssets.assetRequirements = ['用户角色纹理'];
  assert.equal(validatePlan(onlyAssets, request).status, 'needs_assets');
});

test('prohibited mechanisms cannot be promoted into an approved draft', () => {
  const raw = proposal();
  raw.requirements.push({ id: 'bypass', description: '修改反作弊', capability: 'anti_cheat_bypass', status: 'draft_supported' });
  assert.equal(validatePlan(raw, request).status, 'unsupported');
});

test('host/source reversal and altered original request text are rejected', () => {
  const reversed = proposal(); [reversed.hostGame, reversed.sourceGame] = [reversed.sourceGame, reversed.hostGame];
  assert.throws(() => validatePlan(reversed, request), /direction/);
  const changed = proposal(); changed.requirements.unshift({ id: 'original-request', description: '偷换需求', capability: 'request_scope' });
  assert.throws(() => validatePlan(changed, request), /Original request/);
});

test('declared capabilities without a mechanic remain unresolved; empty plans do not succeed', () => {
  const raw = proposal(); raw.mechanics = [];
  const plan = validatePlan(raw, request);
  assert.equal(plan.status, 'needs_adapter');
  assert.ok(plan.requirements.slice(1).every(item => item.status === 'needs_adapter'));
  const empty = proposal(); empty.mechanics = []; empty.requirements = [];
  assert.equal(validatePlan(empty, request).status, 'needs_adapter');
});

test('mechanics are bounded, completed with defaults, and revalidate without changing the plan', () => {
  const raw = proposal(); raw.mechanics[0].durationTicks = 500;
  const plan = validatePlan(raw, request);
  assert.equal(plan.mechanics[0].cooldownTicks, 500);
  assert.equal(plan.mechanics[1].durationTicks, 120);
  assert.equal(plan.mechanics[1].cooldownTicks, 300);
  assert.deepEqual(validatePlan(plan, request), plan);
  const longRequest = { ...request, description: 'a'.repeat(4000) };
  const longPlan = validatePlan(proposal(), longRequest);
  assert.deepEqual(validatePlan(longPlan, longRequest), longPlan);
});

test('mechanic range errors, key collisions and unknown fields are rejected', () => {
  for (const mutate of [
    raw => { raw.mechanics[0].amount = 7; },
    raw => { raw.mechanics[0].amount = 1.5; },
    raw => { raw.mechanics[1].amount = 0.5; },
    raw => { raw.mechanics[1].amount = Infinity; },
    raw => { raw.mechanics[0].durationTicks = 601; },
    raw => { raw.mechanics[0].durationTicks = 1.5; },
    raw => { raw.mechanics[0].cooldownTicks = 1; },
    raw => { raw.mechanics[0].cooldownTicks = 3601; },
    raw => { raw.mechanics[0].key = '../V'; },
    raw => { raw.mechanics[0].key = 'v'; },
    raw => { raw.mechanics[1].key = 'V'; },
    raw => { raw.mechanics[1].type = 'speed_burst'; },
    raw => { raw.mechanics[0].execute = 'shell'; },
    raw => { raw.mechanics[0].type = 'memory_write'; },
    raw => { raw.code = 'unreviewed code'; },
  ]) { const raw = proposal(); mutate(raw); assert.throws(() => validatePlan(raw, request)); }
});

test('malformed requests and plans respect resource and structural limits', () => {
  for (const input of [null, [], { ...request, extra: true }, { ...request, description: '' }, { ...request, description: 'x'.repeat(8001) },
    { ...request, description: '中'.repeat(5000) }, { ...request, hostGame: 'a\n' }, { ...request, hostGame: '' }]) {
    assert.throws(() => validateRequest(input));
  }
  for (const mutate of [raw => { raw.schemaVersion = 2; }, raw => { raw.mechanics = new Array(3).fill(raw.mechanics[0]); },
    raw => { raw.requirements = new Array(33).fill(raw.requirements[0]); }, raw => { raw.assetRequirements = new Array(17).fill('asset'); },
    raw => { raw.requirements.push({ ...raw.requirements[0] }); }, raw => { raw.requirements[0].capability = 'Bad Field'; },
    raw => { raw.mechanics = new Array(1); }, raw => { raw.limitations = [null]; }]) {
    const raw = proposal(); mutate(raw); assert.throws(() => validatePlan(raw, request));
  }
});

test('game aliases are normalized without allowing object-prototype names to become games', () => {
  assert.deepEqual(validateRequest({ hostGame: '星露谷物语', sourceGame: '泰拉瑞亚', description: '动作' }), { hostGame: 'stardew-valley', sourceGame: 'terraria', description: '动作' });
  assert.equal(validateRequest({ ...request, hostGame: '__proto__' }).hostGame, '__proto__');
  const raw = proposal(); raw.hostGame = '__proto__';
  assert.equal(validatePlan(raw, { ...request, hostGame: '__proto__' }).status, 'needs_adapter');
});

test('large asset dependency lists and local limitations remain stable under revalidation', () => {
  const raw = proposal(); raw.assetRequirements = new Array(16).fill('a'.repeat(500)); raw.limitations = new Array(16).fill('limit');
  const plan = validatePlan(raw, request);
  assert.equal(plan.limitations.length, 17);
  assert.deepEqual(validatePlan(plan, request), plan);
});

test('fixed example identifies itself as non-AI source-draft demonstration', () => {
  const plan = createExamplePlan();
  assert.equal(plan.status, 'draft_supported');
  assert.match(plan.summary, /未调用 AI/);
  assert.ok(plan.limitations.some(item => item.includes('不是 AI')));
  assert.deepEqual(PLAN_STATUSES, ['draft_supported', 'needs_assets', 'needs_adapter', 'unsupported']);
});

test('the exported structural contract is immutable and matches locally enforced resource limits', () => {
  assert.equal(PLAN_PROPOSAL_SCHEMA.additionalProperties, false);
  assert.equal(PLAN_PROPOSAL_SCHEMA.properties.assetRequirements.items.type, 'string');
  assert.equal(PLAN_PROPOSAL_SCHEMA.properties.assetRequirements.maxItems, 16);
  assert.equal(PLAN_PROPOSAL_SCHEMA.properties.assetRequirements.items.maxLength, 500);
  assert.equal(PLAN_PROPOSAL_SCHEMA.properties.mechanics.maxItems, 2);
  assert.ok(Object.isFrozen(PLAN_PROPOSAL_SCHEMA.properties.assetRequirements.items));
  assert.throws(() => { PLAN_PROPOSAL_SCHEMA.properties.assetRequirements.items.type = 'object'; }, TypeError);
  const raw = proposal(); raw.assetRequirements = ['a'.repeat(501)];
  assert.throws(() => validatePlan(raw, request), error => {
    assert.equal(error.category, 'schema');
    assert.deepEqual(error.diagnostics, [{ path: '/assetRequirements/0', rule: 'maxLength', expected: 'string of at most 500 characters' }]);
    return true;
  });
});

test('malformed resource shapes have precise bounded diagnostics without coercion or discarded requirements', () => {
  for (const value of [[{ kind: 'character', path: '/private/do-not-retain' }], [null], [['nested']], [42], ['   '], null, 'one asset']) {
    const raw = proposal(); raw.assetRequirements = value;
    const before = structuredClone(raw);
    assert.throws(() => validatePlan(raw, request), error => {
      assert.equal(error.code, 'INVALID_PLAN');
      assert.equal(error.category, 'schema');
      assert.match(error.diagnostics[0].path, /^\/assetRequirements(?:\/0)?$/);
      assert.equal(error.diagnostics.length, 1);
      assert.ok(JSON.stringify(error).length < 600);
      assert.ok(!JSON.stringify(error).includes('/private/do-not-retain'));
      return true;
    });
    assert.deepEqual(raw, before, 'rejected proposal must not be rewritten into a successful plan');
  }
});

test('unknown field names, accessors and hidden properties never become retained diagnostics or executable getters', () => {
  const raw = proposal();
  raw['private-field-do-not-retain'] = 'value';
  assert.throws(() => validatePlan(raw, request), error => {
    assert.deepEqual(error.diagnostics, [{ path: '/', rule: 'additionalProperties', expected: 'only declared fields' }]);
    assert.ok(!JSON.stringify(error).includes('private-field-do-not-retain'));
    return true;
  });
  for (const enumerable of [false, true]) {
    let called = false;
    const accessor = proposal();
    Object.defineProperty(accessor, 'summary', { enumerable, get() { called = true; throw new Error('getter must not run'); } });
    assert.throws(() => validatePlan(accessor, request), error => error.category === 'schema');
    assert.equal(called, false);
  }
  const sparse = proposal(); sparse.assetRequirements = new Array(1); sparse.assetRequirements.extra = 'fills apparent key count';
  assert.throws(() => validatePlan(sparse, request), error => error.category === 'schema');
});
