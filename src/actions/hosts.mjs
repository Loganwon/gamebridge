import { validateActionBlueprint, ACTION_BLUEPRINT_LIMITS } from './spec.mjs';

// Documentation and user-supplied metadata never establish a working host adapter.
// This module performs no I/O and intentionally has no route to a passed state.
const LIMITS = Object.freeze({ bytes: ACTION_BLUEPRINT_LIMITS.maxBytes, nodes: 4096, depth: 12,
  actions: ACTION_BLUEPRINT_LIMITS.maxActions, requirements: ACTION_BLUEPRINT_LIMITS.maxRequirements });
const HOSTS = [
  {
    id: 'bannerlord', label: 'Mount & Blade II: Bannerlord', status: 'candidate',
    targetPlatform: 'win32', exactGameVersion: null, exactToolsVersion: null, adapterVersion: null,
    verifiedCapabilities: [],
    officialReferences: [
      'https://moddocs.bannerlord.com/',
      'https://moddocs.bannerlord.com/asset-management/faq/',
      'https://moddocs.bannerlord.com/asset-management/asset-types/animations/',
      'https://apidoc.bannerlord.com/',
    ],
    note: '优先研究候选；尚无动作适配器、精确版本或真实游戏验收。官方动画导入说明不证明连招、取消或命中控制可行。',
  },
  {
    id: 'stardew-valley', label: 'Stardew Valley / SMAPI', status: 'pipeline_only',
    targetPlatform: null, exactGameVersion: null, exactToolsVersion: null, adapterVersion: null,
    verifiedCapabilities: [], officialReferences: ['https://smapi.io/'],
    note: '现有加速与近战倍率仅为独立管线测试；不构成武器动作、动画、连招或闪避适配。',
  },
];
const ALIASES = new Map([
  ['bannerlord', 'bannerlord'], ['mount & blade ii: bannerlord', 'bannerlord'],
  ['mount & blade ii bannerlord', 'bannerlord'], ['骑马与砍杀2', 'bannerlord'], ['骑马与砍杀 2', 'bannerlord'],
  ['stardew-valley', 'stardew-valley'], ['stardew valley', 'stardew-valley'], ['星露谷', 'stardew-valley'], ['星露谷物语', 'stardew-valley'],
]);
const CAPABILITIES = {
  module_lifecycle: '模块加载、版本核对与生命周期',
  input_events: '游戏输入与原生控制交接',
  action_timing: '攻击起手、命中和后摇时序',
  animation_binding: '动作与可用动画绑定',
  world_hit_detection: '真实目标与命中判定',
  damage_application: '宿主伤害与反馈',
  movement_action: '闪避位移与碰撞',
  conditional_transitions: '连段与取消状态转换',
  hit_confirmation: '真实命中确认条件',
  stamina_accounting: '资源消耗与恢复',
  interrupt_handling: '受击与死亡中断',
  lifecycle_restore: '菜单、场景和退出后的恢复',
};
const UNKNOWN = /^(?:unknown|unverified|latest|current|any|\*|未知|未确定|未验收)$/i;
function unknownVersion(value) { return UNKNOWN.test(value) || /[<>=*^~]/.test(value); }

