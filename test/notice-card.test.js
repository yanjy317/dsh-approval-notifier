/**
 * The in-app notice card: hierarchy, folding, in-card decisions, and motion.
 *
 * These render the real components through a small React stub that *does* keep
 * state, so a click can be followed the way a browser would: press 允许一次 and
 * the card has to disappear, press 展开 and the full text has to appear.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {
  __ModuleLoader__: {
    load(entry) {
      (globalThis.__notifierRegistrations ??= new Map()).set(entry.id, entry);
    },
  },
};
await import('../lib/client.js');

const registration = globalThis.__notifierRegistrations.get('dsh-approval-notifier');

/**
 * A React stub with working local state.
 *
 * Local state has to survive across renders (an expander that forgets it was
 * opened is not testable), while data read from an external store has to be
 * re-read every render. `useState` therefore keeps its slot, and the store
 * subscription is simulated by re-running the component on demand.
 */
function makeReact() {
  let slots = [];
  let cursor = 0;
  let rerender = () => {};
  const react = {
    createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children: children.flat() } }),
    useState(initial) {
      const at = cursor;
      cursor += 1;
      if (slots[at] === undefined) slots[at] = typeof initial === 'function' ? initial() : initial;
      const set = (next) => {
        slots[at] = typeof next === 'function' ? next(slots[at]) : next;
        rerender();
      };
      return [slots[at], set];
    },
    useEffect() {},
  };
  return {
    react,
    /**
     * Render `fn`, keeping local state and re-running on every state update.
     *
     * `useCards` reads the store through `useState` and refreshes it in an
     * effect; the stub has no commit phase, so slot 0 — the store snapshot — is
     * re-settled on every render. Every other slot keeps its value, which is
     * what makes an opened expander stay open.
     */
    mount(fn) {
      let tree;
      const run = () => {
        cursor = 0;
        slots[0] = undefined;
        tree = fn();
        return tree;
      };
      rerender = () => { run(); };
      return run;
    },
  };
}

/** Load a fresh copy of the client bound to that React stub. */
function loadClient() {
  const harness = makeReact();
  const client = registration.factory((specifier) => {
    if (specifier === 'react') return harness.react;
    throw new Error(`unexpected require(${specifier})`);
  });
  return { client, internals: client.__internals, mount: harness.mount };
}

/** A store on a controllable clock. */
function makeStore(internals, options = {}) {
  let current = 1_000_000;
  const store = internals.createNoticeStore({
    now: () => current,
    maxCards: options.maxCards ?? 6,
    ttlMs: options.ttlMs ?? 600_000,
  });
  return { store, at: () => current, advance: (ms) => { current += ms; } };
}

/** Find every node whose type matches, depth-first. */
function findAll(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, found);
    return found;
  }
  if (predicate(node)) found.push(node);
  if (node.props !== undefined) findAll(node.props.children, predicate, found);
  return found;
}

/** The text content of one rendered node. */
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node.props === undefined) return '';
  return textOf(node.props.children);
}

/** The rendered card elements of one stack render, with their notice keys. */
function cardsOf(tree, client) {
  if (tree === null) return [];
  return tree.props.children
    .filter((child) => child !== null && child.type === client.NoticeCard)
    .map((element) => ({ key: element.props.card.key, node: client.NoticeCard(element.props) }));
}

/** The rendered node for one notice key. */
function cardFor(tree, client, key) {
  const found = cardsOf(tree, client).find((entry) => entry.key === key);
  assert.ok(found, `expected a card for ${key}`);
  return found.node;
}

/** The buttons inside a rendered card, by their visible label. */
function buttonLabels(cardNode) {
  return findAll(cardNode, (node) => node.type === 'button').map((node) => textOf(node).trim());
}

/** Press one button inside a rendered card. */
function press(cardNode, label) {
  const target = findAll(cardNode, (node) => node.type === 'button').find((node) => textOf(node).trim() === label);
  assert.ok(target, `expected a "${label}" button`);
  target.props.onClick({ stopPropagation() {} });
}

