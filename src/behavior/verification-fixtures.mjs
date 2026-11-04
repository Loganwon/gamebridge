// Project-owned compiler fixtures. These are neither game adapters nor playable Mods.
const literal = value => ({ op: 'literal', value });
const variable = id => ({ op: 'variable', id });
const field = id => ({ op: 'event', id });
const expression = (op, ...args) => ({ op, args });
const update = (variable, value) => ({ variable, value });
const event = (id, fields = []) => ({ id, fields });
const transition = (id, from, event, to, priority, requirementIds, guard, updates = []) => ({ id, from, event, to, priority, requirementIds, guard, updates });
const result = (state, variables, transitionId = null) => ({ state, variables, transitionId });
const step = (eventId, fields, expected, error = false) => ({ eventId, fields, expected, ...(error ? { error: true } : {}) });

function timedSpec() {
  return { schemaVersion: 1, id: 'timed-interlock', requirementIds: ['timing', 'interlock'], initialState: 'ready', states: ['ready', 'active'],
    variables: [{ id: 'remaining', initial: 0, min: 0, max: 1002 }, { id: 'operations', initial: 0, min: 0, max: 100 }],
    events: [event('begin', [{ id: 'duration', min: 1, max: 1000 }]), event('activate'), event('tick', [{ id: 'dt', min: 1, max: 1000 }]), event('cancel')],
    transitions: [
      transition('begin-active', 'ready', 'begin', 'active', 0, ['timing', 'interlock'], literal(true), [update('remaining', field('duration'))]),
      transition('activate-ready', 'ready', 'activate', 'ready', 0, ['interlock'], literal(true), [update('operations', expression('add', variable('operations'), literal(1)))]),
      transition('finish-active', 'active', 'tick', 'ready', 0, ['timing'], expression('gte', field('dt'), variable('remaining')), [update('remaining', literal(0))]),
      transition('countdown-active', 'active', 'tick', 'active', 1, ['timing'], expression('lt', field('dt'), variable('remaining')), [update('remaining', expression('sub', variable('remaining'), field('dt')))]),
      transition('cancel-active', 'active', 'cancel', 'ready', 0, ['interlock'], literal(true), [update('remaining', literal(0))]),
    ], unresolved: [] };
}
function resourceSpec() {
  return { schemaVersion: 1, id: 'resource-reservation', requirementIds: ['resource', 'atomic'], initialState: 'ready', states: ['ready', 'reserved'],
    variables: [{ id: 'available', initial: 4, min: 0, max: 8 }, { id: 'reserved', initial: 0, min: 0, max: 8 }, { id: 'accepted', initial: 0, min: 0, max: 3 }],
    events: [event('reserve', [{ id: 'units', min: 1, max: 8 }]), event('commit'), event('rollback')],
    transitions: [
      transition('reserve-budget', 'ready', 'reserve', 'reserved', 0, ['resource'], expression('gte', variable('available'), field('units')), [update('available', expression('sub', variable('available'), field('units'))), update('reserved', field('units'))]),
      transition('commit-reserved', 'reserved', 'commit', 'ready', 0, ['resource', 'atomic'], literal(true), [update('reserved', literal(0)), update('accepted', expression('add', variable('accepted'), variable('reserved')))]),
      transition('rollback-reserved', 'reserved', 'rollback', 'ready', 0, ['resource', 'atomic'], literal(true), [update('available', expression('add', variable('available'), variable('reserved'))), update('reserved', literal(0))]),
    ], unresolved: [] };
}
function sequenceSpec() {
  const spec = { schemaVersion: 1, id: 'sequence-window', requirementIds: ['sequence', 'window', 'cancel'], initialState: 'idle', states: ['idle', 'primed', 'chained'],
    variables: [{ id: 'stage', initial: 0, min: 0, max: 2 }, { id: 'window', initial: 0, min: 0, max: 100 }, { id: 'accepted', initial: 0, min: 0, max: 100 }],
    events: [event('prime', [{ id: 'duration', min: 1, max: 100 }]), event('advance'), event('tick', [{ id: 'dt', min: 1, max: 100 }]), event('cancel')],
    transitions: [
      transition('prime-sequence', 'idle', 'prime', 'primed', 0, ['sequence', 'window'], literal(true), [update('stage', literal(1)), update('window', field('duration'))]),
      transition('advance-first', 'primed', 'advance', 'chained', 0, ['sequence'], expression('gt', variable('window'), literal(0)), [update('stage', literal(2)), update('accepted', expression('add', variable('accepted'), literal(1)))]),
      transition('advance-second', 'chained', 'advance', 'idle', 0, ['sequence'], expression('gt', variable('window'), literal(0)), [update('stage', literal(0)), update('window', literal(0)), update('accepted', expression('add', variable('accepted'), literal(2)))]),
    ], unresolved: [] };
  for (const state of ['primed', 'chained']) {
    spec.transitions.push(transition('expire-' + state, state, 'tick', 'idle', 0, ['window'], expression('gte', field('dt'), variable('window')), [update('stage', literal(0)), update('window', literal(0))]));
    spec.transitions.push(transition('reduce-' + state, state, 'tick', state, 1, ['window'], expression('lt', field('dt'), variable('window')), [update('window', expression('sub', variable('window'), field('dt')))]));
    spec.transitions.push(transition('cancel-' + state, state, 'cancel', 'idle', 0, ['cancel'], literal(true), [update('stage', literal(0)), update('window', literal(0))]));
  }
  return spec;
}

