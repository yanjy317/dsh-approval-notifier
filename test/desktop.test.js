import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_EXE_NAME, findDesktopInstall } from '../lib/desktop.js';

/**
 * Lay out a fake install and return the `node.exe` path inside it.
 *
 * The harness runs under `…\DSH Desktop\resources\app\node_modules\node\bin\node.exe`,
 * so the fixture reproduces exactly that depth.
 */
function fakeInstall() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-'));
  const app = join(root, 'DSH Desktop');
  const resources = join(app, 'resources');
  const bin = join(resources, 'app', 'node_modules', 'node', 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(app, DEFAULT_EXE_NAME), '');
  writeFileSync(join(resources, 'icon.png'), '');
  return { app, resources, execPath: join(bin, 'node.exe') };
}

test('the install is found by walking up from the bundled node.exe', () => {
  const layout = fakeInstall();
  const install = findDesktopInstall({ execPath: layout.execPath, env: {} });
  assert.equal(install.appRoot, layout.app);
  assert.equal(install.exePath, join(layout.app, DEFAULT_EXE_NAME));
  assert.equal(install.processName, DEFAULT_EXE_NAME);
  assert.equal(install.iconPath, join(layout.resources, 'icon.png'));
});

test('the Electron layout is found when execPath is the desktop exe itself', () => {
  // Newer builds ship resources/app.asar and no bundled node.exe at all, so the
  // harness runs inside the Electron main process and process.execPath *is* the
  // desktop exe. The old walk assumed the bundled-node depth unconditionally,
  // climbed five levels above the install, and returned nothing -- which cost
  // both the click target and the toast identity.
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-electron-'));
  const app = join(root, 'DSH Desktop');
  const resources = join(app, 'resources');
  mkdirSync(resources, { recursive: true });
  const exe = join(app, DEFAULT_EXE_NAME);
  writeFileSync(exe, '');
  writeFileSync(join(resources, 'icon.png'), '');
  writeFileSync(join(resources, 'app.asar'), '');

  const install = findDesktopInstall({ execPath: exe, env: {} });
  assert.equal(install.appRoot, app);
  assert.equal(install.exePath, exe);
  assert.equal(install.processName, DEFAULT_EXE_NAME);
  assert.equal(install.iconPath, join(resources, 'icon.png'));
});

test('an unusual launch depth still resolves to the nearest containing root', () => {
  // An Electron main process started from an arbitrary node_modules depth has no
  // fixed number of hops to the app root. Searching for the directory that
  // actually holds the exe keeps it working instead of yielding empty strings.
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-deep-'));
  const app = join(root, 'DSH Desktop');
  const deep = join(app, 'resources', 'app', 'node_modules', 'some', 'weird', 'bin');
  mkdirSync(deep, { recursive: true });
  writeFileSync(join(app, DEFAULT_EXE_NAME), '');

  const install = findDesktopInstall({ execPath: join(deep, 'helper.exe'), env: {} });
  assert.equal(install.appRoot, app);
  assert.equal(install.exePath, join(app, DEFAULT_EXE_NAME));
});

test('settings override the detected executable and icon', () => {
  const layout = fakeInstall();
  const install = findDesktopInstall({
    execPath: layout.execPath,
    env: {},
    settings: { desktopExePath: 'D:\\other\\DSH Desktop.exe', iconPath: 'D:\\other\\icon.png' },
  });
  assert.equal(install.exePath, 'D:\\other\\DSH Desktop.exe');
  assert.equal(install.processName, 'DSH Desktop.exe', 'the process name follows the exe');
  assert.equal(install.iconPath, 'D:\\other\\icon.png');
});

test('the environment overrides detection but not an explicit setting', () => {
  const layout = fakeInstall();
  const fromEnv = findDesktopInstall({
    execPath: layout.execPath,
    env: { DSH_DESKTOP_EXE: 'E:\\x\\DSH Desktop.exe', DSH_APP_ICON: 'E:\\x\\icon.png' },
  });
  assert.equal(fromEnv.exePath, 'E:\\x\\DSH Desktop.exe');
  assert.equal(fromEnv.iconPath, 'E:\\x\\icon.png');

  const fromSettings = findDesktopInstall({
    execPath: layout.execPath,
    env: { DSH_DESKTOP_EXE: 'E:\\x\\DSH Desktop.exe' },
    settings: { desktopExePath: 'D:\\configured\\DSH Desktop.exe' },
  });
  assert.equal(fromSettings.exePath, 'D:\\configured\\DSH Desktop.exe');
});

test('a missing install degrades to the known names instead of throwing', () => {
  const install = findDesktopInstall({ execPath: 'C:\\nowhere\\node.exe', env: {} });
  assert.equal(typeof install.exePath, 'string');
  assert.equal(install.exePath, '', 'nothing to offer when the walk finds no install');
  assert.equal(install.processName, DEFAULT_EXE_NAME);
});