/**
 * Render the stack against a live store.
 *
 * `useCards` keeps its snapshot in `useState` and refreshes it from an effect;
 * the stub has no commit phase, so this re-renders with a cleared slot table on
 * every call, which is what a committed React update would produce.
 */
function renderStack(mount, client, store, handlers = {}) {
  return mount(() => client.NoticeStack({
    store,
    now: handlers.now,
    onOpen: handlers.onOpen ?? (() => {}),
    onDismiss: handlers.onDismiss ?? (() => {}),
    onDecide: handlers.onDecide ?? (() => {}),
  }));
}

test('an approval card offers the two in-card decisions, a question card does not', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: '需要你确认：pwsh', lines: ['需要你确认：pwsh', 'rm -rf build'] });
  store.add({ key: 'question|q1', kind: 'question', sessionId: 's2', title: '需要你的回答', lines: ['需要你的回答', '选哪个？'] });

  const approval = cardFor(get(), client, 'approval|a1');
  const question = cardFor(get(), client, 'question|q1');

  const approvalLabels = buttonLabels(approval);
  assert.ok(approvalLabels.includes('允许一次'), 'an approval can be allowed from the card');
  assert.ok(approvalLabels.includes('拒绝'), 'and rejected from it');
  assert.ok(approvalLabels.includes('×'), 'the dismiss control stays');

  const questionLabels = buttonLabels(question);
  assert.equal(questionLabels.includes('允许一次'), false, 'a question has no approval to answer');
  assert.equal(questionLabels.includes('拒绝'), false);
});

test('an in-card decision carries the card identity and retires it on success', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const seen = [];
  const get = renderStack(mount, client, store, {
    onDecide: (card, decision) => {
      seen.push({ key: card.key, sessionId: card.sessionId, callId: card.callId, decision });
      store.drop(card.key);
    },
  });

  store.add({
    key: 'approval|a1',
    kind: 'approval',
    sessionId: 's1',
    callId: 'call-9',
    title: '需要你确认：pwsh',
    lines: ['需要你确认：pwsh'],
  });

  press(cardFor(get(), client, 'approval|a1'), '允许一次');
  assert.deepEqual(seen, [{ key: 'approval|a1', sessionId: 's1', callId: 'call-9', decision: 'allowed-once' }]);
  assert.equal(cardsOf(get(), client).length, 0, 'an answered approval leaves the stack');

  store.add({ key: 'approval|a2', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T'] });
  press(cardFor(get(), client, 'approval|a2'), '拒绝');
  assert.equal(seen[1].decision, 'rejected');
});

test('pressing the answer buttons does not also open the session', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const opened = [];
  const get = renderStack(mount, client, store, { onOpen: (card) => opened.push(card.key) });

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T'] });
  const card = cardFor(get(), client, 'approval|a1');

  const allow = findAll(card, (node) => node.type === 'button').find((node) => textOf(node).trim() === '允许一次');
  let stopped = false;
  allow.props.onClick({ stopPropagation() { stopped = true; } });
  assert.equal(stopped, true, 'the click is kept inside the card');
  assert.deepEqual(opened, [], 'answering must not navigate away');
});

test('a long line is clipped to one preview row, and 展开 reveals the rest', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  const long = 'x'.repeat(400);
  store.add({
    key: 'approval|a1',
    kind: 'approval',
    sessionId: 's1',
    title: '需要你确认：pwsh',
    lines: ['需要你确认：pwsh', long, '第二条补充', '第三条补充'],
  });

  const collapsed = cardFor(get(), client, 'approval|a1');
  const collapsedText = textOf(collapsed);
  assert.ok(!collapsedText.includes(long), 'the raw 400-char line must not be rendered whole');
  assert.ok(collapsedText.includes('…'), 'a clipped line is marked as such');
  assert.ok(!collapsedText.includes('第二条补充'), 'the extra lines stay folded away');
  assert.ok(buttonLabels(collapsed).includes('展开'));

  press(collapsed, '展开');
  const expanded = cardFor(get(), client, 'approval|a1');
  const expandedText = textOf(expanded);
  assert.ok(expandedText.includes('第二条补充'), 'expanding shows the remaining lines');
  assert.ok(buttonLabels(expanded).includes('收起'), 'and offers a way back');
});

