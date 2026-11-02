import { ProviderError, requestJsonCompletion, validateProviderConfig } from '../ai/provider.mjs';
import { CONVERSION_LIMITS, ConversionPlanError, validateConversionRequest, validateConversionPlan } from './spec.mjs';

export function buildConversionMessages(rawRequest) {
  const request = validateConversionRequest(rawRequest);
  return { request, messages: [
    { role: 'system', content: `You analyze cross-game conversion requirements for GameBridge, a general AI Mod development tool. The user plays within hostGame and wants content/interactions from sourceGame. Preserve the EXACT direction, complete original intent, requested content kinds and versions. Do not choose a different host, construct a standalone minigame, or replace complex mechanics with a fixed weapon/speed/damage template.
Return one JSON object only, no Markdown, code, executable commands, file paths or claimed results. This is ANALYSIS ONLY. No executable game adapters are registered. Every possible host/source combination requires official/permitted interface research, source behavior specifications, legally usable resources, conversion-loss analysis, project generation, real compilation and real-game acceptance. Do not claim broad game support or invent inspected APIs, citations, assets, exact source timings, build success or game success. Unknown information becomes a question or limitation.
Use exactly this shape: {"schemaVersion":1,"title":"short title","hostGame":"EXACT input hostGame","sourceGame":"EXACT input sourceGame","summary":"analysis summary","requirements":[{"id":"req-1","kind":"character|weapon|moveset|rules|world|audio|ui|assets|other","description":"one retained requested feature","disposition":"needs_research|needs_assets|out_of_scope","reason":"why further work is needed"}],"assetNeeds":[{"id":"asset-1","description":"resource and usage-scope evidence needed","requirementIds":["req-1"]}],"interfaceNeeds":[{"id":"interface-1","description":"host or source interface capability to investigate, not a verified API","requirementIds":["req-1"]}],"questions":["missing user/source/environment detail"],"limitations":["unknown capability or conversion loss"]}.
The | expressions above mean choose ONE enumerated value, not that literal text. Requirements are all retained as mandatory; never omit or mark an inconvenient request optional. needs_assets requires a matching assetNeeds entry. needs_research means unverified, never supported. out_of_scope is an analysis opinion, not evidence that a legitimate feature can never be implemented. Explicitly identify disallowed injection, memory editing, anti-cheat evasion and unauthorized competitive-online changes as out_of_scope. Use official/permitted Mod/import/edit interfaces only. Positive requests for source characters, weapons or animations must remain requirements and resource needs; scope statements such as reusing host assets, not importing original files or not claiming exact fidelity stay in limitations and original request.
Every resource/interface need refers to existing requirement IDs. assetNeeds/interfaceNeeds may be [] if no such dependency is identified, but explain unknown resources or interfaces in questions/limitations. Text lists contain plain non-empty strings, never objects/null. Write text in the user's language. Limits: ${JSON.stringify(CONVERSION_LIMITS)}; titles 120 characters, summary 1800, requirement description 1600, reason 800, dependency description 1000, questions/limitations 800. Use at most 32 requirements and 32 of each dependency kind. Do not output originalRequest, scope, status, workflow, evidence, coverage, readyToGenerate, realModBuild, game, readyToInstall or modelCalls: local code owns these.` },
    { role: 'user', content: JSON.stringify(request) },
  ] };
}

/** One model analysis request. Does not retry, generate code, compile or run a game. */
export async function generateConversionPlan(rawRequest, options = {}) {
  const { request, messages } = buildConversionMessages(rawRequest);
  validateProviderConfig(options);
  const proposal = await requestJsonCompletion(messages, { ...options, maxTokens: 8192, timeoutMs: 120000 });
  try { return validateConversionPlan(proposal, request); }
  catch (error) {
    throw new ProviderError('INVALID_CONVERSION_PLAN', '模型分析未通过转换需求合同校验，已停止且未自动重试。', {
      category: 'schema', diagnostics: error instanceof ConversionPlanError ? error.diagnostics : Object.freeze([Object.freeze({ path: '/', rule: 'schema', expected: 'finite conversion analysis data' })]),
    });
  }
}
