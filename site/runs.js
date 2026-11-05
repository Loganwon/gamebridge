// The browser controls durable workflows through the local service only.
// It never stores credentials or determines build/game evidence.
const element = id => document.getElementById(id);
const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
const terminal = new Set(['blocked', 'succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
const labels = { pending: '待调度', ready: '就绪', running: '运行中', succeeded: '完成 · 数据已校验', failed: '失败', blocked: '阻断', cancelled: '已取消', interrupted: '已中断', paused: '已暂停', created: '已创建' };
const roles = { requirements: '需求规划', 'source-research': '来源分析', 'host-research': '宿主分析', 'conversion-implementation': '转换设计', 'independent-validation': '独立审查' };
const executionKinds = { generation: '工程生成', build: '真实 Mod 构建', game: '游戏验收' };
const projectWorkflow = 'gamebridge.conversion-project.v1', analysisWorkflow = 'gamebridge.multi-agent-analysis.v1';
const workflows = { [projectWorkflow]: { calls: 6, label: '统一转换流程', button: '启动统一转换流程', hint: '统一流程通常 6 次；工程草稿在本地生成，失败不自动重试' },
  [analysisWorkflow]: { calls: 5, label: '五角色分析', button: '启动五角色分析', hint: '五角色分析通常 5 次；失败不自动重试' } };
const taskLabels = { 'specify-behavior': 'AI 行为规格提案', 'validate-behavior': '行为规格结构校验', 'generate-adapter-project': '生成适配工程草稿', 'generate-project': '正式宿主 Mod 工程' };
const failureLabels = { INVALID_AGENT_REPORT: 'Agent 返回未通过角色合同校验；没有自动重试。', INVALID_CONVERSION_PLAN: '需求方案未通过合同校验；没有自动重试。', INVALID_BEHAVIOR_PROPOSAL: '行为规格未通过受限合同校验；没有自动重试。', TASK_TIMEOUT: '任务观察超时；晚到结果会丢弃。', TASK_CANCELLED: '任务已取消；晚到结果会丢弃。' };
let connected = false, configured = null, current = null, epoch = 0, timer = null, sending = false;

function node(tag, text, className) {
  const result = document.createElement(tag); if (text !== undefined) result.textContent = String(text).slice(0, 3000); if (className) result.className = className; return result;
}
function showError(error) {
  let message = error?.message || '工作流操作未完成。';
  const key = element('provider-key').value;
  if (key) message = message.replaceAll(key, '[已隐藏密钥]');
  element('run-error').textContent = message.slice(0, 1200); element('run-error').hidden = false;
}
function budget() {
  const maxModelCalls = Number(element('model-budget').value);
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 20) throw new Error('总调用预算须为 0–20 的整数；统一流程通常 6 次，五角色分析 5 次。');
  return { maxModelCalls };
}
function workflow() {
  const id = element('workflow-mode').value;
  if (!Object.hasOwn(workflows, id)) throw new Error('请选择已登记的转换流程。');
  if (id === projectWorkflow && configured?.capabilities?.unifiedConversionWorkflow !== true) throw new Error('当前本地服务尚未提供统一转换流程，请更新服务或选择五角色分析。');
  return id;
}
function workflowLabels(resetBudget = false) {
  const selected = workflows[element('workflow-mode').value];
  if (!selected) return;
  element('workflow-budget-hint').textContent = selected.hint;
  element('start-run').textContent = selected.button;
  if (resetBudget) element('model-budget').value = String(selected.calls);
}
function provider() {
  const value = { apiKey: element('provider-key').value.trim(), baseUrl: element('provider-base').value.trim(), model: element('provider-model').value.trim() };
  const url = new URL(value.baseUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('请输入有效的 HTTPS API 根地址。');
  if (!value.apiKey && !(configured?.providerConfigured && url.origin === new URL(configured.defaultProvider.baseUrl).origin)) throw new Error('请填写当前 API 地址对应的密钥；默认密钥不能跨地址使用。');
  return value;
}
function request() {
  return { hostGame: element('host-game').value.trim(), sourceGame: element('source-game').value.trim(), description: element('description').value.trim(),
    contentKinds: [...document.querySelectorAll('[name="content-kind"]')].filter(input => input.checked).map(input => input.value),
    ...(element('host-version').value.trim() ? { hostVersion: element('host-version').value.trim() } : {}),
    ...(element('source-version').value.trim() ? { sourceVersion: element('source-version').value.trim() } : {}) };
}
async function api(path, payload) {
  const options = payload === undefined ? { cache: 'no-store' } : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) };
  const response = await fetch(path, { ...options, signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || '工作流服务未完成操作。');
  return data;
}
function controls() {
  const active = current && (current.observation?.active === true || !terminal.has(current.status));
  const supported = element('workflow-mode').value === analysisWorkflow || (element('workflow-mode').value === projectWorkflow && configured?.capabilities?.unifiedConversionWorkflow === true);
  element('start-run').disabled = !connected || !supported || sending || Boolean(active);
  element('workflow-mode').disabled = !connected || sending || Boolean(active);
  element('model-budget').disabled = !connected || sending;
  element('refresh-runs').disabled = !connected || sending;
  element('cancel-run').hidden = !active;
  element('cancel-run').disabled = sending;
  element('resume-run').hidden = Boolean(active) || !current || !terminal.has(current.status) || current.status === 'succeeded';
  element('resume-run').disabled = sending;
  const interrupted = current?.tasks?.some(task => ['interrupted', 'failed', 'cancelled'].includes(task.status));
  element('replay-label').hidden = !interrupted;
  element('allow-replay').disabled = sending;
}
function textList(entry, heading, values, describe = value => value) {
  if (!Array.isArray(values) || !values.length) return;
  entry.append(node('h3', heading));
  const list = node('ul', undefined, 'run-output-summary');
  list.append(...values.slice(0, 64).map(value => node('li', describe(value)))); entry.append(list);
}
function behaviorSummary(entry, proposal) {
  const spec = proposal?.spec;
  if (!spec || !Array.isArray(spec.states) || !Array.isArray(spec.events) || !Array.isArray(spec.transitions) || !Array.isArray(spec.requirementIds) || !Array.isArray(spec.unresolved)) return;
  entry.append(node('p', proposal.summary), node('p', `结构化规格：${spec.states.length} 个状态、${spec.events.length} 类事件、${spec.transitions.length} 条转换；引用 ${spec.requirementIds.length} 项需求。引用齐全不证明语义完整。`));
  if (spec.unresolved.length) textList(entry, '尚未表达的需求', spec.unresolved, item => `${item.requirementId}：${item.reason}`);
  else entry.append(node('p', '规格未列出未表达项；仍须核对原始需求与实际宿主接口。'));
  textList(entry, '规格假设', proposal.assumptions); textList(entry, '规格限制', proposal.limitations);
}
function projectHandle(run) {
  const task = run.tasks.find(item => item.id === 'generate-adapter-project' && item.status === 'succeeded'), data = task?.result?.data;
  const handle = data?.project;
  return data?.metadata?.scope === 'adapter-project-draft' && handle?.scope === 'local-tool-artifact' && typeof handle.id === 'string' && /^[a-f0-9-]{36}$/.test(handle.id) &&
    typeof handle.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(handle.manifestSha256) ? data : null;
}
function render(run) {
  if (!run || typeof run.id !== 'string' || !/^[a-f0-9-]{36}$/.test(run.id) || !Array.isArray(run.tasks) || run.tasks.length > 128 || !Array.isArray(run.graph)) throw new Error('工作流记录不完整。');
  if (current?.id !== run.id) {
    const savedWorkflow = run.context?.workflow || analysisWorkflow;
    if (Object.hasOwn(workflows, savedWorkflow)) element('workflow-mode').value = savedWorkflow;
    element('model-budget').value = String(run.budget?.maxModelCalls ?? workflows[savedWorkflow]?.calls ?? 5);
    workflowLabels();
  }
  current = run;
  const draft = projectHandle(run), projectUrl = `/api/runs/${run.id}/project`;
  const downloadableProject = draft && run.projectDownloadUrl === projectUrl;
  element('download-project').hidden = !downloadableProject;
  element('download-project').removeAttribute('href');
  if (downloadableProject) element('download-project').href = projectUrl;
  const completed = run.tasks.filter(task => task.status === 'succeeded').length;
  element('run-status').textContent = run.observation?.active && terminal.has(run.status) ? '正在调度恢复' : draft && run.status === 'blocked' ? '工程草稿已生成 · 等待宿主适配' : labels[run.status] || '未验证';
  element('run-summary').textContent = `任务 ${completed}/${run.tasks.length} · 调用预算已预留 ${run.budget?.modelCallsReserved ?? 0}/${run.budget?.maxModelCalls ?? 0}。${draft ? '适配工程草稿已保存，宿主绑定仍待实现；' : '按阶段保留分析、规格与阻断原因；'}真实 Mod 构建和游戏仍未运行。`;
  const brief = node('details', undefined, 'run-artifact'), original = node('pre');
  original.textContent = typeof run.context?.request?.description === 'string' ? run.context.request.description : '本次记录未提供原始描述。';
  brief.append(node('summary', '本次任务的完整需求'), node('p', `宿主：${run.context?.request?.hostGame || '未指定'} ← 来源：${run.context?.request?.sourceGame || '未指定'}`), original);
  element('run-brief').replaceChildren(brief);
  element('run-tasks').replaceChildren(...run.tasks.map(task => {
    const definition = run.graph.find(item => item.id === task.id) || {};
    const entry = node('li'), title = node('div', undefined, 'task-title');
    title.append(node('strong', taskLabels[task.id] || executionKinds[definition.kind] || roles[definition.role] || definition.id || task.id), node('span', labels[task.status] || '未验证', 'badge'));
    entry.append(title, node('p', `尝试 ${task.attemptCount ?? 0} · 依赖：${definition.dependsOn?.length ? definition.dependsOn.join('、') : '无'}`));
    for (const blocker of task.blockers || []) entry.append(node('p', typeof blocker === 'string' ? blocker : blocker.message || blocker.code || '等待前置条件', 'run-task-error'));
    const last = task.attempts?.[task.attempts.length - 1];
    if (last?.error) entry.append(node('p', `${last.error.code}: ${failureLabels[last.error.code] || last.error.message || '任务未完成。'}`, 'run-task-error'));
    for (const diagnostic of last?.error?.diagnostics || []) entry.append(node('p', `${diagnostic.path} · ${diagnostic.rule} · ${diagnostic.expected}`, 'run-task-error'));
    if (task.result?.data !== undefined) {
      const data = task.result.data;
      if (task.id === 'requirements') {
        if (data.analysis?.summary) entry.append(node('p', data.analysis.summary));
        textList(entry, '保留的逐项需求', data.analysis?.requirements, item => `${item.id}：${item.description}（${item.reason || '待进一步核验'}）`);
      }
      if (task.id === 'specify-behavior') behaviorSummary(entry, data.proposal);
      if (task.id === 'validate-behavior') entry.append(node('p', `行为规格结构已校验；${Array.isArray(data.requirementIds) ? data.requirementIds.length : 0} 项外部绑定需求，${Array.isArray(data.unresolvedRequirementIds) ? data.unresolvedRequirementIds.length : 0} 项尚未表达。语义完整性仍未验证。`));
      if (task.id === 'generate-adapter-project' && draft) {
        entry.append(node('p', '已生成受限行为源码和接口绑定清单。此产物是适配工程草稿，不能直接安装进游戏。'));
        textList(entry, '工程文件', draft.metadata.filePaths);
        textList(entry, '尚未表达的需求', draft.metadata.unresolvedRequirementIds);
        textList(entry, '宿主绑定与执行阻断', draft.metadata.blockers, item => `${item.code || '待适配'}：${item.message || '等待接口核验与实现'}`);
        if (downloadableProject) { const link = node('a', '下载适配工程草稿', 'download'); link.href = projectUrl; entry.append(link); }
      }
      const details = node('details', undefined, 'run-artifact');
      const raw = node('pre'); raw.textContent = JSON.stringify({ artifact: task.result.artifact, data }, null, 2);
      details.append(node('summary', '查看完整结构化输出与来源'), raw);
      entry.append(details);
    }
    return entry;
  }));
  element('download-run').href = `/api/runs/${run.id}/download`; element('download-run').hidden = false;
  controls();
}
function stopPolling() { if (timer !== null) clearTimeout(timer); timer = null; }
async function poll(id, version) {
  try {
    const run = await api(`/api/runs/${id}`);
    if (version !== epoch) return;
    render(run);
    if (run.serviceError) showError(new Error(run.serviceError.message));
    if (run.observation?.active || !terminal.has(run.status)) timer = setTimeout(() => { void poll(id, version); }, 1200);
  } catch (error) { if (version === epoch) showError(error); }
}
async function select(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return;
  stopPolling(); epoch++; element('allow-replay').checked = false; element('run-error').hidden = true;
  await poll(id, epoch);
}
async function history() {
  const result = await api('/api/runs');
  if (!Array.isArray(result.runs) || result.runs.length > 128) throw new Error('本机任务列表不完整。');
  element('run-history').replaceChildren(...result.runs.map(run => {
    const button = node('button', `${run.context?.request?.hostGame || '宿主'} ← ${run.context?.request?.sourceGame || '来源'} · ${labels[run.status] || run.status}`);
    button.type = 'button'; button.addEventListener('click', () => { void select(run.id); }); return button;
  }));
}
element('start-run').addEventListener('click', async () => {
  if (!connected || sending || (current && (current.observation?.active || !terminal.has(current.status)))) return;
  if (element('conversion-form').getAttribute('aria-busy') === 'true') { showError(new Error('单次分析仍在运行，请先等待或取消。')); return; }
  if (!element('conversion-form').reportValidity()) return;
  let payload; try { payload = { request: request(), provider: provider(), budget: budget(), workflow: workflow() }; } catch (error) { showError(error); return; }
  sending = true; stopPolling(); epoch++; const version = epoch; controls(); element('run-error').hidden = true;
  try {
    const run = await api('/api/runs', payload);
    if (version === epoch) { render(run); await poll(run.id, version); }
    await history();
  } catch (error) { if (version === epoch) showError(error); }
  finally { sending = false; controls(); }
});
element('cancel-run').addEventListener('click', async () => {
  if (!current || sending || !connected) return;
  sending = true; controls(); stopPolling(); epoch++; const version = epoch, id = current.id;
  try { const run = await api(`/api/runs/${id}/cancel`, {}); if (version === epoch) render(run); }
  catch (error) { if (version === epoch) showError(error); }
  finally { sending = false; controls(); }
});
element('resume-run').addEventListener('click', async () => {
  if (!current || sending || !connected) return;
  let payload; try { payload = { provider: provider(), budget: budget(), allowReplay: element('allow-replay').checked }; } catch (error) { showError(error); return; }
  sending = true; controls(); stopPolling(); epoch++; const version = epoch, id = current.id; element('run-error').hidden = true;
  try { const run = await api(`/api/runs/${id}/resume`, payload); if (version === epoch) { render(run); await poll(id, version); } }
  catch (error) { if (version === epoch) showError(error); }
  finally { sending = false; controls(); }
});
element('refresh-runs').addEventListener('click', () => { if (connected) void history().catch(showError); });
element('workflow-mode').addEventListener('change', () => { workflowLabels(true); controls(); });

async function connect() {
  if (!local) { controls(); return; }
  try {
    const config = await api('/api/config');
    if (config?.local !== true || config.capabilities?.multiAgentAnalysis !== true || !config.defaultProvider || typeof config.defaultProvider.baseUrl !== 'string') return;
    configured = config;
    if (config.capabilities.unifiedConversionWorkflow !== true) element('workflow-mode').value = analysisWorkflow;
    else if (!Object.hasOwn(workflows, element('workflow-mode').value)) element('workflow-mode').value = projectWorkflow;
    workflowLabels(true); connected = true; controls(); await history();
  } catch (error) { showError(error); }
}
void connect();
