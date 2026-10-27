import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFakeReg, createFakeSpawn, decodePayload, flush } from './helpers.js';
import { approvalEvent, boot, fakeResponse, fakeRequest, fakeSession } from './harness.js';

/** Report one page state through the real route. */
async function reportState(routes, state) {
  const route = routes.find((candidate) => candidate.path.endsWith('/client-state'));
  const response = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', url: '/dsh-approval-notifier/client-state', body: JSON.stringify(state) }), response);
  return response;
}

/** Read the notice stream once, without holding the response open. */
async function readEvents(routes, query = 'cursor=0&wait=0') {
  const route = routes.find((candidate) => candidate.path.endsWith('/events'));
  const response = fakeResponse();
  await route.handler(fakeRequest({ url: `/dsh-approval-notifier/events?${query}` }), response);
  return response.json();
}

/** Simulate the shell activating our URL scheme. */
async function activateQuery(routes, query) {
  const route = routes.find((candidate) => candidate.path.endsWith('/activate'));
  const response = fakeResponse();
  await route.handler(fakeRequest({ url: `/dsh-approval-notifier/activate${query}` }), response);
  return response.json();
}

/** The query half of one toast action URL. */
function actionQuery(url) {
  return url.slice(url.indexOf('?'));
}

/**
 * Raise one approval that becomes a toast, and return its two action URLs.
 *
 * The page has to be *connected but not in front*: a live page is what makes
 * the buttons honest (it will answer them), and a page that is not in front is
 * what makes the host choose the OS toast in the first place.
 */
async function toastApproval(config) {
  const booted = boot(config);
  const { routes, listeners, spawn } = booted;
  await reportState(routes, { clientId: 'p1', sessionId: 'another-session', visible: false });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  return { ...booted, actions: decodePayload(spawn.calls[0]).actions ?? [] };
}

test('the plugin subscribes to the durable approval event and the question waterfall', () => {
  const { listeners } = boot();
  assert.deepEqual([...listeners.keys()].sort(), ['session/event', 'user-questions/request']);
  assert.equal(listeners.get('session/event').length, 1);
  assert.equal(listeners.get('user-questions/request')[0].prepend, true);
});

test('the click target names the session and the schema is registered once', () => {
  const { reg, spawn, listeners } = boot();
  assert.equal(reg.values.size, 3, 'scheme, URL Protocol, and the command');
  const command = reg.defaultOf('HKCU\\Software\\Classes\\dsh-approval-notifier\\shell\\open\\command');
  assert.match(command, /wscript\.exe" \/\/B \/\/NoLogo /);
  assert.match(command, /--api "http:\/\/127\.0\.0\.1:43129\/dsh-approval-notifier\/activate"/);
  assert.match(command, /"%1"$/, 'the URL placeholder is what carries the session');

  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  return flush().then(() => {
    const payload = decodePayload(spawn.calls[0]);
    assert.equal(payload.launch, 'dsh-approval-notifier://focus?session=session-1234abcd');
  });
});

test('the boot line reports transport, click target, and the config path', () => {
  const { reports, home } = boot();
  const line = reports.at(-1);
  assert.match(line, /^ready \(transport=windows-toast/);
  assert.match(line, /click=dsh-approval-notifier:\/\/focus/);
  assert.match(line, /routes=mounted/);
  assert.match(line, new RegExp(`config=${home.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&')}`));
  assert.match(line, /\[created\]/);
});

test('a non-Windows host reports no transport instead of failing', () => {
  const { handles, reports } = boot({ platform: 'linux' });
  assert.equal(handles.capability.transport, 'none');
  assert.match(reports.at(-1), /transport=none, only Windows has native toasts/);
});

test('a prompt for the session already on screen is announced nowhere', async () => {
  const { routes, listeners, spawn } = boot();
  const reported = await reportState(routes, { clientId: 'p1', sessionId: 'session-1234abcd', visible: true });
  assert.equal(reported.json().decision, 'silent');

  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 0, 'the prompt card is already on screen: no toast');
  assert.deepEqual((await readEvents(routes)).events, [], 'and no corner card either');
});

test('a prompt for another session is an in-app card, never a toast', async () => {
  const { routes, listeners, spawn } = boot();
  const reported = await reportState(routes, { clientId: 'p1', sessionId: 'some-other-session', visible: true });
  assert.equal(reported.json().sessionId, 'some-other-session');

  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 0, 'the window is in front: the OS toast would be noise');

  const stream = await readEvents(routes);
  assert.equal(stream.events.length, 1);
  assert.equal(stream.events[0].kind, 'approval');
  assert.equal(stream.events[0].sessionId, 'session-1234abcd');
  assert.match(stream.events[0].title, /需要你确认：pwsh/);
});

