/**
 * Desktop-install detection: where DSH Desktop lives, its exe, and its icon.
 *
 * The plugin needs three paths and one process name, and it must find them
 * without asking: an approval toast whose click cannot locate the app is a
 * toast whose click does nothing, and the toast identity registration needs a
 * real executable to point the shortcut at.
 *
 * Two layouts exist and both must work:
 *
 *   bundled node   …\DSH Desktop\resources\app\node_modules\node\bin\node.exe
 *                  → resources is 4 levels up, the app root one more
 *   Electron host  …\DSH Desktop\DSH Desktop.exe
 *                  → the harness runs *inside* the desktop app, so `execPath`
 *                    already is the desktop exe (newer builds ship an
 *                    `app.asar` and no bundled `node.exe` at all)
 *
 * The old code assumed the first layout unconditionally, so on the second it
 * walked five levels above `D:\soft\DSH Desktop` and found nothing: `exePath`,
 * `iconPath`, and `appRoot` all came back empty, which silently disabled both
 * the click target and the toast identity.
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
 * Work out the app root from `execPath`, whichever layout is in use.
 *
 * Detected by looking at the executable's own name first: if `execPath` *is* the
 * desktop app, its directory is the root and there is no walk to do. Otherwise
 * the bundled-node walk is tried, and finally a search up the tree for a
 * directory that actually contains the desktop exe — which covers an Electron
 * main process launched from an arbitrary `node_modules` depth.
 *
 * @param execPath - `process.execPath`.
 * @returns the app root, or `''` when it cannot be established.
 */
function appRootOf(execPath) {
  const exeDir = dirname(execPath);
  // The harness running inside the desktop app: execPath is the app itself.
  if (basename(execPath).toLowerCase() === DEFAULT_EXE_NAME.toLowerCase()) return exeDir;

  const fromResources = up(exeDir, ROOT_LEVELS - 1);
  const fromWalk = fromResources === '' ? '' : up(fromResources, 1);
  if (fromWalk !== '' && existsSync(join(fromWalk, DEFAULT_EXE_NAME))) return fromWalk;

  // Fall back to the nearest ancestor that holds the exe, so an unusual launch
  // layout still resolves instead of silently yielding nothing.
  let current = exeDir;
  for (let hop = 0; hop < ROOT_LEVELS + 2; hop += 1) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    if (existsSync(join(current, DEFAULT_EXE_NAME))) return current;
  }
  return '';
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

  const appRoot = appRootOf(execPath);
  const resources = appRoot === '' ? '' : join(appRoot, 'resources');

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
