import { validateRequest } from './plan.mjs';
import { ProviderError, requestJsonCompletion, validateProviderConfig } from './provider.mjs';
import { ACTION_BLUEPRINT_SCHEMA_EXAMPLE, ACTION_BLUEPRINT_LIMITS, validateActionBlueprint } from '../actions/spec.mjs';

export function buildActionMessages(rawRequest) {
  const request = validateRequest(rawRequest);
  return { request, messages: [
    { role: 'system', content: `You design bounded declarative action rules for GameBridge. Return ONE JSON object matching the example keys and types below; no Markdown, code, extra fields, execution instructions, or claims of game support.
The host game is the world the player plays in; the source game is the requested gameplay reference. Preserve that direction and ALL original requirements. Write descriptions in the user's language. This call produces a RULE DESIGN, not a Mod, a playable game, or verified source-game fidelity.
There is no implemented host action adapter. A rule can be described without claiming it is implemented in a host. Set hostVersion and source.version to "unknown" unless supplied explicitly in the request. Use source.references=[] unless the user provides an exact HTTPS reference; do not invent references or exact timings from a game's name. List unknown source timings, missing assets and host adaptation in limitations.
Decompose every requested feature as a requirement: disposition="rule" only if mapped to concrete actionIds; use needs_assets, needs_adapter, or unsupported for remaining requirements. Do not replace complex combat with speed/damage buffs. Character models, weapons, animations and sounds need separately usable resources and host binding. Any process injection, memory modification, anti-cheat evasion or competitive-online modification must be marked unsupported and never encoded as an action.
Scope constraints such as "only design rules", "do not generate a Mod", "do not claim game support", and unknown versions belong in limitations. They are not unsupported gameplay features or missing mandatory actions. Keep these constraints in the original request; do not add an unsupported requirement merely because the request tells you not to perform something.
Rules represent discrete ticks and actions of kind attack or dodge. Idle is implicit. Attack phases derive from hitWindow; dodge uses hitWindow=null. Entry input starts an action. Hit and transition windows are start-inclusive and end-exclusive [startTick,endTick). A transition has condition always or hit_confirmed. A hit event in the standalone simulator is synthetic evidence only. No arbitrary scripts, expressions, file paths, executable names or code are allowed.
Use actual requested actions when representable; other requested behavior remains in requirements. If nothing can be expressed, use actions:[] and entryActions:[], preserving the unsupported/needs_adapter requirements instead of inventing actions. An action can finish into idle, so transitions may be []. Avoid ambiguous duplicate input bindings. Use non-empty plain strings in assetRequirements and limitations, never objects or null. required is a JSON boolean, not a string. Numeric fields are finite numbers; ticks are integers. Requirements/action references must exist.
Bounds: ${JSON.stringify(ACTION_BLUEPRINT_LIMITS)}
maxBytes is the 64 KiB budget for the complete JSON proposal you return. maxNormalizedBytes is reserved for local original-request and validation metadata, not extra model output. Generated replay scenario limits are enforced locally, not output fields.
Complete shape example, authored by this project and NOT a commercial source game or a supported host:
${JSON.stringify(ACTION_BLUEPRINT_SCHEMA_EXAMPLE)}
Use exactly the request hostGame/sourceGame. Do not copy the example's gameplay if the user requested something else. Do not output locally derived fields such as originalRequest, coverage, scope, status, sourceVerification, realModBuild, game, or readyToInstall.` },
    { role: 'user', content: JSON.stringify(request) },
  ] };
}

export async function generateActionBlueprint(rawRequest, options = {}) {
  const { request, messages } = buildActionMessages(rawRequest);
  validateProviderConfig(options);
  const proposal = await requestJsonCompletion(messages, { ...options, maxTokens: 8192, timeoutMs: 120000 });
  try { return validateActionBlueprint(proposal, request); }
  catch {
    // Raw model output and arbitrary validator text must never enter a public job.
    throw new ProviderError('INVALID_ACTION_BLUEPRINT', '模型动作方案未通过本地结构或引用校验；已停止，未重试、未生成 Mod。');
  }
}