test('a prompt while the window is behind is an OS toast carrying its session', async () => {
  const { routes, listeners, spawn } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'session-1234abcd', visible: false });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 1);
  const payload = decodePayload(spawn.calls[0]);
  assert.match(payload.launch, /session=session-1234abcd$/);
  assert.match(payload.lines.join(' '), /Set-Content/);
  assert.match(payload.lines.join(' '), /会话：插件通知调试/);
});

test('a session whose policy is never is not announced at all', async () => {
  const captured = [];
  const { routes, listeners, spawn, ctx } = boot();
  ctx.get = (key) => (key === 'approval' ? { effectivePolicy: () => 'never' } : undefined);
  await reportState(routes, { clientId: 'p1', sessionId: 'other', visible: true });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 0);
  assert.deepEqual((await readEvents(routes)).events, []);
  assert.deepEqual(captured, []);
});

test('includeToolCall: false keeps the command out of the toast', async () => {
  const { routes, listeners, spawn } = boot({ config: { includeToolCall: false } });
  await reportState(routes, { clientId: 'p1', sessionId: 'other', visible: true });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  const stream = await readEvents(routes);
  assert.doesNotMatch(stream.events[0].lines.join(' '), /Set-Content/);
  assert.equal(spawn.calls.length, 0);
});

test('a pending question is announced, and retired when it is answered', async () => {
  const { routes, listeners, spawn } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'other', visible: true });
  let settleWaterfall;
  const handler = listeners.get('user-questions/request')[0].handler;
  const outcome = handler(
    { agent: { session: fakeSession() }, questions: [{ header: 'H', question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] },
    () => new Promise((resolve) => {
      settleWaterfall = resolve;
    }),
  );
  await flush();
  const shown = await readEvents(routes);
  assert.equal(shown.events.length, 1);
  assert.equal(shown.events[0].kind, 'question');
  assert.deepEqual(shown.events[0].lines.slice(0, 3), ['需要你的回答：H', 'Q?', 'A / B']);

  settleWaterfall('allowed');
  await Promise.resolve(outcome);
  await flush();
  const settled = await readEvents(routes, `cursor=${shown.cursor}&wait=0`);
  assert.equal(settled.events[0].kind, 'clear', 'the answer retires the card');
  assert.equal(spawn.calls.length, 0);
});

test('the question observer always passes the waterfall through untouched', () => {
  const { listeners } = boot();
  const handler = listeners.get('user-questions/request')[0].handler;
  let called = 0;
  const sentinel = Promise.resolve('answered');
  const result = handler({ agent: { session: fakeSession() }, questions: [] }, () => {
    called += 1;
    return sentinel;
  });
  assert.equal(called, 1);
  assert.equal(result, sentinel);
});

test('an approval/decided event retires the queued notice', async () => {
  const { routes, listeners } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'other', visible: true });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  listeners.get('session/event')[0].handler(fakeSession(), { type: 'approval/decided', data: { id: 'req-1', outcome: 'allowed-once' } });
  await flush();
  const stream = await readEvents(routes);
  assert.equal(stream.events.at(-1).kind, 'clear');
  assert.equal(stream.events.at(-1).key, 'approval|req-1');
});

test('clicking a toast queues the session the page should switch to', async () => {
  const { routes } = boot();
  const clicked = await activateQuery(routes, '?session=session-abc');
  assert.equal(clicked.queued, true);
  assert.equal(clicked.sessionId, 'session-abc');
  const stream = await readEvents(routes);
  assert.equal(stream.events[0].kind, 'navigate');
  assert.equal(stream.events[0].sessionId, 'session-abc');
});

test('a click with no session only brings the window forward', async () => {
  const { routes, home } = boot();
  const clicked = await activateQuery(routes, '');
  assert.equal(clicked.queued, false);
  assert.deepEqual((await readEvents(routes)).events, []);
  const contents = readFileSync(join(home, 'dsh-approval-notifier.log'), 'utf8');
  assert.match(contents, /CLICK without a session \(window only\)/);
});

test('the event route holds the response until something is queued', async () => {
  const { routes, listeners } = boot();
  const route = routes.find((candidate) => candidate.path.endsWith('/events'));
  const response = fakeResponse();
  const pending = route.handler(fakeRequest({ url: '/dsh-approval-notifier/events?cursor=0&wait=5' }), response);
  assert.equal(response.body, '', 'the route has not answered yet');

  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await pending;
  const body = response.json();
  assert.equal(body.events.length, 1, 'the queued notice woke the long poll');
});

