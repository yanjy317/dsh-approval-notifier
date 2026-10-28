/**
 * AppUserModelID registration for the toast identity.
 *
 * A Win32 process can raise a toast under any string it likes, and WinRT will
 * accept it: `Show()` returns normally and the payload is even written to
 * `wpndatabase`. What it will *not* do is display the toast. The shell only
 * renders for an AppUserModelID it can map back to an installed application,
 * and for a non-packaged app that mapping is a Start Menu shortcut whose
 * `System.AppUserModel.ID` property equals the id. Without one the toast is
 * silently dropped: no banner, no sound, nothing in the notification centre.
 *
 * That failure is invisible from the API — `Setting` still reports `Enabled`
 * and `Show()` still returns without throwing — so a plugin shipping a bare id
 * like `DSH.ApprovalNotifier` appears to work while doing nothing. Observed on
 * Windows 10.0.26200: every working desktop app in `wpndatabase` had a
 * `…NonImmersivePackage` id backed by a shortcut, while the bare id had no
 * records after its first registration date.
 *
 * This module creates that shortcut (per-user Start Menu, no elevation) and
 * stamps the id onto it through `IPropertyStore`. It is idempotent: a shortcut
 * that already carries the wanted id is left untouched, one that carries a
 * different id has that id rewritten. Nothing here ever throws — a toast
 * transport problem must not break the plugin on a machine that has already
 * solved this identity question some other way.
 *
 * @module dsh-approval-notifier/shortcut
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** PKEY_AppUserModel_ID guid, as stored in a shortcut's property store. */
export const APP_USER_MODEL_ID_PKEY = '9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3';

/**
 * Where a per-user Start Menu shortcut lives, from the environment.
 *
 * `APPDATA` is the fast path, but a stripped environment (a service host, a
 * test harness, a launcher that rebuilds `env`) may not carry it while still
 * carrying `USERPROFILE`. Deriving from the profile keeps the identity
 * registrable there instead of silently producing undisplayable toasts.
 *
 * @param env - environment to read.
 * @param platform - the running platform.
 * @returns the folder, or `''` when neither variable is usable.
 */
export function startMenuProgramsDir(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return '';
  const appData = typeof env.APPDATA === 'string' && env.APPDATA !== ''
    ? env.APPDATA
    : (typeof env.USERPROFILE === 'string' && env.USERPROFILE !== ''
      ? join(env.USERPROFILE, 'AppData', 'Roaming')
      : '');
  if (appData === '') return '';
  return join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
}

/**
 * The shortcut file name (thus the Start Menu entry) for an id.
 *
 * Invalid characters are sanitised rather than rejected: the shell matches on
 * the stored property, not the file name, but a path separator would still let
 * a configured id escape the Start Menu directory.
 *
 * @param appId - the AppUserModelID.
 * @returns a safe file stem, or `''` for an unusable id.
 */
