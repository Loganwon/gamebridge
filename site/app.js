const $ = (id) => document.getElementById(id);
const ui = {
  form: $('request-form'), host: $('host-game'), source: $('source-game'), description: $('request-description'),
  analyze: $('analyze-button'), analyzeLabel: $('analyze-label'), example: $('example-project-button'),
  settings: $('model-settings'), key: $('provider-api-key'), base: $('provider-base-url'), model: $('provider-model'),
  generate: $('generate-button'), error: $('error-message'), action: $('action-message'), download: $('download-button'),
};
const isLocalOrigin = ['localhost', '127.0.0.1'].includes(location.hostname);
let serviceReady = false;
let providerConfigured = false;
let busy = false;
let planId = null;
let currentPlan = null;
let currentProject = null;
let examplePlan = false;
let selectedFile = null;
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
  ui.analyzeLabel.textContent = value && label ? label : '分析需求（调用模型）';
  for (const input of [ui.host, ui.source, ui.description, ui.key, ui.base, ui.model, $('clear-key')]) input.disabled = value || !serviceReady;
  for (const button of document.querySelectorAll('[data-example]')) button.disabled = value;
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
  ui.download.classList.add('is-disabled');
  ui.download.setAttribute('aria-disabled', 'true');
  ui.download.tabIndex = -1;
}
function invalidatePlan() {
  if (busy) return;
  planId = null; currentPlan = null; examplePlan = false;
  $('empty-plan').hidden = false;
  $('plan-content').hidden = true;
  $('plan-badge').textContent = '需求已更改';
  $('plan-badge').classList.remove('is-example');
  ui.generate.disabled = true;
  resetProject(); resetMessages(); stage('request');
}
function requestValues() { return {hostGame: ui.host.value.trim(), sourceGame: ui.source.value.trim(), description: ui.description.value.trim()}; }
function canGenerate(plan) {
  if (!plan || !Array.isArray(plan.mechanics) || !plan.mechanics.length) return false;
  const host = String(plan.hostGame || '').toLowerCase().replace(/[_\s]/g, '-');
  return ['stardew-valley', 'stardew', '星露谷物语'].includes(host);
}
async function api(url, body) {
  if (!isLocalOrigin || !serviceReady) throw new Error('请在本地运行 npm run dev 后使用制作功能。');
  const response = await fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})});
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
function renderProject(result) {
  if (!result || !Array.isArray(result.files) || !result.files.length) throw new Error('工程未包含源码文件，未开放下载。');
  currentProject = result;
  const report = result.report || {};
  const staticPassed = report.staticValidation?.passed === true;
  $('file-count').textContent = result.files.length + ' FILES';
  $('file-list').replaceChildren(...result.files.map((file, index) => {
    const button = element('button', file.path); button.type = 'button'; button.title = file.path;
    button.addEventListener('click', () => selectFile(index)); return button;
  }));
  selectFile(Math.max(0, result.files.findIndex(file => file.path.endsWith('ModEntry.cs'))));
  $('source-status').textContent = examplePlan ? '示例源码已生成' : '源码草稿已生成';
  $('source-state').classList.add('is-complete');
  $('static-status').textContent = staticPassed ? '静态检查通过' : '未取得通过结果';
  $('static-state').classList.toggle('is-complete', staticPassed);
  $('game-status').textContent = '构建 / 游戏实测待验证';
  $('project-status').textContent = examplePlan ? '示例源码工程 · 未调用云端模型' : 'Mod 源码草稿已生成';
  $('project-note').textContent = '含源码、配置与需求缺口；尚未构建，未在目标游戏中验证。请按工程说明继续检查。';
  if (typeof result.downloadUrl === 'string' && /^\/api\/projects\/[A-Za-z0-9_-]+\/download$/.test(result.downloadUrl)) {
    ui.download.href = result.downloadUrl;
    ui.download.download = '';
    ui.download.classList.remove('is-disabled'); ui.download.setAttribute('aria-disabled', 'false'); ui.download.tabIndex = 0;
  } else throw new Error('工程下载地址无效，未开放下载。');
  stage(staticPassed ? 'game' : 'static', staticPassed ? ['request','plan','source','static'] : ['request','plan','source']);
}
async function generateProject() {
  if (!planId || !canGenerate(currentPlan)) return;
  resetMessages(); setBusy(true, '正在生成工程…'); stage('source', ['request','plan']);
  try {
    const result = await api('/api/projects', {planId});
    renderProject(result);
    announce(examplePlan ? '示例源码工程已生成，未调用 AI。构建与实机验证尚未执行。' : '源码草稿已生成。请检查未实现项，再按工程说明构建和实机验证。');
  } catch (error) { showError(error); stage('plan', ['request']); }
  finally { setBusy(false); }
}
ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (busy || !serviceReady || !ui.form.reportValidity()) return;
  resetMessages();
  if (!ui.key.value.trim() && !providerConfigured) { ui.settings.open = true; ui.key.focus(); showError(new Error('请先填写 API Key，或使用下方不调用 AI 的示例工程。')); return; }
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
$('clear-key').addEventListener('click', () => { ui.key.value = ''; ui.key.focus(); });
ui.download.addEventListener('click', event => { if (ui.download.getAttribute('aria-disabled') === 'true') event.preventDefault(); });
for (const input of [ui.host, ui.source, ui.description]) input.addEventListener('input', () => { countDescription(); invalidatePlan(); });
for (const button of document.querySelectorAll('[data-example]')) button.addEventListener('click', () => {
  const example = examples[button.dataset.example];
  ui.host.value = example.host; ui.source.value = example.source; ui.description.value = example.description;
  countDescription(); invalidatePlan();
});
async function initialize() {
  countDescription();
  if (!isLocalOrigin) {
    $('connection-text').textContent = '公开界面预览';
    $('runtime-notice').replaceChildren(element('strong', '当前是公开预览页面'), element('p', '调用模型与生成工程请在本地运行 npm run dev。本页不会连接你的电脑，也不接收 API Key。'));
    $('form-note').textContent = '本地制作功能在下方“本地运行”说明中开启。';
    ui.settings.hidden = true;
    setBusy(false);
    return;
  }
  try {
    const response = await fetch('/api/config', {cache: 'no-store'});
    if (!response.ok) throw new Error('本地 API 尚未启动。');
    const config = await response.json();
    if (config.local !== true) throw new Error('无法确认本地制作服务。');
    serviceReady = true; providerConfigured = config.providerConfigured === true;
    ui.settings.hidden = false;
    if (config.defaultProvider?.baseUrl) ui.base.value = config.defaultProvider.baseUrl;
    if (config.defaultProvider?.model) ui.model.value = config.defaultProvider.model;
    $('connection-badge').classList.add('is-local'); $('connection-text').textContent = '本地服务已连接';
    $('runtime-notice').classList.add('is-local');
    $('runtime-notice').replaceChildren(element('strong', '本地制作服务已就绪'), element('p', '配置模型后分析需求，或查看不调用 AI 的固定示例。源码工程仍需构建与游戏实测。'));
    $('form-note').textContent = '调用模型会使用你所配置供应商的 API 额度。';
    if (providerConfigured) { $('api-key-hint').textContent = '本地环境已配置；可留空使用'; ui.key.placeholder = '留空使用本地环境中的密钥'; }
    setBusy(false);
  } catch (error) {
    $('connection-text').textContent = '本地服务未就绪';
    $('runtime-notice').replaceChildren(element('strong', '尚未连接制作服务'), element('p', '请通过 npm run dev 启动完整本地服务，再刷新此页面。'));
    $('form-note').textContent = '仅静态预览服务器不提供模型调用或工程生成。';
    setBusy(false);
  }
}
initialize();
