import { randomUUID, createHash } from 'node:crypto';
import { validateTaskGraph } from './protocol.mjs';
import { assertRunData } from './store.mjs';

const TASK_STATES = new Set(['pending', 'running', 'succeeded', 'failed', 'blocked', 'interrupted', 'cancelled']);
const RUN_STATES = new Set(['created', 'running', 'succeeded', 'failed', 'blocked', 'interrupted', 'cancelled']);
const REPORT = Object.freeze({ scope: 'orchestration-only', realModBuild: 'not_run', game: 'not_run', readyToInstall: false });
const LIMITS = Object.freeze({ contextBytes: 128 * 1024, resultBytes: 128 * 1024, maxModelCalls: 128, maxAttempts: 192, events: 128 });
function fault(code, message) { const error = new Error(message); error.code = code; return error; }
function integer(value, min, max) { return Number.isSafeInteger(value) && value >= min && value <= max; }
function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function budget(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['maxModelCalls', 'maxAttempts'].includes(key)) ||
      !integer(value.maxModelCalls ?? 5, 0, LIMITS.maxModelCalls) || !integer(value.maxAttempts ?? 128, 1, LIMITS.maxAttempts)) throw fault('INVALID_RUN_BUDGET', 'Run budget is invalid or unbounded.');
  return { maxModelCalls: value.maxModelCalls ?? 5, maxAttempts: value.maxAttempts ?? 128, modelCallsReserved: 0, attemptsReserved: 0 };
}
// Only a local diagnostic vocabulary is persisted. Raw exception messages,
// unknown property names and model-provided expectations never enter snapshots.
const DIAGNOSTIC_EXPECTATIONS = Object.freeze({ schema: 'supported schema', structure: 'bounded plain JSON', text: 'bounded nonempty text', number: 'finite number', array: 'bounded dense array', property: 'known data properties', bytes: 'within byte budget', object: 'object with exact fields', required: 'required field', identifier: 'local identifier syntax', unique: 'unique identifiers', reference: 'existing requirement reference', context: 'required upstream context', const: 'required constant', enum: 'allowed enum value', coverage: 'every requirement exactly once', 'local-value': 'locally assigned metadata' });
const DIAGNOSTIC_SEGMENTS = new Set('schemaVersion role scope evidenceScope hostGame sourceGame analysis realModBuild game readyToInstall summary items questions limitations coverage issues id requirementId requirementIds assessment reason description nextStep'.split(' '));
function dataProperty(value, key) { return value && ['object', 'function'].includes(typeof value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined; }
function safeDiagnostics(error) {
  const raw = dataProperty(error, 'diagnostics');
  if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype) return [];
  const result = [];
  for (let index = 0; index < Math.min(raw.length, 3); index++) {
    const entry = dataProperty(raw, String(index)), path = dataProperty(entry, 'path'), rule = dataProperty(entry, 'rule');
    if (typeof path !== 'string' || path.length > 512 || !path.startsWith('/') || typeof rule !== 'string' || !Object.hasOwn(DIAGNOSTIC_EXPECTATIONS, rule)) continue;
    const segments = path === '/' ? [] : path.slice(1).split('/');
    if (segments.length > 18 || segments.some(segment => !DIAGNOSTIC_SEGMENTS.has(segment) && !/^(?:0|[1-9]\d{0,2})$/.test(segment)) || segments.some(segment => /^\d/.test(segment) && Number(segment) > 255)) continue;
    result.push({ path, rule, expected: DIAGNOSTIC_EXPECTATIONS[rule] });
  }
  return result;
}
function safeFailure(error, cancelled) {
  const code = dataProperty(error, 'code'), diagnostics = cancelled ? [] : safeDiagnostics(error);
  return { code: cancelled ? 'TASK_CANCELLED' : typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'TASK_FAILED',
    message: cancelled ? 'Task observation was cancelled; late results were discarded.' : 'Registered task execution did not complete its local contract.',
    ...(diagnostics.length ? { diagnostics } : {}) };
}

/** Deterministic dependency scheduler. Registered handlers provide data; the
 * scheduler owns attempts, budget reservations, state and artifact provenance.
 * No result can promote real Mod/game evidence through this infrastructure.
 */