test('expanding a single long line shows that whole line back', () => {
  // The common real case: a notice whose only body line is one long command or
  // reason. The preview clips it, and expanding must restore the full text --
  // it used to render only the lines *after* the first, so the toggle appeared
  // and then did nothing at all.
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  const long = 'escalate sandbox: ' + 'y'.repeat(300);
  store.add({
    key: 'approval|a1',
    kind: 'approval',
    sessionId: 's1',
    title: '需要你确认：pwsh',
    lines: ['需要你确认：pwsh', long],
  });

  const collapsed = cardFor(get(), client, 'approval|a1');
  assert.ok(!textOf(collapsed).includes(long), 'the long line is clipped while collapsed');
  assert.ok(buttonLabels(collapsed).includes('展开'), 'and the card offers to expand');

  press(collapsed, '展开');
  const expanded = cardFor(get(), client, 'approval|a1');
  assert.ok(textOf(expanded).includes(long), 'expanding restores the whole line');
});

test('a short notice needs no expander at all', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T', 'short'] });
  const card = cardFor(get(), client, 'approval|a1');
  assert.equal(buttonLabels(card).includes('展开'), false, 'nothing was folded, so nothing to unfold');
});

test('a burst folds past the third card and 另有 N 条 expands the rest', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals, { maxCards: 10 });
  const get = renderStack(mount, client, store);

  for (let n = 1; n <= 5; n += 1) {
    store.add({ key: 'approval|a' + n, kind: 'approval', sessionId: 's' + n, title: 'T' + n, lines: ['T' + n] });
  }

  const folded = get();
  assert.equal(cardsOf(folded, client).length, 3, 'only three cards are drawn at once');
  const foldButton = folded.props.children.find((child) => child !== null && child.props
    && child.props['data-dsh-approval-notifier'] === 'fold');
  assert.ok(foldButton, 'the overflow is announced');
  assert.ok(textOf(foldButton).includes('2'), 'and says how many are hidden');

  foldButton.props.onClick();
  const unfolded = get();
  assert.equal(cardsOf(unfolded, client).length, 5, 'expanding shows every card');
  const collapseButton = unfolded.props.children.find((child) => child !== null && child.props
    && child.props['data-dsh-approval-notifier'] === 'collapse');
  assert.ok(collapseButton, 'and offers a way back');

  collapseButton.props.onClick();
  assert.equal(cardsOf(get(), client).length, 3, 'collapsing folds them again');
});

test('a small stack shows no fold control at all', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T1', lines: ['T1'] });
  const tree = get();
  const controls = tree.props.children.filter((child) => child !== null && child.props
    && String(child.props['data-dsh-approval-notifier'] ?? '').match(/fold|collapse/u));
  assert.deepEqual(controls, [], 'nothing to fold, so no fold control');
});

test('the stack carries its enter animation and respects reduced motion', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T'] });
  const tree = get();
  const style = tree.props.children.find((child) => child !== null && child.type === 'style');
  assert.ok(style, 'the stack injects the one rule inline styles cannot express');
  const css = textOf(style);
  assert.ok(css.includes('@keyframes dsh-approval-notifier-in'), 'the animation is defined');
  assert.ok(css.includes('prefers-reduced-motion'), 'and can be switched off by preference');
  assert.ok(/data-dsh-approval-notifier="cards"/u.test(css), 'the rule is scoped to our own stack');

  const card = cardFor(tree, client, 'approval|a1');
  assert.equal(card.props.style.animation, 'dsh-approval-notifier-in .22s cubic-bezier(.2,.7,.3,1) both');
});

