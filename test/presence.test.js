import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_FOREGROUND_TTL_MS, DEFAULT_PRESENCE_TTL_MS, DELIVERY, createPresence, decideDelivery } from '../lib/presence.js';

/** A presence registry on a controllable clock. */
function makePresence(options = {}) {
  let now = 1_000_000;
  const presence = createPresence({ now: () => now, ttlMs: options.ttlMs });
  return { presence, advance: (ms) => { now += ms; } };
}

test('a report is accepted only with a client id', () => {
  const { presence } = makePresence();
  assert.equal(presence.report({}), false);
  assert.equal(presence.report({ clientId: '   ' }), false);
  assert.equal(presence.report({ clientId: 'p1' }), true);
  assert.equal(presence.live(), true);
});

test('showing() is true only for a live, in-front page on that session', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  assert.equal(presence.showing('session-a'), true);
  assert.equal(presence.showing('session-b'), false);
  assert.equal(presence.showing(''), false);

  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: false });
  assert.equal(presence.showing('session-a'), false, 'a window that is behind is not showing anything to the user');
});

test('touch() keeps a polling page live without inventing one', () => {
  const { presence, advance } = makePresence({ ttlMs: 1000 });
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  advance(900);
  assert.equal(presence.touch('p1'), true);
  advance(900);
  assert.equal(presence.showing('session-a'), true, 'the long poll refreshed the report');

  assert.equal(presence.touch('nobody'), false);
  advance(DEFAULT_PRESENCE_TTL_MS);
  assert.equal(presence.live(), false, 'and an untouched page ages out');
});

test('a report older than the TTL stops counting as live', () => {
  const { presence, advance } = makePresence({ ttlMs: 500 });
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  assert.equal(presence.live(), true);
  advance(600);
  assert.equal(presence.live(), false);
  assert.equal(presence.showing('session-a'), false);
  assert.equal(presence.snapshot().pages.length, 0);
});

test('a page that goes quiet stops being "in front" long before it stops being live', () => {
  const { presence, advance } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.SILENT);

  // Two empty 5 s polls of the notice stream: still looking at it.
  advance(12000);
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.SILENT);

  // Past the foreground window but inside the liveness one: the window may
  // still be open, yet nothing may be swallowed any more.
  advance(8000);
  assert.equal(presence.live(), true, 'the page is still connected');
  assert.equal(presence.showing('session-a'), false);
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.TOAST,
    'a silent page must not be trusted to hold a prompt back');
  assert.equal(decideDelivery('session-b', presence, {}), DELIVERY.TOAST);

  const snapshot = presence.snapshot();
  assert.equal(snapshot.foregroundTtlMs, DEFAULT_FOREGROUND_TTL_MS);
  assert.equal(snapshot.pages[0].inFront, false);
  assert.equal(snapshot.pages[0].visible, true);
});

test('a newer report replaces the previous state of the same page', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  presence.report({ clientId: 'p1', sessionId: 'session-b', visible: true });
  assert.equal(presence.showing('session-a'), false);
  assert.equal(presence.showing('session-b'), true);
  assert.equal(presence.snapshot().pages.length, 1);
});

test('decideDelivery falls back to a toast when nothing is connected', () => {
  const { presence } = makePresence();
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.TOAST);
});

test('decideDelivery is silent for the session already on screen', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.SILENT);
  assert.equal(
    decideDelivery('session-a', presence, { suppressVisible: false }),
    DELIVERY.IN_APP,
    'opting out of suppression turns it into a card',
  );
});

test('decideDelivery turns another session into an in-app notice only', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: true });
  assert.equal(decideDelivery('session-b', presence, {}), DELIVERY.IN_APP);
  assert.equal(
    decideDelivery('session-b', presence, { notifyInApp: false }),
    DELIVERY.TOAST,
    'with cards switched off the toast is the only channel left',
  );
});

test('decideDelivery toasts while the window is behind', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'p1', sessionId: 'session-a', visible: false });
  assert.equal(decideDelivery('session-a', presence, {}), DELIVERY.TOAST);
});

test('one foreground page among several is enough to decide', () => {
  const { presence } = makePresence();
  presence.report({ clientId: 'background', sessionId: 'session-a', visible: false });
  presence.report({ clientId: 'front', sessionId: 'session-b', visible: true });
  assert.equal(presence.foreground(), true);
  assert.equal(decideDelivery('session-b', presence, {}), DELIVERY.SILENT);
  assert.equal(decideDelivery('session-c', presence, {}), DELIVERY.IN_APP);
});