export class HostAssessmentError extends Error {
  constructor(message) { super(message); this.name = 'HostAssessmentError'; this.code = 'INVALID_HOST_ASSESSMENT'; }
}
function fail(message) { throw new HostAssessmentError(message); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`Invalid ${label}.`);
  return value;
}
function text(value, label, max = 100) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function boundedData(value) {
  let nodes = 0;
  const ancestors = new Set();
  function visit(item, depth) {
    if (++nodes > LIMITS.nodes || depth > LIMITS.depth) fail('Assessment input exceeds structural limits.');
    if (item === null || typeof item === 'boolean') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail('Assessment input contains a non-finite number.'); return; }
    if (typeof item === 'string') { if (item.length > 12000) fail('Assessment input text is too long.'); return; }
    if (typeof item !== 'object') fail('Assessment input must contain JSON data only.');
    if (ancestors.has(item)) fail('Assessment input contains a cycle.');
    if (Array.isArray(item)) { if (item.length > 512) fail('Assessment array is too large.'); }
    else object(item, 'assessment object');
    if (Object.getOwnPropertySymbols(item).length) fail('Assessment input contains symbol properties.');
    ancestors.add(item);
    const descriptors = Object.getOwnPropertyDescriptors(item);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(item) && key === 'length') continue;
      if (['__proto__', 'prototype', 'constructor'].includes(key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Assessment input contains unsafe properties.');
      if (Array.isArray(item) && !/^(?:0|[1-9][0-9]*)$/.test(key)) fail('Assessment input contains a malformed array.');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(item) && Object.keys(item).length !== item.length) fail('Assessment input contains a sparse array.');
    ancestors.delete(item);
  }
  visit(value, 0);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > LIMITS.bytes) fail('Assessment input exceeds byte limits.');
}
function readBlueprint(raw) {
  boundedData(raw);
  object(raw, 'action blueprint');
  let normalized;
  try {
    normalized = validateActionBlueprint(raw, raw.originalRequest ?? {
      hostGame: raw.hostGame, sourceGame: raw.sourceGame, description: '宿主能力预检，不代表需求覆盖验收。',
    });
  } catch { fail('Invalid action blueprint for host assessment.'); }
  return { raw: normalized, hostGame: normalized.hostGame, hostVersion: normalized.hostVersion,
    actions: normalized.actions, requirements: normalized.requirements, assets: normalized.assetRequirements,
    sourceVersion: normalized.source.version };
}
function readEnvironment(raw) {
  if (raw === undefined) return { provided: false, verification: 'metadata-only', platform: null, gameVersion: null, toolsVersion: null, gameInstalled: false, toolsInstalled: false, versionValidated: false };
  boundedData(raw); object(raw, 'environment metadata');
  const allowed = ['platform', 'gameVersion', 'toolsVersion', 'gameInstalled', 'toolsInstalled'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail('Unknown environment metadata field.');
  if (raw.platform !== undefined && !['win32', 'darwin', 'linux'].includes(raw.platform)) fail('Invalid environment platform.');
  for (const name of ['gameInstalled', 'toolsInstalled']) if (raw[name] !== undefined && typeof raw[name] !== 'boolean') fail('Invalid installation metadata.');
  return {
    provided: true, verification: 'metadata-only', platform: raw.platform ?? null,
    gameVersion: raw.gameVersion === undefined ? null : text(raw.gameVersion, 'game version', 80),
    toolsVersion: raw.toolsVersion === undefined ? null : text(raw.toolsVersion, 'tools version', 80),
    gameInstalled: raw.gameInstalled ?? false, toolsInstalled: raw.toolsInstalled ?? false, versionValidated: false,
  };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

/** Candidate catalogue, not a compatibility or support list. Each call is detached. */
export function getHostCatalog() { return clone(HOSTS); }

/** Pure metadata preflight. Model claims and self-reported installations cannot pass it. */
export function assessActionHost(blueprint, { environment: rawEnvironment } = {}) {
  const plan = readBlueprint(blueprint);
  const environment = readEnvironment(rawEnvironment);
  const hostGame = ALIASES.get(plan.hostGame.toLowerCase()) ?? plan.hostGame;
  const known = HOSTS.find(item => item.id === hostGame);
  const host = known ? clone(known) : {
    id: hostGame, label: hostGame, status: 'unknown', targetPlatform: null,
    exactGameVersion: null, exactToolsVersion: null, adapterVersion: null, verifiedCapabilities: [], officialReferences: [],
    note: '没有该宿主的动作适配器或版本化能力证据。',
  };
  const blockers = [];
  const add = (code, message, extra = {}) => blockers.push({ code, message, ...extra });
  if (!known) add('HOST_UNKNOWN', '该宿主尚未进入已研究目录，不能制作真实动作 Mod。');
  add('ACTION_ADAPTER_REQUIRED', known?.status === 'pipeline_only'
    ? '已有 SMAPI 管线仅覆盖两种 Buff；武器动作适配器尚未实现。'
    : '尚无经过真实游戏验证的动作宿主适配器。');
  if (unknownVersion(plan.hostVersion)) add('HOST_VERSION_REQUIRED', '需冻结宿主的精确游戏版本；unknown/latest 不构成版本证据。');
  add('HOST_VERSION_NOT_VERIFIED', '尚未核对真实游戏、工具与动作适配器的精确版本。');
  if (!environment.provided || !environment.gameInstalled || !environment.toolsInstalled) add('GAME_ENVIRONMENT_REQUIRED', '真实能力探针需要本地游戏和相应 Mod 工具；当前元数据不足。');
  if (environment.provided) {
    add('ENVIRONMENT_NOT_VERIFIED', '环境信息仅为用户提供的元数据，未检测安装文件或运行真实游戏。');
    if (host.targetPlatform && environment.platform !== host.targetPlatform) add('TARGET_PLATFORM_REQUIRED', '该候选的首轮验证目标是 Windows；当前平台未匹配。');
    if (!environment.gameVersion || !environment.toolsVersion || unknownVersion(environment.gameVersion) || unknownVersion(environment.toolsVersion)) add('ENVIRONMENT_VERSION_REQUIRED', '需要分别记录真实游戏和 Mod 工具的精确版本。');
    else {
      if (environment.gameVersion !== environment.toolsVersion && hostGame === 'bannerlord') add('GAME_TOOLS_VERSION_MISMATCH', 'Bannerlord 官方工具和游戏必须使用同一版本。');
      if (!unknownVersion(plan.hostVersion) && environment.gameVersion !== plan.hostVersion) add('BLUEPRINT_VERSION_MISMATCH', '蓝图目标版本与环境自报游戏版本不一致。');
    }
  }
  if (unknownVersion(plan.sourceVersion) || !plan.raw.source.references.length) add('SOURCE_SPEC_REQUIRED', '来源游戏版本、动作出处与可核对规格尚未冻结。');
  add('SOURCE_FIDELITY_NOT_VERIFIED', '来源描述和引用尚未证明招式、时序或资源保真。');
  for (const requirement of plan.requirements) if (requirement.disposition !== 'rule') {
    add(requirement.disposition === 'needs_assets' ? 'REQUIREMENT_ASSETS_REQUIRED' : requirement.disposition === 'unsupported' ? 'REQUIREMENT_UNSUPPORTED' : 'REQUIREMENT_ADAPTER_REQUIRED',
      requirement.required ? '必需需求仍有素材或适配缺口，不能标为完成。' : '可选需求存在未解决的素材或适配缺口。',
      { requirementId: requirement.id, required: requirement.required, disposition: requirement.disposition });
  }
  if (plan.assets.length) add('ASSETS_NOT_VERIFIED', '资源依赖尚未经过本地来源、导入与动作绑定验收。');
  if (!plan.actions.length) add('RULES_NOT_EXPRESSED', '当前需求没有可表达的动作规则；缺失需求仍须新增规则或适配，不能由示例动作替代。');
  const required = new Set(['module_lifecycle', 'lifecycle_restore']);
  if (plan.actions.length) for (const id of ['input_events', 'action_timing', 'animation_binding']) required.add(id);
  for (const action of plan.actions) {
    if (action.kind === 'attack') { required.add('world_hit_detection'); required.add('damage_application'); }
    if (action.kind === 'dodge') required.add('movement_action');
    if (action.transitions.length) required.add('conditional_transitions');
    if (action.transitions.some(item => item.condition === 'hit_confirmed')) required.add('hit_confirmation');
    if (action.staminaCost > 0) required.add('stamina_accounting');
    if (action.interruptible) required.add('interrupt_handling');
  }
  if (plan.raw.stamina.regenPerTick > 0) required.add('stamina_accounting');
  const capabilities = [...required].map(id => ({
    id, label: CAPABILITIES[id], status: known ? 'unverified' : 'missing', required: true,
    reason: '当前只有声明式规则模拟；该项宿主接口尚未通过真实能力探针。',
  }));
  return {
    schemaVersion: 1, scope: 'host-capability-preflight-only', status: 'blocked', hostGame, hostVersion: plan.hostVersion,
    host, environment, capabilities, blockers,
    featureLoss: ['规则模拟不包含实际动画、位移碰撞、敌人 AI、伤害或存档。', '文档存在、元数据填写完整和模拟通过均不建立宿主兼容性。'],
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
  };
}

export const ACTION_HOST_LIMITS = LIMITS;
