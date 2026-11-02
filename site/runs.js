// The browser controls durable workflows through the local service only.
// It never stores credentials or determines build/game evidence.
const element = id => document.getElementById(id);
const local = ['127.0.0.1', 'localhost'].includes(location.hostname);
const terminal = new Set(['blocked', 'succeeded', 'failed', 'cancelled', 'interrupted', 'paused']);
const labels = { pending: '待调度', ready: '就绪', running: '运行中', succeeded: '完成 · 数据已校验', failed: '失败', blocked: '阻断', cancelled: '已取消', interrupted: '已中断', paused: '已暂停', created: '已创建' };
const roles = { requirements: '需求规划', 'source-research': '来源分析', 'host-research': '宿主分析', 'conversion-implementation': '转换设计', 'independent-validation': '独立审查' };
const executionKinds = { generation: '工程生成', build: '真实 Mod 构建', game: '游戏验收' };
const failureLabels = { INVALID_AGENT_REPORT: 'Agent 返回未通过角色合同校验；没有自动重试。', INVALID_CONVERSION_PLAN: '需求方案未通过合同校验；没有自动重试。', TASK_TIMEOUT: '任务观察超时；晚到结果会丢弃。', TASK_CANCELLED: '任务已取消；晚到结果会丢弃。' };
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
  if (!Number.isSafeInteger(maxModelCalls) || maxModelCalls < 0 || maxModelCalls > 20) throw new Error('总调用预算须为 0–20 的整数；正常协作需要 5 次。');
  return { maxModelCalls };
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
  element('start-run').disabled = !connected || sending || Boolean(active);
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
function render(run) {
  if (!run || typeof run.id !== 'string' || !/^[a-f0-9-]{36}$/.test(run.id) || !Array.isArray(run.tasks) || run.tasks.length > 128 || !Array.isArray(run.graph)) throw new Error('工作流记录不完整。');
  current = run;
  const completed = run.tasks.filter(task => task.status === 'succeeded').length;
  element('run-status').textContent = run.observation?.active && terminal.has(run.status) ? '正在调度恢复' : labels[run.status] || '未验证';
  element('run-summary').textContent = `任务 ${completed}/${run.tasks.length} · 调用预算已预留 ${run.budget?.modelCallsReserved ?? 0}/${run.budget?.maxModelCalls ?? 0}。这是分析/编排记录，真实 Mod 构建和游戏仍未运行。`;
  element('run-tasks').replaceChildren(...run.tasks.map(task => {
    const definition = run.graph.find(item => item.id === task.id) || {};
    const entry = node('li'), title = node('div', undefined, 'task-title');
    title.append(node('strong', executionKinds[definition.kind] || roles[definition.role] || definition.id || task.id), node('span', labels[task.status] || '未验证', 'badge'));
    entry.append(title, node('p', `尝试 ${task.attemptCount ?? 0} · 依赖：${definition.dependsOn?.length ? definition.dependsOn.join('、') : '无'}`));
    for (const blocker of task.blockers || []) entry.append(node('p', typeof blocker === 'string' ? blocker : blocker.message || blocker.code || '等待前置条件', 'run-task-error'));
    const last = task.attempts?.[task.attempts.length - 1];
    if (last?.error) entry.append(node('p', `${last.error.code}: ${failureLabels[last.error.code] || last.error.message || '任务未完成。'}`, 'run-task-error'));
    for (const diagnostic of last?.error?.diagnostics || []) entry.append(node('p', `${diagnostic.path} · ${diagnostic.rule} · ${diagnostic.expected}`, 'run-task-error'));
    if (task.result?.data !== undefined) {
      const details = node('details', undefined, 'run-artifact');
      details.append(node('summary', '查看分析输出与来源'), node('pre', JSON.stringify({ artifact: task.result.artifact, data: task.result.data }, null, 2)));
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
  let payload; try { payload = { request: request(), provider: provider(), budget: budget() }; } catch (error) { showError(error); return; }
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

async function connect() {
  if (!local) { controls(); return; }
  try {
    const config = await api('/api/config');
    if (config?.local !== true || config.capabilities?.multiAgentAnalysis !== true || !config.defaultProvider || typeof config.defaultProvider.baseUrl !== 'string') return;
    configured = config; connected = true; controls(); await history();
  } catch (error) { showError(error); }
}
void connect();
