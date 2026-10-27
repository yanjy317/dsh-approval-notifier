import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAppLaunchCommand,
  buildVbsCommand,
  createProtocolHandler,
  defaultWscriptPath,
} from '../lib/protocol.js';
import { createFakeReg } from './helpers.js';

const WSCRIPT = 'C:\\Windows\\System32\\wscript.exe';
const VBS = 'D:\\a b\\focus.vbs';
const EXE = 'D:\\soft\\DSH Desktop\\DSH Desktop.exe';
const ROUTE = 'http://127.0.0.1:43129/dsh-approval-notifier/activate';

test('buildVbsCommand uses a GUI host, quotes every path, and carries the clicked URL', () => {
  const command = buildVbsCommand(WSCRIPT, VBS, EXE);
  assert.equal(
    command,
    '"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "D:\\a b\\focus.vbs" "D:\\soft\\DSH Desktop\\DSH Desktop.exe" "%1"',
  );
  // `"%1"` is not decoration: the shell only hands a protocol handler the
  // clicked URL where the command names it. Without the placeholder the handler
  // starts with no URL, so focus.vbs never sees the session and a click can only
  // raise the window.
  assert.match(command, /"%1"$/, 'the URL placeholder is what carries the query');
  assert.doesNotMatch(command, /powershell|cmd\.exe|pwsh/i);
});

test('buildVbsCommand keeps the placeholder when a route is present', () => {
  const command = buildVbsCommand(WSCRIPT, VBS, EXE, ROUTE);
  assert.equal(
    command,
    `"C:\\Windows\\System32\\wscript.exe" //B //NoLogo "D:\\a b\\focus.vbs" "D:\\soft\\DSH Desktop\\DSH Desktop.exe" --api "${ROUTE}" "%1"`,
  );
});

test('buildAppLaunchCommand is the script-free fallback', () => {
  const command = buildAppLaunchCommand(EXE);
  assert.equal(command, '"D:\\soft\\DSH Desktop\\DSH Desktop.exe" "%1"');
  assert.doesNotMatch(command, /powershell|wscript|cmd\.exe/i);
});

test('defaultWscriptPath only answers on Windows', () => {
  assert.equal(defaultWscriptPath({}, 'linux'), '');
  assert.equal(defaultWscriptPath({}, 'darwin'), '');
});

test('ensure() writes the three keys the shell needs, then stops writing', () => {
  const reg = createFakeReg();
  const handler = createProtocolHandler({ scheme: 'dsh-approval-notifier', run: reg });
  const command = buildVbsCommand(WSCRIPT, VBS, EXE, ROUTE);

  assert.equal(handler.status().registered, false);
  assert.equal(handler.ensure(command), true);
  assert.equal(handler.status().registered, true);
  assert.equal(handler.status().registeredCommand, command);
  assert.equal(reg.defaultOf('HKCU\\Software\\Classes\\dsh-approval-notifier'), 'URL:DSH approval notification focus protocol');
  assert.equal(
    reg.defaultOf('HKCU\\Software\\Classes\\dsh-approval-notifier\\shell\\open\\command'),
    command,
  );

  const before = reg.values.size;
  assert.equal(handler.ensure(command), true, 'an unchanged command is left alone');
  assert.equal(reg.values.size, before);
});

test('ensure() rewrites the command when it changed', () => {
  const reg = createFakeReg();
  const handler = createProtocolHandler({ scheme: 'dsh-approval-notifier', run: reg });
  handler.ensure(buildVbsCommand(WSCRIPT, VBS, EXE));
  const next = buildVbsCommand(WSCRIPT, VBS, EXE, ROUTE);
  assert.equal(handler.ensure(next), true);
  assert.equal(handler.status().registeredCommand, next, 'the port moved: the command follows');
});

test('remove() deletes the scheme key and reports the outcome', () => {
  const reg = createFakeReg();
  const handler = createProtocolHandler({ scheme: 'dsh-approval-notifier', run: reg });
  assert.equal(handler.remove(), true, 'removing an absent scheme is already the wanted state');
  handler.ensure(buildVbsCommand(WSCRIPT, VBS, EXE));
  assert.equal(handler.remove(), true);
  assert.equal(handler.status().registered, false);
});

test('a failing registry is reported instead of assumed', () => {
  const warnings = [];
  const alwaysFails = () => ({ ok: false, code: 1, stdout: '', stderr: 'access denied', error: '' });
  const handler = createProtocolHandler({ scheme: 'x', run: alwaysFails, logger: { warn: (m) => warnings.push(m) } });
  assert.equal(handler.ensure('cmd'), false);
  assert.equal(handler.status().registered, false);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /无法注册 x/);
});

test('the scheme may be a thunk so live config changes are honoured', () => {
  let scheme = 'one';
  const reg = createFakeReg();
  const handler = createProtocolHandler({ scheme: () => scheme, run: reg });
  handler.ensure('cmd-a');
  assert.equal(handler.status().scheme, 'one');
  scheme = 'two';
  handler.ensure(reg.defaultOf('HKCU\\Software\\Classes\\two\\shell\\open\\command') ?? 'cmd-b');
  assert.equal(handler.status().scheme, 'two');
  assert.ok(reg.defaultOf('HKCU\\Software\\Classes\\two\\shell\\open\\command') !== undefined);
});
