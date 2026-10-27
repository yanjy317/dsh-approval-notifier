/**
 * Windows toast transport plus dedupe, throttling, and diagnostics.
 *
 * The harness runs plugins in a plain Node process (the Electron main process
 * is not reachable from here), so the notification is produced by a short-lived
 * Windows PowerShell 5.1 child running `toast.ps1`, which calls the WinRT
 * `ToastNotificationManager` directly. That path needs no dependency, no
 * packaging, and no app registration.
 *
 * Nothing in this module ever rejects or throws into the caller: it sits on the
 * approval hot path, where a notification failure must stay invisible to the
 * approval it describes.
 *
 * @module dsh-approval-notifier/notify
 */

import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

/** How many notifications the diagnostics ring keeps. */
const RECENT_LIMIT = 25;

/** Log file size at which the log is truncated before the next append. */
const LOG_LIMIT_BYTES = 256 * 1024;

/** Rolling window used by the per-minute cap. */
const RATE_WINDOW_MS = 60000;

/**
 * Locate Windows PowerShell.
 *
 * PowerShell 7 cannot project the WinRT types without extra assemblies, so the
 * versioned 5.1 binary is preferred explicitly over whatever `powershell` the
 * PATH would resolve.
 *
 * @param env - environment to read.
 * @param platform - the running platform.
 * @returns the executable path (possibly a bare name, as a last resort).
 */
export function defaultPowershellPath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return '';
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot !== ''
    ? env.SystemRoot
    : (typeof env.windir === 'string' && env.windir !== '' ? env.windir : 'C:\\Windows');
  const candidate = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return existsSync(candidate) ? candidate : 'powershell.exe';
}

/**
 * Split one settings value into the payload fields `toast.ps1` consumes.
 *
 * The click target is per notification when the caller set one: an approval
 * toast must activate *its own session* (`…://focus?session=…`), not a shared
 * "bring the window forward" URL. Everything else comes from settings.
 *
 * `actions` are the toast's buttons (允许一次 / 拒绝 on an approval). They are
 * `{ content, arguments }` pairs the script turns into `<action>` elements;
 * anything incomplete is dropped rather than rendered as a dead button. When
 * actions are present the single label button is dropped: the body click still
 * activates the session, so a third button would only crowd the two that matter.
 *
 * @param notification - `{ lines, kind, clickUrl?, actions? }`.
 * @param settings - merged settings.
 * @returns the JSON payload for the child process.
 */
export function buildToastPayload(notification, settings) {
  const perNotification = typeof notification.clickUrl === 'string' ? notification.clickUrl : '';
  const launch = perNotification !== '' ? perNotification : (settings.clickUrl ?? settings.openUrl ?? '');
  const actions = (Array.isArray(notification.actions) ? notification.actions : []).filter(
    (action) => typeof action?.content === 'string' && action.content !== ''
      && typeof action?.arguments === 'string' && action.arguments !== '',
  ).map((action) => ({ content: action.content, arguments: action.arguments }));
  return {
    appId: settings.appId,
    lines: notification.lines,
    sound: settings.sound !== false && notification.silent !== true,
    launch,
    button: actions.length > 0 || launch === '' ? '' : (settings.clickLabel ?? ''),
    actions,
    icon: settings.iconPath ?? '',
  };
}

/**
 * Create the notifier.
 *
 * @param options - `{ getSettings, scriptPath, spawn?, platform?, env?, logger?, now? }`.
 * @returns `{ deliver, send, status, dispose, note, capabilities }`.
 */
