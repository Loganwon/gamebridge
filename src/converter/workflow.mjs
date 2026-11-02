// Generic task planning only. No executable adapters are registered by this module.
export const CONVERSION_STAGES = Object.freeze(['analysis', 'sourceResearch', 'hostInspection', 'assetMapping', 'interactionMapping', 'generation', 'build', 'game']);

export function readAdapterCatalog() { return []; }

/** Build a deterministic DAG; model text can describe work, never complete it. */
export function createConversionWorkflow(plan) {
  const task = (id, kind, label, requirementIds, dependsOn, blockers) => ({ id, kind, label, requirementIds: [...requirementIds], dependsOn: [...dependsOn], status: blockers.length ? 'blocked' : 'validated', blockers: [...blockers] });
  const ids = plan.requirements.map(item => item.id);
  const tasks = [
    task('analyze', 'analysis', '保留完整需求并校验分析结构', ids, [], []),
    task('inspect-source', 'sourceResearch', '核验来源内容、版本、行为规格与可用资源', ids, ['analyze'], ['来源规格和资源尚未核验。']),
    task('inspect-host', 'hostInspection', '核验宿主正式接口、版本和运行环境', ids, ['analyze'], ['尚无已实现并验收的宿主适配器。']),
    task('resolve-assets', 'assetMapping', '核验资源来源、使用范围和映射损失', [...new Set(plan.assetNeeds.flatMap(item => item.requirementIds))], ['inspect-source', 'inspect-host'], ['资源映射和使用范围尚未验证。']),
    ...plan.requirements.map((item, index) => task(`map-${index + 1}`, 'interactionMapping', `映射需求：${item.id}`, [item.id], ['inspect-source', 'inspect-host', 'resolve-assets'], ['该项需求尚无经过验证的内容与宿主接口映射。'])),
    task('generate-project', 'generation', '生成宿主原生 Mod 工程与对应实现', ids, plan.requirements.map((_, index) => `map-${index + 1}`), ['缺少生成适配器，尚未生成任何代码。']),
    task('compile-mod', 'build', '按锁定工具链真实编译并校验产物', ids, ['generate-project'], ['缺少构建适配器、真实引用及已生成工程。']),
    task('verify-game', 'game', '在宿主真实世界验证交互与需求覆盖', ids, ['compile-mod'], ['缺少运行验收适配器和已构建产物。']),
  ];
  return { kind: 'conversion-task-dag', executable: false, tasks };
}

export function assessConversion(plan) {
  if (!plan || plan.scope !== 'conversion-plan' || !Array.isArray(plan.requirements)) throw new TypeError('A validated conversion plan is required.');
  const blockers = [
    { code: 'HOST_ADAPTER_REQUIRED', message: '需要宿主版本化接口、工程生成、构建与验收适配器。' },
    { code: 'SOURCE_SPEC_UNVERIFIED', message: '来源内容、版本、行为规格和资源尚未核验。' },
    { code: 'REQUIREMENTS_UNVERIFIED', message: '结构化分析不证明逐项需求能够实现或已完整覆盖。' },
  ];
  if (plan.assetNeeds.length) blockers.push({ code: 'ASSETS_UNVERIFIED', message: '资源依赖尚未核验来源、使用范围和映射损失。' });
  return { scope: 'conversion-adapter-assessment', status: 'blocked', hostGame: plan.hostGame, sourceGame: plan.sourceGame,
    adapters: readAdapterCatalog(), blockers, readyToGenerate: false, realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
}
