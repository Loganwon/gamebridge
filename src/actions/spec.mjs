import { validateRequest } from '../ai/plan.mjs';

export const ACTION_BLUEPRINT_LIMITS = Object.freeze({
  maxBytes: 64 * 1024, maxNormalizedBytes: 80 * 1024,
  maxActions: 16, maxRequirements: 32, maxEntryActions: 8,
  maxTransitionsPerAction: 8, maxActionTicks: 600, maxStamina: 1000,
  maxRegenPerTick: 20, maxScenarioTicks: 3600, maxScenarioEvents: 256,
  maxTraceEntries: 2048, maxGeneratedScenarios: 64,
});

const LOCAL_FIELDS = ['originalRequest', 'scope', 'sourceVerification', 'realModBuild', 'game', 'readyToInstall', 'coverage'];
const PROPOSAL_FIELDS = ['schemaVersion', 'title', 'hostGame', 'hostVersion', 'sourceGame', 'source', 'requirements', 'stamina', 'entryActions', 'actions', 'assetRequirements', 'limitations'];
const DISPOSITIONS = new Set(['rule', 'needs_assets', 'needs_adapter', 'unsupported']);
const ID = /^[a-z][a-z0-9_-]{0,63}$/;
const INPUT = /^[a-z][a-z0-9_-]{0,39}$/;
const MANDATORY_LIMITATION = '动作规则模拟不证明来源玩法保真、宿主接口兼容、真实 Mod 编译或游戏内可玩。';

export class ActionBlueprintError extends Error {
  constructor(message) { super(message); this.name = 'ActionBlueprintError'; this.code = 'INVALID_ACTION_BLUEPRINT'; }
}
function fail(message) { throw new ActionBlueprintError(message); }

export function actionObject(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) fail(`Invalid or unknown ${label} fields.`);
}
export function actionText(value, label, max, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
export function actionArray(value, label, max, min = 0) {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      Array.from({ length: value.length }, (_, index) => !Object.hasOwn(value, index)).some(Boolean) ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(item => !Object.hasOwn(item, 'value'))) fail(`Invalid or oversized ${label}.`);
  return value;
}
export function actionInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`Invalid ${label}: expected integer ${min}..${max}.`);
  return value;
}
function identifier(value, label, expression = ID) {
  const result = actionText(value, label, 64);
  if (!expression.test(result) || ['__proto__', 'constructor', 'prototype'].includes(result)) fail(`Invalid ${label}.`);
  return result;
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`Invalid ${label}.`); return value; }
function texts(raw, label, max, length) { return actionArray(raw, label, max).map(item => actionText(item, label, length, true)); }
function unique(values, label) { if (new Set(values).size !== values.length) fail(`Duplicate ${label}.`); }
function boundedJson(raw, maxBytes = ACTION_BLUEPRINT_LIMITS.maxBytes) {
  const stack = [[raw, 0]];
  const seen = new Set();
  let nodes = 0;
  while (stack.length) {
    if (++nodes > 10000) fail('Action blueprint JSON structure exceeds its limit.');
    const [value, depth] = stack.pop();
    if (depth > 16) fail('Action blueprint JSON nesting exceeds its limit.');
    if (typeof value === 'string' && value.length > ACTION_BLUEPRINT_LIMITS.maxBytes) fail('Action blueprint text exceeds its limit.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;
    if (typeof value === 'number') { if (!Number.isFinite(value)) fail('Action blueprint must contain finite JSON numbers.'); continue; }
    if (!value || typeof value !== 'object' || seen.has(value) ||
        (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))) fail('Action blueprint must be a finite JSON tree.');
    seen.add(value);
    // Reject sparse/amplified array lengths before JSON.stringify can expand them.
    if (Array.isArray(value) && (value.length > ACTION_BLUEPRINT_LIMITS.maxRequirements ||
        Reflect.ownKeys(value).length !== value.length + 1)) fail('Action blueprint array structure exceeds its limit.');
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (typeof key !== 'string' || !Object.hasOwn(descriptor, 'value')) fail('Action blueprint cannot contain accessors or symbols.');
      stack.push([descriptor.value, depth + 1]);
    }
  }
  let json;
  try { json = JSON.stringify(raw); } catch { fail('Action blueprint must be finite JSON.'); }
  if (new TextEncoder().encode(json).byteLength > maxBytes) fail(`Action blueprint exceeds ${maxBytes / 1024} KiB.`);
}
function proposalData(raw) {
  return Object.fromEntries(PROPOSAL_FIELDS.filter(field => Object.hasOwn(raw, field)).map(field => [field, raw[field]]));
}
function boundedBlueprint(raw) {
  const normalized = LOCAL_FIELDS.some(field => Object.hasOwn(raw, field));
  boundedJson(raw, normalized ? ACTION_BLUEPRINT_LIMITS.maxNormalizedBytes : ACTION_BLUEPRINT_LIMITS.maxBytes);
  // Local metadata has its own finite allowance. It cannot hide model data
  // outside the unchanged proposal budget or bypass local-state verification.
  if (normalized) boundedJson(proposalData(raw));
}