export function createNotifier(options) {
  const getSettings = options.getSettings;
  const scriptPath = options.scriptPath;
  const spawn = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logger = options.logger;
  const now = options.now ?? Date.now;

  const counters = { delivered: 0, deduped: 0, throttled: 0, failed: 0, skipped: 0 };
  const lastKeyAt = new Map();
  const rateWindow = [];
  const recent = [];
  const live = new Set();
  let lastError = '';

  /** Log a diagnostic line to the plugin logger. */
  function log(level, message) {
    try {
      logger?.[level]?.(`dsh-approval-notifier: ${message}`);
    } catch {
      // A logger failure must never affect a notification.
    }
  }

  /** The transport this process would use, and why when it has none. */
  function capabilities() {
    if (platform !== 'win32') {
      return { transport: 'none', supported: false, reason: `only Windows has native toasts (this is ${platform})` };
    }
    const settings = getSettings();
    const powerShell = settings.powershellPath !== '' ? settings.powershellPath : defaultPowershellPath(env, platform);
    if (powerShell === '') {
      return { transport: 'none', supported: false, reason: 'Windows PowerShell 5.1 not found' };
    }
    return { transport: 'windows-toast', supported: true, reason: '', powershellPath: powerShell };
  }

  /** Append one line to the plugin's log file, if logging is on. */
  function note(message) {
    let path = '';
    try {
      const settings = getSettings();
      if (settings.log === false) return;
      path = typeof settings.logFile === 'string' ? settings.logFile : '';
    } catch {
      return;
    }
    if (path === '') return;
    try {
      if (existsSync(path) && statSync(path).size > LOG_LIMIT_BYTES) writeFileSync(path, '', 'utf8');
      appendFileSync(path, `[${new Date(now()).toISOString()}] ${message}\n`, 'utf8');
    } catch {
      // A read-only home must not cost the notification.
    }
  }

  /** Record one outcome for the diagnostics ring and the log. */
  function record(kind, ok, lines, error = '') {
    const entry = { at: now(), kind, ok, lines: [...lines], error };
    recent.push(entry);
    if (recent.length > RECENT_LIMIT) recent.shift();
    note(`${ok ? 'OK  ' : 'FAIL'} ${kind} | ${entry.lines.join(' | ')}${error === '' ? '' : ` | ${error}`}`);
    return entry;
  }

  /** The per-minute cap: prune the window, then decide. */
  function throttled(settings) {
    const time = now();
    while (rateWindow.length > 0 && time - rateWindow[0] > RATE_WINDOW_MS) rateWindow.shift();
    const limit = Number.isFinite(settings.maxPerMinute) ? settings.maxPerMinute : 30;
    if (rateWindow.length >= limit) return true;
    rateWindow.push(time);
    return false;
  }

  /** Whether this exact notice was already raised inside the dedupe window. */
  function deduped(settings, key) {
    if (typeof key !== 'string' || key === '') return false;
    const window = Number.isFinite(settings.dedupeMs) ? settings.dedupeMs : 1500;
    const time = now();
    const previous = lastKeyAt.get(key);
    lastKeyAt.set(key, time);
    for (const [stale, at] of lastKeyAt) {
      if (time - at > Math.max(window, RATE_WINDOW_MS)) lastKeyAt.delete(stale);
    }
    return previous !== undefined && time - previous <= window;
  }

  /**
   * Run `toast.ps1` once and classify its stdout.
   *
   * @param settings - merged settings.
   * @param payload - the JSON payload.
   * @returns `{ ok, error }`.
   */
  function runScript(settings, payload) {
    return new Promise((resolve) => {
      const capability = capabilities();
      if (!capability.supported) {
        resolve({ ok: false, error: capability.reason });
        return;
      }
      const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
      const timeout = Number.isFinite(settings.timeoutMs) ? settings.timeoutMs : 15000;
      let child;
      try {
        child = spawn(capability.powershellPath, [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-Payload',
          encoded,
        ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({ ok: false, error: `spawn failed: ${String(error)}` });
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
        finish({ ok: false, error: `toast script timed out after ${timeout} ms` });
      }, timeout);
      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
      });
      child.on('error', (error) => finish({ ok: false, error: `spawn failed: ${String(error)}` }));
      child.on('close', () => {
        if (stdout.includes('TOAST-OK')) finish({ ok: true, error: '' });
        else {
          const failLine = /TOAST-FAIL:[^\r\n]*/u.exec(stdout);
          const firstError = stderr.split(/\r?\n/u).find((line) => line.trim() !== '') ?? '';
          finish({ ok: false, error: failLine?.[0] ?? firstError ?? 'toast script reported nothing' });
        }
      });
    });
  }

  /**
   * Raise one notification, honouring the switches, dedupe and rate cap.
   *
   * @param notification - `{ kind, key?, noticeKey?, lines, clickUrl?, silent? }`.
   * @returns `{ ok, skipped?, error? }`.
   */
  async function send(notification) {
    const settings = getSettings();
    // `silent` is the self-test route's explicit opt-in; a disabled plugin
    // raises nothing at all.
    if (settings.enabled === false) {
      counters.skipped += 1;
      return { ok: false, skipped: true, error: 'notifications are disabled' };
    }
    if (deduped(settings, notification.key ?? notification.noticeKey)) {
      counters.deduped += 1;
      record('dedupe', true, notification.lines);
      return { ok: false, deduped: true };
    }
    if (throttled(settings)) {
      counters.throttled += 1;
      record('throttle', false, notification.lines, 'rate cap reached');
      return { ok: false, throttled: true, error: 'rate cap reached' };
    }
    const payload = buildToastPayload(notification, settings);
    const result = await runScript(settings, payload);
    if (result.ok) {
      counters.delivered += 1;
      record(notification.kind ?? 'notice', true, notification.lines);
      return { ok: true };
    }
    counters.failed += 1;
    lastError = result.error;
    record(notification.kind ?? 'notice', false, notification.lines, result.error);
    return { ok: false, error: result.error };
  }

  return {
    send,
    note,
    capabilities,
    /**
     * Fire and forget: a notification must never delay the prompt it describes.
     *
     * @param build - a thunk returning the notification (built lazily).
     */
    deliver(build) {
      let notification;
      try {
        notification = build();
      } catch (error) {
        log('warn', `could not build a notification: ${String(error)}`);
        return;
      }
      const attempt = send(notification).catch((error) => {
        log('warn', `notification failed: ${String(error)}`);
      });
      live.add(attempt);
      void attempt.finally(() => {
        live.delete(attempt);
      });
    },
    /** The diagnostics snapshot the status route returns. */
    status() {
      const capability = capabilities();
      return {
        transport: capability.transport,
        lastError,
        counters: { ...counters },
        recent: recent.slice(-10),
        ...(capability.powershellPath === undefined ? {} : { powershellPath: capability.powershellPath }),
        ...(capability.reason === '' ? {} : { reason: capability.reason }),
      };
    },
    /** Wait for in-flight deliveries (used by tests and shutdown). */
    async dispose() {
      await Promise.allSettled([...live]);
    },
  };
}
