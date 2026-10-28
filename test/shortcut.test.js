/**
 * The toast identity: a Start Menu shortcut carrying `System.AppUserModel.ID`.
 *
 * These tests never touch the real Start Menu or launch PowerShell: the
 * promise under test is the *decision* — which id, which path, whether to create
 * anything at all — and the `run` seam stands in for the script that performs
 * it. The one thing that is real is `existsSync` on the target executable, so a
 * missing exe is exercised by pointing at a path that cannot exist.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  createShortcutRegistrar,
  parseShortcutResult,
  shortcutNameFor,
  startMenuProgramsDir,
} from '../lib/shortcut.js';

const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib');

/** An APPDATA that exists, so the Start Menu derivation is deterministic. */
const ENV = { APPDATA: 'C:\\Users\\someone\\AppData\\Roaming' };

/** The script path the registrar is told to run. */
const SCRIPT = 'C:\\plugins\\dsh-approval-notifier\\lib\\register-shortcut.ps1';

/** A target that exists on every Windows install. */
const EXISTING_TARGET = 'C:\\Windows\\System32\\cmd.exe';

/** Build a registrar whose script run is a recording double. */
function registrarWith(stdout, options = {}) {
  const calls = [];
  const registrar = createShortcutRegistrar({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    scriptPath: SCRIPT,
    platform: 'win32',
    env: ENV,
    run: (exe, args) => {
      calls.push({ exe, args });
      return { status: 0, stdout, stderr: '', error: undefined };
    },
    ...options,
  });
  return { registrar, calls };
}

/** The value following a flag in an argv list. */
function valueOf(args, flag) {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

test('startMenuProgramsDir is the per-user Start Menu on Windows only', () => {
  assert.equal(
    startMenuProgramsDir(ENV, 'win32'),
    join(ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  );
  assert.equal(startMenuProgramsDir(ENV, 'linux'), '');
  assert.equal(startMenuProgramsDir({}, 'win32'), '');
});

test('startMenuProgramsDir falls back to USERPROFILE when APPDATA is absent', () => {
  // A rebuilt environment (service host, harness, launcher) may drop APPDATA
  // while keeping the profile; the identity must stay registrable there.
  const profile = { USERPROFILE: 'C:\\Users\\someone' };
  assert.equal(
    startMenuProgramsDir(profile, 'win32'),
    join(profile.USERPROFILE, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  );
  // APPDATA still wins when both are present, since it may be relocated.
  assert.equal(
    startMenuProgramsDir({ ...ENV, USERPROFILE: 'C:\\Users\\other' }, 'win32'),
    join(ENV.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  );
});

test('shortcutNameFor refuses an empty id and cannot escape the Start Menu', () => {
  assert.equal(shortcutNameFor(''), '');
  assert.equal(shortcutNameFor('   '), '');
  assert.equal(shortcutNameFor('DSH.ApprovalNotifier'), 'DSH.ApprovalNotifier');
  // A separator would otherwise let a configured id write outside the folder.
  assert.equal(shortcutNameFor('..\\..\\evil'), '.._.._evil');
  assert.equal(shortcutNameFor('a/b'), 'a_b');
});

test('parseShortcutResult reads created, unchanged, and failure', () => {
  assert.deepEqual(parseShortcutResult('SHORTCUT-OK: created'), {
    ok: true, created: true, error: '',
  });
  assert.deepEqual(parseShortcutResult('SHORTCUT-OK: unchanged'), {
    ok: true, created: false, error: '',
  });
  assert.deepEqual(parseShortcutResult('SHORTCUT-FAIL: no exe'), {
    ok: false, created: false, error: 'no exe',
  });
  // stdout may carry the failure while stderr carries an unrelated warning.
  assert.deepEqual(parseShortcutResult('SHORTCUT-FAIL: boom', 'warning'), {
    ok: false, created: false, error: 'boom',
  });
  assert.equal(parseShortcutResult('', 'first line\nsecond').error, 'first line');
  assert.equal(parseShortcutResult('', '').ok, false);
});

test('ensure creates the shortcut under the configured appId', () => {
  const { registrar, calls } = registrarWith('SHORTCUT-OK: created');
  const result = registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET });

  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.equal(result.path, join(
    ENV.APPDATA,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'DSH.ApprovalNotifier.lnk',
  ));

  assert.equal(calls.length, 1);
  const { args } = calls[0];
  assert.ok(args.includes('-NoProfile'));
  assert.ok(args.includes('-NonInteractive'));
  assert.ok(args.includes('-ExecutionPolicy'));
  assert.ok(args.includes('Bypass'));
  assert.equal(valueOf(args, '-File'), SCRIPT);
  assert.equal(valueOf(args, '-LnkPath'), result.path);
  assert.equal(valueOf(args, '-TargetPath'), EXISTING_TARGET);
  assert.equal(valueOf(args, '-AppId'), 'DSH.ApprovalNotifier');
});

test('ensure forwards an icon and a working directory only when given', () => {
  const { registrar, calls } = registrarWith('SHORTCUT-OK: created');
  registrar.ensure({
    appId: 'DSH.ApprovalNotifier',
    targetPath: EXISTING_TARGET,
    iconPath: 'C:\\icons\\dsh.ico',
    workingDirectory: 'C:\\Windows\\System32',
  });
  const { args } = calls[0];
  assert.equal(valueOf(args, '-IconPath'), 'C:\\icons\\dsh.ico');
  assert.equal(valueOf(args, '-WorkingDirectory'), 'C:\\Windows\\System32');

  const plain = registrarWith('SHORTCUT-OK: created');
  plain.registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET });
  assert.equal(plain.calls[0].args.includes('-IconPath'), false);
  assert.equal(plain.calls[0].args.includes('-WorkingDirectory'), false);
});

