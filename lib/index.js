/**
 * dsh-approval-notifier — host half.
 *
 * Pops a native Windows notification whenever DSH is about to ask the user
 * something, so an approval request is noticeable while the DSH window is
 * behind another one.
 *
 * Triggers, both observed read-only:
 *
 * - `session/event` + `approval/asked`: the durable audit event
 *   `dsh-user-approval` appends for every permission request, *before* the
 *   answerer waterfall runs. It is therefore independent of who answers, of
 *   listener order, and of the approval outcome — and, unlike a
 *   `approval/request` listener, it can never veto or delay a prompt. The
 *   matching `approval/decided` retires the in-app copy of the notice.
 * - `user-questions/request`: the `ask_user_question` waterfall. This one is a
 *   pure observer registered with `prepend`, so it still passes `next()`
 *   through untouched.
 *
 * How a prompt is raised depends on what the browser half reports (see
 * `presence.js`): a session already on screen is not announced at all, a window
 * in front on *another* session gets an in-app notice, and a window that is not
 * in front (or no window at all) gets the OS toast.
 *
 * Clicking a notification activates `<focusScheme>://focus?session=<id>`, a
 * per-user URL scheme this plugin registers. The registered command is
 * `wscript.exe` running `focus.vbs` — a GUI-subsystem host, so no console ever
 * flashes — which brings the window forward and then GETs this plugin's own
 * `…/activate` route with that query, so the page switches to the session the
 * notification was about.
 *
 * An approval toast also carries two protocol actions — 允许一次 / 拒绝 — that
 * activate `<focusScheme>://decide?…`. They do not answer anything here: the
 * host forwards the decision to the page, which resolves the *same* pending
 * approval its own card would. Answering from the host instead would have to
 * race the `approval/request` waterfall, and the in-app card — driven by the
 * client's own pending request — would then be left on screen after the toast
 * already answered. The buttons are only offered while a page is connected, and
 * a decision is only accepted for an approval that is still pending.
 *
 * @module dsh-approval-notifier
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigResolver } from './config.js';
import { createNotifier, defaultPowershellPath } from './notify.js';
import { buildApprovalNotification, buildQuestionNotification, buildTestNotification } from './message.js';
import { approvalPolicyIsNever, readSessionContext } from './session-read.js';
import { findDesktopInstall } from './desktop.js';
import { createInbox } from './inbox.js';
import { createPresence, decideDelivery, DELIVERY } from './presence.js';
import {
  buildAppLaunchCommand,
  buildVbsCommand,
  createProtocolHandler,
  defaultWscriptPath,
  probeScriptHost,
} from './protocol.js';
import { createShortcutRegistrar } from './shortcut.js';

/** The plugin name every log line and slot carries. */
const name = 'dsh-approval-notifier';

/** Route prefix shared with the browser half. */
const ROUTE_BASE = '/dsh-approval-notifier';

/** Directory holding the scripts shipped beside this module. */
const LIB_DIR = dirname(fileURLToPath(import.meta.url));

/** The toast script, run once per notification. */
const TOAST_SCRIPT = join(LIB_DIR, 'toast.ps1');

/** The click handler the URL scheme runs. */
const FOCUS_SCRIPT = join(LIB_DIR, 'focus.vbs');

/**
 * The script that registers the toast identity's Start Menu shortcut.
 *
 * Without it a toast is written to the database and never displayed: the shell
 * will not render for an AppUserModelID it cannot map to an installed app, and
 * for a non-packaged app that mapping is a Start Menu shortcut carrying the id.
 */
const SHORTCUT_SCRIPT = join(LIB_DIR, 'register-shortcut.ps1');

/** Default hold for the page's long poll, in seconds. */
const DEFAULT_EVENT_WAIT_SECONDS = 25;

/** Longest a page may hold the event route open, in milliseconds. */
const MAX_EVENT_WAIT_MS = 60000;

/** How long a pending approval stays answerable from a toast. */
const PENDING_APPROVAL_TTL_MS = 600000;

/**
 * Start the plugin.
 *
 * @param ctx - the cordis context.
 * @param pluginConfig - the profile's config object for this plugin.
 * @param overrides - injection points used by the test suite.
 * @returns handles the tests drive.
 */