/** Four independent, fresh machines, with explicit expected values and errors. */
export function createBehaviorVerificationCases() {
  const timed = timedSpec(), resource = resourceSpec(), sequence = sequenceSpec();
  const modified = timedSpec(); modified.id = 'timed-pause-resume'; modified.requirementIds.push('pause-resume'); modified.states.push('paused'); modified.events.push(event('resume'));
  const cancel = modified.transitions.find(item => item.id === 'cancel-active'); cancel.to = 'paused'; cancel.updates = []; cancel.requirementIds.push('pause-resume');
  modified.transitions.push(transition('resume-paused', 'paused', 'resume', 'active', 0, ['pause-resume'], literal(true)));
  return [
    { id: 'timed-interlock', spec: timed, steps: [
      step('activate', {}, result('ready', { remaining: 0, operations: 1 }, 'activate-ready')),
      step('begin', { duration: 5 }, result('active', { remaining: 5, operations: 1 }, 'begin-active')),
      step('activate', {}, result('active', { remaining: 5, operations: 1 })),
      step('tick', { dt: 2 }, result('active', { remaining: 3, operations: 1 }, 'countdown-active')),
      step('tick', { dt: 3 }, result('ready', { remaining: 0, operations: 1 }, 'finish-active')),
      step('activate', {}, result('ready', { remaining: 0, operations: 2 }, 'activate-ready')),
      step('begin', {}, result('ready', { remaining: 0, operations: 2 }), true),
      step('tick', { dt: 0 }, result('ready', { remaining: 0, operations: 2 }), true),
      step('unknown', {}, result('ready', { remaining: 0, operations: 2 }), true),
    ] },
    { id: 'resource-reservation', spec: resource, steps: [
      step('reserve', { units: 3 }, result('reserved', { available: 1, reserved: 3, accepted: 0 }, 'reserve-budget')),
      step('reserve', { units: 1 }, result('reserved', { available: 1, reserved: 3, accepted: 0 })),
      step('rollback', {}, result('ready', { available: 4, reserved: 0, accepted: 0 }, 'rollback-reserved')),
      step('reserve', { units: 5 }, result('ready', { available: 4, reserved: 0, accepted: 0 })),
      step('reserve', { units: 2 }, result('reserved', { available: 2, reserved: 2, accepted: 0 }, 'reserve-budget')),
      step('commit', {}, result('ready', { available: 2, reserved: 0, accepted: 2 }, 'commit-reserved')),
      step('reserve', { units: 2 }, result('reserved', { available: 0, reserved: 2, accepted: 2 }, 'reserve-budget')),
      step('commit', {}, result('reserved', { available: 0, reserved: 2, accepted: 2 }), true),
      step('rollback', {}, result('ready', { available: 2, reserved: 0, accepted: 2 }, 'rollback-reserved')),
      step('reserve', { units: 0 }, result('ready', { available: 2, reserved: 0, accepted: 2 }), true),
      step('reserve', { units: 1, unexpected: 0 }, result('ready', { available: 2, reserved: 0, accepted: 2 }), true),
    ] },
    { id: 'sequence-window', spec: sequence, steps: [
      step('prime', { duration: 10 }, result('primed', { stage: 1, window: 10, accepted: 0 }, 'prime-sequence')),
      step('tick', { dt: 3 }, result('primed', { stage: 1, window: 7, accepted: 0 }, 'reduce-primed')),
      step('advance', {}, result('chained', { stage: 2, window: 7, accepted: 1 }, 'advance-first')),
      step('cancel', {}, result('idle', { stage: 0, window: 0, accepted: 1 }, 'cancel-chained')),
      step('advance', {}, result('idle', { stage: 0, window: 0, accepted: 1 })),
      step('prime', { duration: 5 }, result('primed', { stage: 1, window: 5, accepted: 1 }, 'prime-sequence')),
      step('tick', { dt: 5 }, result('idle', { stage: 0, window: 0, accepted: 1 }, 'expire-primed')),
      step('advance', {}, result('idle', { stage: 0, window: 0, accepted: 1 })),
      step('prime', { duration: 4 }, result('primed', { stage: 1, window: 4, accepted: 1 }, 'prime-sequence')),
      step('advance', {}, result('chained', { stage: 2, window: 4, accepted: 2 }, 'advance-first')),
      step('advance', {}, result('idle', { stage: 0, window: 0, accepted: 4 }, 'advance-second')),
      step('tick', { dt: -1 }, result('idle', { stage: 0, window: 0, accepted: 4 }), true),
    ] },
    { id: 'timed-pause-resume', spec: modified, steps: [
      step('begin', { duration: 5 }, result('active', { remaining: 5, operations: 0 }, 'begin-active')),
      step('tick', { dt: 2 }, result('active', { remaining: 3, operations: 0 }, 'countdown-active')),
      step('cancel', {}, result('paused', { remaining: 3, operations: 0 }, 'cancel-active')),
      step('tick', { dt: 3 }, result('paused', { remaining: 3, operations: 0 })),
      step('activate', {}, result('paused', { remaining: 3, operations: 0 })),
      step('resume', {}, result('active', { remaining: 3, operations: 0 }, 'resume-paused')),
      step('tick', { dt: 3 }, result('ready', { remaining: 0, operations: 0 }, 'finish-active')),
      step('activate', {}, result('ready', { remaining: 0, operations: 1 }, 'activate-ready')),
    ] },
  ];
}
