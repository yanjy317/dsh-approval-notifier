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