export function serializeActionProposal(blueprint) {
  actionObject(blueprint, [...PROPOSAL_FIELDS, ...LOCAL_FIELDS], 'action blueprint');
  boundedBlueprint(blueprint);
  // Serialization is not a way to erase forged locally determined state.
  if (LOCAL_FIELDS.some(field => Object.hasOwn(blueprint, field))) validateActionBlueprint(blueprint, blueprint.originalRequest);
  const proposal = {};
  for (const field of PROPOSAL_FIELDS) proposal[field] = blueprint[field];
  try { return JSON.parse(JSON.stringify(proposal)); }
  catch { fail('Action blueprint must be finite JSON.'); }
}

/** A bounded, declarative action plan. It declares no host support or execution. */
export function validateActionBlueprint(raw, rawRequest) {
  const request = validateRequest(rawRequest);
  actionObject(raw, [...PROPOSAL_FIELDS, ...LOCAL_FIELDS], 'action blueprint');
  boundedBlueprint(raw);
  if (raw.schemaVersion !== 1) fail('Unsupported action blueprint schema version.');
  const title = actionText(raw.title, 'action blueprint title', 120);
  const direction = validateRequest({ hostGame: raw.hostGame, sourceGame: raw.sourceGame, description: request.description });
  if (direction.hostGame !== request.hostGame || direction.sourceGame !== request.sourceGame) fail('Action blueprint changed host/source direction.');
  const hostVersion = actionText(raw.hostVersion, 'host version', 80);
  actionObject(raw.source, ['version', 'references'], 'source');
  const source = { version: actionText(raw.source.version, 'source version', 80), references: [] };
  for (const item of actionArray(raw.source.references, 'source references', 8)) {
    const text = actionText(item, 'source reference', 500);
    let url;
    try { url = new URL(text); } catch { fail('Source reference must be an HTTPS URL.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !url.hostname.includes('.') ||
        /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) || url.hostname.startsWith('[') ||
        /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) fail('Source reference must be a public HTTPS URL without credentials or fragment.');
    if (url.href.length > 500) fail('Normalized source reference exceeds its limit.');
    source.references.push(url.href);
  }
  unique(source.references, 'source references');
  actionObject(raw.stamina, ['max', 'regenPerTick'], 'stamina');
  const stamina = {
    max: actionInteger(raw.stamina.max, 'maximum stamina', 1, ACTION_BLUEPRINT_LIMITS.maxStamina),
    regenPerTick: actionInteger(raw.stamina.regenPerTick, 'idle stamina regeneration', 0, ACTION_BLUEPRINT_LIMITS.maxRegenPerTick),
  };
  const actions = actionArray(raw.actions, 'actions', ACTION_BLUEPRINT_LIMITS.maxActions).map(item => {
    actionObject(item, ['id', 'kind', 'durationTicks', 'staminaCost', 'interruptible', 'hitWindow', 'transitions'], 'action');
    const id = identifier(item.id, 'action id');
    if (!['attack', 'dodge'].includes(item.kind)) fail('Action kind must be attack or dodge.');
    const durationTicks = actionInteger(item.durationTicks, 'action duration', 1, ACTION_BLUEPRINT_LIMITS.maxActionTicks);
    let hitWindow = null;
    if (item.kind === 'attack') {
      actionObject(item.hitWindow, ['startTick', 'endTick'], 'hit window');
      const startTick = actionInteger(item.hitWindow.startTick, 'hit-window start', 0, durationTicks - 1);
      const endTick = actionInteger(item.hitWindow.endTick, 'hit-window end', startTick + 1, durationTicks);
      hitWindow = { startTick, endTick };
    } else if (item.hitWindow !== null) fail('Dodge actions cannot declare a hit window.');
    const transitions = actionArray(item.transitions, 'action transitions', ACTION_BLUEPRINT_LIMITS.maxTransitionsPerAction).map(transition => {
      actionObject(transition, ['input', 'to', 'windowStartTick', 'windowEndTick', 'condition'], 'action transition');
      const input = identifier(transition.input, 'transition input', INPUT);
      const to = identifier(transition.to, 'transition target');
      const windowStartTick = actionInteger(transition.windowStartTick, 'transition-window start', 0, durationTicks - 1);
      const windowEndTick = actionInteger(transition.windowEndTick, 'transition-window end', windowStartTick + 1, durationTicks);
      if (!['always', 'hit_confirmed'].includes(transition.condition)) fail('Unknown transition condition.');
      if (transition.condition === 'hit_confirmed' && item.kind !== 'attack') fail('Only attacks can require a confirmed hit.');
      if (transition.condition === 'hit_confirmed' && windowEndTick <= hitWindow.startTick) fail('Confirmed-hit transition has no possible preceding active window.');
      return { input, to, windowStartTick, windowEndTick, condition: transition.condition };
    });
    for (let i = 0; i < transitions.length; i++) {
      for (const prior of transitions.slice(0, i)) {
        if (prior.input === transitions[i].input && prior.windowStartTick < transitions[i].windowEndTick && transitions[i].windowStartTick < prior.windowEndTick) fail('Overlapping transitions for the same input are ambiguous.');
      }
    }
    return { id, kind: item.kind, durationTicks, staminaCost: actionInteger(item.staminaCost, 'action stamina cost', 0, stamina.max),
      interruptible: bool(item.interruptible, 'action interruptible'), hitWindow, transitions };
  });
  unique(actions.map(item => item.id), 'action ids');
  const ids = new Set(actions.map(item => item.id));
  const entryActions = actionArray(raw.entryActions, 'entry actions', ACTION_BLUEPRINT_LIMITS.maxEntryActions, actions.length ? 1 : 0).map(item => {
    actionObject(item, ['input', 'actionId'], 'entry action');
    const input = identifier(item.input, 'entry input', INPUT);
    const actionId = identifier(item.actionId, 'entry action id');
    if (!ids.has(actionId)) fail('Entry action references an unknown action.');
    return { input, actionId };
  });
  unique(entryActions.map(item => item.input), 'entry inputs');
  for (const action of actions) for (const transition of action.transitions) if (!ids.has(transition.to)) fail('Transition references an unknown action.');
  const reachable = new Set();
  const pending = entryActions.map(item => item.actionId);
  while (pending.length) {
    const id = pending.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    pending.push(...actions.find(item => item.id === id).transitions.map(item => item.to));
  }
  if (reachable.size !== actions.length) fail('Blueprint contains unreachable actions.');

  const requirements = actionArray(raw.requirements, 'action requirements', ACTION_BLUEPRINT_LIMITS.maxRequirements, 1).map(item => {
    actionObject(item, ['id', 'description', 'required', 'disposition', 'actionIds'], 'action requirement');
    const id = identifier(item.id, 'requirement id');
    if (!DISPOSITIONS.has(item.disposition)) fail('Unknown requirement disposition.');
    const actionIds = actionArray(item.actionIds, 'requirement action ids', ACTION_BLUEPRINT_LIMITS.maxActions).map(value => identifier(value, 'requirement action id'));
    unique(actionIds, 'requirement action ids');
    if (actionIds.some(value => !ids.has(value))) fail('Requirement references an unknown action.');
    if (item.disposition === 'rule' && !actionIds.length) fail('Rule requirements must map to at least one action.');
    return { id, description: actionText(item.description, 'requirement description', 2000, true), required: bool(item.required, 'requirement required'),
      disposition: item.disposition, actionIds };
  });
  unique(requirements.map(item => item.id), 'requirement ids');
  if (!requirements.some(item => item.required)) fail('Blueprint requires at least one mandatory requirement.');
  if (actions.some(action => !requirements.some(item => item.actionIds.includes(action.id)))) fail('Every action must map to a declared requirement.');
  const assetRequirements = texts(raw.assetRequirements, 'asset requirements', 16, 500);
  const limitations = texts(raw.limitations, 'limitations', 17, 600);
  if (!limitations.includes(MANDATORY_LIMITATION)) limitations.push(MANDATORY_LIMITATION);
  if (limitations.length > 17) fail('Too many action limitations.');
  const coverage = {
    requiredCount: requirements.filter(item => item.required).length,
    ruleMappedCount: requirements.filter(item => item.required && item.disposition === 'rule').length,
    unresolvedIds: requirements.filter(item => item.required && item.disposition !== 'rule').map(item => item.id),
    semanticCoverage: 'not_verified',
  };
  const local = { originalRequest: request, scope: 'action-blueprint-only', sourceVerification: 'not_verified', realModBuild: 'not_run', game: 'not_run', readyToInstall: false, coverage };
  for (const key of LOCAL_FIELDS) {
    if (Object.hasOwn(raw, key) && JSON.stringify(raw[key]) !== JSON.stringify(local[key])) fail(`Invalid locally determined ${key}.`);
  }
  const result = { schemaVersion: 1, title, hostGame: request.hostGame, hostVersion, sourceGame: request.sourceGame, source,
    requirements, stamina, entryActions, actions, assetRequirements, limitations, ...local };
  // Canonical URLs and the mandatory limitation may expand a proposal. Check
  // the returned form now so every accepted result can be revalidated later.
  boundedJson(proposalData(result));
  boundedJson(result, ACTION_BLUEPRINT_LIMITS.maxNormalizedBytes);
  return result;
}

