// A model proposes a plan; only this local capability catalogue determines status.
const STATUSES = ['draft_supported', 'needs_assets', 'needs_adapter', 'unsupported'];
const HOST = 'stardew-valley';
const MECHANICS = new Set(['speed_burst', 'melee_modifier']);
const ASSET_CAPABILITIES = new Set(['character_model', 'character_animation', 'weapon_asset', 'source_asset', 'character_assets', 'animation_assets', 'weapon_assets']);
const FORBIDDEN_CAPABILITIES = new Set(['process_injection', 'memory_write', 'anti_cheat_bypass', 'anti_cheat_evasion', 'online_competitive']);
const MAX_REQUEST_BYTES = 12 * 1024;

export class PlanValidationError extends Error {
  constructor(message) { super(message); this.name = 'PlanValidationError'; this.code = 'INVALID_PLAN'; }
}
function fail(message) { throw new PlanValidationError(message); }
function object(value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Object.keys(value).some(key => !allowed.includes(key))) fail(`Invalid or unknown ${label} fields.`);
}
function string(value, label, max, { multiline = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max ||
      (multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(value)) fail(`Invalid ${label}.`);
  return value.trim();
}
function array(value, label, max) {
  if (!Array.isArray(value) || value.length > max || Object.keys(value).length !== value.length) fail(`Invalid or oversized ${label}.`);
  return value;
}
function canonicalGame(value, label) {
  const text = string(value, label, 80);
  const aliases = {
    'stardew-valley': HOST, 'stardew valley': HOST, '星露谷物语': HOST, '星露谷': HOST,
    'terraria': 'terraria', '泰拉瑞亚': 'terraria',
    'gta v': 'gta-v', 'gta5': 'gta-v', 'gta-v': 'gta-v', 'gta 5': 'gta-v',
    'cs': 'counter-strike', 'counter-strike': 'counter-strike', 'counter strike': 'counter-strike',
  };
  return Object.hasOwn(aliases, text.toLowerCase()) ? aliases[text.toLowerCase()] : text;
}
export function validateRequest(raw) {
  object(raw, ['hostGame', 'sourceGame', 'description'], 'request');
  const request = {
    hostGame: canonicalGame(raw.hostGame, 'host game'),
    sourceGame: canonicalGame(raw.sourceGame, 'source game'),
    description: string(raw.description, 'request description', 8000, { multiline: true }),
  };
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > MAX_REQUEST_BYTES) fail('Request exceeds 12 KiB.');
  return request;
}
function capabilityStatus(host, capability) {
  if (FORBIDDEN_CAPABILITIES.has(capability)) return {
    status: 'unsupported', reason: '该能力超出项目允许的 Mod 接口范围，不能生成或执行。',
  };
  if (host !== HOST) return {
    status: 'needs_adapter', reason: '尚无该宿主的生成适配器，模型描述不能证明已经接入。',
  };
  if (ASSET_CAPABILITIES.has(capability)) return {
    status: 'needs_assets', reason: '需要用户提供有权使用的角色、武器或动作资源，并另行完成适配和验证。',
  };
  if (MECHANICS.has(capability)) return {
    status: 'draft_supported', reason: '本地模板能够生成这项 SMAPI 源码草稿；尚未证明构建或游戏内行为。',
  };
  return { status: 'needs_adapter', reason: '当前能力目录没有这项实现，需要新增适配后才能生成。' };
}
function worst(statuses) {
  const order = ['draft_supported', 'needs_assets', 'needs_adapter', 'unsupported'];
  return statuses.reduce((a, b) => order.indexOf(b) > order.indexOf(a) ? b : a, 'draft_supported');
}
function validateMechanic(raw) {
  object(raw, ['type', 'key', 'durationTicks', 'cooldownTicks', 'amount'], 'mechanic');
  if (!MECHANICS.has(raw.type)) fail('Unknown mechanic type.');
  const key = raw.key === undefined ? (raw.type === 'speed_burst' ? 'V' : 'B') : raw.key;
  if (typeof key !== 'string' || !/^[A-Z]$/.test(key)) fail('Mechanic key must be a single uppercase A–Z key.');
  const durationTicks = raw.durationTicks ?? 120;
  const cooldownTicks = raw.cooldownTicks ?? Math.max(300, durationTicks);
  const amount = raw.amount ?? (raw.type === 'speed_burst' ? 2 : 1.5);
  if (!Number.isSafeInteger(durationTicks) || durationTicks < 1 || durationTicks > 600) fail('Mechanic duration is outside 1–600 ticks.');
  if (!Number.isSafeInteger(cooldownTicks) || cooldownTicks < durationTicks || cooldownTicks > 3600) fail('Mechanic cooldown must cover duration and stay within 3600 ticks.');
  if (!Number.isFinite(amount) || (raw.type === 'speed_burst' ? !Number.isSafeInteger(amount) || amount < 1 || amount > 6 : amount < 1 || amount > 3)) fail('Mechanic amount exceeds the local template limit.');
  return { type: raw.type, key, durationTicks, cooldownTicks, amount };
}
function textList(raw, label, maxItems, maxLength) {
  return array(raw, label, maxItems).map(item => string(item, label, maxLength, { multiline: true }));
}

