import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { generatePlan } from '../src/ai/provider.mjs';
import { validateProviderConfig } from '../src/ai/provider.mjs';
import { generateActionBlueprint } from '../src/ai/action-provider.mjs';
import { createActionExample } from '../src/actions/spec.mjs';
import { createActionScenarios, simulateActionBlueprint } from '../src/actions/runtime.mjs';
import { assessActionHost } from '../src/actions/hosts.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_LIVE_CALLS = 3;
const DEFAULT_OUTPUT = path.join(ROOT, 'artifacts/action-design-verification/report.json');
const LIVE_STEPS = [
  {
    id: 'legacy-fresh-analysis', kind: 'legacy-plan',
    request: {
      hostGame: 'stardew-valley', sourceGame: 'terraria',
      description: '在星露谷的世界中规划泰拉瑞亚式角色、武器和动作交互：需要角色外观、武器素材、招式动画、瞄准攻击、闪避和连段。逐项保留这些要求并列明素材与接口缺口，不能用加速或伤害倍率替代。当前只做需求分析，不提供或提取商业游戏素材，不要求执行或安装 Mod。',
    },
  },
  {
    id: 'action-hit-confirm', kind: 'action-blueprint',
    request: {
      hostGame: 'bannerlord', sourceGame: 'gamebridge-reference-actions',
      description: '设计项目自有的动作规则，不引用商业来源游戏或资产：轻击必须命中才能接第二段；第一段攻击后摇允许用闪避取消。攻击和闪避消耗体力，体力不足时不发动，攻击受击时中断。请保留宿主输入、动画、武器、真实命中与资源绑定待适配，不宣称游戏支持或保真。宿主版本和来源版本未知；只需要受限规则设计与模拟，不生成 Mod。',
    },
  },
  {
    id: 'action-free-chain-committed', kind: 'action-blueprint',
    request: {
      hostGame: 'bannerlord', sourceGame: 'gamebridge-reference-actions',
      description: '设计项目自有的动作规则，不引用商业来源游戏或资产：轻击即使挥空也能接第二段；攻击过程中禁止闪避取消，只能在空闲时发动闪避。攻击和闪避消耗体力，体力不足时不发动，攻击受击时中断。请保留宿主输入、动画、武器、真实命中与资源绑定待适配，不宣称游戏支持或保真。宿主版本和来源版本未知；只需要受限规则设计与模拟，不生成 Mod。',
    },
  },
];