test('the client-state route validates its body and echoes the decision', async () => {
  const { routes } = boot();
  const route = routes.find((candidate) => candidate.path.endsWith('/client-state'));

  const bad = fakeResponse();
  await route.handler({ method: 'POST', url: '/x', on(event, handler) {
    if (event === 'data') setImmediate(() => handler('not json'));
    if (event === 'end') setImmediate(() => handler());
    return this;
  }, setEncoding() {} }, bad);
  assert.equal(bad.statusCode, 400);

  const noId = fakeResponse();
  await route.handler(fakeRequest({ method: 'POST', url: '/x', body: JSON.stringify({}) }), noId);
  assert.equal(noId.statusCode, 400);
  assert.match(noId.json().error, /clientId/);

  const good = await reportState(routes, { clientId: 'p1', sessionId: 'session-x', visible: true });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().decision, 'silent');
});

test('in-app notices can be turned off without losing the toast', async () => {
  const { routes, listeners, spawn } = boot({ config: { notifyInApp: false } });
  await reportState(routes, { clientId: 'p1', sessionId: 'some-other-session', visible: true });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 1, 'the toast is the remaining channel');
  assert.deepEqual((await readEvents(routes)).events, [], 'and no card is queued');
});

test('suppressVisible: false announces a session that is on screen (as a card)', async () => {
  const { routes, listeners, spawn } = boot({ config: { suppressVisible: false } });
  await reportState(routes, { clientId: 'p1', sessionId: 'session-1234abcd', visible: true });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 0, 'still no toast: the window is in front');
  const stream = await readEvents(routes);
  assert.equal(stream.events.length, 1);
});

test('the test route really sends a notification and reports the transport', async () => {
  const { routes, spawn } = boot();
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?silent=1' }), response);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(decodePayload(spawn.calls[0]).sound, false);
  assert.match(body.hint, /通知已发送/);
});

test('the test route explains a failing transport', async () => {
  const spawn = createFakeSpawn({ plan: { stdout: 'TOAST-FAIL: System.Exception :: blocked\r\n', code: 0 } });
  const { routes } = boot({ spawn });
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test' }), response);
  const body = response.json();
  assert.equal(body.ok, false);
  assert.match(body.hint, /TOAST-FAIL/);
});

test('the self-test toast carries the session a page reports, so its click can jump', async () => {
  const { routes, spawn } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'session-1234abcd', visible: false });
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?silent=1' }), response);
  const body = response.json();
  assert.equal(body.sessionId, 'session-1234abcd');
  assert.equal(body.clickUrl, 'dsh-approval-notifier://focus?session=session-1234abcd');
  assert.equal(decodePayload(spawn.calls[0]).launch, body.clickUrl);
});

test('the self-test toast says so when it has no session to point at', async () => {
  const { routes, spawn } = boot();
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?silent=1' }), response);
  const body = response.json();
  assert.equal(body.sessionId, '');
  assert.equal(body.clickUrl, '');
  assert.equal(decodePayload(spawn.calls[0]).launch, 'dsh-approval-notifier://focus');
  assert.match(body.hint, /没有带会话/, 'and it must not read as a broken jump');
});

test('?session= names the self-test target explicitly', async () => {
  const { routes, spawn } = boot();
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?silent=1&session=session-explicit' }), response);
  assert.equal(response.json().sessionId, 'session-explicit');
  assert.equal(decodePayload(spawn.calls[0]).launch, 'dsh-approval-notifier://focus?session=session-explicit');
});

test('?decide=1 gives the self-test toast the two approval buttons', async () => {
  const { routes, spawn } = boot();
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?silent=1&decide=1&session=session-1' }), response);
  const body = response.json();
  assert.equal(body.actions, 2);
  const payload = decodePayload(spawn.calls[0]);
  assert.deepEqual(payload.actions.map((action) => action.content), ['允许一次', '拒绝']);

  // Pressing one must be accepted, because the route registered that test key.
  const pressed = await activateQuery(routes, actionQuery(payload.actions[0].arguments));
  assert.equal(pressed.decided, true);
});

test('the test route can preview the in-app card', async () => {
  const { routes } = boot();
  const testRoute = routes.find((route) => route.path.endsWith('/test'));
  const response = fakeResponse();
  await testRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/test?inapp=1' }), response);
  const body = response.json();
  assert.equal(body.queued, 'in-app');
  const stream = await readEvents(routes);
  assert.equal(stream.events[0].kind, 'test');
});

