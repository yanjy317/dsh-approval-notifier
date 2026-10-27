/**
 * Per-user URL-scheme registration, so a toast click can bring DSH forward.
 *
 * A toast produced from an unregistered AppUserModelID cannot call back into
 * this process: the only activation a non-packaged, unregistered app can
 * receive is *protocol* activation, which the shell resolves through
 * `HKCU\Software\Classes\<scheme>\shell\open\command`. Registering one scheme
 * there is what turns "click the notification" into "run focus.vbs".
 *
 * The registered command must never start a console program. `powershell.exe`
 * is console-subsystem, and its window is created before `-WindowStyle Hidden`
 * can hide it — a visible flash on every click. So the handler is either:
 *
 *   wscript.exe //B //NoLogo focus.vbs "<DSH Desktop.exe>" … "%1"  (GUI host)
 *   "<DSH Desktop.exe>" "%1"                                       (no script
 *       at all: the app's own single-instance handler restores and focuses)
 *
 * The second form is the fallback for a host where the script engine is
 * unavailable; the plugin probes the script host once at startup and picks.
 *
 * The registration is strictly per-user (`HKCU`, no elevation), carries only
 * our own scheme key, and is idempotent: the command is rewritten when it
 * changed and left alone when it did not. `remove()` deletes exactly that key.
 *
 * @module dsh-approval-notifier/protocol
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Registry root every registration lives under. */
const CLASSES = 'HKCU\\Software\\Classes';

/** Description stored on the scheme key (ASCII only: it is a registry value). */
const SCHEME_DESCRIPTION = 'URL:DSH approval notification focus protocol';

/**
 * Locate the Windows Script Host.
 *
 * @param env - environment to read.
 * @param platform - the running platform.
 * @returns the executable path, or `''` when unavailable.
 */
export function defaultWscriptPath(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return '';
  const root = typeof env.SystemRoot === 'string' && env.SystemRoot !== ''
    ? env.SystemRoot
    : (typeof env.windir === 'string' && env.windir !== '' ? env.windir : 'C:\\Windows');
  const candidate = `${root}\\System32\\wscript.exe`;
  return existsSync(candidate) ? candidate : 'wscript.exe';
}

/**
 * Build the `shell\open\command` value that runs the focus script.
 *
 * Quoting matters: the value is parsed as a command line by the shell, so every
 * path is wrapped — the default DSH Desktop install has a space in it.
 *
 * `activateUrl` is the plugin's own route on the harness's loopback HTTP
 * surface.
 *
 * The trailing `"%1"` is what carries the clicked URL. A protocol handler is
 * only handed the URL where the command names `%1`: without the placeholder the
 * shell starts the handler with **no URL argument at all**, so the script never
 * learns which session the notification was about and every click degrades to
 * "bring the window forward" — which reads exactly like a broken jump.
 *
 * @param wscriptPath - the Windows Script Host executable.
 * @param vbsPath - the focus script.
 * @param exePath - the desktop executable to focus (or start).
 * @param activateUrl - the route receiving the clicked query, or `''`.
 * @returns the command line stored in the registry.
 */
export function buildVbsCommand(wscriptPath, vbsPath, exePath, activateUrl = '') {
  const base = `"${wscriptPath}" //B //NoLogo "${vbsPath}" "${exePath}"`;
  const withRoute = activateUrl === '' ? base : `${base} --api "${activateUrl}"`;
  return `${withRoute} "%1"`;
}

/**
 * Build the script-free fallback: relaunch the desktop app and let its own
 * single-instance handler restore and focus the existing window.
 *
 * @param exePath - the desktop executable.
 * @returns the command line stored in the registry.
 */
export function buildAppLaunchCommand(exePath) {
  return `"${exePath}" "%1"`;
}

/**
 * Check that the script host can actually run the focus script.
 *
 * The `--probe` argument makes `focus.vbs` exit immediately, so this proves the
 * engine is present without activating anything. A Windows build with VBScript
 * removed as an optional feature fails here and the caller falls back.
 *
 * @param wscriptPath - the Windows Script Host executable.
 * @param vbsPath - the focus script.
 * @returns true when the script host ran it successfully.
 */
