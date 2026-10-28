import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The browser half is a classic bundle: it registers a factory on
 * `window.__ModuleLoader__` and receives `react` through `require`. Loading it
 * here with a stub loader is what proves the module face — id, exports,
 * declared service dependencies — before a browser ever sees it.
 */
globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      (globalThis.__notifierRegistrations ??= new Map()).set(entry.id, entry);
    },
  },
};
await import('../lib/client.js');

const registration = globalThis.__notifierRegistrations.get('dsh-approval-notifier');

/** A React stub: enough for module evaluation and one shallow render. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
};

const client = registration.factory((specifier) => {
  if (specifier === 'react') return fakeReact;
  throw new Error(`unexpected require(${specifier})`);
});
const internals = client.__internals;

/** A store on a controllable clock. */
function makeStore(options = {}) {
  let current = 1_000_000;
  const store = internals.createNoticeStore({
    now: () => current,
    maxCards: options.maxCards ?? 4,
    ttlMs: options.ttlMs ?? 1000,
  });
  return { store, advance: (ms) => { current += ms; } };
}

/** Timers that never fire on their own, so polling stays deterministic. */
function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const handle = { fn, ms };
      scheduled.push(handle);
      return handle;
    },
    clearTimeout(handle) {
      const at = scheduled.indexOf(handle);
      if (at >= 0) scheduled.splice(at, 1);
    },
  };
}

/** A fetch stand-in: client-state answers immediately, events follow a script. */
function fakeFetch(events) {
  const calls = [];
  const impl = (url, options) => {
    calls.push({ url, options });
    if (url.includes('/client-state')) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    }
    const body = events.length > 0 ? events.shift() : { ok: true, cursor: 0, events: [] };
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
  impl.calls = calls;
  return impl;
}

/**
 * The client-side services the channel uses, shaped like the real ones.
 *
 * `sessions.list` is the Session **catalog** (`{ ids, byId }`) with no "current
 * session" field at all — the page's view rides `retainedBy.mainView` — and
 * navigation belongs to `uiWorkspace.openSession`. The snapshot below still
 * carries the legacy `current` field so anything reading it reads a wrong value
 * and is caught, rather than being quietly served by the fixture.
 */
