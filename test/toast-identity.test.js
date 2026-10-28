/**
 * The wire between the plugin and the toast identity.
 *
 * `lib/shortcut.js` is tested on its own; this file proves the plugin actually
 * calls it, with the configured id and the discovered executable, and that the
 * wiring does not recurse (the registrar reads `powershellPath` from the config
 * resolver, while `ensure()` itself runs from inside `getSettings()`).
 *
 * A recording `runShortcut` stands in for the script, so nothing here touches
 * the real Start Menu.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boot, fakeRequest, fakeResponse } from './harness.js';

/** Find the `/status` route the plugin mounted. */
function statusRoute(routes) {
  const route = routes.find((entry) => String(entry.path ?? entry.route ?? '').endsWith('/status'));
  assert.ok(route, 'the /status route should be mounted');
  return route;
}

/** Ask the plugin for its status, which resolves settings on the way. */
async function readStatus(routes) {
  const response = fakeResponse();
  await statusRoute(routes).handler(
    fakeRequest({ method: 'GET', url: '/dsh-approval-notifier/status' }),
    response,
  );
  assert.equal(response.statusCode, 200);
  return response.json();
}

/** A boot whose shortcut script is recorded instead of run. */
function bootWithRecorder(options = {}) {
  const calls = [];
  const booted = boot({
    // APPDATA is what makes the registrar willing to act, so the happy path is
    // exercised rather than the "no Start Menu" decline.
    env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming', ...options.env },
    runShortcut: (exe, args) => {
      calls.push({ exe, args });
      return { status: 0, stdout: options.stdout ?? 'SHORTCUT-OK: created', stderr: '' };
    },
    ...options,
  });
  return { ...booted, calls };
}

/** The value following a flag in an argv list. */
function valueOf(args, flag) {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

test('resolving settings registers the toast identity for the discovered exe', async () => {
  const { routes, calls, desktop } = bootWithRecorder();
  const body = await readStatus(routes);

  assert.equal(calls.length, 1, 'the identity should be registered once');
  assert.equal(valueOf(calls[0].args, '-AppId'), 'DSH.ApprovalNotifier');
  assert.equal(valueOf(calls[0].args, '-TargetPath'), desktop.exePath);
  assert.match(valueOf(calls[0].args, '-LnkPath'), /DSH\.ApprovalNotifier\.lnk$/u);

  assert.equal(body.toastIdentity.attempted, true);
  assert.equal(body.toastIdentity.ok, true);
  assert.equal(body.toastIdentity.appId, 'DSH.ApprovalNotifier');
});

test('the identity is registered once, not on every settings resolution', async () => {
  const { routes, calls } = bootWithRecorder();
  await readStatus(routes);
  await readStatus(routes);
  await readStatus(routes);
  assert.equal(calls.length, 1, 'a memo should collapse repeated resolutions');
});

test('a failed registration is reported and not retried in a tight loop', async () => {
  const { routes, calls } = bootWithRecorder({ stdout: 'SHORTCUT-FAIL: powershell missing' });
  const first = await readStatus(routes);
  assert.equal(first.toastIdentity.ok, false);
  assert.match(first.toastIdentity.error, /powershell missing/u);
  // One attempt for the whole request: settings resolve several times per
  // request, and a doomed 1.5 s child process each time is not acceptable.
  assert.equal(calls.length, 1);

  // The memo records the failure, so an immediate second request pays nothing.
  await readStatus(routes);
  assert.equal(calls.length, 1, 'a failure must be throttled, not re-run per call');
});

test('a failure is retried once the backoff expires', async () => {
  let clock = 1_000_000;
  const calls = [];
  let succeeding = false;
  const { routes } = boot({
    env: { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' },
    now: () => clock,
    runShortcut: (exe, args) => {
      calls.push({ exe, args });
      return succeeding
        ? { status: 0, stdout: 'SHORTCUT-OK: created', stderr: '' }
        : { status: 0, stdout: 'SHORTCUT-FAIL: transient', stderr: '' };
    },
  });

  assert.equal((await readStatus(routes)).toastIdentity.ok, false);
  assert.equal(calls.length, 1);

  // Still inside the backoff: nothing more is spent.
  clock += 30_000;
  await readStatus(routes);
  assert.equal(calls.length, 1);

  // Past it: the machine is asked again, and this time it works.
  succeeding = true;
  clock += 40_000;
  const healed = await readStatus(routes);
  assert.equal(calls.length, 2);
  assert.equal(healed.toastIdentity.ok, true);

  // Once registered, later resolutions are free.
  clock += 10_000;
  await readStatus(routes);
  assert.equal(calls.length, 2);
});

test('a custom appId is honoured end to end', async () => {
  const { routes, calls } = bootWithRecorder({ config: { appId: 'Acme.Notifier' } });
  const body = await readStatus(routes);
  assert.equal(valueOf(calls[0].args, '-AppId'), 'Acme.Notifier');
  assert.match(valueOf(calls[0].args, '-LnkPath'), /Acme\.Notifier\.lnk$/u);
  assert.equal(body.toastIdentity.appId, 'Acme.Notifier');
});

test('a disabled plugin registers nothing', async () => {
  const { routes, calls } = bootWithRecorder({ config: { enabled: false } });
  await readStatus(routes);
  assert.equal(calls.length, 0);
});

test('an icon path is forwarded when one resolves', async () => {
  const { routes, calls, desktop } = bootWithRecorder();
  await readStatus(routes);
  // The fake desktop tree ships resources/icon.png, which discovery picks up.
  assert.equal(valueOf(calls[0].args, '-IconPath'), desktop.iconPath);
});

test('the registrar never recurses through getSettings()', async () => {
  // The registrar's powershellPath thunk reads the raw config resolver; if it
  // went through getSettings() instead, ensure() -> getSettings() -> ensure()
  // would either hang the suite or blow the stack. Reaching this assertion at
  // all is the result.
  const { routes, calls } = bootWithRecorder();
  const body = await readStatus(routes);
  assert.equal(body.ok, true);
  assert.equal(calls.length, 1);
});
