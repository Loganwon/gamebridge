const $ = (id) => document.getElementById(id);
const ui = {
  form: $('request-form'), host: $('host-game'), source: $('source-game'), description: $('request-description'),
  analyze: $('analyze-button'), analyzeLabel: $('analyze-label'), example: $('example-project-button'),
  settings: $('model-settings'), key: $('provider-api-key'), base: $('provider-base-url'), model: $('provider-model'),
  generate: $('generate-button'), error: $('error-message'), action: $('action-message'), download: $('download-button'),
  pipeline: $('pipeline-start'), sourceOnly: $('source-start'), repairs: $('repair-limit'), refreshEnvironment: $('refresh-environment'), cancel: $('cancel-job'),
};
const isLocalOrigin = ['localhost', '127.0.0.1'].includes(location.hostname);
let serviceReady = false;
let providerConfigured = false;
let configuredProviderOrigin = null;
let displayedProviderOrigin = null;
let busy = false;
let planId = null;
let currentPlan = null;
let currentProject = null;
let examplePlan = false;
let selectedFile = null;
let buildEnvironment = null;
let environmentChecking = false;
let activeJobId = null;
let pollTimer = null;
let requestRevision = 0;
const terminalJobs = new Set(['generated', 'passed', 'failed', 'blocked', 'cancelled']);
const jobLabels = {queued: '任务已排队', generating: '模型正在生成源码', generated: '源码已生成 · 尚未编译', compiling: '正在编译工程', repairing: '模型正在修复编译错误', passed: '编译通过 · 游戏未验收', failed: '制作流程未通过', blocked: '需要补充本地环境', cancelled: '任务已取消'};
const statuses = {
  draft_supported: {label: '可生成草稿', className: 'draft-supported'},
  needs_assets: {label: '需要素材', className: 'needs-assets'},
  needs_adapter: {label: '需要适配器', className: 'needs-adapter'},
  unsupported: {label: '当前不支持', className: 'unsupported'},
};
const examples = {
  stardew: {host: 'Stardew Valley', source: 'Terraria', description: '在星露谷中保留农场、NPC 和存档，加入泰拉瑞亚式的近战、瞄准攻击和位移动作。需要角色或武器素材时，请明确列出依赖和仍需适配的部分。'},
  gta: {host: 'GTA V', source: 'Counter-Strike', description: '在 GTA V 的单人世界中体验 CS 的武器操作、瞄准、后坐力和换弹动作，保留 GTA 的地图与 NPC。请逐项说明角色、武器、动画、接口和素材的依赖。'},
};
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function safeMessage(value) {
  let message = String(value || '请求未完成，请检查本地服务后重试。');
  if (ui.key.value) message = message.split(ui.key.value).join('[已隐藏密钥]');
  return message.slice(0, 1400);
}
function showError(error) {
  ui.error.textContent = safeMessage(error instanceof Error ? error.message : error);
  ui.error.hidden = false;
  ui.action.hidden = true;
}
function announce(message) { ui.action.textContent = message; ui.action.hidden = !message; }
function resetMessages() { ui.error.hidden = true; announce(''); }
function countDescription() { $('description-count').textContent = ui.description.value.length + ' / 6000'; }
function setBusy(value, label) {
  busy = value;
  ui.form.setAttribute('aria-busy', value ? 'true' : 'false');
  ui.analyze.disabled = value || !serviceReady;
  ui.example.disabled = value || !serviceReady;
  ui.generate.disabled = value || !serviceReady || !planId || !canGenerate(currentPlan);
  ui.sourceOnly.disabled = value || !serviceReady || !planId || !canGenerate(currentPlan);
  ui.pipeline.disabled = value || !serviceReady || !planId || !canGenerate(currentPlan) || environmentChecking || buildEnvironment?.ready !== true;
  ui.repairs.disabled = value || !serviceReady;
  ui.refreshEnvironment.disabled = value || !serviceReady || environmentChecking;
  ui.analyzeLabel.textContent = value && label ? label : '分析需求（调用模型）';
  for (const input of [ui.host, ui.source, ui.description, ui.key, ui.base, ui.model, $('clear-key')]) input.disabled = value || !serviceReady;
  for (const button of document.querySelectorAll('[data-example]')) button.disabled = value;
}
function providerValues() { return {apiKey: ui.key.value.trim(), baseUrl: ui.base.value.trim(), model: ui.model.value.trim()}; }
function usesConfiguredProvider() {
  try { return new URL(ui.base.value.trim()).origin === configuredProviderOrigin; }
  catch { return false; }
}
function updateCredentialHint() {
  const canUseDefault = providerConfigured && usesConfiguredProvider();
  $('api-key-hint').textContent = canUseDefault ? '本地已配置此地址的密钥；可留空' : providerConfigured ? '地址已更改，请填写对应的 API Key' : '仅在当前页面内存中使用';
  ui.key.placeholder = canUseDefault ? '留空使用此地址的本地密钥' : '输入当前 API 地址的密钥';
}
function stopPolling() { if (pollTimer !== null) clearTimeout(pollTimer); pollTimer = null; }
function resetJob() {
  stopPolling();
  const previousJob = activeJobId;
  activeJobId = null;
  if (previousJob && serviceReady) api('/api/jobs/' + previousJob + '/cancel').catch(() => {});
  $('job-progress').hidden = true;
  $('job-events').replaceChildren(); $('job-attempts').replaceChildren();
  $('job-message').textContent = ''; $('job-badge').textContent = '等待计划';
  ui.cancel.hidden = true;
}
function stage(current, complete = []) {
  for (const node of document.querySelectorAll('.workflow-nav li')) {
    node.classList.toggle('is-current', node.dataset.stage === current);
    node.classList.toggle('is-complete', complete.includes(node.dataset.stage));
  }
}
function resetProject() {
  currentProject = null;
  selectedFile = null;
  $('file-count').textContent = 'NO FILES';
  $('file-list').replaceChildren(element('p', '生成的文件将在这里显示。'));
  $('active-filename').textContent = '等待工程文件';
  $('source-preview').textContent = '描述需求并分析后，可以创建可下载的 Mod 源码工程。';
  $('source-status').textContent = '尚未生成';
  $('source-state').classList.remove('is-complete');
  $('static-status').textContent = '待生成后检查';
  $('static-state').classList.remove('is-complete');
  $('game-status').textContent = '尚未验证';
  $('project-status').textContent = planId ? '等待生成源码草稿' : '等待制作计划';
  $('project-note').textContent = '生成源码与静态检查不代表 Mod 已经可以在游戏内运行。';
  ui.download.removeAttribute('href');
  ui.download.removeAttribute('download');
  ui.download.replaceChildren(element('span', '↓'), document.createTextNode(' 下载源码工程'));
  ui.download.classList.add('is-disabled');
  ui.download.setAttribute('aria-disabled', 'true');
  ui.download.tabIndex = -1;
}
function invalidatePlan() {
  if (busy && !activeJobId) return;
  requestRevision++;
  resetJob();
  if (busy) setBusy(false);
  planId = null; currentPlan = null; examplePlan = false;
  $('empty-plan').hidden = false;
  $('plan-content').hidden = true;
  $('plan-badge').textContent = '需求已更改';
  $('plan-badge').classList.remove('is-example');
  ui.generate.disabled = true;
  resetProject(); resetMessages(); stage('request');
  setBusy(busy);
}
function requestValues() { return {hostGame: ui.host.value.trim(), sourceGame: ui.source.value.trim(), description: ui.description.value.trim()}; }
function canGenerate(plan) {
  if (!plan || !Array.isArray(plan.mechanics) || !plan.mechanics.length) return false;
  const host = String(plan.hostGame || '').toLowerCase().replace(/[_\s]/g, '-');
  return ['stardew-valley', 'stardew', '星露谷物语'].includes(host);
}
async function api(url, body, method = 'POST') {
  if (!isLocalOrigin || !serviceReady) throw new Error('请在本地运行 npm run dev 后使用制作功能。');
  const response = await fetch(url, {method, headers: {'Content-Type': 'application/json'}, ...(method === 'GET' ? {cache: 'no-store'} : {body: JSON.stringify(body || {})})});
  let data;
  try { data = await response.json(); } catch { throw new Error('本地服务返回了无法识别的结果。请重启服务后重试。'); }
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || '请求失败（HTTP ' + response.status + '）。');
  return data;
}
function renderList(id, sectionId, values) {
  const list = $(id);
  list.replaceChildren(...(Array.isArray(values) ? values : []).map(value => element('li', typeof value === 'string' ? value : JSON.stringify(value))));
  $(sectionId).hidden = !list.children.length;
}
function renderPlan(result, isExample = false) {
  if (!result || !result.id || !result.plan || !Array.isArray(result.plan.requirements)) throw new Error('制作计划缺少必要字段，未进入生成阶段。');
  planId = result.id;
  currentPlan = result.plan;
  examplePlan = isExample || result.provenance === 'example' || result.report?.provenance === 'example';
  resetProject();
  $('empty-plan').hidden = true;
  $('plan-content').hidden = false;
  $('plan-title').textContent = currentPlan.title || '跨游戏 Mod 制作计划';
  $('plan-summary').textContent = currentPlan.summary || '';
  $('plan-badge').textContent = examplePlan ? '示例计划 · 未调用 AI' : '模型计划 · 已校验';
  $('plan-badge').classList.toggle('is-example', examplePlan);
  $('plan-origin').textContent = examplePlan ? 'EXAMPLE' : 'MODEL PLAN';
  $('plan-origin').classList.toggle('is-example', examplePlan);
  const counts = {draft_supported: 0, needs_assets: 0, needs_adapter: 0, unsupported: 0};
  for (const requirement of currentPlan.requirements) if (requirement.capability !== 'request_scope' && Object.hasOwn(counts, requirement.status)) counts[requirement.status]++;
  $('scope-counts').replaceChildren(...Object.keys(counts).map(key => {
    const item = element('div'); item.append(element('strong', counts[key]), element('small', statuses[key].label)); return item;
  }));
  $('requirements').replaceChildren(...currentPlan.requirements.map(requirement => {
    const item = element('li'), top = element('div', undefined, 'requirement-top');
    const status = requirement.capability === 'request_scope'
      ? {label: '原始需求 · 完整保留', className: ''}
      : statuses[requirement.status] || {label: '待确认', className: 'needs-adapter'};
    top.append(element('strong', requirement.description || requirement.id || '未命名需求'), element('span', status.label, status.className));
    item.append(top, element('p', requirement.reason || '需要进一步检查具体游戏接口与资源。'));
    return item;
  }));
  renderList('asset-requirements', 'assets-section', currentPlan.assetRequirements);
  renderList('plan-limitations', 'limitations-section', currentPlan.limitations);
  $('plan-parameters').textContent = JSON.stringify({hostGame: currentPlan.hostGame, sourceGame: currentPlan.sourceGame, mechanics: currentPlan.mechanics || []}, null, 2);
  $('generation-hint').textContent = canGenerate(currentPlan) ? '只生成已列明的草稿子集；素材与适配缺口会随工程保留。' : '当前计划缺少可用的宿主生成器或动作定义，保留需求等待适配。';
  ui.generate.disabled = busy || !serviceReady || !canGenerate(currentPlan);
  $('job-badge').textContent = '可准备生成';
  $('pipeline-hint').textContent = canGenerate(currentPlan)
    ? '模型只处理当前适配器的生成范围；素材与玩法缺口仍需另行完成。编译通过后还要进入游戏验收。'
    : '当前宿主或机制缺少生成适配器，完整需求继续保留，暂不能进入 AI 编译流程。';
  setBusy(busy);
  stage('plan', ['request']);
}
function selectFile(index) {
  if (!currentProject?.files?.[index]) return;
  selectedFile = index;
  const file = currentProject.files[index];
  $('active-filename').textContent = file.path;
  $('source-preview').textContent = typeof file.content === 'string' ? file.content : String(file.content ?? '');
  for (const [i, button] of [...$('file-list').children].entries()) button.setAttribute('aria-current', i === index ? 'true' : 'false');
}
function renderProject(result, {aiGenerated = false} = {}) {
  if (!result || !Array.isArray(result.files) || !result.files.length) throw new Error('工程未包含源码文件，未开放下载。');
  currentProject = result;
  const report = result.report || {};
  const staticPassed = report.staticValidation?.passed === true;
  const compiled = report.build === 'passed';
  const modelSource = aiGenerated || report.codeProvenance === 'model' || report.generation === 'model';
  $('file-count').textContent = result.files.length + ' FILES';
  $('file-list').replaceChildren(...result.files.map((file, index) => {
    const button = element('button', file.path); button.type = 'button'; button.title = file.path;
    button.addEventListener('click', () => selectFile(index)); return button;
  }));
  selectFile(Math.max(0, result.files.findIndex(file => file.path.endsWith('ModEntry.cs'))));
  $('source-status').textContent = modelSource ? 'AI 源码已生成' : examplePlan ? '示例源码已生成' : '源码草稿已生成';
  $('source-state').classList.add('is-complete');
  $('static-status').textContent = staticPassed ? '静态检查通过' : '未取得通过结果';
  $('static-state').classList.toggle('is-complete', staticPassed);
  $('game-status').textContent = compiled ? '编译通过 / 游戏未验收' : report.build === 'failed' ? '编译未通过 / 游戏未验收' : '构建 / 游戏实测待验证';
  $('project-status').textContent = compiled ? 'Mod 工程编译通过 · 游戏未验收' : modelSource ? 'AI Mod 源码草稿' : examplePlan ? '示例源码工程 · 未调用云端模型' : 'Mod 源码草稿已生成';
  $('project-note').textContent = compiled ? '编译通过仅确认本地构建结果；完整需求、素材与真实游戏表现仍需核查。' : '含源码、配置与需求缺口；未获得构建通过结果，未在目标游戏中验证。';
  ui.download.replaceChildren(element('span', '↓'), document.createTextNode(compiled ? ' 下载工程与编译结果' : ' 下载源码工程'));
  if (typeof result.downloadUrl === 'string' && /^\/api\/projects\/[A-Za-z0-9_-]+\/download$/.test(result.downloadUrl)) {
    ui.download.href = result.downloadUrl;
    ui.download.download = '';
    ui.download.classList.remove('is-disabled'); ui.download.setAttribute('aria-disabled', 'false'); ui.download.tabIndex = 0;
  } else throw new Error('工程下载地址无效，未开放下载。');
  stage(compiled ? 'game' : 'static', compiled ? ['request','plan','source','static'] : ['request','plan','source']);
}
async function generateProject() {
  if (!planId || !canGenerate(currentPlan)) return;
  resetJob();
  resetMessages(); setBusy(true, '正在生成工程…'); stage('source', ['request','plan']);
  try {
    const result = await api('/api/projects', {planId});
    renderProject(result);
    announce(examplePlan ? '示例源码工程已生成，未调用 AI。构建与实机验证尚未执行。' : '源码草稿已生成。请检查未实现项，再按工程说明构建和实机验证。');
  } catch (error) { showError(error); stage('plan', ['request']); }
  finally { setBusy(false); }
}
function updateBudget() {
  const repairs = Number(ui.repairs.value);
  $('pipeline-cost').textContent = '本次最多调用模型 ' + (1 + repairs) + ' 次（1 次生成 + ' + repairs + ' 次修复）；需求分析的调用另计。仅编译错误触发修复。';
}
async function refreshEnvironment() {
  if (!serviceReady || environmentChecking) return;
  environmentChecking = true; setBusy(busy);
  $('environment-summary').textContent = '正在检查 SDK 与游戏引用…';
  try {
    const environment = await api('/api/environment', undefined, 'GET');
    buildEnvironment = environment;
    $('environment-summary').textContent = environment.ready === true
      ? '构建环境已就绪 · SDK ' + (environment.dotnet?.version || '已找到')
      : '构建环境尚未就绪 · 可先生成源码草稿';
    const issues = Array.isArray(environment.issues) ? environment.issues : [];
    $('environment-issues').replaceChildren(...issues.map(issue => element('li', safeMessage(issue.message || issue.code || issue))));
    if (environment.ready === true) $('environment-issues').replaceChildren(element('li', '已找到本地 SDK 与所需游戏 / SMAPI 引用；此检查不代表游戏内验证。'));
  } catch (error) {
    buildEnvironment = null;
    $('environment-summary').textContent = '构建环境检查未完成';
    $('environment-issues').replaceChildren(element('li', safeMessage(error.message)));
  } finally { environmentChecking = false; setBusy(busy); }
}
function renderJob(job) {
  const label = jobLabels[job.status] || '正在读取任务状态';
  $('job-progress').hidden = false;
  $('job-badge').textContent = label;
  $('job-status').textContent = label;
  const calls = Number.isSafeInteger(job.modelCalls) ? job.modelCalls : 0;
  const limit = Number.isSafeInteger(job.maxModelCalls) ? job.maxModelCalls : job.mode === 'source' ? 1 : 1 + Number(ui.repairs.value);
  $('job-budget').textContent = '模型调用 ' + calls + ' / ' + limit;
  $('job-events').replaceChildren(...(Array.isArray(job.events) ? job.events : []).slice(-80).map(event => {
    const item = element('li');
    item.append(element('span', event.stage || '状态'), element('p', safeMessage(event.message || '')));
    return item;
  }));
  const attempts = Array.isArray(job.attempts) ? job.attempts : [];
  $('job-diagnostics').hidden = !attempts.length;
  $('job-attempts').replaceChildren(...attempts.slice(0, 3).map((attempt, index) => {
    const group = element('section');
    group.append(element('h4', '第 ' + (Number.isSafeInteger(attempt.attempt) ? attempt.attempt + 1 : index + 1) + ' 次编译 · ' + (attempt.status === 'passed' ? '通过' : attempt.status === 'blocked' ? '环境缺失' : attempt.status === 'cancelled' ? '已取消' : '未通过')));
    const diagnostics = Array.isArray(attempt.diagnostics) ? attempt.diagnostics : [];
    const list = element('ul');
    for (const diagnostic of diagnostics.slice(0, 80)) {
      const location = diagnostic.file ? diagnostic.file + (diagnostic.line ? ':' + diagnostic.line : '') : '';
      list.append(element('li', [diagnostic.code, location, safeMessage(diagnostic.message || '')].filter(Boolean).join(' · ')));
    }
    if (!diagnostics.length) list.append(element('li', attempt.status === 'passed' ? '未报告编译错误。' : '未提供编译诊断。'));
    group.append(list); return group;
  }));
  $('job-message').textContent = job.error ? safeMessage(job.error.message || job.error.code) : job.status === 'passed'
    ? '源码已编译，尚未安装到游戏，也未验证角色、武器或招式的实际表现。'
    : job.status === 'generated' ? '本次仅生成源码草稿，未运行编译、自动修复或游戏验收；尚不能作为可玩的 Mod 使用。'
    : job.status === 'cancelled' ? '后续生成和修复已停止；已发出的模型请求可能已产生费用。' : '';
  ui.cancel.hidden = terminalJobs.has(job.status);
  ui.cancel.disabled = false;
  stage(['compiling', 'repairing'].includes(job.status) ? 'static' : job.status === 'passed' ? 'game' : 'source', ['request', 'plan', ...(['compiling', 'repairing', 'passed'].includes(job.status) ? ['source'] : []), ...(job.status === 'passed' ? ['static'] : [])]);
}
function finishJob(job) {
  stopPolling(); activeJobId = null;
  try { if (job.project) renderProject(job.project, {aiGenerated: true}); }
  catch (error) { showError(error); }
  finally { setBusy(false); }
  if (job.status === 'passed') announce('AI 源码生成与编译已通过，游戏内验收尚未执行。');
  else if (job.status === 'generated') announce('AI 源码草稿已生成。本次未编译、未自动修复，也未进入游戏验证。');
  else if (job.status === 'blocked') announce('流程停在环境检查；请补充列出的本地环境后重试。');
  else if (job.status === 'cancelled') announce('任务已取消，未继续后续模型调用。');
}
async function pollJob(id, revision) {
  if (id !== activeJobId || revision !== requestRevision) return;
  try {
    const job = await api('/api/jobs/' + id, undefined, 'GET');
    if (id !== activeJobId || revision !== requestRevision) return;
    renderJob(job);
    if (terminalJobs.has(job.status)) { finishJob(job); return; }
  } catch (error) {
    if (id !== activeJobId || revision !== requestRevision) return;
    $('job-message').textContent = '暂时无法读取本地任务状态，将自动重试。' + safeMessage(error.message);
  }
  pollTimer = setTimeout(() => pollJob(id, revision), 1000);
}
async function startPipeline(mode = 'build') {
  if (busy || !serviceReady || !planId || !canGenerate(currentPlan)) return;
  resetMessages();
  if (!ui.key.value.trim() && !(providerConfigured && usesConfiguredProvider())) { ui.settings.open = true; ui.key.focus(); showError(new Error('请填写当前 API 地址对应的 API Key 后再运行 AI 制作。')); return; }
  const revision = requestRevision;
  const targetPlanId = planId;
  if (mode === 'build') {
    setBusy(true, '正在检查构建环境…');
    await refreshEnvironment();
    if (revision !== requestRevision || targetPlanId !== planId) { setBusy(false); return; }
    if (buildEnvironment?.ready !== true) { showError(new Error('本地构建环境尚未就绪；没有发起生成与编译流程。可先选择仅生成源码，或补充环境后重新检查。')); setBusy(false); return; }
  }
  resetJob(); resetProject(); setBusy(true, 'AI 流程正在运行…');
  try {
    const job = await api('/api/jobs', {planId: targetPlanId, provider: providerValues(), mode, maxRepairs: mode === 'source' ? 0 : Number(ui.repairs.value)});
    if (!job.id || !/^[A-Za-z0-9_-]+$/.test(job.id)) throw new Error('未取得有效的任务 ID。');
    if (revision !== requestRevision) { api('/api/jobs/' + job.id + '/cancel').catch(() => {}); return; }
    activeJobId = job.id;
    renderJob(job);
    if (terminalJobs.has(job.status)) finishJob(job);
    else pollTimer = setTimeout(() => pollJob(job.id, revision), 500);
  } catch (error) { showError(error); setBusy(false); }
}
ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !serviceReady || !ui.form.reportValidity()) return;
  resetMessages();
  if (!ui.key.value.trim() && !(providerConfigured && usesConfiguredProvider())) { ui.settings.open = true; ui.key.focus(); showError(new Error('请填写当前 API 地址对应的 API Key，或使用不调用 AI 的示例工程。')); return; }
  requestRevision++; resetJob();
  planId = null; currentPlan = null; resetProject();
  setBusy(true, '模型正在分析…'); stage('plan', ['request']);
  try {
    const result = await api('/api/plan', {request: requestValues(), provider: {apiKey: ui.key.value.trim(), baseUrl: ui.base.value.trim(), model: ui.model.value.trim()}});
    renderPlan(result, false);
    announce('计划已返回，请逐项检查生成范围、素材和适配器缺口。');
  } catch (error) { showError(error); stage('request'); }
  finally { setBusy(false); }
});
ui.example.addEventListener('click', async () => {
  if (busy || !serviceReady) return;
  invalidatePlan();
  resetMessages(); setBusy(true, '正在准备示例…'); stage('plan', ['request']);
  try {
    const result = await api('/api/example');
    ui.host.value = result.plan.hostGame;
    ui.source.value = result.plan.sourceGame;
    ui.description.value = result.plan.requirements.find(requirement => requirement.capability === 'request_scope')?.description || result.plan.summary;
    countDescription();
    renderPlan(result, true);
    if (canGenerate(currentPlan)) {
      const project = await api('/api/projects', {planId});
      renderProject(project);
    }
    announce('这是固定示例工程，用于检查制作流程；未调用云端模型，也未执行游戏验证。');
  } catch (error) { showError(error); }
  finally { setBusy(false); }
});
ui.generate.addEventListener('click', generateProject);
ui.pipeline.addEventListener('click', () => startPipeline('build'));
ui.sourceOnly.addEventListener('click', () => startPipeline('source'));
ui.repairs.addEventListener('change', updateBudget);
ui.refreshEnvironment.addEventListener('click', refreshEnvironment);
ui.cancel.addEventListener('click', async () => {
  if (!activeJobId) return;
  const id = activeJobId, revision = requestRevision;
  ui.cancel.disabled = true;
  $('job-message').textContent = '正在停止任务；已发出的模型请求可能已产生费用。';
  try {
    const job = await api('/api/jobs/' + id + '/cancel');
    if (id !== activeJobId || revision !== requestRevision) return;
    renderJob(job);
    if (terminalJobs.has(job.status)) finishJob(job);
  } catch (error) {
    if (id !== activeJobId || revision !== requestRevision) return;
    ui.cancel.disabled = false;
    $('job-message').textContent = '取消请求未确认，请保持页面连接并重试。' + safeMessage(error.message);
  }
});
$('clear-key').addEventListener('click', () => { ui.key.value = ''; ui.key.focus(); });
ui.base.addEventListener('input', () => {
  let origin = null;
  try { origin = new URL(ui.base.value.trim()).origin; } catch {}
  if (origin !== displayedProviderOrigin) ui.key.value = '';
  displayedProviderOrigin = origin;
  updateCredentialHint();
});
ui.download.addEventListener('click', event => { if (ui.download.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
for (const input of [ui.host, ui.source, ui.description]) input.addEventListener('input', () => { countDescription(); invalidatePlan(); });
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => {
  const example = examples[button.dataset.example];
  ui.host.value = example.host; ui.source.value = example.source; ui.description.value = example.description;
  countDescription(); invalidatePlan();
});
async function initialize() {
  countDescription();
  updateBudget();
  if (!isLocalOrigin) {
    $('connection-text').textContent = '公开界面预览';
    $('runtime-notice').replaceChildren(element('strong', '当前是公开预览页面'), element('p', '调用模型与生成工程请在本地运行 npm run dev。本页不会连接你的电脑，也不接收 API Key。'));
    $('form-note').textContent = '本地制作功能在下方“本地运行”说明中开启。';
    ui.settings.hidden = true;
    $('environment-summary').textContent = '构建检查在本地工作台进行';
    $('pipeline-hint').textContent = '公开网页不调用模型或编译源码。请在本地运行 npm run dev 后使用 AI 制作流程。';
    setBusy(false);
    return;
  }
  try {
    const response = await fetch('/api/config', {cache: 'no-store'});
    if (!response.ok) throw new Error('本地 API 尚未启动。');
    const config = await response.json();
    if (config.local !== true) throw new Error('无法确认本地制作服务。');
    if (!config.defaultProvider || typeof config.defaultProvider.baseUrl !== 'string' || typeof config.defaultProvider.model !== 'string') throw new Error('本地供应商配置不完整。');
    const providerOrigin = new URL(config.defaultProvider.baseUrl).origin;
    providerConfigured = config.providerConfigured === true;
    ui.settings.hidden = false;
    ui.base.value = config.defaultProvider.baseUrl;
    ui.model.value = config.defaultProvider.model;
    configuredProviderOrigin = providerOrigin;
    displayedProviderOrigin = configuredProviderOrigin;
    $('connection-badge').classList.add('is-local'); $('connection-text').textContent = '本地服务已连接';
    $('runtime-notice').classList.add('is-local');
    $('runtime-notice').replaceChildren(element('strong', '本地制作服务已就绪'), element('p', '配置模型后分析需求，或查看不调用 AI 的固定示例。源码工程仍需构建与游戏实测。'));
    $('form-note').textContent = '调用模型会使用你所配置供应商的 API 额度。';
    updateCredentialHint();
    serviceReady = true;
    setBusy(false);
    await refreshEnvironment();
  } catch (error) {
    serviceReady = false;
    $('connection-text').textContent = '本地服务未就绪';
    $('runtime-notice').replaceChildren(element('strong', '尚未连接制作服务'), element('p', '请通过 npm run dev 启动完整本地服务，再刷新此页面。'));
    $('form-note').textContent = '仅静态预览服务器不提供模型调用或工程生成。';
    setBusy(false);
  }
}
window.addEventListener('beforeunload', () => {
  if (!activeJobId || !serviceReady) return;
  fetch('/api/jobs/' + activeJobId + '/cancel', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: '{}', keepalive: true}).catch(() => {});
});
initialize();
