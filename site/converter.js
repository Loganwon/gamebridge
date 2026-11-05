const $ = id => document.getElementById(id);
const localOrigin = ['127.0.0.1', 'localhost'].includes(location.hostname);
const fields = ['host-game', 'source-game', 'host-version', 'source-version', 'description', 'provider-base', 'provider-model', 'provider-key'];
const kindInputs = [...document.querySelectorAll('[name="content-kind"]')];
const dispositions = { needs_research: '待调查', needs_assets: '需资源', out_of_scope: '不在可执行范围' };
let ready = false, busy = false, providerConfigured = false;
let configuredOrigin = null, displayedOrigin = null, controller = null, revision = 0;

function providerOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Invalid API origin.');
  return url.origin;
}
function usesDefaultKey() {
  try { return providerOrigin($('provider-base').value.trim()) === configuredOrigin; } catch { return false; }
}
function credentialHint() {
  $('key-status').textContent = providerConfigured ? (usesDefaultKey() ? '本地已配置此地址的密钥；可留空' : '地址已更改，请填写对应 API Key') : '仅在本次请求使用';
}
function node(tag, text, className) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = String(text).slice(0, 3000);
  if (className) result.className = className;
  return result;
}
function errorMessage(error) {
  let message = error?.message || '操作未完成。';
  const key = $('provider-key').value;
  if (key) message = message.replaceAll(key, '[已隐藏密钥]');
  $('error').textContent = message.slice(0, 1200); $('error').hidden = false;
}
function setBusy(value) {
  busy = value; $('conversion-form').setAttribute('aria-busy', String(value));
  for (const id of fields) $(id).disabled = value || !ready;
  for (const input of kindInputs) input.disabled = value || !ready;
  $('analyze').disabled = value || !ready;
  $('analyze').textContent = value ? '正在拆解转换需求…' : '单次需求分析';
  $('cancel-analysis').hidden = !value;
}
function clearResult() {
  revision++; $('empty').hidden = false; $('plan').hidden = true;
  $('provenance').textContent = '等待需求'; $('analysis-status').textContent = '待分析';
  $('download-plan').hidden = true; $('download-plan').removeAttribute('href');
  $('tasks').replaceChildren(node('li', '分析后显示任务依赖与阻断原因。', 'task-placeholder'));
  $('error').hidden = true;
}
function list(id, values, emptyText, describe = item => item) {
  $(id).replaceChildren(...(values.length ? values.map(item => node('li', describe(item))) : [node('li', emptyText)]));
}
function render(record) {
  const plan = record?.plan;
  if (!plan || typeof plan.title !== 'string' || typeof plan.summary !== 'string' ||
      !Array.isArray(plan.requirements) || plan.requirements.length > 64 ||
      !Array.isArray(plan.workflow?.tasks) || plan.workflow.tasks.length > 64 ||
      !Array.isArray(plan.assetNeeds) || !Array.isArray(plan.interfaceNeeds) || !Array.isArray(plan.questions) || !Array.isArray(plan.limitations)) throw new Error('本地服务返回了不完整的转换方案。');
  $('empty').hidden = true; $('plan').hidden = false;
  $('plan-title').textContent = plan.title;
  $('plan-summary').textContent = plan.summary;
  $('plan-direction').textContent = `宿主：${plan.hostGame} ← 内容来源：${plan.sourceGame}。原始需求保留在导出方案中；来源与宿主接口均待调查。`;
  $('provenance').textContent = 'AI 转换分析 · 尚未执行';
  $('requirements').replaceChildren(...plan.requirements.map(item => {
    const entry = node('div', undefined, 'requirement'), top = node('div');
    top.append(node('strong', item.description), node('span', dispositions[item.disposition] || '未验证', 'badge'));
    entry.append(top, node('p', `必需需求 · ${item.id} · ${item.reason || '等待进一步核验。'}`));
    return entry;
  }));
  list('interface-needs', plan.interfaceNeeds, '本轮未列出具体接口；接口调查尚未运行。', item => item.description);
  list('asset-needs', plan.assetNeeds, '本轮未列出具体资源；这不等于已核对资源来源与可用性。', item => item.description);
  list('questions', plan.questions, '本轮未提出额外问题；缺失版本和接口仍需后续核验。');
  list('limitations', plan.limitations, '完整需求覆盖和来源保真尚未验证。');
  $('tasks').replaceChildren(...plan.workflow.tasks.map(task => {
    const entry = node('li'), title = node('div', undefined, 'task-title');
    title.append(node('strong', task.label), node('span', task.status === 'validated' ? '结构已校验' : '阻断', 'badge'));
    entry.append(title, node('p', `依赖：${task.dependsOn?.length ? task.dependsOn.join('、') : '无前置任务'}`));
    if (task.blockers?.length) entry.append(node('p', task.blockers.join('；')));
    return entry;
  }));
  $('analysis-status').textContent = '结构已校验';
  // A plan is the only current artifact. Model claims cannot upgrade execution
  // evidence or expose build/install controls on this page.
  const id = record.id;
  if (typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id)) {
    $('download-plan').href = `/api/conversions/${id}/download`; $('download-plan').hidden = false;
  }
}
for (const id of fields) $(id).addEventListener('input', () => { if (!busy) clearResult(); credentialHint(); });
for (const input of kindInputs) input.addEventListener('change', () => { if (!busy) clearResult(); });
$('provider-base').addEventListener('input', () => {
  let origin = null; try { origin = providerOrigin($('provider-base').value.trim()); } catch {}
  if (origin !== displayedOrigin) $('provider-key').value = '';
  displayedOrigin = origin; credentialHint();
});
$('conversion-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!ready || busy || !localOrigin) return;
  if (!$('provider-key').value.trim() && !(providerConfigured && usesDefaultKey())) {
    $('model-settings').open = true; $('provider-key').focus();
    errorMessage(new Error('请填写当前 API 地址对应的密钥；默认密钥只能用于已配置地址。')); return;
  }
  clearResult(); const currentRevision = revision; const active = new AbortController(); controller = active; setBusy(true);
  try {
    const request = { hostGame: $('host-game').value.trim(), sourceGame: $('source-game').value.trim(), description: $('description').value.trim(),
      contentKinds: kindInputs.filter(input => input.checked).map(input => input.value),
      ...($('host-version').value.trim() ? { hostVersion: $('host-version').value.trim() } : {}),
      ...($('source-version').value.trim() ? { sourceVersion: $('source-version').value.trim() } : {}) };
    const provider = { apiKey: $('provider-key').value.trim(), baseUrl: $('provider-base').value.trim(), model: $('provider-model').value.trim() };
    const response = await fetch('/api/conversions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request, provider }), signal: active.signal });
    const record = await response.json();
    if (currentRevision !== revision || active.signal.aborted) return;
    if (!response.ok) throw new Error(record.error?.message || '转换分析未完成。');
    render(record);
  } catch (error) {
    if (currentRevision === revision) errorMessage(error.name === 'AbortError' ? new Error('已停止等待；已发出的模型请求仍可能计费。') : error);
  } finally { if (currentRevision === revision) { controller = null; setBusy(false); } }
});
$('cancel-analysis').addEventListener('click', () => {
  if (!busy) return;
  revision++; controller?.abort(); controller = null; setBusy(false);
  $('provenance').textContent = '已取消';
  errorMessage(new Error('已停止等待，晚到结果不会保存到界面；已发出的模型请求仍可能计费。'));
});
async function connect() {
  if (!localOrigin) { $('connection').textContent = '公开说明 · 制作流程在本机运行'; setBusy(false); return; }
  try {
    const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const config = await response.json();
    if (!response.ok || config?.local !== true || !config.defaultProvider || typeof config.defaultProvider.model !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(config.defaultProvider.model)) throw new Error('Incomplete local configuration.');
    configuredOrigin = providerOrigin(config.defaultProvider.baseUrl); displayedOrigin = configuredOrigin;
    providerConfigured = config.providerConfigured === true;
    $('provider-base').value = config.defaultProvider.baseUrl; $('provider-model').value = config.defaultProvider.model;
    $('model-settings').hidden = false; ready = true; credentialHint();
    $('connection').textContent = '本地转换工作台已连接';
    $('runtime-notice').textContent = config.capabilities?.unifiedConversionWorkflow === true
      ? '统一流程可连接 AI 分析、行为规格与本地适配工程草稿。尚无已验收游戏适配器，正式 Mod 工程、构建和游戏实测仍保持阻断；不会自动启动游戏。'
      : '当前可调用云端模型分析完整转换需求。没有已验收游戏适配器，工程生成、构建和游戏实测仍保持阻断。';
  } catch { ready = false; $('connection').textContent = '本地服务未连接 · 请运行 npm run dev'; }
  setBusy(false);
}
connect();