export function createScheduler({ store, registry, maxConcurrency = 2, secrets = [], clock = Date.now } = {}) {
  if (!store?.withLease || !store?.write || !registry?.resolveTask || !integer(maxConcurrency, 1, 8)) throw fault('INVALID_SCHEDULER_CONFIG', 'A local store, registry and bounded concurrency are required.');
  const active = new Map();
  function check(value, maxBytes) { assertRunData(value, { secrets, ...(maxBytes ? { maxBytes } : {}) }); store.checkData(value, maxBytes ? { maxBytes } : {}); }
  function validateSnapshot(value) {
    check(value);
    if (!value || value.schemaVersion !== 1 || !RUN_STATES.has(value.status) || !Array.isArray(value.tasks) || !value.budget ||
        JSON.stringify(value.report) !== JSON.stringify(REPORT) || !integer(value.eventSequence, 0, 1000000)) throw fault('RUN_STATE_INVALID', 'Persisted scheduler state violates its contract.');
    const graph = validateTaskGraph(value.graph);
    if (JSON.stringify(graph) !== JSON.stringify(value.graph) || value.tasks.length !== graph.length || !Array.isArray(value.events) || value.events.length > LIMITS.events) throw fault('RUN_STATE_INVALID', 'Persisted task definitions or events are invalid.');
    const limits = budget({ maxModelCalls: value.budget.maxModelCalls, maxAttempts: value.budget.maxAttempts });
    let calls = 0, attempts = 0;
    for (let index = 0; index < graph.length; index++) {
      const definition = graph[index], task = value.tasks[index];
      if (!task || task.id !== definition.id || !TASK_STATES.has(task.status) || !Array.isArray(task.attempts) || !integer(task.attemptCount, 0, definition.retryPolicy.maxAttempts) || task.attempts.length !== task.attemptCount || !Array.isArray(task.blockers)) throw fault('RUN_STATE_INVALID', 'Persisted task state is invalid.');
      for (let i = 0; i < task.attempts.length; i++) {
        const attempt = task.attempts[i];
        if (attempt.number !== i + 1 || !['running', 'succeeded', 'failed', 'interrupted', 'cancelled'].includes(attempt.status) || typeof attempt.token !== 'string' || !integer(attempt.modelCallsReserved, 0, 2)) throw fault('RUN_STATE_INVALID', 'Persisted attempt metadata is invalid.');
        calls += attempt.modelCallsReserved; attempts++;
      }
      if (task.status === 'succeeded') {
        if (!task.result || task.attempts.at(-1)?.status !== 'succeeded' || task.result.artifact?.sha256 !== hash(task.result.data) ||
            task.result.artifact?.bytes !== Buffer.byteLength(JSON.stringify(task.result.data)) ||
            task.result.artifact?.id !== `${task.id}.${task.attemptCount}` ||
            task.result.artifact?.provenance?.taskId !== task.id || task.result.artifact?.provenance?.attempt !== task.attemptCount ||
            task.result.artifact?.provenance?.adapterId !== task.attempts.at(-1).adapter?.id ||
            task.result.artifact?.provenance?.adapterVersion !== task.attempts.at(-1).adapter?.version ||
            task.result.artifact?.provenance?.operation !== task.attempts.at(-1).adapter?.operation ||
            task.result.artifact?.scope !== task.attempts.at(-1).adapter?.evidenceScope ||
            !(definition.outputTypes.length ? definition.outputTypes : ['task.data']).includes(task.result.artifact?.type) ||
            !definition.dependsOn.every(id => value.tasks.find(item => item.id === id)?.status === 'succeeded')) throw fault('RUN_STATE_INVALID', 'Persisted task result or provenance is inconsistent.');
      } else if (task.result !== undefined) throw fault('RUN_STATE_INVALID', 'Only succeeded tasks may retain an accepted result.');
    }
    if (calls !== value.budget.modelCallsReserved || attempts !== value.budget.attemptsReserved || calls > limits.maxModelCalls || attempts > limits.maxAttempts) throw fault('RUN_STATE_INVALID', 'Persisted budget reservations are inconsistent.');
    if (value.status === 'succeeded' && !value.tasks.every(task => task.status === 'succeeded')) throw fault('RUN_STATE_INVALID', 'Succeeded runs require every dependency task to have succeeded.');
    return structuredClone(value);
  }
  function event(state, type, taskId, code) {
    state.eventSequence++;
    state.events.push({ seq: state.eventSequence, time: clock(), type, ...(taskId ? { taskId } : {}), ...(code ? { code } : {}) });
    if (state.events.length > LIMITS.events) state.events.splice(0, state.events.length - LIMITS.events);
    state.updatedAt = clock();
  }
  async function checkpoint(state, lease) { check(state); return store.write(state, { lease, expectedRevision: state.revision }); }
  function reconcile(state, includeCreated = false) {
    let changed = false;
    for (const task of state.tasks) if (task.status === 'running') {
      const attempt = task.attempts.at(-1); if (!attempt || attempt.status !== 'running') throw fault('RUN_STATE_INVALID', 'Running task has no running attempt.');
      attempt.status = 'interrupted'; attempt.endedAt = clock();
      attempt.error = { code: 'TASK_INTERRUPTED', message: 'The previous process stopped before committing a task result.' };
      task.status = 'interrupted'; task.blockers = ['EXPLICIT_REPLAY_REQUIRED']; event(state, 'task-interrupted', task.id); changed = true;
    }
    if (changed || state.status === 'running' || (includeCreated && state.status === 'created')) { state.status = 'interrupted'; event(state, 'run-recovered'); changed = true; }
    return changed;
  }
  function safeReplay(definition, binding, task) {
    return definition.retryPolicy.replaySafe && binding.manifest.execution.idempotent && binding.manifest.execution.sideEffects === 'none' &&
      binding.manifest.execution.modelCallsPerAttempt === 0 && task.attempts.every(attempt => attempt.modelCallsReserved === 0);
  }
  function invoke(definition, task, binding, state, runSignal) {
    const controller = new AbortController();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.min(definition.timeoutMs, binding.manifest.resourceLimits.timeoutMs));
    const signal = AbortSignal.any([controller.signal, runSignal, timeout.signal]);
    let onAbort;
    const abort = new Promise((_, reject) => {
      onAbort = () => reject(fault(timeout.signal.aborted && !runSignal.aborted ? 'TASK_TIMEOUT' : 'TASK_CANCELLED', 'Task observation ended.'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    const attempt = structuredClone(task.attempts.at(-1)), attemptToken = attempt.token;
    Object.freeze(attempt.adapter); Object.freeze(attempt);
    const input = { context: structuredClone(state.context), dependencies: Object.fromEntries(definition.dependsOn.map(id => [id, structuredClone(state.tasks.find(item => item.id === id).result)])) };
    const promise = (async () => {
      try {
        check(input, binding.manifest.resourceLimits.maxInputBytes);
        if (signal.aborted) throw fault('TASK_CANCELLED', 'Task was cancelled.');
        const result = await Promise.race([Promise.resolve().then(() => binding.handler({ task: structuredClone(definition), input, signal, attempt })), abort]);
        if (signal.aborted) throw fault(timeout.signal.aborted ? 'TASK_TIMEOUT' : 'TASK_CANCELLED', 'Task observation ended.');
        if (!result || typeof result !== 'object' || Array.isArray(result) || ![Object.prototype, null].includes(Object.getPrototypeOf(result)) ||
            Reflect.ownKeys(result).length !== 1 || !Object.hasOwn(result, 'data') || !Object.hasOwn(Object.getOwnPropertyDescriptor(result, 'data'), 'value')) throw fault('INVALID_TASK_RESULT', 'Handlers may return only structured data.');
        check(result.data, Math.min(LIMITS.resultBytes, binding.manifest.resourceLimits.maxOutputBytes));
        return { id: task.id, token: attemptToken, binding, data: structuredClone(result.data) };
      } catch (cause) { return { id: task.id, token: attemptToken, binding, error: safeFailure(cause, runSignal.aborted) }; }
      finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
    })();
    return { promise, controller };
  }
  function deriveStatus(state) {
    if (state.tasks.every(task => task.status === 'succeeded')) return 'succeeded';
    if (state.tasks.some(task => task.status === 'interrupted')) return 'interrupted';
    if (state.tasks.some(task => task.status === 'failed')) return 'failed';
    return 'blocked';
  }
  async function execute(id, { signal: parentSignal, allowReplay = false, budget: increase, resume = false } = {}) {
    if (active.has(id)) throw fault('RUN_BUSY', 'This scheduler is already observing the run.');
    if (typeof allowReplay !== 'boolean' || (parentSignal !== undefined && !(parentSignal instanceof AbortSignal))) throw fault('INVALID_RESUME_OPTIONS', 'Invalid scheduler execution options.');
    const controller = new AbortController(), signal = parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const promise = store.withLease(id, async lease => {
      let state = validateSnapshot(await store.read(id));
      // A delayed initial dispatch must not undo a cancellation or implicitly
      // restart a settled/recovered run. Only an explicit resume may do that.
      if (!resume && state.status !== 'created') return state;
      reconcile(state);
      if (increase !== undefined) {
        if (!resume || !increase || typeof increase !== 'object' || Object.keys(increase).some(key => key !== 'maxModelCalls') || !integer(increase.maxModelCalls, state.budget.maxModelCalls, LIMITS.maxModelCalls)) throw fault('INVALID_RUN_BUDGET', 'Resume can only increase the total model-call budget.');
        state.budget.maxModelCalls = increase.maxModelCalls;
      }
      if (state.status === 'succeeded') return state;
      for (const task of state.tasks) {
        if (task.status === 'succeeded') continue;
        if (task.attemptCount === 0) { task.status = 'pending'; task.blockers = []; continue; }
        const definition = state.graph.find(item => item.id === task.id), binding = registry.resolveTask(definition, state.context);
        if (binding.blocked) { task.status = 'blocked'; task.blockers = [binding.code]; continue; }
        if (task.attemptCount >= definition.retryPolicy.maxAttempts) continue;
        const automaticReplay = safeReplay(definition, binding, task) && (task.status !== 'failed' || definition.retryPolicy.retryableCodes.includes(task.attempts.at(-1)?.error?.code));
        if (automaticReplay || (resume && allowReplay)) { task.status = 'pending'; task.blockers = []; }
        else if (['interrupted', 'cancelled', 'blocked', 'failed'].includes(task.status)) task.blockers = ['EXPLICIT_REPLAY_REQUIRED'];
      }
      state.status = 'running'; event(state, resume ? 'run-resumed' : 'run-started'); state = await checkpoint(state, lease);
      const running = new Map();
      try {
        while (true) {
          if (signal.aborted) {
            for (const operation of running.values()) operation.controller.abort();
            for (const task of state.tasks) if (task.status !== 'succeeded' && task.status !== 'failed') {
              if (task.status === 'running') { const attempt = task.attempts.at(-1); attempt.status = 'cancelled'; attempt.endedAt = clock(); attempt.error = safeFailure(null, true); }
              task.status = 'cancelled'; task.blockers = ['RUN_CANCELLED'];
            }
            state.status = 'cancelled'; event(state, 'run-cancelled'); state = await checkpoint(state, lease); return state;
          }
          for (const definition of state.graph) {
            if (running.size >= maxConcurrency) break;
            const task = state.tasks.find(item => item.id === definition.id);
            if (task.status !== 'pending') continue;
            if (!definition.dependsOn.every(id => state.tasks.find(item => item.id === id).status === 'succeeded')) continue;
            const binding = registry.resolveTask(definition, state.context);
            if (binding.blocked) { task.status = 'blocked'; task.blockers = [binding.code]; event(state, 'task-blocked', task.id, binding.code); continue; }
            const calls = binding.manifest.execution.modelCallsPerAttempt;
            if (task.attemptCount >= definition.retryPolicy.maxAttempts || state.budget.attemptsReserved >= state.budget.maxAttempts || state.budget.modelCallsReserved + calls > state.budget.maxModelCalls) {
              task.status = 'blocked'; task.blockers = ['RUN_BUDGET_EXHAUSTED']; event(state, 'task-blocked', task.id, 'RUN_BUDGET_EXHAUSTED'); continue;
            }
            task.status = 'running'; task.blockers = []; task.attemptCount++;
            const attempt = { number: task.attemptCount, token: randomUUID(), status: 'running', startedAt: clock(),
              adapter: { id: binding.manifest.id, version: binding.manifest.version, operation: binding.operation, evidenceScope: binding.manifest.evidenceScope }, modelCallsReserved: calls };
            task.attempts.push(attempt); state.budget.modelCallsReserved += calls; state.budget.attemptsReserved++;
            event(state, 'task-started', task.id); state = await checkpoint(state, lease);
            const latestTask = state.tasks.find(item => item.id === task.id);
            running.set(task.id, invoke(definition, latestTask, binding, state, signal));
          }
          if (!running.size) break;
          const outcome = await Promise.race([...running.values()].map(value => value.promise)); running.delete(outcome.id);
          const task = state.tasks.find(item => item.id === outcome.id), attempt = task.attempts.at(-1);
          if (attempt.token !== outcome.token || task.status !== 'running') continue;
          if (signal.aborted) continue;
          attempt.endedAt = clock();
          if (outcome.error) {
            attempt.status = 'failed'; attempt.error = outcome.error; task.status = 'failed';
            const definition = state.graph.find(item => item.id === task.id);
            if (task.attemptCount < definition.retryPolicy.maxAttempts && definition.retryPolicy.retryableCodes.includes(outcome.error.code) && safeReplay(definition, outcome.binding, task)) task.status = 'pending';
            event(state, 'task-failed', task.id, outcome.error.code);
          } else {
            attempt.status = 'succeeded'; task.status = 'succeeded';
            const definition = state.graph.find(item => item.id === task.id), manifest = outcome.binding.manifest;
            task.result = { data: outcome.data, artifact: { id: `${task.id}.${task.attemptCount}`, type: definition.outputTypes[0] || 'task.data', scope: manifest.evidenceScope,
              sha256: hash(outcome.data), bytes: Buffer.byteLength(JSON.stringify(outcome.data)),
              provenance: { adapterId: manifest.id, adapterVersion: manifest.version, operation: outcome.binding.operation, taskId: task.id, attempt: task.attemptCount } } };
            event(state, 'task-succeeded', task.id);
          }
          state = await checkpoint(state, lease);
        }
        for (const task of state.tasks) if (task.status === 'pending') { task.status = 'blocked'; task.blockers = ['DEPENDENCY_NOT_SUCCEEDED']; }
        state.status = deriveStatus(state); event(state, 'run-settled'); return checkpoint(state, lease);
      } finally { for (const operation of running.values()) operation.controller.abort(); }
    });
    active.set(id, { controller, promise });
    try { return structuredClone(await promise); } finally { active.delete(id); }
  }
  return {
    async createRun(graph, { context = {}, budget: rawBudget } = {}) {
      const definitions = validateTaskGraph(graph); check(context, LIMITS.contextBytes);
      const now = clock(), state = { schemaVersion: 1, id: randomUUID(), revision: 0, createdAt: now, updatedAt: now, status: 'created',
        context: structuredClone(context), graph: definitions, tasks: definitions.map(task => ({ id: task.id, status: 'pending', attemptCount: 0, attempts: [], blockers: [] })),
        budget: budget(rawBudget), events: [], eventSequence: 0, report: { ...REPORT } };
      event(state, 'run-created'); return store.create(state);
    },
    async get(id) { return validateSnapshot(await store.read(id)); },
    async list() { const records = await store.list(); return records.map(validateSnapshot); },
    run: (id, options = {}) => execute(id, options),
    resume: (id, options = {}) => execute(id, { ...options, resume: true }),
    async recover(id) {
      return store.withLease(id, async lease => { let state = validateSnapshot(await store.read(id)); if (reconcile(state, true)) state = await checkpoint(state, lease); return state; });
    },
    async cancel(id) {
      const running = active.get(id); if (running) { running.controller.abort(); return running.promise; }
      return store.withLease(id, async lease => {
        let state = validateSnapshot(await store.read(id)); if (state.status === 'succeeded') return state;
        reconcile(state); for (const task of state.tasks) if (task.status !== 'succeeded' && task.status !== 'failed') { task.status = 'cancelled'; task.blockers = ['RUN_CANCELLED']; }
        state.status = 'cancelled'; event(state, 'run-cancelled'); return checkpoint(state, lease);
      });
    },
    async close() { const current = [...active.values()]; for (const value of current) value.controller.abort(); await Promise.allSettled(current.map(value => value.promise)); },
    get activeCount() { return active.size; },
  };
}