export function validatePlan(raw, rawRequest) {
  const request = validateRequest(rawRequest);
  object(raw, ['schemaVersion', 'title', 'hostGame', 'sourceGame', 'summary', 'requirements', 'mechanics', 'assetRequirements', 'limitations', 'status'], 'plan');
  if (raw.schemaVersion !== 1) fail('Unsupported plan schema version.');
  if (canonicalGame(raw.hostGame, 'plan host game') !== request.hostGame ||
      canonicalGame(raw.sourceGame, 'plan source game') !== request.sourceGame) fail('The plan changed the requested host or source direction.');
  if (raw.status !== undefined && typeof raw.status !== 'string') fail('Invalid model-proposed status.');
  const title = string(raw.title, 'plan title', 120);
  const summary = string(raw.summary, 'plan summary', 1800, { multiline: true });
  const mechanics = array(raw.mechanics, 'mechanics', 2).map(validateMechanic);
  if (new Set(mechanics.map(item => item.type)).size !== mechanics.length ||
      new Set(mechanics.map(item => item.key)).size !== mechanics.length) fail('Mechanic types and keys must be unique.');
  const assetRequirements = textList(raw.assetRequirements, 'asset requirements', 16, 500);
  const limitations = textList(raw.limitations, 'limitations', 17, 600);
  const requirements = [];
  const ids = new Set(['original-request']);
  for (const item of array(raw.requirements, 'requirements', 32)) {
    object(item, ['id', 'description', 'capability', 'status', 'reason'], 'requirement');
    const id = string(item.id, 'requirement id', 64);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(id)) fail('Invalid requirement id.');
    const description = string(item.description, 'requirement description', id === 'original-request' ? 8000 : 2000, { multiline: true });
    const capability = string(item.capability, 'requirement capability', 80);
    if (!/^[a-z][a-z0-9_]*$/.test(capability)) fail('Invalid capability name.');
    if (item.status !== undefined && typeof item.status !== 'string') fail('Invalid requirement status.');
    if (item.reason !== undefined) string(item.reason, 'requirement reason', 1000, { multiline: true });
    // Revalidation is idempotent. The local original-text row cannot be replaced.
    if (id === 'original-request') {
      if (description !== request.description || capability !== 'request_scope') fail('Original request text was altered.');
      continue;
    }
    if (ids.has(id)) fail('Duplicate requirement id.');
    ids.add(id);
    requirements.push({ id, description, capability, ...capabilityStatus(request.hostGame, capability) });
  }
  // A model must not hide a requested capability by proposing no implementation.
  for (const requirement of requirements) {
    if (MECHANICS.has(requirement.capability) && !mechanics.some(m => m.type === requirement.capability)) {
      requirement.status = 'needs_adapter';
      requirement.reason = '计划提到此能力，但未提供可生成的具体机制配置。';
    }
  }
  for (const [index, mechanic] of mechanics.entries()) {
    if (!requirements.some(item => item.capability === mechanic.type)) {
      let id = `mechanic-${index + 1}`;
      while (ids.has(id)) id += '-local';
      ids.add(id);
      requirements.push({ id, description: `生成 ${mechanic.type} 的源码草稿。`, capability: mechanic.type, ...capabilityStatus(request.hostGame, mechanic.type) });
    }
  }
  if (assetRequirements.length && !requirements.some(item => item.status === 'needs_assets')) {
    let id = 'assets-local';
    while (ids.has(id)) id += '-local';
    requirements.push({ id, description: `计划列出 ${assetRequirements.length} 项资源依赖，详见 assetRequirements。`, capability: 'source_asset', ...capabilityStatus(request.hostGame, 'source_asset') });
  }
  let status = worst(requirements.map(item => item.status));
  if (request.hostGame !== HOST) status = worst([status, 'needs_adapter']);
  if (!mechanics.length && status === 'draft_supported') status = 'needs_adapter';
  if (requirements.length > 31) fail('Plan has too many effective requirements.');
  requirements.unshift({
    id: 'original-request', description: request.description, capability: 'request_scope', status,
    reason: '保留用户原始需求供逐项核对；当前状态只反映本地生成能力，不代表完整需求已实现或已实机验证。',
  });
  const mandatory = '生成结果仅为源码草稿；模型与模板检查不能证明完整语义覆盖、构建成功或真实游戏兼容。';
  if (!limitations.includes(mandatory)) limitations.push(mandatory);
  if (limitations.length > 17) fail('Too many limitations.');
  return { schemaVersion: 1, title, hostGame: request.hostGame, sourceGame: request.sourceGame,
    summary, requirements, mechanics, assetRequirements, limitations, status };
}

export function createExamplePlan() {
  const request = { hostGame: HOST, sourceGame: 'terraria', description: '在星露谷里制作一个泰拉瑞亚风格的短时加速和近战增强源码草稿，不包含角色、美术或完整游戏规则。' };
  return validatePlan({ schemaVersion: 1, title: '星露谷动作扩展示例工程', hostGame: HOST, sourceGame: 'terraria',
    summary: '固定模板示例，未调用 AI；仅演示受支持的工程生成流程，不宣称复用了泰拉瑞亚代码或完整玩法。',
    requirements: [
      { id: 'speed', description: '通过按键获得短时加速。', capability: 'speed_burst' },
      { id: 'melee', description: '通过按键获得短时近战伤害增强。', capability: 'melee_modifier' },
    ], mechanics: [{ type: 'speed_burst', key: 'V', amount: 2 }, { type: 'melee_modifier', key: 'B', amount: 1.5 }],
    assetRequirements: [], limitations: ['本示例使用固定模板，不是 AI 生成结果。', '未包含泰拉瑞亚角色、武器素材、招式动画、地图或规则系统。'],
  }, request);
}

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_STATUSES = Object.freeze([...STATUSES]);