test('a missing executable is a warning, not a crash, and runs nothing', () => {
  const { registrar, calls } = registrarWith('SHORTCUT-OK: created');
  const result = registrar.ensure({
    appId: 'DSH.ApprovalNotifier',
    targetPath: 'C:\\definitely\\not\\here\\DSH Desktop.exe',
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /no executable/u);
  assert.equal(calls.length, 0);
  assert.equal(registrar.status().ok, false);
});

test('an empty appId, a non-Windows host, and no APPDATA all decline', () => {
  const empty = registrarWith('SHORTCUT-OK: created');
  assert.match(
    empty.registrar.ensure({ appId: '', targetPath: EXISTING_TARGET }).error,
    /appId is empty/u,
  );

  const linux = registrarWith('SHORTCUT-OK: created', { platform: 'linux' });
  assert.match(
    linux.registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET }).error,
    /only Windows/u,
  );

  const homeless = registrarWith('SHORTCUT-OK: created', { env: {} });
  assert.match(
    homeless.registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET }).error,
    /APPDATA is unset/u,
  );
  assert.equal(homeless.calls.length, 0);
});

test('a script failure is reported and never thrown', () => {
  const { registrar } = registrarWith('SHORTCUT-FAIL: AppUserModelID did not stick');
  const result = registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET });
  assert.equal(result.ok, false);
  assert.match(result.error, /did not stick/u);
  assert.equal(registrar.status().attempted, true);
  assert.equal(registrar.status().ok, false);
});

test('a throwing run is contained', () => {
  const registrar = createShortcutRegistrar({
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    scriptPath: SCRIPT,
    platform: 'win32',
    env: ENV,
    run: () => {
      throw new Error('spawn exploded');
    },
  });
  const result = registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET });
  assert.equal(result.ok, false);
  assert.match(result.error, /spawn exploded/u);
});

test('status reports what the last attempt did', () => {
  const { registrar } = registrarWith('SHORTCUT-OK: unchanged');
  assert.equal(registrar.status().attempted, false);
  const result = registrar.ensure({ appId: 'DSH.ApprovalNotifier', targetPath: EXISTING_TARGET });
  const status = registrar.status();
  assert.equal(status.ok, true);
  assert.equal(status.created, false);
  assert.equal(status.appId, 'DSH.ApprovalNotifier');
  assert.equal(status.path, result.path);
  assert.equal(status.error, '');
});

test('the shipped script is ASCII-only and exits 0 on both outcomes', () => {
  // Windows PowerShell 5.1 reads a BOM-less .ps1 as ANSI, so a non-ASCII
  // literal is mangled on a non-UTF-8 code page and the script fails to parse.
  const source = readFileSync(join(LIB_DIR, 'register-shortcut.ps1'), 'utf8');
  const nonAscii = [...source].filter((char) => char.codePointAt(0) > 0x7e);
  assert.deepEqual(nonAscii, [], 'register-shortcut.ps1 must stay pure ASCII');

  // The parent classifies from stdout, never the exit code, so the failure path
  // must not be allowed to surface as a non-zero exit that some caller treats
  // as "no answer".
  const failBody = /function Write-Fail[\s\S]*?\n\}/u.exec(source)?.[0] ?? '';
  assert.match(failBody, /exit 0/u);
});

test('the id is quoted-safe: a spaced appId becomes a spaced file name', () => {
  assert.equal(shortcutNameFor('My Cool App'), 'My Cool App');
  const { registrar, calls } = registrarWith('SHORTCUT-OK: created');
  const result = registrar.ensure({ appId: 'My Cool App', targetPath: EXISTING_TARGET });
  assert.equal(result.path.endsWith(join('Programs', 'My Cool App.lnk')), true);
  assert.equal(valueOf(calls[0].args, '-AppId'), 'My Cool App');
});