test('hovering a card lifts it and tints its border to its own accent', () => {
  const card = { key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T'], at: 1_000_000 };
  const { client } = loadClient();
  const base = { card, now: 1_000_000, expanded: false, onOpen() {}, onDismiss() {}, onDecide() {}, onToggleExpanded() {}, onHover() {} };

  const calm = client.NoticeCard({ ...base, hovered: false });
  const lifted = client.NoticeCard({ ...base, hovered: true });
  assert.equal(calm.props.style.transform, 'none');
  assert.equal(lifted.props.style.transform, 'translateY(-1px)');
  assert.ok(lifted.props.style.boxShadow !== calm.props.style.boxShadow, 'it rises off the surface');
  assert.match(lifted.props.style.border, /#e8590c/iu, 'the border takes the approval accent');
  assert.match(calm.props.style.border, /rgba\(128,128,128/u, 'and is neutral at rest');
  assert.match(calm.props.style.transition, /transform/u, 'the change is animated, not snapped');
});

test('a self-test notice is drawn in the approval skin but offers no buttons', () => {
  // `?inapp=1` previews the approval layout, but it names no pending
  // interaction, so 允许一次 / 拒绝 could only ever do nothing. Offering them
  // would be a lie, and a click that silently does nothing reads as broken.
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'test|manual', kind: 'test', sessionId: 's1', title: '测试', lines: ['测试', '预览'] });
  const card = cardFor(get(), client, 'test|manual');
  assert.equal(card.props['data-kind'], 'approval', 'it still previews the approval look');
  const labels = buttonLabels(card);
  assert.equal(labels.includes('允许一次'), false, 'but it cannot be answered');
  assert.equal(labels.includes('拒绝'), false);
});

test('a card whose approval is gone says so instead of swallowing the click', () => {
  const { client, internals, mount } = loadClient();
  const { store } = makeStore(internals);
  const get = renderStack(mount, client, store);

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: 'T', lines: ['T'] });
  assert.ok(buttonLabels(cardFor(get(), client, 'approval|a1')).includes('允许一次'));

  // The approval was answered elsewhere, or replaced by a later one.
  assert.equal(store.markStale('approval|a1', '这条审批已不在待处理状态'), true);
  const stale = cardFor(get(), client, 'approval|a1');
  assert.equal(buttonLabels(stale).includes('允许一次'), false, 'dead buttons are withdrawn');
  assert.ok(textOf(stale).includes('这条审批已不在待处理状态'), 'and the card explains why');

  // Marking a card that is not decidable, or is absent, is a no-op.
  assert.equal(store.markStale('approval|a1', 'again'), false);
  assert.equal(store.markStale('nope', 'x'), false);
});

test('the kind badge and age distinguish an approval from a question', () => {
  const { client, internals, mount } = loadClient();
  const { store, advance, at } = makeStore(internals);
  // The stack reads its own clock, so hand it the same one the store uses.
  const get = renderStack(mount, client, store, { now: at });

  store.add({ key: 'approval|a1', kind: 'approval', sessionId: 's1', title: '需要你确认：pwsh', lines: ['需要你确认：pwsh'] });
  let card = cardFor(get(), client, 'approval|a1');
  assert.equal(card.props['data-kind'], 'approval');
  assert.ok(textOf(card).includes('审批'), 'the card says what it is');
  assert.ok(textOf(card).includes('刚刚'), 'a fresh card says so');

  advance(120_000);
  card = cardFor(get(), client, 'approval|a1');
  assert.ok(textOf(card).includes('2 分钟前'), 'the age follows the clock');

  store.add({ key: 'question|q1', kind: 'question', sessionId: 's2', title: '需要你的回答', lines: ['需要你的回答'] });
  card = cardFor(get(), client, 'question|q1');
  assert.equal(card.props['data-kind'], 'question');
  assert.ok(textOf(card).includes('提问'));
});