function fakeContext(options = {}) {
  const opened = [];
  const listeners = new Set();
  let byId = {};
  const publish = () => {
    listeners.forEach((listener) => listener());
  };
  const setCurrent = (id) => {
    byId = id === '' ? {} : { [id]: { id, retainedBy: { mainView: 1 } } };
    publish();
  };
  setCurrent(options.current ?? 'session-a');
  const uiWorkspace = {
    openSession(id) {
      if (options.unknown === id) throw new Error(`uiWorkspace: unknown session ${id}`);
      opened.push(id);
      setCurrent(id);
    },
  };
  return {
    opened,
    uiWorkspace,
    setCurrent,
    /** List one more catalog row that is *not* the view, ahead of the view row. */
    listSession(id) {
      byId = { [id]: { id, retainedBy: {} }, ...byId };
      publish();
    },
    get(name) {
      if (name === 'uiWorkspace') return uiWorkspace;
      if (name === 'uiSession') return options.uiSession;
      return undefined;
    },
    sessions: {
      list: {
        getSnapshot: () => ({ ids: Object.keys(byId), byId, phase: 'ready', current: 'session-legacy' }),
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  };
}

/** A document / window pair reporting "in front". */
function fakeDom(state = {}) {
  const listeners = new Map();
  return {
    state,
    document: {
      visibilityState: state.visibility ?? 'visible',
      hasFocus: () => state.focused !== false,
      addEventListener(name, handler) {
        const list = listeners.get(name) ?? [];
        list.push(handler);
        listeners.set(name, list);
      },
      removeEventListener(name, handler) {
        const list = listeners.get(name) ?? [];
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      },
    },
    window: {
      addEventListener(name, handler) {
        const list = listeners.get(name) ?? [];
        list.push(handler);
        listeners.set(name, list);
      },
      removeEventListener(name, handler) {
        const list = listeners.get(name) ?? [];
        const at = list.indexOf(handler);
        if (at >= 0) list.splice(at, 1);
      },
    },
    listeners,
  };
}

/** Let queued promise callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the bundle declares the service dependencies it looks up', () => {
  assert.equal(registration.id, 'dsh-approval-notifier');
  assert.deepEqual(client.inject, ['slots', 'sessions']);
  assert.equal(typeof client.apply, 'function');
  assert.equal(typeof client.NoticeStack, 'function');
});

test('the card store keeps the newest cards and drops the oldest', () => {
  const { store } = makeStore({ maxCards: 2 });
  store.add({ key: 'k1', kind: 'approval', sessionId: 'a', title: 'T1', lines: ['T1'] });
  store.add({ key: 'k2', kind: 'approval', sessionId: 'b', title: 'T2', lines: ['T2'] });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2', 'k1']);
  store.add({ key: 'k1', kind: 'approval', sessionId: 'a', title: 'T1 new', lines: [] });
  assert.deepEqual(store.getSnapshot().map((card) => card.title), ['T2', 'T1 new'], 'an update keeps its place');
  store.add({ key: 'k3', kind: 'approval', sessionId: 'c', title: 'T3', lines: [] });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k3', 'k2'], 'the oldest card is dropped');
  assert.equal(store.drop('k3'), true);
  assert.equal(store.drop('nothing'), false);
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2']);
  assert.equal(store.dropSession('b'), true);
  assert.equal(store.dropSession(''), false);
  assert.equal(store.size(), 0);
});

test('the card store forgets cards nobody acted on', () => {
  const { store, advance } = makeStore({ ttlMs: 1000 });
  store.add({ key: 'k1', kind: 'approval', sessionId: 'a', title: 'T1', lines: [] });
  advance(900);
  assert.equal(store.prune(), false);
  advance(200);
  assert.equal(store.prune(), true);
  assert.equal(store.size(), 0);
});

test('the store withholds cards for the session on screen, and gives them back', () => {
  const { store } = makeStore();
  store.add({ key: 'k1', kind: 'approval', sessionId: 'a', title: 'T1', lines: [] });
  store.add({ key: 'k2', kind: 'question', sessionId: 'b', title: 'T2', lines: [] });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2', 'k1']);

  assert.equal(store.setView({ sessionId: 'a', foreground: true }), true);
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2'], 'the prompt on screen is not duplicated');
  assert.equal(store.size(), 1, 'size() counts what would be drawn');

  store.setView({ sessionId: 'a', foreground: false });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2', 'k1'], 'a window that is behind keeps both');

  store.setView({ sessionId: 'b', foreground: true });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k1']);

  assert.equal(store.setView({ sessionId: 'b', foreground: true }), false, 'an unchanged page state is not a change');
  assert.equal(store.setView(null), true, 'so is a page that reports nothing');
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2', 'k1']);
  assert.equal(store.getSnapshot(), store.getSnapshot(), 'the drawn slice is cached between changes');
});

test('the card stack keeps out of the composer and stays click-through', () => {
  const style = internals.STACK_STYLE;
  assert.equal(style.position, 'fixed');
  assert.equal(style.pointerEvents, 'none', 'the container never takes the pointer; only the cards do');
  assert.equal(style.bottom, undefined, 'the bottom of the frame is where the composer and its approval buttons live');
  assert.equal(style.right, undefined);
  assert.match(String(style.top), /--dsh-windows-titlebar-height/, 'the stack clears the Windows titlebar drag strip');
  assert.equal(internals.MAX_CARDS, 3, 'the stack stays short enough to read past');
});

test('the stack renders one card per drawn notice, and nothing for the session on screen', () => {
  const { store } = makeStore();
  const props = { store, onOpen() {}, onDismiss() {} };
  assert.equal(client.NoticeStack(props), null, 'an empty store draws no surface at all');

  store.add({ key: 'k1', kind: 'approval', sessionId: 'session-a', title: 'T1', lines: ['T1', 'body'] });
  store.add({ key: 'k2', kind: 'question', sessionId: 'session-b', title: 'T2', lines: ['T2'] });
  const tree = client.NoticeStack(props);
  assert.equal(tree.type, 'div');
  assert.equal(tree.props.style, internals.STACK_STYLE);
  assert.equal(tree.props['data-dsh-approval-notifier'], 'cards');
  // The stack also injects its stylesheet, so select the cards by type rather
  // than by position.
  const cardKeys = (node) => node.props.children
    .filter((child) => child !== null && child.type === client.NoticeCard)
    .map((card) => card.props.card.key);
  assert.deepEqual(cardKeys(tree), ['k2', 'k1']);

  store.setView({ sessionId: 'session-b', foreground: true });
  const after = client.NoticeStack(props);
  assert.deepEqual(cardKeys(after), ['k1'], 'the session on screen is gone');
});

test('reduceEvent shows, retires, and navigates', () => {
  const { store } = makeStore();
  const navigated = [];
  const view = { navigate: (id) => navigated.push(id) };

  assert.equal(internals.reduceEvent({ kind: 'approval', key: 'k1', sessionId: 'a', title: 'T1', lines: ['T1'] }, store, view), true);
  assert.equal(store.size(), 1);
  assert.equal(internals.reduceEvent({ kind: 'clear', key: 'k1' }, store, view), true);
  assert.equal(store.size(), 0);

  store.add({ key: 'k9', kind: 'approval', sessionId: 'a', title: 'T9', lines: [] });
  assert.equal(internals.reduceEvent({ kind: 'navigate', sessionId: 'a' }, store, view), true);
  assert.deepEqual(navigated, ['a']);
  assert.equal(store.size(), 0, 'jumping to a session retires its card');
  assert.equal(internals.reduceEvent({ kind: 'navigate', sessionId: '' }, store, view), false);
  assert.equal(internals.reduceEvent(null, store, view), false);
  assert.equal(internals.reduceEvent('nope', store, view), false);
  assert.equal(internals.reduceEvent({ kind: 'approval' }, store, view), false, 'a notice without a key is dropped');
});

test('a decide event answers the pending approval the card is showing', () => {
  const { store } = makeStore();
  const answers = [];
  const pending = { kind: 'approval', callId: 'call-1', answer: (outcome) => answers.push(outcome) };
  const ctx = {
    get(name) {
      if (name !== 'uiSession') return undefined;
      return { sessionStatus: { getSnapshot: () => new Map([['session-a', { pendingInteraction: pending }]]) } };
    },
  };
  const channel = internals.createChannel({ ctx, store, fetch: () => new Promise(() => {}) });
  const view = { navigate: () => {}, decide: channel.decide };
  const event = { kind: 'decide', key: 'approval|req-1', sessionId: 'session-a', callId: 'call-1' };

  store.add({ key: 'approval|req-1', kind: 'approval', sessionId: 'session-a', title: 'T', lines: [] });
  assert.equal(internals.reduceEvent({ ...event, decision: 'allowed-once' }, store, view), true);
  assert.deepEqual(answers, ['allowed-once'], 'the toast button answers exactly like the card');
  assert.equal(store.size(), 0, 'and the card goes with it');

  answers.length = 0;
  assert.equal(internals.reduceEvent({ ...event, callId: 'call-9', decision: 'allowed-once' }, store, view), false);
  assert.deepEqual(answers, [], 'a mismatched call id is refused');

  pending.kind = 'question';
  assert.equal(internals.reduceEvent(event, store, view), false, 'a question card is never answered this way');
  assert.deepEqual(answers, []);
});

test('a decide event with no uiSession or no pending approval is a no-op', () => {
  const { store } = makeStore();
  const channel = internals.createChannel({ ctx: { get: () => undefined }, store, fetch: () => new Promise(() => {}) });
  const view = { navigate: () => {}, decide: channel.decide };
  assert.equal(internals.reduceEvent({ kind: 'decide', key: 'k', sessionId: 's', decision: 'rejected' }, store, view), false);
  assert.equal(internals.reduceEvent({ kind: 'decide', key: 'k', decision: 'rejected' }, store, view), false);
  assert.equal(store.size(), 0);
});

test('the page reports the session its main view shows, never the removed current field', async () => {
  const { store } = makeStore();
  const ctx = fakeContext({ current: 'session-a' });
  ctx.listSession('session-z');
  const dom = fakeDom();
  const timers = fakeTimers();
  const fetchImpl = fakeFetch([]);
  const channel = internals.createChannel({
    ctx,
    store,
    fetch: fetchImpl,
    document: dom.document,
    window: dom.window,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    clientId: 'page-6',
  });
  channel.start();
  await settle();

  const reported = () => JSON.parse(fetchImpl.calls.filter((call) => call.url.includes('/client-state')).at(-1).options.body);
  assert.equal(reported().sessionId, 'session-a', 'the row retained by mainView is the session on screen');
  assert.notEqual(reported().sessionId, 'session-legacy', 'SessionListState.current no longer exists and must not be read');
  assert.notEqual(reported().sessionId, 'session-z', 'a listed row is not the session being viewed');

  store.add({ key: 'k1', kind: 'approval', sessionId: 'session-a', title: 'T1', lines: [] });
  assert.equal(store.size(), 0);
  store.add({ key: 'k2', kind: 'approval', sessionId: 'session-z', title: 'T2', lines: [] });
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['k2']);
  channel.stop();
});

test('the channel reports what the page shows, then streams notices into cards', async () => {
  const { store } = makeStore();
  const ctx = fakeContext({ current: 'session-a' });
  const dom = fakeDom();
  const timers = fakeTimers();
  const events = [
    { ok: true, cursor: 7, events: [
      { seq: 6, kind: 'approval', key: 'approval|r1', sessionId: 'session-b', title: '需要你确认：pwsh', lines: ['需要你确认：pwsh', '写文件'] },
      { seq: 7, kind: 'clear', key: 'approval|r9' },
    ] },
  ];
  const fetchImpl = fakeFetch(events);
  const channel = internals.createChannel({
    ctx,
    store,
    fetch: fetchImpl,
    document: dom.document,
    window: dom.window,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    clientId: 'page-1',
  });

  channel.start();
  await settle();
  const state = fetchImpl.calls.find((call) => call.url.includes('/client-state'));
  assert.ok(state, 'the page announced itself on start');
  assert.deepEqual(JSON.parse(state.options.body), { clientId: 'page-1', sessionId: 'session-a', visible: true });
  const polls = fetchImpl.calls.filter((call) => call.url.includes('/events')).map((call) => call.url);
  assert.match(polls[0], /\/events\?cursor=0&client=page-1&wait=25$/);
  assert.match(polls.at(-1), /\/events\?cursor=7&client=page-1&wait=25$/, 'the cursor follows the stream');

  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['approval|r1']);
  assert.equal(store.getSnapshot()[0].sessionId, 'session-b');
  assert.equal(channel.cursor(), 7);

  // A selection change is reported, and the card for the session you are now
  // looking at stops being drawn — it is held back, not thrown away.
  ctx.setCurrent('session-b');
  await settle();
  assert.equal(store.size(), 0);
  const latest = fetchImpl.calls.filter((call) => call.url.includes('/client-state')).at(-1);
  assert.equal(JSON.parse(latest.options.body).sessionId, 'session-b');

  // Leaving that session while its prompt is still unanswered brings it back.
  ctx.setCurrent('session-a');
  await settle();
  assert.deepEqual(store.getSnapshot().map((card) => card.key), ['approval|r1']);
  channel.stop();
  assert.equal(timers.scheduled.length, 0, 'stopping clears the heartbeat and the poll');
});

test('a toast click opens another session, and the prompt left behind keeps its card', async () => {
  const { store } = makeStore();
  const ctx = fakeContext({ current: 'session-a' });
  const dom = fakeDom();
  const timers = fakeTimers();
  const fetchImpl = fakeFetch([
    { ok: true, cursor: 3, events: [
      { seq: 1, kind: 'approval', key: 'approval|r2', sessionId: 'session-a', title: 'on screen', lines: [] },
      { seq: 2, kind: 'navigate', sessionId: 'session-c' },
    ] },
  ]);
  const channel = internals.createChannel({
    ctx,
    store,
    fetch: fetchImpl,
    document: dom.document,
    window: dom.window,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    clientId: 'page-2',
  });
  channel.start();
  await settle();

  assert.deepEqual(ctx.opened, ['session-c'], 'the toast click switched the page');
  assert.deepEqual(
    store.getSnapshot().map((card) => card.sessionId),
    ['session-a'],
    'the still-unanswered prompt in the session the page just left is what the card points at',
  );
  assert.equal(channel.cursor(), 3);
  const polls = fetchImpl.calls.filter((call) => call.url.includes('/events')).map((call) => call.url);
  assert.match(polls[0], /cursor=0/, 'the first poll asks for everything');
  assert.match(polls[1], /cursor=3/, 'the next poll resumes where the stream left off');
  channel.stop();
});

test('a hidden window still polls, and an unknown session is contained', async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const { store } = makeStore();
    const ctx = fakeContext({ current: 'session-a', unknown: 'session-gone' });
    const dom = fakeDom({ visibility: 'hidden', focused: false });
    const timers = fakeTimers();
    const fetchImpl = fakeFetch([
      { ok: true, cursor: 1, events: [{ seq: 1, kind: 'navigate', sessionId: 'session-gone' }] },
    ]);
    const channel = internals.createChannel({
      ctx,
      store,
      fetch: fetchImpl,
      document: dom.document,
      window: dom.window,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
      clientId: 'page-3',
    });
    channel.start();
    await settle();

    const reported = JSON.parse(fetchImpl.calls.find((call) => call.url.includes('/client-state')).options.body);
    assert.equal(reported.visible, false, 'a hidden page says so, so a toast is raised instead of a card');
    assert.match(fetchImpl.calls.at(-1).url, /client=page-3/, 'and it keeps polling anyway');
    assert.equal(warnings.length, 1, 'the failure is reported once, not on every poll');
    assert.match(warnings[0], /could not open session session-gone/);
    channel.stop();
  } finally {
    console.warn = original;
  }
});

test('apply() registers the card stack on shell.overlay and owns the stream', async () => {
  const entries = [];
  const disposers = [];
  const network = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    network.push(String(url));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, cursor: 0, events: [] }) });
  };
  try {
    const ctx = fakeContext();
    const applyCtx = {
      sessions: ctx.sessions,
      get(name) {
        return name === 'slots' ? applyCtx.slots : undefined;
      },
      slots: {
        inject(name, callback) {
          callback();
          return () => {};
        },
        register(options, component) {
          entries.push({ options, component });
          return () => {};
        },
      },
      effect(callback) {
        const disposer = callback();
        if (typeof disposer === 'function') disposers.push(disposer);
        return () => {};
      },
    };
    client.apply(applyCtx);
    await settle();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].options.name, 'shell.overlay');
    assert.equal(entries[0].options.id, 'dsh-approval-notifier');
    assert.equal(entries[0].options.label(), '审批提醒');
    assert.equal(typeof entries[0].component, 'function');
    assert.ok(network.some((url) => url.includes('/client-state')), 'the stream starts with a report');
    assert.equal(disposers.length, 2, 'the stream and the slot entry are both owned');

    for (const dispose of disposers) dispose();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
