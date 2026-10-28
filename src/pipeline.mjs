import { randomUUID, createHash } from 'node:crypto';
import { generateProject } from './generator/smapi.mjs';
import { generateModCode, repairModCode, validateModCode } from './ai/code.mjs';
import { compileProject, inspectBuildEnvironment } from './build/runner.mjs';

const TERMINAL = new Set(['passed', 'generated', 'failed', 'blocked', 'cancelled']);
const hash = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled(signal) { if (signal.aborted) throw failure('CANCELLED', '任务已取消。'); }

// Jobs retain public state only. Provider credentials live in the running closure,
// are never written to disk, and are discarded when that closure settles.
export function createPipeline({
  inspect = inspectBuildEnvironment, compile = compileProject,
  generate = generateModCode, repair = repairModCode, validateCode = validateModCode,
  makeProject = generateProject, publishProject = async ({ files, report }) => ({ files, report }),
  buildOptions = {}, clock = Date.now,
} = {}) {
  const jobs = new Map(), controllers = new Map();
  let active = 0;
  function record(id) {
    const job = jobs.get(id);
    if (!job || (TERMINAL.has(job.status) && clock() - job.updated > 3600000)) {
      jobs.delete(id); throw failure('JOB_NOT_FOUND', '任务不存在或已过期。');
    }
    return job;
  }
  function event(job, stage, message, attempt) {
    job.updated = clock();
    job.events.push({ stage, message, ...(attempt === undefined ? {} : { attempt }) });
    if (job.events.length > 64) job.events.shift();
  }
  function setStage(job, stage, message, attempt) { job.status = stage; event(job, stage, message, attempt); }
  function rejectSecrets(value, secrets) {
    const serialized = JSON.stringify(value);
    if (secrets.some(secret => secret && serialized.includes(JSON.stringify(secret).slice(1, -1)))) {
      throw failure('CREDENTIAL_IN_RESPONSE', '结果包含凭据，已丢弃。');
    }
  }
  function boundedDiagnostics(result) {
    if (!Array.isArray(result.diagnostics)) return [];
    return result.diagnostics.slice(0, 64).map(item => ({
      code: String(item.code || 'BUILD_ERROR').slice(0, 80),
      severity: item.severity === 'warning' ? 'warning' : 'error',
      message: String(item.message || '编译未完成。').slice(0, 1500),
      ...(item.file === 'ModEntry.cs' || item.file === 'ModConfig.cs' ? { file: item.file } : {}),
      ...(Number.isSafeInteger(item.line) && item.line > 0 ? { line: item.line } : {}),
    }));
  }
  function overlay(files, proposal, secrets) {
    rejectSecrets(proposal, secrets);
    const checked = validateCode(proposal);
    if (checked.files.length !== 1 || checked.files[0].path !== 'ModEntry.cs') throw failure('INVALID_CODE', '模型只能修改 ModEntry.cs。');
    return files.map(file => file.path === 'ModEntry.cs' ? { ...checked.files[0] } : file);
  }
  async function execute(job, input, controller) {
    const { provider, plan, provenance } = input;
    const secrets = [provider.apiKey, ...(input.secrets || [])].filter(value => typeof value === 'string' && value);
    const signal = controller.signal;
    const options = { ...provider, signal };
    let files, generated, lastBuild, hasModelCode = false, artifactFiles = [];
    async function publish(finalStatus) {
      if (!files || !hasModelCode) return;
      cancelled(signal);
      const report = {
        ...generated.report, status: finalStatus === 'passed' ? 'build_passed' : 'source_generated',
        staticValidation: { passed: true, kind: 'generated-source-policy', checks: ['fixed-project', 'bounded-source', 'source-policy-screen'] },
        build: job.report.build, game: 'not_run', readyToInstall: false,
        completeRequirementCoverage: false, codeProvenance: 'model',
        artifact: artifactFiles.length ? 'build-package' : 'source-draft',
        artifactType: artifactFiles.length ? 'smapi-build-package' : 'smapi-source-draft',
        provenance, model: provider.model, modelCalls: job.modelCalls,
        buildAttempts: job.attempts,
        limitations: [
          'Model-generated source is screened by a limited text policy; this is not a sandbox or behavioral proof.',
          'Compilation and real-game validation are separate; no generated DLL is executed or automatically installed.',
          ...generated.report.limitations.slice(1),
        ],
      };
      const metadata = { artifact: report.artifact, planProvenance: provenance, codeProvenance: 'model', model: provider.model, modelCalls: job.modelCalls, maxRepairs: job.maxRepairs, build: report.build, game: 'not_run' };
      const sourceFiles = files.filter(file => !['validation-report.json', 'generation.json', 'README.md'].includes(file.path));
      sourceFiles.push({ path: 'README.md', content: `# GameBridge AI Mod 工程\n\n代码来源：用户配置的云端模型。计划来源：${provenance === 'example' ? '固定示例（计划未调用 AI）' : '模型分析'}。\n\n## 本包的验证状态\n\n- C# 构建：${report.build}。${artifactFiles.length ? '包含本次编译的自有 Mod DLL/PDB。' : '不含已验证的 Mod DLL。'}\n- 游戏内验收：not_run。尚未证明可玩、行为等价或游戏兼容。\n- 模型调用：${job.modelCalls} 次；自动修复上限：${job.maxRepairs} 次。\n- 完整需求覆盖：未证明；readyToInstall=false。\n\n完整原始需求、逐项缺口和素材依赖在 plan.json；源码检查、构建诊断和尝试记录在 validation-report.json；调用来源在 generation.json。编译通过不会把缺失的角色、武器、动画或动作交互改为已实现。\n\n## 目标与构建\n\nStardew Valley 1.6.14+、SMAPI 4.5.2+，目标框架 net6.0，固定 ModBuildConfig 4.4.0。使用 .NET SDK 8+（推荐 10 LTS），并准备真实游戏与 SMAPI 引用。\n\n\`\`\`sh\ndotnet build GameBridge.Generated.csproj -c Release -p:GamePath="/your/local/game"\n\`\`\`\n\n工程与 config.json 均关闭自动部署/自动启用；Enabled 默认 false。本工具没有执行或安装生成的 DLL。检查源码、需求缺口及构建结果后，另行在独立单人测试存档中验收。只分发自有 Mod 产物，不附带游戏程序集或资源。\n\n## 当前能力范围\n\n仅为计划中明确声明的短时速度 Buff 与近战倍率机制生成源码。它们不代表来源游戏的完整角色、武器、招式、碰撞控制器或规则系统。代码文本检查只是有限的策略筛查，不是沙箱、语义证明或安全保证。\n\n接口依据见 validation-report.json 的 references。\n` });
      sourceFiles.push({ path: 'validation-report.json', content: JSON.stringify(report, null, 2) + '\n' });
      sourceFiles.push({ path: 'generation.json', content: JSON.stringify(metadata, null, 2) + '\n' });
      rejectSecrets({ sourceFiles, report }, secrets);
      const project = await publishProject({ files: sourceFiles, report, artifacts: artifactFiles });
      // A cancelled task must not expose a late package or become successful.
      cancelled(signal);
      rejectSecrets(project, secrets);
      job.project = project;
    }
    try {
      cancelled(signal);
      if (job.mode === 'build') {
        event(job, 'environment', '检查 .NET SDK 与游戏/SMAPI 引用；环境不就绪时不调用模型。');
        const environment = await inspect({ ...buildOptions, signal });
        cancelled(signal);
        rejectSecrets(environment, secrets);
        job.environment = environment;
        if (!environment.ready) {
          setStage(job, 'blocked', '编译环境未就绪，未发起收费代码生成。');
          job.error = { code: 'ENVIRONMENT_REQUIRED', message: '请按环境检查结果准备 SDK 和游戏/SMAPI 引用。' };
          return;
        }
      }
      generated = makeProject(plan);
      if (generated.report?.staticValidation?.passed !== true) throw failure('INVALID_GENERATOR', '基础工程未通过校验。');
      files = generated.files;
      rejectSecrets({ plan, files }, secrets);
      setStage(job, 'generating', '请求 DeepSeek 生成 ModEntry.cs；项目、依赖和配置由本地固定。');
      job.modelCalls++;
      const proposal = await generate({ plan, files }, options);
      cancelled(signal);
      files = overlay(files, proposal, secrets);
      hasModelCode = true;
      if (job.mode === 'source') {
        await publish('generated');
        setStage(job, 'generated', 'AI 源码已生成；本次未执行编译、修复或游戏验收。');
        return;
      }
      const seenSources = new Set([hash(files.find(file => file.path === 'ModEntry.cs').content)]);
      let previousErrors;
      for (let attempt = 0; attempt <= job.maxRepairs; attempt++) {
        cancelled(signal);
        setStage(job, 'compiling', '编译源码；生成的 DLL 不会被执行或自动安装。', attempt);
        lastBuild = await compile({ files, ...buildOptions, signal });
        cancelled(signal);
        const diagnostics = boundedDiagnostics(lastBuild);
        rejectSecrets(diagnostics, secrets);
        job.attempts.push({ attempt, status: lastBuild.status, diagnostics });
        if (lastBuild.status === 'passed') {
          if (!Array.isArray(lastBuild.artifacts) || !lastBuild.artifacts.some(file => file.path === 'GameBridge.Generated.dll')) throw failure('MISSING_BUILD_ARTIFACT', '编译器未返回目标 DLL，不能声明编译通过。');
          artifactFiles = lastBuild.artifacts;
          job.report.build = 'passed';
          await publish('passed');
          setStage(job, 'passed', '编译通过；尚未在游戏中加载或验收。', attempt);
          return;
        }
        if (lastBuild.status === 'cancelled') throw failure('CANCELLED', '任务已取消。');
        job.report.build = lastBuild.status === 'blocked' ? 'not_run' : 'failed';
        if (lastBuild.status === 'blocked' || lastBuild.repairable !== true) {
          const finalStatus = lastBuild.status === 'blocked' ? 'blocked' : 'failed';
          job.error = { code: 'BUILD_NOT_REPAIRABLE', message: '此错误不属于模型可修复的 C# 编译错误，请检查构建诊断。' };
          await publish(finalStatus);
          setStage(job, finalStatus, '构建环境或工具错误，停止模型修复。', attempt);
          return;
        }
        const fingerprint = JSON.stringify(diagnostics.filter(item => item.severity === 'error').map(item => [item.code, item.message]));
        if (attempt === job.maxRepairs || (previousErrors !== undefined && previousErrors === fingerprint)) {
          job.error = { code: attempt === job.maxRepairs ? 'REPAIR_LIMIT' : 'REPEATED_COMPILER_ERRORS', message: '编译未通过；请检查保存的需求、源码和错误报告。' };
          await publish('failed');
          setStage(job, 'failed', attempt === job.maxRepairs ? '已达到修复次数上限，保留失败源码与诊断。' : '相同编译错误重复出现，停止继续收费修复。', attempt);
          return;
        }
        previousErrors = fingerprint;
        setStage(job, 'repairing', '把源码与结构化编译错误发送给模型进行一次修复。', attempt + 1);
        job.modelCalls++;
        const repaired = await repair({ plan, files, diagnostics: diagnostics.filter(item => /^CS\d{4}$/.test(item.code)), attempt: attempt + 1 }, options);
        cancelled(signal);
        const updated = overlay(files, repaired, secrets);
        const digest = hash(updated.find(file => file.path === 'ModEntry.cs').content);
        if (seenSources.has(digest)) throw failure('UNCHANGED_REPAIR', '模型返回了未改变或已尝试过的源码，停止重复修复。');
        seenSources.add(digest); files = updated;
      }
    } catch (error) {
      if (signal.aborted || error.code === 'CANCELLED' || error.code === 'PROVIDER_CANCELLED') {
        setStage(job, 'cancelled', '任务已取消；已发出的云端请求可能仍产生费用。');
      } else {
        let message = String(error.message || '任务失败。').slice(0, 1500);
        for (const secret of secrets) message = message.replaceAll(secret, '[redacted]');
        job.error = { code: String(error.code || 'PIPELINE_FAILED').slice(0, 80), message };
        // Retain only a previously accepted source after compiler/repair failure.
        // A credential echo is discarded entirely, including the rejected result.
        if (files && error.code !== 'CREDENTIAL_IN_RESPONSE') {
          try { await publish('failed'); }
          catch { if (!signal.aborted) job.error = { code: 'ARTIFACT_FAILED', message: '工程无法安全打包，未开放下载。' }; }
        }
        if (signal.aborted) setStage(job, 'cancelled', '任务已取消；已发出的云端请求可能仍产生费用。');
        else setStage(job, 'failed', '流程已停止，未声明构建或游戏验证成功。');
      }
    } finally {
      active--;
      controllers.delete(job.id);
    }
  }
  return {
    get activeCount() { return active; },
    start({ plan, provenance = 'model', provider, maxRepairs = 1, secrets = [], mode = 'build' }) {
      if (active) throw failure('PIPELINE_BUSY', '已有制作任务在运行，请等待或取消后再试。');
      if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2) throw failure('INVALID_REPAIR_LIMIT', '修复次数必须为 0、1 或 2。');
      if (!['source', 'build'].includes(mode)) throw failure('INVALID_MODE', '制作模式必须为 source 或 build。');
      if (!provider?.apiKey) throw failure('API_KEY_REQUIRED', '请先在本地配置 DeepSeek API Key。');
      if (jobs.size >= 8) jobs.delete(jobs.keys().next().value);
      const effectiveRepairs = mode === 'source' ? 0 : maxRepairs;
      const job = { id: randomUUID(), mode, status: 'queued', created: clock(), updated: clock(), events: [], attempts: [], maxRepairs: effectiveRepairs, modelCalls: 0, maxModelCalls: 1 + effectiveRepairs, report: { build: 'not_run', game: 'not_run', readyToInstall: false } };
      jobs.set(job.id, job);
      const controller = new AbortController(); controllers.set(job.id, controller); active++;
      const input = { plan: clone(plan), provenance, provider: { ...provider }, secrets: [...secrets] };
      queueMicrotask(() => { void execute(job, input, controller); });
      return clone(job);
    },
    get(id) { return clone(record(id)); },
    cancel(id) {
      const job = record(id);
      if (!TERMINAL.has(job.status)) { controllers.get(id)?.abort(); setStage(job, 'cancelled', '正在取消任务并终止编译进程。'); }
      return clone(job);
    },
    close() { for (const controller of controllers.values()) controller.abort(); },
  };
}