export function start(ctx, pluginConfig = {}, overrides = {}) {
  const env = overrides.env ?? process.env;
  const now = overrides.now ?? Date.now;
  const spawn = overrides.spawn ?? nodeSpawn;
  const execPath = overrides.execPath ?? process.execPath;
  const platform = overrides.platform ?? process.platform;

  const resolver = createConfigResolver({
    pluginConfig,
    env,
    home: overrides.home,
    filePath: overrides.configPath,
    autoCreate: overrides.autoCreate,
  });
  const configCreated = resolver.ensureFile();

  /** Report one boot/diagnostic line where a human will see it. */
  const report = overrides.report ?? ((message) => {
    try {
      process.stdout.write(`[${name}] ${message}\n`);
    } catch {
      // A closed stdout must not stop the plugin.
    }
  });

  const install = findDesktopInstall({ execPath, env, settings: pluginConfig });

  /** The route that receives a click, or `''` until the port is known. */
  const activateUrlOf = () => {
    try {
      const port = serverPort();
      if (port === 0) return '';
      return `http://127.0.0.1:${port}${ROUTE_BASE}/activate`;
    } catch {
      return '';
    }
  };

  /** The http.Server port the harness bound, or 0. */
  function serverPort() {
    const server = overrides.webServer ?? serviceOf('webServer');
    if (server === undefined || server === null) return 0;
    const port = Number(server.port);
    return Number.isFinite(port) && port > 0 ? port : 0;
  }

  /** The command a click runs, re-resolved whenever the port changes. */
  let clickMemo = { key: '', target: { url: '', label: '', scheme: false } };

  const protocolHandler = createProtocolHandler({
    scheme: () => resolver.current().focusScheme,
    logger: ctx.logger,
    run: overrides.reg,
  });

  /** Whether the script host can run `focus.vbs` (probed once per process). */
  let scriptHostVerdict;

  function scriptHostWorks() {
    if (scriptHostVerdict !== undefined) return scriptHostVerdict;
    scriptHostVerdict = overrides.probeScriptHost ?? (() => {
      const wscript = defaultWscriptPath(env, platform);
      if (wscript === '') return false;
      return probeScriptHost(wscript, FOCUS_SCRIPT);
    });
    return scriptHostVerdict;
  }

  /** Pick the registry command that brings DSH forward, or `''`. */
  function chooseFocusCommand(exePath, activateUrl) {
    const wscript = defaultWscriptPath(env, platform);
    if (wscript !== '' && scriptHostWorks()) {
      return buildVbsCommand(wscript, FOCUS_SCRIPT, exePath, activateUrl);
    }
    return exePath === '' ? '' : buildAppLaunchCommand(exePath);
  }

  const notifier = createNotifier({
    getSettings: () => getSettings(),
    scriptPath: TOAST_SCRIPT,
    spawn,
    platform,
    env,
    logger: ctx.logger,
    now,
  });

  /**
   * The toast identity registrar.
   *
   * `appId` is only a string until a shortcut carrying it exists, and an
   * unregistered id produces toasts that WinRT accepts, writes to the database,
   * and never displays. Keeping this next to the notifier makes the pairing
   * obvious: one raises the toast, the other makes it visible.
   *
   * The PowerShell path is read from the raw config resolver rather than through
   * `getSettings()`: `getSettings()` is what calls `ensure()` below, so asking
   * it for the executable here would recurse back into this registrar.
   */
  const shortcutRegistrar = createShortcutRegistrar({
    powershellPath: () => {
      const configured = resolver.current().powershellPath;
      return configured !== '' ? configured : defaultPowershellPath(env, platform);
    },
    scriptPath: SHORTCUT_SCRIPT,
    platform,
    env,
    logger: ctx.logger,
    run: overrides.runShortcut,
  });

  const presence = createPresence({ now, ttlMs: overrides.presenceTtlMs });
  const inbox = createInbox({ now, limit: overrides.inboxLimit });
  const delivery = { silent: 0, inApp: 0, toast: 0 };

  /** Read one optional service without failing when it is not composed. */
  const serviceOf = (key) => {
    try {
      return ctx.get?.(key);
    } catch {
      return undefined;
    }
  };

  /**
   * The secret every decision URL carries and the route checks.
   *
   * The `…/activate` route is loopback and unauthenticated — that was harmless
   * while it could only navigate, but it can now answer a permission request.
   * The approval id is a UUID, yet `/status` publishes the pending notice keys,
   * so any local process could otherwise read one and approve on the user's
   * behalf. A per-process token keeps a decision to a toast the user was
   * actually shown. It never appears in `/status`, in the log, or in a response.
   */
  const decisionToken = randomUUID().replace(/-/gu, '');

  /**
   * Approval requests that are still open, by notice key.
   *
   * Populated from the durable `approval/asked` audit event and cleared by the
   * matching `approval/decided`. A decision is only accepted for a key that is
   * still here, which is what stops a stale toast (the user answered it in the
   * app an hour ago) from answering whatever approval happens to be pending
   * later.
   */
  const pendingApprovals = new Map();

  /**
   * The still-open approval for one notice key, if any.
   *
   * Entries expire: a missed `approval/decided` (a crash, a reload) must not
   * leave a key answerable forever.
   *
   * @param key - the notice key.
   * @returns the entry, or undefined.
   */
  const pendingApproval = (key) => {
    const entry = pendingApprovals.get(key);
    if (entry === undefined) return undefined;
    if (now() - entry.at > PENDING_APPROVAL_TTL_MS) {
      pendingApprovals.delete(key);
      return undefined;
    }
    return entry;
  };

  /**
   * Resolve what clicking a notification should do.
   *
   * `focus-app` (and `auto`, when a desktop install is found) registers a
   * per-user URL scheme that brings the DSH Desktop window forward; the toast
   * then activates `<scheme>://focus`. When that is unavailable, `auto` falls
   * back to opening `openUrl`, and `none` does nothing at all.
   *
   * @param settings - merged settings.
   * @returns `{ url, label, scheme }`.
   */
  const computeClick = (settings) => {
    const nothing = { url: '', label: '', scheme: false };
    if (!settings.enabled || settings.clickAction === 'none') {
      // An explicit opt-out also removes the scheme this plugin owns.
      if (settings.clickAction === 'none') protocolHandler.remove();
      return nothing;
    }
    if (settings.clickAction === 'open-url') {
      return settings.openUrl === '' ? nothing : { url: settings.openUrl, label: '打开 DSH 页面', scheme: false };
    }
    const configuredExe = settings.desktopExePath;
    const exePath = configuredExe !== '' ? configuredExe : install.exePath;
    if (exePath !== '' && settings.focusScheme !== '') {
      const command = chooseFocusCommand(exePath, activateUrlOf());
      if (command !== '' && protocolHandler.ensure(command)) {
        return { url: `${settings.focusScheme}://focus`, label: '查看该会话', scheme: true };
      }
    }
    if (settings.clickAction === 'auto' && settings.openUrl !== '') {
      return { url: settings.openUrl, label: '打开 DSH 页面', scheme: false };
    }
    return nothing;
  };

  /**
   * Ensure the configured `appId` is backed by a Start Menu shortcut.
   *
   * Called on every settings resolution rather than once at startup: the id and
   * the executable are both configurable, and a toast raised under an id with no
   * shortcut is written to the database and silently dropped. The registrar is
   * idempotent and cheap when the shortcut already carries the right id (it
   * skips creating anything), and it never throws.
   */
  const ensureToastIdentity = (settings) => {
    if (!settings.enabled) return;
    const configuredExe = settings.desktopExePath;
    const exePath = configuredExe !== '' ? configuredExe : install.exePath;
    if (exePath === '') return;
    shortcutRegistrar.ensure({
      appId: settings.appId,
      targetPath: exePath,
      iconPath: settings.iconPath,
      workingDirectory: dirname(exePath),
    });
  };

  /** Re-resolve the click target only when its inputs moved. */
  const resolveClick = (settings) => {
    const key = JSON.stringify([
      settings.enabled,
      settings.clickAction,
      settings.desktopExePath,
      install.exePath,
      settings.openUrl,
      settings.focusScheme,
      activateUrlOf(),
    ]);
    if (clickMemo.key === key) return clickMemo.target;
    const target = computeClick(settings);
    clickMemo = { key, target };
    return target;
  };

  /**
   * Ensure the toast identity only when its inputs move.
   *
   * `getSettings` runs on every notification (and several times per HTTP
   * request), so an unconditional `ensure` would spawn a PowerShell process each
   * time. The identity only changes when the id or the executable changes, which
   * is the memo key.
   *
   * A failure is retried, but not immediately: a machine where registration
   * cannot succeed (no Start Menu, locked-down policy, missing PowerShell) would
   * otherwise pay for a doomed 1.5 s child process on every single call. The
   * retry is throttled to one attempt per `RETRY_MS`, so a transient failure
   * still heals within one notification cycle.
   */
  const RETRY_MS = 60000;
  let identityMemo = '';
  let identityFailed = '';
  let identityRetryAt = 0;
  const resolveToastIdentity = (settings) => {
    if (!settings.enabled) return;
    const configuredExe = settings.desktopExePath;
    const exePath = configuredExe !== '' ? configuredExe : install.exePath;
    const key = JSON.stringify([settings.appId, exePath, settings.iconPath]);
    if (key === identityMemo) return;
    if (key === identityFailed && now() < identityRetryAt) return;
    ensureToastIdentity(settings);
    if (shortcutRegistrar.status().ok) {
      identityMemo = key;
      identityFailed = '';
    } else {
      identityFailed = key;
      identityRetryAt = now() + RETRY_MS;
    }
  };

  const getSettings = () => {
    const settings = resolver.current();
    if (settings.iconPath === '') settings.iconPath = install.iconPath;
    const click = resolveClick(settings);
    settings.clickUrl = click.url;
    settings.clickLabel = click.label;
    settings.clickScheme = click.scheme;
    resolveToastIdentity(settings);
    return settings;
  };

  /**
   * The click target for one notification, with the session folded in.
   *
   * A protocol target gets `?session=<id>` appended, so the click can switch the
   * page to the session the notification was about. Any other target (a plain
   * page URL) is left alone: it has no notion of sessions.
   *
   * @param settings - merged settings.
   * @param sessionId - the session the notification belongs to.
   * @returns the activation URL, or `''` for an inert toast.
   */
  const clickTargetFor = (settings, sessionId) => {
    const base = typeof settings.clickUrl === 'string' ? settings.clickUrl : '';
    if (base === '' || settings.clickScheme !== true || sessionId === '') return base;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}session=${encodeURIComponent(sessionId)}`;
  };

  /**
   * One decision action URL: what a 允许一次 / 拒绝 button activates.
   *
   * @param settings - merged settings.
   * @param decision - `'allow'` or `'deny'`.
   * @param sessionId - the session the approval belongs to.
   * @param key - the notice key (`approval|<approval id>`).
   * @returns the activation URL.
   */
  const decisionUrl = (settings, decision, sessionId, key) => [
    `${settings.focusScheme}://decide`,
    `?decision=${decision}`,
    `&session=${encodeURIComponent(sessionId)}`,
    `&key=${encodeURIComponent(key)}`,
    `&t=${decisionToken}`,
  ].join('');

  /**
   * The two decision buttons an approval toast may carry.
   *
   * They are offered only when they can actually work: a page must be connected
   * to answer on the user's behalf, and the click must be able to reach this
   * process at all (the scheme route is registered). Claiming the buttons
   * otherwise would be a lie the user only discovers by pressing one.
   *
   * `settings.decideFromToast === false` turns them off (`clickAction: none`
   * already removes the scheme, which disables them too).
   *
   * @param settings - merged settings.
   * @param sessionId - the session the approval belongs to.
   * @param key - the notice key (`approval|<approval id>`).
   * @returns the `<actions>` entries, or `[]`.
   */
  const decisionActionsFor = (settings, sessionId, key) => {
    if (settings.decideFromToast === false) return [];
    if (settings.clickScheme !== true || settings.focusScheme === '') return [];
    if (typeof key !== 'string' || key === '' || sessionId === '') return [];
    if (!presence.live()) return [];
    return [
      { content: '允许一次', arguments: decisionUrl(settings, 'allow', sessionId, key) },
      { content: '拒绝', arguments: decisionUrl(settings, 'deny', sessionId, key) },
    ];
  };

  /**
   * Queue the in-app copy of one notice.
   *
   * @param notification - the record the transport would have sent.
   * @param sessionId - the session it belongs to.
   */
  const queueNotice = (notification, sessionId) => {
    const kind = notification?.kind;
    if (kind !== 'approval' && kind !== 'question' && kind !== 'test') return;
    // The card can now answer an approval itself, so it needs the same identity
    // the toast buttons carry: without the call id, a stale card could answer a
    // later approval in the same session.
    const key = notification.noticeKey ?? notification.key;
    const pending = key === undefined ? undefined : pendingApprovals.get(String(key));
    inbox.push({
      kind,
      key,
      sessionId,
      title: notification.title,
      lines: notification.lines,
      callId: pending === undefined ? '' : pending.callId,
      toolName: typeof notification.toolName === 'string' ? notification.toolName : '',
    });
  };

  /** Retire the in-app copy of one settled prompt. */
  const retireNotice = (notification, sessionId) => {
    if (notification === undefined || notification === null) return;
    const key = notification.noticeKey ?? notification.key;
    try {
      inbox.resolve(key, sessionId);
    } catch {
      // The queue is bounded and never throws; this is pure defence.
    }
  };

  /**
   * Raise one notification the way the current page state calls for.
   *
   * @param notification - the record built by `message.js`.
   * @param sessionId - the session the prompt belongs to.
   */
  const dispatch = (notification, sessionId) => {
    let settings;
    let decision;
    try {
      settings = getSettings();
      decision = decideDelivery(sessionId, presence, settings);
    } catch (error) {
      // Never let the routing decision cost the notification itself.
      settings = undefined;
      decision = DELIVERY.TOAST;
      ctx.logger?.warn?.(`${name}: delivery decision failed: ${String(error)}`);
    }
    if (decision === DELIVERY.SILENT) {
      delivery.silent += 1;
      notifier.note(`SKIP on-screen | ${notification.lines.join(' | ')}`);
      return;
    }
    if (settings?.notifyInApp !== false) queueNotice(notification, sessionId);
    if (decision === DELIVERY.IN_APP) {
      delivery.inApp += 1;
      notifier.note(`IN-APP | ${notification.lines.join(' | ')}`);
      return;
    }
    delivery.toast += 1;
    const target = clickTargetFor(settings ?? {}, sessionId);
    const key = notification.noticeKey ?? notification.key;
    // Approval toasts get the two decision buttons; the body click still jumps
    // to the session, so the label button would only crowd them out.
    const actions = notification.kind === 'approval'
      ? decisionActionsFor(settings ?? {}, sessionId, key)
      : [];
    notifier.deliver(() => {
      const withClick = target === '' ? notification : { ...notification, clickUrl: target };
      return actions.length === 0 ? withClick : { ...withClick, actions };
    });
  };

  /**
   * Notify for every durable approval request, and retire the notice when the
   * request is decided.
   */
  const onSessionEvent = (session, event) => {
    try {
      const type = event?.type;
      if (type === 'approval/decided') {
        const id = event.data?.id;
        if (id === undefined || id === null) return;
        pendingApprovals.delete(`approval|${String(id)}`);
        inbox.resolve(`approval|${String(id)}`);
        return;
      }
      if (type !== 'approval/asked') return;
      const settings = getSettings();
      if (!settings.enabled || !settings.notifyApprovals) return;
      if (approvalPolicyIsNever(serviceOf('approval'), session)) return;
      const data = event.data ?? {};
      const info = readSessionContext(session, {
        callId: data.callId,
        includeToolCall: settings.includeToolCall,
      });
      if (data.id !== undefined && data.id !== null) {
        pendingApprovals.set(`approval|${String(data.id)}`, {
          sessionId: info.sessionId,
          callId: data.callId === undefined ? '' : String(data.callId),
          at: now(),
        });
      }
      dispatch(buildApprovalNotification(data, info), info.sessionId);
    } catch (error) {
      ctx.logger?.warn?.(`${name}: approval notification failed: ${String(error)}`);
    }
  };

  /** Notify for every pending `ask_user_question`, then continue the waterfall. */
  const onUserQuestion = (request, next) => {
    let notification;
    let sessionId = '';
    try {
      const settings = getSettings();
      if (settings.enabled && settings.notifyQuestions) {
        const info = readSessionContext(request?.agent?.session, { includeToolCall: false });
        notification = buildQuestionNotification(request, info);
        sessionId = info.sessionId;
        dispatch(notification, sessionId);
      }
    } catch (error) {
      ctx.logger?.warn?.(`${name}: question notification failed: ${String(error)}`);
    }
    const outcome = next();
    // The answer settles the card: whatever resolves the waterfall retires it.
    if (notification !== undefined) {
      const settle = () => retireNotice(notification, sessionId);
      Promise.resolve(outcome).then(settle, settle);
    }
    return outcome;
  };

  const disposers = [];
  try {
    disposers.push(ctx.on('session/event', onSessionEvent));
    // `prepend` keeps the observer ahead of the answerer purely so its
    // notification is spawned before the answerer awaits a human.
    disposers.push(ctx.on('user-questions/request', onUserQuestion, { prepend: true }));
  } catch (error) {
    ctx.logger?.warn?.(`${name}: could not subscribe: ${String(error)}`);
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.reverse()) {
      try {
        if (typeof dispose === 'function') dispose();
      } catch {
        // Unloading already disposed it.
      }
    }
  }, `${name}: listener disposal`);

  const statusBody = () => ({
    ok: true,
    name,
    ...notifier.status(),
    configCreated,
    triggeredBy: ['session/event:approval/asked', 'user-questions/request'],
    desktop: {
      appRoot: install.appRoot,
      exePath: install.exePath,
      processName: install.processName,
      iconPath: getSettings().iconPath,
      detectedIconPath: install.iconPath,
    },
    protocol: protocolHandler.status(),
    // The toast identity. `ok: false` here is why a toast can be delivered
    // (`Show()` accepts it and the database records it) yet never appear.
    toastIdentity: shortcutRegistrar.status(),
    attention: {
      activateUrl: activateUrlOf(),
      delivery: { ...delivery },
      presence: presence.snapshot(),
      inbox: {
        size: inbox.size(),
        cursor: inbox.cursor(),
        // The notice key is what a decision URL has to name, so it is not
        // published: this route is readable by any local process, and the
        // per-process token only stays meaningful if the key is not handed out
        // next to it.
        recent: inbox.recent(5).map((entry) => ({
          seq: entry.seq,
          at: entry.at,
          kind: entry.kind,
          sessionId: entry.sessionId,
          title: entry.title,
        })),
      },
      // A count, never the keys, for the same reason.
      pendingApprovals: pendingApprovals.size,
      decideFromToast: getSettings().decideFromToast !== false,
    },
  });

  /** Write one JSON answer. */
  const sendJson = (response, status, body) => {
    const text = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    });
    response.end(text);
  };

  /** GET /dsh-approval-notifier/status — resolved config, transport, counters. */
  const statusHandler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    try {
      const body = statusBody();
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        response.end();
        return;
      }
      sendJson(response, 200, body);
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * The session a self-test notification should point at.
   *
   * A click can only switch sessions when the toast carries one, and the test
   * route deliberately bypasses `dispatch` — so without this, "测试通知" proved
   * the transport while silently skipping the click target: clicking it brought
   * the window forward and nothing else, which reads exactly like a broken
   * jump. Prefer the session a page is actually showing.
   */
  const reportedSessionId = () => {
    try {
      const pages = presence.snapshot().pages;
      const showing = pages.find((page) => page.sessionId !== '' && page.visible === true);
      if (showing !== undefined) return showing.sessionId;
      const any = pages.find((page) => page.sessionId !== '');
      return any === undefined ? '' : any.sessionId;
    } catch {
      return '';
    }
  };

  /** GET /dsh-approval-notifier/test — fire one real notification, report the result. */
  const testHandler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, POST' });
      response.end();
      return;
    }
    try {
      const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
      const overridesForTest = {};
      const title = params.get('title');
      const body = params.get('body');
      if (title !== null && title !== '') overridesForTest.title = title;
      if (body !== null && body !== '') overridesForTest.body = body;
      const silent = params.get('silent');
      const notification = buildTestNotification(overridesForTest);
      if (silent === '1' || silent === 'true') notification.silent = true;
      // `?session=` names one explicitly; otherwise the test points at whatever
      // a page reports, so it exercises the same click path a real toast does.
      const requestedSession = params.get('session');
      const sessionId = requestedSession !== null && requestedSession !== '' ? requestedSession : reportedSessionId();
      // Empty means "no session target": the toast then keeps the generic
      // focus URL from settings, which can only bring the window forward.
      const clickUrl = sessionId === '' ? '' : clickTargetFor(getSettings(), sessionId);
      if (clickUrl !== '') notification.clickUrl = clickUrl;
      // `?decide=1` adds the two approval buttons to the test toast, wired to a
      // short-lived test key so the whole decision path — button, protocol
      // activation, route, page — can be exercised without waiting for a real
      // permission request.
      if (params.get('decide') === '1') {
        const testKey = `test|decide|${randomUUID()}`;
        const target = sessionId === '' ? 'test-session' : sessionId;
        pendingApprovals.set(testKey, { sessionId: target, callId: '', at: now() });
        notification.noticeKey = testKey;
        notification.actions = [
          { content: '允许一次', arguments: decisionUrl(getSettings(), 'allow', target, testKey) },
          { content: '拒绝', arguments: decisionUrl(getSettings(), 'deny', target, testKey) },
        ];
      }
      if (params.get('inapp') === '1') {
        queueNotice({ ...notification, noticeKey: 'test|manual' }, sessionId);
        sendJson(response, 200, {
          ok: true,
          queued: 'in-app',
          sessionId,
          clickUrl,
          detail: { kind: 'test' },
          hint: sessionId === ''
            ? '还没有页面上报它在看哪个会话，所以这条自检卡片点进去不会切会话；用 ?session=<会话 id> 指定一个。'
            : '点击这张卡片应该切到 sessionId 指定的会话。',
        });
        return;
      }
      const result = await notifier.send(notification);
      const capability = notifier.capabilities();
      sendJson(response, 200, {
        ok: result.ok === true,
        sessionId,
        clickUrl,
        actions: Array.isArray(notification.actions) ? notification.actions.length : 0,
        detail: result,
        transport: capability.transport,
        powershellPath: capability.powershellPath === undefined ? '' : capability.powershellPath,
        hint: result.ok === true
          ? (params.get('decide') === '1'
            ? '测试通知带上了「允许一次 / 拒绝」两颗按钮；点任一颗应该写到 %TEMP%\\dsh-approval-notifier-click.log，并在插件日志里留下 DECIDE 一行（不会真的回答任何审批）。'
            : (sessionId === ''
              ? '通知已发送，但它没有带会话（还没有页面上报在看哪个会话），点它只会把窗口带到前台；加 ?session=<会话 id> 就能连跳转一起测。'
              : '通知已发送，并带上了会话 —— 点它应该切到该会话；点完没跳就看 %TEMP%\\dsh-approval-notifier-click.log。'))
          : (result.error ?? capability.reason ?? 'notification failed'),
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * POST /dsh-approval-notifier/client-state — one page reports itself.
   *
   * Body: `{ clientId, sessionId, visible }`. The answer carries the decision
   * this state would produce right now, which is what makes the wiring
   * debuggable from the browser console alone.
   */
  const clientStateHandler = async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { allow: 'POST' });
      response.end();
      return;
    }
    let state;
    try {
      const raw = await readBody(request);
      state = JSON.parse(raw);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: `body must be JSON: ${String(error)}` });
      return;
    }
    if (!presence.report(state)) {
      sendJson(response, 400, { ok: false, error: 'clientId 不能为空' });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      sessionId: typeof state.sessionId === 'string' ? state.sessionId : '',
      visible: state.visible === true,
      decision: decideDelivery(state.sessionId, presence, getSettings()),
    });
  };

  /** Read a request body (bounded, so a stray client cannot exhaust memory). */
  const readBody = (request, limit = 64 * 1024) => new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.setEncoding?.('utf8');
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        return;
      }
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
    request.on('aborted', () => reject(new Error('aborted')));
  });

  /**
   * GET /dsh-approval-notifier/events — the page's notice stream.
   *
   * A cursor query (`cursor=<seq>`, `client=<id>`, `wait=<seconds>`) holds the
   * response open until something is queued or the wait expires, which is what
   * makes a toast click switch sessions immediately instead of on the next poll.
   */
  const eventsHandler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { allow: 'GET, HEAD' });
      response.end();
      return;
    }
    try {
      const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
      const cursor = Number(params.get('cursor') ?? '0');
      const clientId = params.get('client') ?? '';
      if (clientId !== '') presence.touch(clientId);
      const requested = request.method === 'HEAD' ? 0 : Number(params.get('wait') ?? `${DEFAULT_EVENT_WAIT_SECONDS}`);
      const waitMs = Number.isFinite(requested) ? Math.min(Math.max(requested * 1000, 0), MAX_EVENT_WAIT_MS) : 0;
      let events = inbox.since(cursor);
      if (events.length === 0 && waitMs > 0) {
        await new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            unsubscribe();
            resolve();
          };
          const timer = setTimeout(finish, waitMs);
          const unsubscribe = inbox.onPush(finish);
          request.on('close', finish);
          request.on('aborted', finish);
        });
        events = inbox.since(cursor);
      }
      if (clientId !== '') presence.touch(clientId);
      sendJson(response, 200, { ok: true, cursor: inbox.cursor(), events });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * GET /dsh-approval-notifier/activate — a toast click, reported by `focus.vbs`.
   *
   * Two kinds of click arrive here, distinguished by the URL's query:
   *
   * - `?session=<id>` (a body click): queue a `navigate` entry so whichever page
   *   is streaming `/events` opens that session.
   * - `?decision=allow|deny&key=…&t=…` (a 允许一次 / 拒绝 button): queue a
   *   `decide` entry the page applies to the approval its own card is showing.
   *   The key must still be pending and the token must match, so a stale toast
   *   or a local process replaying a key cannot answer something else.
   *
   * Loopback-only, no credentials beyond that token: it carries no authority
   * beyond "show this session" / "answer the request this toast was about", and
   * the route answers 200 even when no page is connected, because the window was
   * already brought forward by then.
   */
  const activateHandler = async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'POST') {
      response.writeHead(405, { allow: 'GET, HEAD, POST' });
      response.end();
      return;
    }
    try {
      const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams;
      const sessionId = (params.get('session') ?? '').trim();
      const pages = presence.snapshot().pages.length;
      const requested = (params.get('decision') ?? '').trim();

      if (requested !== '') {
        const key = (params.get('key') ?? '').trim();
        const token = (params.get('t') ?? '').trim();
        const pending = pendingApproval(key);
        const accepted = (requested === 'allow' || requested === 'deny')
          && token === decisionToken
          && pending !== undefined;
        // Only an approval this plugin actually announced, and that is still
        // open, may be answered this way.
        const event = accepted
          ? inbox.push({
            kind: 'decide',
            key,
            sessionId: pending.sessionId,
            callId: pending.callId,
            decision: requested === 'allow' ? 'allowed-once' : 'rejected',
          })
          : undefined;
        // Answering from the toast retires the approval. A real one is cleared by
        // its own `approval/decided` audit event, but a `?decide=1` self-test key
        // has no such event behind it, so it would otherwise stay pending for
        // the life of the process and let the same stale toast be answered again.
        if (accepted) pendingApprovals.delete(key);
        notifier.note(
          `DECIDE ${requested} key=${key} accepted=${String(accepted)}`
          + `${pending === undefined ? ' (not pending)' : ''}`
          + `${token !== decisionToken ? ' (bad token)' : ''} pages=${String(pages)}`,
        );
        sendJson(response, 200, {
          ok: true,
          decided: accepted,
          sessionId: pending === undefined ? sessionId : pending.sessionId,
          queued: event !== undefined,
          pages,
        });
        return;
      }

      const event = sessionId === '' ? undefined : inbox.push({ kind: 'navigate', sessionId });
      // A click is otherwise invisible in this log, which left "clicking the
      // notification did nothing" with no evidence on either side.
      notifier.note(
        sessionId === ''
          ? `CLICK without a session (window only) pages=${String(pages)}`
          : `CLICK session=${sessionId} queued=${String(event !== undefined)} pages=${String(pages)}`,
      );
      sendJson(response, 200, {
        ok: true,
        sessionId,
        queued: event !== undefined,
        pages,
      });
    } catch (error) {
      sendJson(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };

  /** Register the diagnostics routes once the HTTP surface exists. */
  const mount = (scope) => {
    const target = scope ?? ctx;
    const webServer = webServerOf(target);
    if (webServer === undefined) {
      report(`diagnostics routes NOT mounted: webServer service unavailable`);
      return;
    }
    const routes = [];
    try {
      routes.push(webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/status`, handler: statusHandler }));
      routes.push(webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/test`, handler: testHandler }));
      routes.push(webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/client-state`, handler: clientStateHandler }));
      routes.push(webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/events`, handler: eventsHandler }));
      routes.push(webServer.register({ kind: 'exact', path: `${ROUTE_BASE}/activate`, handler: activateHandler }));
      mountedRoutes = true;
    } catch (error) {
      report(`diagnostics routes failed to mount: ${String(error)}`);
    }
    // The port is only knowable now, and it belongs in the registered click
    // command; recomputing the click here rewrites the scheme when needed.
    try {
      getSettings();
    } catch {
      // Registration will be retried on the next notification.
    }
    target.effect?.(() => () => {
      for (const dispose of routes.reverse()) {
        try {
          if (typeof dispose === 'function') dispose();
        } catch {
          // Already removed.
        }
      }
    }, `${name}: route disposal`);
  };

  /** Read the webServer service without failing when it is absent. */
  function webServerOf(target) {
    try {
      if (target.webServer !== undefined) return target.webServer;
      return target.get?.('webServer');
    } catch {
      return undefined;
    }
  }

  let mountedRoutes = false;
  let mounted = false;
  const mountOnce = (scope) => {
    if (mounted) return;
    mounted = true;
    mount(scope);
  };
  if (webServerOf(ctx) !== undefined) mountOnce(ctx);
  else {
    try {
      // Inject ONLY a service that exists in this composition. `ctx.inject()`
      // mounts a child plugin that waits for EVERY listed name, so a name that
      // does not exist leaves the routes unmounted with no error at all.
      ctx.inject(['webServer'], (scope) => mountOnce(scope));
    } catch (error) {
      report(`could not wait for webServer: ${String(error)}`);
    }
  }

  const capability = notifier.capabilities();
  report(
    `ready (transport=${capability.transport}${capability.supported ? '' : `, ${capability.reason}`}, `
    + `click=${getSettings().clickUrl === '' ? 'none' : getSettings().clickUrl}, `
    + `activate=${activateUrlOf() === '' ? 'none' : activateUrlOf()}, `
    + `desktop=${install.exePath || 'not found'}, routes=${mountedRoutes ? 'mounted' : 'pending/no-webServer'}, `
    + `config=${resolver.path}${configCreated ? ' [created]' : ''})`,
  );

  return {
    capability,
    activateUrl: activateUrlOf(),
    resolveClickTarget: clickTargetFor,
    reachability: () => ({ static: install, runtime: { execPath, platform } }),
    deliver: (notification) => notifier.send(notification),
    dispatch,
    presence,
    inbox,
    notifier,
    protocol: protocolHandler,
    settings: getSettings,
    pendingApprovals,
    decisionToken,
    status: statusBody,
    mount,
  };
}
