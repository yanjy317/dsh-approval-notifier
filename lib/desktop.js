/**
 * Desktop-install detection: where DSH Desktop lives, its exe, and its icon.
 *
 * The plugin needs three paths and one process name, and it must find them
 * without asking: an approval toast whose click cannot locate the app is a
 * toast whose click does nothing. The harness runs under the desktop app's own
 * bundled Node binary, so the install is derived by walking up from `execPath`
 * (…\DSH Desktop\resources\app\node_modules\node\bin\node.exe):
 *
 *   resources  = 3 levels up (…\DSH Desktop\resources) → icon.png
 *   root       = 4 levels up (…\DSH Desktop)           → DSH Desktop.exe
 *
 * Both are overridable by environment and by settings, and every step degrades
 * to "not found" instead of throwing: a missing install costs the click target,
 * never the notification.
 *
 * @module dsh-approval-notifier/desktop
 */

import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** The executable name when nothing else is known. */
export const DEFAULT_EXE_NAME = 'DSH Desktop.exe';

/** How many levels above `node.exe`'s directory the desktop root sits. */
const ROOT_LEVELS = 5;

/**
 * Walk up `levels` directories.
 *
 * @param start - the starting directory.
 * @param levels - how many parents to take.
 * @returns the ancestor, or `''` when the walk runs out.
 */
function up(start, levels) {
  let current = start;
  for (let hop = 0; hop < levels; hop += 1) {
    const parent = dirname(current);
    if (parent === current) return '';
    current = parent;
  }
  return current;
}

/**
 * Detect the DSH Desktop installation.
 *
 * @param options - `{ execPath?, argv?, env?, settings? }`.
 * @returns `{ appRoot, exePath, processName, iconPath }` (missing pieces are `''`).
 */
export function findDesktopInstall(options = {}) {
  const execPath = typeof options.execPath === 'string' ? options.execPath : process.execPath;
  const env = options.env ?? {};
  const settings = options.settings ?? {};

  // …\DSH Desktop\resources\app\node_modules\node\bin\node.exe
  //   bin → node → node_modules → app → resources → DSH Desktop
  // Four hops from the exe's own directory reach `resources`; one more reaches
  // the app root.
  const resources = up(dirname(execPath), ROOT_LEVELS - 1);
  const appRoot = resources === '' ? '' : up(resources, 1);

  const configuredExe = typeof settings.desktopExePath === 'string' ? settings.desktopExePath : '';
  const envExe = typeof env.DSH_DESKTOP_EXE === 'string' ? env.DSH_DESKTOP_EXE : '';
  const guessedExe = appRoot === '' ? '' : join(appRoot, DEFAULT_EXE_NAME);
  const exePath = configuredExe !== ''
    ? configuredExe
    : (envExe !== '' ? envExe : (existsSync(guessedExe) ? guessedExe : ''));

  const configuredIcon = typeof settings.iconPath === 'string' ? settings.iconPath : '';
  const envIcon = typeof env.DSH_APP_ICON === 'string' ? env.DSH_APP_ICON : '';
  const candidateIcon = resources === '' ? '' : join(resources, 'icon.png');
  const iconPath = configuredIcon !== ''
    ? configuredIcon
    : (envIcon !== '' ? envIcon : (candidateIcon !== '' && existsSync(candidateIcon) ? candidateIcon : ''));

  const processName = exePath === '' ? DEFAULT_EXE_NAME : basename(exePath);
  return { appRoot, exePath, processName, iconPath };
}
