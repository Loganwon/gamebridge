import { createActionExample, validateActionBlueprint } from './core/actions/spec.mjs';
import { createActionScenarios, simulateActionBlueprint } from './core/actions/runtime.mjs';
import { assessActionHost } from './core/actions/hosts.mjs';

const $ = id => document.getElementById(id);
const localOrigin = ['127.0.0.1', 'localhost'].includes(location.hostname);
const fields = ['host', 'source', 'description', 'base-url', 'model', 'api-key'];
let serviceReady = false;
let providerConfigured = false;
let configuredProviderOrigin = null;
let displayedProviderOrigin = null;
let busy = false;
let state = null;
let downloadUrl = null;
let controller = null;
let revision = 0;
const labels = { rule: '规则已描述', needs_assets: '需要资源', needs_adapter: '需要适配', unsupported: '当前不支持' };
const ignoredLabels = { insufficient_stamina: '体力不足', no_entry: '该输入没有起始动作', no_transition: '当前阶段不允许这次切换', hit_required: '尚未满足命中条件' };
const phaseLabels = { idle: '空闲', startup: '起手', active: '命中窗口', recovery: '后摇', dodge: '闪避' };
function usesConfiguredProvider() {
  try { return new URL($('base-url').value.trim()).origin === configuredProviderOrigin; }
  catch { return false; }
}
function updateCredentialHint() {
  $('key-status').textContent = providerConfigured
    ? (usesConfiguredProvider() ? '本地已配置此地址的密钥；可留空' : '地址已更改，请填写对应的 API Key')
    : '仅在本次请求使用';
}
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function errorText(error) {
  let message = error?.message || '操作未完成。';
  const key = $('api-key').value;
  if (key) message = message.replaceAll(key, '[已隐藏密钥]');
  $('error').textContent = message.slice(0, 1400);
  $('error').hidden = false;
}
function setBusy(value) {
  busy = value;
  $('action-form').setAttribute('aria-busy', String(value));
  for (const id of fields) $(id).disabled = value || !serviceReady;
  $('analyze').disabled = value || !serviceReady;
  $('analyze').textContent = value ? '正在分析并设计规则…' : 'AI 分析并设计动作规则';
  for (const button of document.querySelectorAll('[data-variant]')) button.disabled = value;
  $('simulate').disabled = value || !state?.blueprint.actions.length;
  $('export').disabled = value || !state;
  $('cancel-analysis').hidden = !value;
}
function resetResult() {
  revision++;
  state = null;
  $('design').hidden = true;
  $('empty').hidden = false;
  $('provenance').textContent = '需求已更改';
  $('simulation-results').replaceChildren();
  $('blockers').replaceChildren();
  $('rules-status').textContent = '待设计';
  $('host-summary').textContent = '没有已验收的动作宿主。需要真实游戏环境与动作接口验证。';
  $('error').hidden = true;
  setBusy(busy);
}
function render(record) {
  const blueprint = validateActionBlueprint(record.blueprint, record.request);
  state = { ...record, blueprint, hostAssessment: assessActionHost(blueprint), simulations: [] };
  $('empty').hidden = true;
  $('design').hidden = false;
  $('error').hidden = true;
  $('provenance').textContent = record.report.provenance === 'model' ? '真实模型输出 · 1 次调用' : '项目自有示例 · 未调用模型';
  $('design-title').textContent = blueprint.title;
  $('design-meta').textContent = `宿主 ${blueprint.hostGame} / 版本 ${blueprint.hostVersion} ← 来源 ${blueprint.sourceGame} / 版本 ${blueprint.source.version}。来源特征与完整需求覆盖尚未验证。`;
  $('requirements').replaceChildren(...blueprint.requirements.map(item => {
    const node = el('div', undefined, 'requirement');
    const top = el('div');
    top.append(el('strong', item.description), el('span', labels[item.disposition], 'badge'));
    node.append(top, el('p', `${item.required ? '必需' : '可选'} · ${item.actionIds.length ? '映射动作：' + item.actionIds.join('、') : '尚无动作映射'}。规则映射不代表宿主已经实现。`));
    return node;
  }));
  $('actions').replaceChildren(...blueprint.actions.map(action => {
    const row = el('tr');
    const timing = action.hitWindow ? `${action.durationTicks} ticks / [${action.hitWindow.startTick}, ${action.hitWindow.endTick})` : `${action.durationTicks} ticks / 无攻击窗口`;
    const bindings = blueprint.entryActions.filter(item => item.actionId === action.id).map(item => `空闲时 ${item.input}`);
    const transitions = action.transitions.map(item => `${item.input} → ${item.to} [${item.windowStartTick}, ${item.windowEndTick}) ${item.condition === 'hit_confirmed' ? '需要已命中' : '无需命中'}`);
    row.append(el('td', `${action.id} · ${action.kind === 'attack' ? '攻击' : '闪避'}`), el('td', timing), el('td', `${action.staminaCost} 体力`), el('td', [...bindings, ...transitions, action.interruptible ? '可受击中断' : '规则中不被受击中断'].join('；')));
    return row;
  }));
  $('limitations').replaceChildren(...[...blueprint.assetRequirements, ...blueprint.limitations].map(value => el('li', value)));
  $('host-summary').textContent = '宿主检查结果：阻断。动作规则已描述，不具备宿主动作适配器或真实游戏验收。';
  $('blockers').replaceChildren(...state.hostAssessment.blockers.map(item => el('li', item.message)));
  $('rules-status').textContent = blueprint.actions.length ? '结构与引用有效' : '无可表达的动作';
  $('simulation-results').replaceChildren();
  setBusy(false);
}
async function post(url, data, signal) {
  if (!serviceReady || !localOrigin) throw new Error('请在本机运行 npm run dev 后使用 AI 分析。');
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal });
  let result;
  try { result = await response.json(); } catch { throw new Error('本地服务响应无效，请重启服务后重试。'); }
  if (!response.ok) throw new Error(result.error?.message || '本地分析未完成。');
  return result;
}
for (const id of fields) $(id).addEventListener('input', () => { if (!busy) resetResult(); updateCredentialHint(); });
$('base-url').addEventListener('input', () => {
  let origin = null;
  try { origin = new URL($('base-url').value.trim()).origin; } catch {}
  if (origin !== displayedProviderOrigin) $('api-key').value = '';
  displayedProviderOrigin = origin;
  updateCredentialHint();
});
for (const button of document.querySelectorAll('[data-variant]')) button.addEventListener('click', () => {
  try {
    resetResult();
    const example = createActionExample(button.dataset.variant);
    $('host').value = example.request.hostGame;
    $('source').value = example.request.sourceGame;
    $('description').value = example.request.description;
    render({ ...example, report: { provenance: 'project-example', modelCalls: 0, scope: 'action-rules-design-only', realModBuild: 'not_run', game: 'not_run', readyToInstall: false, completeRequirementCoverage: false, sourceFidelityVerified: false } });
  } catch (error) { errorText(error); }
});
$('action-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !serviceReady) return;
  if (!$('api-key').value.trim() && !(providerConfigured && usesConfiguredProvider())) {
    $('model-settings').open = true;
    $('api-key').focus();
    errorText(new Error('请填写当前 API 地址对应的密钥；本地默认密钥只用于原配置地址。'));
    return;
  }
  resetResult();
  const currentRevision = revision;
  controller = new AbortController();
  setBusy(true);
  try {
    const request = { hostGame: $('host').value.trim(), sourceGame: $('source').value.trim(), description: $('description').value.trim() };
    const provider = { apiKey: $('api-key').value.trim(), baseUrl: $('base-url').value.trim(), model: $('model').value.trim() };
    const record = await post('/api/action-plans', { request, provider }, controller.signal);
    if (currentRevision === revision) render(record);
  } catch (error) {
    if (currentRevision === revision) errorText(error.name === 'AbortError' ? new Error('已停止等待；已发出的模型请求仍可能计费。') : error);
  } finally { if (currentRevision === revision) { controller = null; setBusy(false); } }
});
$('cancel-analysis').addEventListener('click', () => controller?.abort());
$('simulate').addEventListener('click', () => {
  if (!state || busy) return;
  try {
    const simulations = createActionScenarios(state.blueprint).map(scenario => ({ scenario, result: simulateActionBlueprint(state.blueprint, scenario) }));
    state.simulations = simulations;
    $('simulation-results').replaceChildren(...simulations.map(({ scenario, result }) => {
      const node = el('div', undefined, 'simulation');
      const starts = result.trace.filter(item => item.type === 'action_started').map(item => `${item.actionId}@${item.tick}`);
      const ignored = result.trace.filter(item => item.type === 'input_ignored').map(item => ignoredLabels[item.reason] || item.reason);
      node.append(el('h4', scenario.name), el('p', `动作序列：${starts.join(' → ') || '无动作启动'}。最终状态：${phaseLabels[result.finalState.phase] || result.finalState.phase}，体力 ${result.finalState.stamina}。`));
      if (ignored.length) node.append(el('p', `被规则阻止：${ignored.join('、')}。`));
      const detail = el('details');
      detail.append(el('summary', '查看合成输入与完整状态轨迹'), el('pre', JSON.stringify({ scenario, trace: result.trace, semantics: result.semantics }, null, 2)));
      node.append(detail);
      return node;
    }));
    $('rules-status').textContent = `${simulations.length} 个场景已回放`;
  } catch (error) { errorText(error); }
});
$('export').addEventListener('click', () => {
  if (!state || busy) return;
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  const report = { ...state, artifact: 'action-design-not-a-mod', scope: 'action-rules-design-and-simulation-only', realModBuild: 'not_run', game: 'not_run', readyToInstall: false };
  downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2) + '\n'], { type: 'application/json' }));
  const link = el('a');
  link.href = downloadUrl; link.download = 'gamebridge-action-design.json';
  document.body.append(link); link.click(); link.remove();
});
async function connect() {
  if (!localOrigin) { $('connection').textContent = '公开预览 · 可回放自有规则'; setBusy(false); return; }
  try {
    const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const config = await response.json();
    if (!response.ok || config.local !== true) throw new Error('Local workbench not found.');
    if (!config.defaultProvider || typeof config.defaultProvider.baseUrl !== 'string' || typeof config.defaultProvider.model !== 'string') throw new Error('Incomplete local configuration.');
    $('base-url').value = config.defaultProvider.baseUrl;
    $('model').value = config.defaultProvider.model;
    configuredProviderOrigin = new URL(config.defaultProvider.baseUrl).origin;
    displayedProviderOrigin = configuredProviderOrigin;
    providerConfigured = config.providerConfigured === true;
    updateCredentialHint();
    $('model-settings').hidden = false;
    $('connection').textContent = '本地工作台已连接';
    $('runtime-notice').textContent = '可调用本机配置的模型设计动作规则；一次调用，无自动重试。真实动作宿主尚未接入，仍不能生成可安装的动作 Mod。';
    serviceReady = true;
  } catch { serviceReady = false; $('connection').textContent = '本地服务未连接 · 可回放示例'; }
  setBusy(false);
}
connect();