function exampleProposal(variant) {
  if (!['hit-confirm', 'free-chain', 'committed-attack'].includes(variant)) fail('Unknown action example variant.');
  const dodgeTransition = { input: 'dodge', to: 'dodge', windowStartTick: 6, windowEndTick: 12, condition: 'always' };
  return {
    schemaVersion: 1, title: '项目自有动作规则参考', hostGame: 'bannerlord', hostVersion: 'unknown',
    sourceGame: 'gamebridge-reference-actions', source: { version: '1', references: [] },
    requirements: [
      { id: 'light-chain', description: variant === 'free-chain' ? '轻击挥空也能接第二段。' : '轻击命中后才能接第二段。', required: true, disposition: 'rule', actionIds: ['light-1', 'light-2'] },
      { id: 'dodge-policy', description: variant === 'committed-attack' ? '攻击过程中不能用闪避取消。' : '允许在第一段攻击后摇使用闪避取消。', required: true, disposition: 'rule', actionIds: ['light-1', 'dodge'] },
      { id: 'stamina-and-interrupt', description: '攻击和闪避消耗体力，攻击可被受击中断。', required: true, disposition: 'rule', actionIds: ['light-1', 'light-2', 'dodge'] },
      { id: 'host-integration', description: '宿主输入、动画、武器、真实目标命中与资源绑定仍需适配。', required: true, disposition: 'needs_adapter', actionIds: [] },
    ],
    stamina: { max: 100, regenPerTick: 1 },
    entryActions: [{ input: 'attack', actionId: 'light-1' }, { input: 'dodge', actionId: 'dodge' }],
    actions: [
      { id: 'light-1', kind: 'attack', durationTicks: 12, staminaCost: 25, interruptible: true,
        hitWindow: { startTick: 3, endTick: 5 }, transitions: [
          { input: 'attack', to: 'light-2', windowStartTick: 5, windowEndTick: 10, condition: variant === 'free-chain' ? 'always' : 'hit_confirmed' },
          ...(variant === 'committed-attack' ? [] : [dodgeTransition]),
        ] },
      { id: 'light-2', kind: 'attack', durationTicks: 14, staminaCost: 20, interruptible: true, hitWindow: { startTick: 4, endTick: 6 }, transitions: [] },
      { id: 'dodge', kind: 'dodge', durationTicks: 6, staminaCost: 15, interruptible: false, hitWindow: null, transitions: [] },
    ],
    assetRequirements: [],
    limitations: ['这是项目自有规则示例，未调用模型，不代表商业游戏玩法、角色或资产移植。', '时间单位为确定性的模拟 tick；宿主运行时映射尚未实现。', '体力仅在 idle 状态每 tick 恢复，事件命中为模拟输入。'],
  };
}

function deepFreeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; }
export const ACTION_BLUEPRINT_SCHEMA_EXAMPLE = deepFreeze(exampleProposal('hit-confirm'));

export function createActionExample(variant = 'hit-confirm') {
  const proposal = exampleProposal(variant);
  const request = { hostGame: proposal.hostGame, sourceGame: proposal.sourceGame,
    description: `在候选宿主中规划项目自有动作规则。${proposal.requirements.slice(0, 3).map(item => item.description).join('')}这只是规则模拟，宿主和来源保真均未验收。` };
  return { request, blueprint: validateActionBlueprint(proposal, request) };
}