test('an approval toast carries the two decision buttons when a page can answer them', async () => {
  const { actions, spawn } = await toastApproval();
  assert.equal(spawn.calls.length, 1, 'the window is behind: this is an OS toast');
  assert.deepEqual(actions.map((action) => action.content), ['允许一次', '拒绝']);
  for (const action of actions) {
    assert.match(action.arguments, /^dsh-approval-notifier:\/\/decide\?decision=(allow|deny)&/);
    assert.match(action.arguments, /key=approval%7Creq-1/, 'the button names the approval it came from');
    assert.match(action.arguments, /&t=[0-9a-f]{32}$/, 'and carries the per-process decision token');
  }
  assert.notEqual(actions[0].arguments, actions[1].arguments);
});

test('an approval toast offers no buttons when no page could answer them', async () => {
  const { routes, listeners, spawn } = boot();
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(decodePayload(spawn.calls[0]).actions, [], 'nothing is connected to answer');
});

test('decideFromToast: false leaves the approval toast without buttons', async () => {
  const { actions, spawn } = await toastApproval({ config: { decideFromToast: false } });
  assert.equal(spawn.calls.length, 1);
  assert.deepEqual(actions, []);
});

test('a decision click answers the approval it came from, and only that one', async () => {
  const { routes, actions, spawn } = await toastApproval();
  assert.equal(spawn.calls.length, 1);

  const refused = await activateQuery(routes, actionQuery(actions[1].arguments).replace(/t=[0-9a-f]+/u, 't=forged'));
  assert.equal(refused.decided, false, 'a decision without the process token is refused');
  const unknown = await activateQuery(routes, actionQuery(actions[0].arguments).replace(/key=[^&]+/u, 'key=approval%7Cnope'));
  assert.equal(unknown.decided, false, 'a key that was never announced is refused');

  const accepted = await activateQuery(routes, actionQuery(actions[0].arguments));
  assert.equal(accepted.decided, true);
  assert.equal(accepted.queued, true);
  const stream = await readEvents(routes);
  const decide = stream.events.find((event) => event.kind === 'decide');
  assert.ok(decide, 'the page is told to answer');
  assert.equal(decide.decision, 'allowed-once');
  assert.equal(decide.sessionId, 'session-1234abcd', 'and which session to answer in');
  assert.equal(decide.key, 'approval|req-1');
  assert.equal(
    stream.events.some((event) => event.kind === 'navigate'),
    false,
    'deciding does not also drag the window to the session',
  );
});

test('a toast from an approval that has since been decided cannot answer anything', async () => {
  const { routes, listeners, spawn } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'another-session', visible: false });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();
  const actions = decodePayload(spawn.calls[0]).actions;

  listeners.get('session/event')[0].handler(fakeSession(), {
    type: 'approval/decided',
    data: { id: 'req-1', outcome: 'allowed-once' },
  });
  await flush();

  const late = await activateQuery(routes, actionQuery(actions[0].arguments));
  assert.equal(late.decided, false, 'the stale toast must not answer a later approval');
  const stream = await readEvents(routes);
  assert.equal(stream.events.some((event) => event.kind === 'decide'), false);
});

test('the status route reports the wiring without leaking decision keys', async () => {
  const { routes, listeners } = boot();
  await reportState(routes, { clientId: 'p1', sessionId: 'another-session', visible: false });
  listeners.get('session/event')[0].handler(fakeSession(), approvalEvent);
  await flush();

  const statusRoute = routes.find((route) => route.path.endsWith('/status'));
  const response = fakeResponse();
  await statusRoute.handler(fakeRequest({ url: '/dsh-approval-notifier/status' }), response);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.attention.pendingApprovals, 1);
  assert.equal(body.attention.decideFromToast, true);
  assert.equal(body.attention.presence.pages.length, 1);
  assert.equal(body.protocol.registered, true);
  assert.doesNotMatch(JSON.stringify(body), /approval\|req-1/, 'the notice keys stay private');
  assert.doesNotMatch(JSON.stringify(body), /[0-9a-f]{32}/, 'and so does the decision token');
});

test('the status route rejects a write', async () => {
  const { routes } = boot();
  const statusRoute = routes.find((route) => route.path.endsWith('/status'));
  const response = fakeResponse();
  await statusRoute.handler({ method: 'POST', url: '/dsh-approval-notifier/status' }, response);
  assert.equal(response.statusCode, 405);
});

test('the routes mount late when the web server arrives after boot', async () => {
  const { routes, ctx, injections } = boot({ lateWebServer: true });
  assert.equal(routes.length, 0, 'nothing is mounted without a web server');
  assert.equal(injections.length, 1);
  assert.deepEqual(injections[0].keys, ['webServer'], 'only services that exist in this composition');
  ctx.webServer = {
    port: 43129,
    register(route) {
      routes.push(route);
      return () => {};
    },
  };
  injections[0].callback(ctx);
  assert.equal(routes.length, 5);
});