export function shortcutNameFor(appId) {
  const id = typeof appId === 'string' ? appId.trim() : '';
  if (id === '') return '';
  return id.replace(/[\\/:*?"<>|]/gu, '_');
}

/**
 * Decode the script's stdout into a verdict.
 *
 * @param stdout - captured stdout.
 * @param stderr - captured stderr.
 * @returns `{ ok, created, error }`.
 */
export function parseShortcutResult(stdout, stderr = '') {
  const text = `${stdout ?? ''}\n${stderr ?? ''}`;
  const ok = /SHORTCUT-OK/u.exec(text);
  if (ok !== null) {
    return { ok: true, created: /SHORTCUT-OK: created/u.test(text), error: '' };
  }
  const fail = /SHORTCUT-FAIL:([^\r\n]*)/u.exec(text);
  if (fail !== null) return { ok: false, created: false, error: fail[1].trim() };
  const first = String(stderr ?? '').split(/\r?\n/u).find((line) => line.trim() !== '') ?? '';
  return { ok: false, created: false, error: first === '' ? 'shortcut script reported nothing' : first.trim() };
}

/**
 * Create the shortcut helper.
 *
 * @param options - `{ powershellPath, scriptPath, platform?, env?, logger?,
 *   run? }`. `powershellPath` may be a thunk (the config can change at
 *   runtime). `run` is injectable so tests never touch the real Start Menu.
 * @returns `{ ensure, status }`.
 */
export function createShortcutRegistrar(options) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logger = options.logger;
  const readPowerShell = typeof options.powershellPath === 'function'
    ? options.powershellPath
    : () => options.powershellPath;
  const run = options.run ?? ((exe, args) => spawnSync(exe, args, {
    windowsHide: true,
    timeout: 30000,
    encoding: 'utf8',
  }));

  /** Remember the last outcome so `/status` can explain a silent toast. */
  let last = {
    attempted: false, ok: false, created: false, path: '', appId: '', error: '',
  };

  function warn(message) {
    try {
      logger?.warn?.(`dsh-approval-notifier: ${message}`);
    } catch {
      // A logger failure must not affect registration.
    }
  }

  /** Record and return one failed attempt. */
  function fail(error, path = '') {
    last = {
      attempted: true, ok: false, created: false, path, appId: last.appId, error,
    };
    return { ok: false, created: false, path, error };
  }

  /**
   * Ensure a Start Menu shortcut exists for this id and carries it.
   *
   * @param request - `{ appId, targetPath, iconPath?, workingDirectory? }`.
   * @returns `{ ok, created, path, error }`; never throws.
   */
  function ensure(request) {
    const appId = typeof request?.appId === 'string' ? request.appId.trim() : '';
    const targetPath = typeof request?.targetPath === 'string' ? request.targetPath : '';
    last.appId = appId;

    if (platform !== 'win32') return fail(`only Windows needs a toast shortcut (this is ${platform})`);
    const name = shortcutNameFor(appId);
    if (name === '') return fail('the configured appId is empty');
    if (targetPath === '' || !existsSync(targetPath)) {
      // Without a real executable the shell has nothing to attribute a toast
      // to. The plugin still works everywhere else, so this is a warning only.
      return fail(`no executable to point the toast identity at (${targetPath === '' ? 'unset' : targetPath})`);
    }
    const dir = startMenuProgramsDir(env, platform);
    if (dir === '') return fail('APPDATA is unset, so there is no per-user Start Menu');

    const path = join(dir, `${name}.lnk`);
    let result;
    try {
      const exe = readPowerShell();
      if (exe === '') return fail('Windows PowerShell 5.1 not found', path);
      const args = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        options.scriptPath,
        '-LnkPath',
        path,
        '-TargetPath',
        targetPath,
        '-AppId',
        appId,
      ];
      const icon = typeof request.iconPath === 'string' ? request.iconPath.trim() : '';
      if (icon !== '') args.push('-IconPath', icon);
      const workingDirectory = typeof request.workingDirectory === 'string' ? request.workingDirectory : '';
      if (workingDirectory !== '') args.push('-WorkingDirectory', workingDirectory);
      result = run(exe, args);
    } catch (error) {
      return fail(`could not run the shortcut script: ${String(error)}`, path);
    }

    const verdict = parseShortcutResult(result?.stdout, result?.stderr);
    if (!verdict.ok) {
      warn(`toast identity shortcut failed: ${verdict.error}`);
      last = {
        attempted: true, ok: false, created: false, path, appId, error: verdict.error,
      };
      return { ok: false, created: false, path, error: verdict.error };
    }
    last = {
      attempted: true, ok: true, created: verdict.created, path, appId, error: '',
    };
    return { ok: true, created: verdict.created, path, error: '' };
  }

  return {
    ensure,
    /** The diagnostics view `/status` publishes. */
    status() {
      return { ...last };
    },
  };
}
