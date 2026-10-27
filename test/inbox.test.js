import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInbox } from '../lib/inbox.js';

/** An inbox on a controllable clock. */
function makeInbox(options = {}) {
  let now = 1_000_000;
  const inbox = createInbox({ now: () => now, ...options });
  return { inbox, advance: (ms) => { now += ms; } };
}

test('a pushed entry is readable exactly once per cursor', () => {
  const { inbox } = makeInbox();
  assert.deepEqual(inbox.since(0), []);
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's1', title: 'T', lines: ['T'] });
  const first = inbox.since(0);
  assert.equal(first.length, 1);
  assert.equal(first[0].seq, 1);
  assert.equal(inbox.cursor(), 1);
  assert.deepEqual(inbox.since(1), [], 'a caught-up reader sees nothing');
});

test('resolve() retires only an outstanding notice', () => {
  const { inbox } = makeInbox();
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's1', title: 'T', lines: [] });
  assert.equal(inbox.resolve('k1', 's1').kind, 'clear');
  assert.equal(inbox.resolve('k1', 's1'), undefined, 'a second retire is a no-op');
  assert.equal(inbox.resolve('', 's1'), undefined);
  assert.equal(inbox.resolve(undefined, 's1'), undefined);
});

test('a decide entry closes its notice like a clear does', () => {
  const { inbox } = makeInbox();
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's1', title: 'T', lines: [] });
  inbox.push({ kind: 'decide', key: 'k1', sessionId: 's1', decision: 'allowed-once' });
  assert.equal(inbox.resolve('k1', 's1'), undefined, 'the notice is already closed');
});

test('entries age out, and a navigate expires sooner than a notice', () => {
  const { inbox, advance } = makeInbox({ ttlMs: 1000, navigateTtlMs: 200 });
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's1', title: 'T', lines: [] });
  inbox.push({ kind: 'navigate', sessionId: 's1' });
  advance(300);
  const kinds = inbox.since(0).map((entry) => entry.kind);
  assert.deepEqual(kinds, ['approval'], 'the navigate is already too old to act on');
  advance(800);
  assert.deepEqual(inbox.since(0), [], 'and the notice followed');
});

test('the queue stays bounded under a storm', () => {
  const { inbox } = makeInbox({ limit: 3 });
  for (let i = 0; i < 10; i += 1) inbox.push({ kind: 'approval', key: `k${String(i)}`, sessionId: 's', title: 'T', lines: [] });
  assert.equal(inbox.size(), 3);
  assert.deepEqual(inbox.since(0).map((entry) => entry.key), ['k7', 'k8', 'k9']);
});

test('onPush wakes every waiter exactly when something is queued', () => {
  const { inbox } = makeInbox();
  let woken = 0;
  const unsubscribe = inbox.onPush(() => {
    woken += 1;
  });
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's', title: 'T', lines: [] });
  assert.equal(woken, 1);
  unsubscribe();
  inbox.push({ kind: 'approval', key: 'k2', sessionId: 's', title: 'T', lines: [] });
  assert.equal(woken, 1, 'an unsubscribed waiter hears nothing');
});

test('a throwing waiter does not stop the others', () => {
  const { inbox } = makeInbox();
  let reached = 0;
  inbox.onPush(() => {
    throw new Error('boom');
  });
  inbox.onPush(() => {
    reached += 1;
  });
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's', title: 'T', lines: [] });
  assert.equal(reached, 1);
});

test('recent() and clear() serve diagnostics and disposal', () => {
  const { inbox } = makeInbox();
  inbox.push({ kind: 'approval', key: 'k1', sessionId: 's', title: 'T', lines: [] });
  inbox.push({ kind: 'approval', key: 'k2', sessionId: 's', title: 'T', lines: [] });
  assert.deepEqual(inbox.recent(1).map((entry) => entry.key), ['k2']);
  inbox.clear();
  assert.equal(inbox.size(), 0);
  assert.equal(inbox.cursor(), 0);
});