export function probeScriptHost(wscriptPath, vbsPath) {
  try {
    const result = spawnSync(wscriptPath, ['//B', '//NoLogo', vbsPath, '--probe'], {
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    });
    return result.status === 0 && result.error === undefined;
  } catch {
    return false;
  }
}

/**
 * Run `reg.exe` and capture its result.
 *
 * @param args - arguments after the executable name.
 * @returns `{ ok, code, stdout, stderr, error }`.
 */
function runReg(args) {
  try {
    const result = spawnSync('reg.exe', args, { windowsHide: true, encoding: 'utf8' });
    return {
      ok: result.status === 0 && result.error === undefined,
      code: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      error: result.error === undefined ? '' : String(result.error.message ?? result.error),
    };
  } catch (error) {
    return { ok: false, code: null, stdout: '', stderr: '', error: String(error) };
  }
}

/**
 * Create the protocol handler.
 *
 * @param options - `{ scheme, logger?, run? }`; `scheme` may be a string or a
 *   thunk (config can change at runtime, and the registry follows it). `run` is
 *   injectable so the registry is never touched from a test.
 * @returns `{ ensure, remove, status }`.
 */
export function createProtocolHandler(options) {
  const readScheme = typeof options.scheme === 'function' ? options.scheme : () => options.scheme;
  const logger = options.logger;
  const run = options.run ?? runReg;

  /** The registered command, or `''` when the scheme is absent. */
  function registeredCommand() {
    const result = run(['query', `${CLASSES}\\${readScheme()}\\shell\\open\\command`, '/ve']);
    if (!result.ok) return '';
    const match = /REG_SZ\s+(.*)$/m.exec(result.stdout);
    return match === null ? '' : match[1].trim();
  }

  function warn(message) {
    try {
      logger?.warn?.(`dsh-approval-notifier: ${message}`);
    } catch {
      // A logger failure must not affect registration.
    }
  }

  /**
   * Ensure the scheme resolves to the wanted focus command.
   *
   * @param command - the `shell\open\command` value to install.
   * @returns true when the scheme is (now) registered with that command.
   */
  function ensure(command) {
    if (registeredCommand() === command) return true;
    const scheme = readScheme();
    const steps = [
      ['add', `${CLASSES}\\${scheme}`, '/ve', '/d', SCHEME_DESCRIPTION, '/f'],
      // The shell recognises a scheme by this value's presence; its data is
      // irrelevant, but the value must exist.
      ['add', `${CLASSES}\\${scheme}`, '/v', 'URL Protocol', '/d', SCHEME_DESCRIPTION, '/f'],
      ['add', `${CLASSES}\\${scheme}\\shell\\open\\command`, '/ve', '/d', command, '/f'],
    ];
    for (const args of steps) {
      const result = run(args);
      if (!result.ok) {
        warn(`无法注册 ${scheme}: 协议（${result.error || result.stderr.trim() || `reg exit ${String(result.code)}`}）`);
        return false;
      }
    }
    return registeredCommand() === command;
  }

  /**
   * Delete the scheme key this plugin owns.
   *
   * `reg delete` on the scheme root removes its subkeys too, but a bare
   * `open\command` key can outlive it when only the leaf was created (an older
   * install, a partial write), so the leaf is deleted explicitly as well.
   *
   * @returns true when the key is gone afterwards.
   */
  function remove() {
    const scheme = readScheme();
    run(['delete', `${CLASSES}\\${scheme}\\shell\\open\\command`, '/f']);
    run(['delete', `${CLASSES}\\${scheme}\\shell`, '/f']);
    const result = run(['delete', `${CLASSES}\\${scheme}`, '/f']);
    return result.ok || registeredCommand() === '';
  }

  /** A JSON-able snapshot for diagnostics. */
  function status() {
    const current = registeredCommand();
    return {
      scheme: readScheme(),
      registered: current !== '',
      registeredCommand: current,
    };
  }

  return { ensure, remove, status };
}