function parseArgs(args) {
  const result = { live: false, output: DEFAULT_OUTPUT };
  let hasOutput = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--live' && !result.live) result.live = true;
    else if (args[index] === '--output' && !hasOutput && args[index + 1] && !args[index + 1].startsWith('--')) {
      const target = args[++index];
      if (target.length > 4096 || target.includes('\0') || path.extname(target) !== '.json') throw codeError('INVALID_OUTPUT');
      result.output = path.resolve(target); hasOutput = true;
    } else throw codeError('INVALID_ARGUMENT');
  }
  return result;
}
function codeError(code) { const error = new Error(code); error.code = code; return error; }
function progress(stage, status, extra = {}) { process.stdout.write(JSON.stringify({ stage, status, ...extra }) + '\n'); }
function safeFailure(error, key = '') {
  const safe = value => typeof value === 'string' && value.length <= 240 && (!key || !value.includes(key)) && !/[\x00-\x1f\x7f]/.test(value);
  const code = safe(error?.code) && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'VERIFICATION_STEP_FAILED';
  const result = { code };
  if (['json', 'schema', 'semantic'].includes(error?.category)) result.category = error.category;
  if (Array.isArray(error?.diagnostics)) {
    result.diagnostics = error.diagnostics.slice(0, 4).flatMap(item => {
      if (!item || !safe(item.path) || !/^\/[A-Za-z0-9_/-]*$/.test(item.path) ||
          !safe(item.rule) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(item.rule) || !safe(item.expected)) return [];
      return [{ path: item.path, rule: item.rule, expected: item.expected }];
    });
  }
  return result;
}
function safeJson(value, key) {
  const text = JSON.stringify(value, null, 2) + '\n';
  if (key && (text.includes(key) || text.includes(JSON.stringify(key).slice(1, -1)))) throw codeError('CREDENTIAL_IN_ARTIFACT');
  return text;
}
async function writeJson(target, value, key = '') {
  const text = safeJson(value, key);
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(path.dirname(target), `.gamebridge-action-report-${randomUUID()}.tmp`);
  await writeFile(temporary, text, { flag: 'wx', mode: 0o600 });
  await rename(temporary, target);
}
function summarizeSimulation(result) {
  return {
    name: result.name, scope: result.scope, durationTicks: result.durationTicks,
    traceEntries: result.trace.length, finalState: result.finalState,
    actionStarts: result.trace.filter(item => item.type === 'action_started').map(item => ({ tick: item.tick, actionId: item.actionId, from: item.from })),
    sourceVerification: 'not_verified', realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
  };
}
function runOwnedRules() {
  const examples = Object.fromEntries(['hit-confirm', 'free-chain', 'committed-attack'].map(variant => [variant, createActionExample(variant).blueprint]));
  const attack = { tick: 0, type: 'input', input: 'attack' };
  const second = { tick: 6, type: 'input', input: 'attack' };
  const dodge = { tick: 7, type: 'input', input: 'dodge' };
  const hit = { tick: 3, type: 'hit' };
  const starts = (result, id) => result.trace.some(item => item.type === 'action_started' && item.actionId === id);
  const cases = [
    { id: 'hit-confirm-whiff-blocks-chain', variant: 'hit-confirm', events: [attack, second], check: result => !starts(result, 'light-2') && result.trace.some(item => item.reason === 'hit_required') },
    { id: 'hit-confirm-hit-allows-chain', variant: 'hit-confirm', events: [attack, hit, second], check: result => starts(result, 'light-2') },
    { id: 'free-chain-whiff-allows-chain', variant: 'free-chain', events: [attack, second], check: result => starts(result, 'light-2') },
    { id: 'committed-attack-blocks-dodge-cancel', variant: 'committed-attack', events: [attack, dodge], check: result => !starts(result, 'dodge') && result.trace.some(item => item.input === 'dodge' && item.reason === 'no_transition') },
    { id: 'hit-confirm-allows-recovery-dodge', variant: 'hit-confirm', events: [attack, dodge], check: result => starts(result, 'dodge') },
    { id: 'insufficient-stamina-blocks-start', variant: 'hit-confirm', initialStamina: 24, events: [attack], check: result => !starts(result, 'light-1') && result.trace.some(item => item.reason === 'insufficient_stamina') },
    { id: 'hurt-interrupts-attack', variant: 'hit-confirm', events: [attack, { tick: 1, type: 'hurt' }], check: result => result.trace.some(item => item.type === 'interrupted' && item.actionId === 'light-1') },
    { id: 'dodge-interruption-policy', variant: 'hit-confirm', events: [{ tick: 0, type: 'input', input: 'dodge' }, { tick: 1, type: 'hurt' }], check: result => result.trace.some(item => item.type === 'hurt_ignored' && item.reason === 'not_interruptible') },
  ];
  const results = cases.map(item => {
    const scenario = { name: item.id, durationTicks: 30, events: item.events,
      ...(item.initialStamina === undefined ? {} : { initialStamina: item.initialStamina }) };
    try {
      const result = simulateActionBlueprint(examples[item.variant], scenario);
      return { id: item.id, variant: item.variant, passed: Boolean(item.check(result)), simulation: summarizeSimulation(result) };
    } catch (error) { return { id: item.id, variant: item.variant, passed: false, error: safeFailure(error) }; }
  });
  return {
    scope: 'action-rules-simulation-only', provenance: 'project-owned-examples-no-ai',
    variants: Object.keys(examples), cases: results.length, passed: results.every(item => item.passed), results,
    semanticCoverage: 'project-owned-checks-only', sourceFidelityVerified: false,
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let key = '';
  let provider;
  let providerFailure;
  if (args.live) {
    // Only --live reads provider configuration. No .env or credential file is
    // opened here; the caller may use Node's --env-file-if-exists option.
    key = process.env.DEEPSEEK_API_KEY || '';
    try {
      provider = validateProviderConfig({ apiKey: key, baseUrl: process.env.GAMEBRIDGE_API_BASE || 'https://api.deepseek.com', model: process.env.GAMEBRIDGE_MODEL || 'deepseek-flash' });
      if (provider.model.includes(key) || provider.baseUrl.includes(key)) throw codeError('CREDENTIAL_IN_PROVIDER_METADATA');
    } catch (error) { providerFailure = safeFailure(error, key); }
  }
  const report = {
    schemaVersion: 1, scope: 'action-design-verification-only', startedAt: new Date().toISOString(),
    mode: args.live ? 'live-with-project-owned-rule-baseline' : 'project-owned-rule-replay',
    status: 'running', provider: provider && !providerFailure ? { baseUrl: provider.baseUrl, model: provider.model } : null,
    modelCalls: { limit: args.live ? MAX_LIVE_CALLS : 0, attempted: 0, retries: 0, billingVerified: false },
    actionRules: { scope: 'action-rules-simulation-only', status: 'not_run' },
    liveSteps: args.live ? LIVE_STEPS.map(item => ({ id: item.id, kind: item.kind, status: 'pending', modelCalls: 0 })) : [],
    realModBuild: 'not_run', game: 'not_run', readyToInstall: false, sourceFidelityVerified: false,
    limitations: [
      'Only project-owned declarative action rules are executed; no game or generated Mod is installed or run.',
      'A valid legacy plan establishes structural validity only, not semantic requirement coverage.',
      'Live action designs are structurally validated and replayed, not automatically proven to match their natural-language requests.',
      'Source-game fidelity, host API compatibility, real Mod compilation and gameplay remain unverified.',
      'Every live step is attempted at most once; failures and over-budget outcomes remain in this report.',
    ],
  };
  const checkpoint = () => writeJson(args.output, report, key);
  await checkpoint();
  progress('project-owned-rule-baseline', 'running');
  try {
    report.actionRules = { status: 'completed', ...runOwnedRules() };
  } catch (error) {
    report.actionRules = { scope: 'action-rules-simulation-only', status: 'failed', passed: false, error: safeFailure(error, key) };
  }
  await checkpoint();
  progress('project-owned-rule-baseline', report.actionRules.passed ? 'passed' : 'failed', { cases: report.actionRules.cases || 0 });

  for (const [index, spec] of (args.live ? LIVE_STEPS : []).entries()) {
    const step = report.liveSteps[index];
    if (!report.actionRules.passed || providerFailure) {
      step.status = 'blocked';
      step.error = providerFailure || { code: 'RULE_BASELINE_FAILED' };
      await checkpoint();
      progress(spec.id, 'blocked', { step: `${index + 1}/${MAX_LIVE_CALLS}`, code: step.error.code });
      continue;
    }
    step.status = 'running';
    await checkpoint();
    progress(spec.id, 'running', { step: `${index + 1}/${MAX_LIVE_CALLS}` });
    const fetchImpl = async (...fetchArgs) => {
      if (step.modelCalls || report.modelCalls.attempted >= MAX_LIVE_CALLS) throw codeError('MODEL_CALL_LIMIT');
      step.modelCalls++; report.modelCalls.attempted++;
      await checkpoint();
      return fetch(...fetchArgs);
    };
    try {
      const options = { ...provider, fetchImpl };
      const artifactName = `${path.basename(args.output)}.${spec.id}.json`;
      if (spec.kind === 'legacy-plan') {
        const plan = await generatePlan(spec.request, options);
        await writeJson(path.join(path.dirname(args.output), artifactName), plan, key);
        step.artifact = artifactName;
        step.status = 'structure_valid';
        step.evidence = { scope: 'legacy-plan-structure-only', semanticCoverage: 'not_verified', planStatus: plan.status,
          requirements: plan.requirements.length, assetRequirements: plan.assetRequirements.length };
      } else {
        const blueprint = await generateActionBlueprint(spec.request, options);
        await writeJson(path.join(path.dirname(args.output), artifactName), blueprint, key);
        step.artifact = artifactName;
        step.status = 'structure_valid';
        step.evidence = { scope: 'action-rules-simulation-only', requirementFit: 'not_verified', sourceFidelityVerified: false,
          actionCount: blueprint.actions.length, unresolvedIds: blueprint.coverage.unresolvedIds, hostAssessment: assessActionHost(blueprint),
          simulations: createActionScenarios(blueprint).map(scenario => summarizeSimulation(simulateActionBlueprint(blueprint, scenario))) };
        step.status = 'rules_replayed';
      }
      step.realModBuild = 'not_run'; step.game = 'not_run'; step.readyToInstall = false;
    } catch (error) {
      step.status = 'failed'; step.error = safeFailure(error, key);
    }
    await checkpoint();
    progress(spec.id, step.status, { step: `${index + 1}/${MAX_LIVE_CALLS}`, ...(step.error ? { code: step.error.code } : {}) });
  }
  report.status = report.actionRules.passed && report.liveSteps.every(item => ['structure_valid', 'rules_replayed'].includes(item.status)) ? 'completed' : 'failed';
  report.verdict = report.status === 'completed' ? 'limited_rule_design_evidence_not_game_ready' : 'incomplete_rule_design_evidence_not_game_ready';
  report.finishedAt = new Date().toISOString();
  await checkpoint();
  progress('verification', report.status, { modelCalls: report.modelCalls.attempted, realModBuild: 'not_run', game: 'not_run', readyToInstall: false });
  if (report.status !== 'completed') process.exitCode = 1;
}

main().catch(error => {
  progress('verification', 'failed', { code: /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '') ? error.code : 'VERIFICATION_FAILED' });
  process.exitCode = 1;
});
