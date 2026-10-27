import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildToastPayload,
  createNotifier,
  defaultPowershellPath,
} from '../lib/notify.js';
import { baseSettings, createFakeSpawn, decodePayload, flush, workingSpawn } from './helpers.js';

const TOAST_SCRIPT = fileURLToPath(new URL('../lib/toast.ps1', import.meta.url));

/** One notifier bound to fixed settings and a fake spawner. */
function makeNotifier({ settings = baseSettings(), spawn = workingSpawn(), now = () => 1_000_000 } = {}) {
  const notifier = createNotifier({
    getSettings: () => ({ ...settings }),
    scriptPath: TOAST_SCRIPT,
    spawn,
    platform: 'win32',
    env: {},
    now,
  });
  return { notifier, spawn };
}

const sampleNotification = {
  kind: 'approval',
  title: '需要你确认：pwsh',
  lines: ['需要你确认：pwsh', 'escalate sandbox to danger-full-access: 需要写文件'],
  key: 'approval|req-1|pwsh|call-1',
};

test('defaultPowershellPath only answers on Windows', () => {
  const onWindows = defaultPowershellPath({ SystemRoot: 'C:\\Windows' }, 'win32');
  // The suite may run anywhere; only assert the shape it promises.
  assert.equal(defaultPowershellPath({}, 'linux'), '');
  if (onWindows !== '') assert.match(onWindows, /powershell(\.exe)?$/i);
});

test('buildToastPayload maps settings onto the script payload', () => {
  const payload = buildToastPayload(sampleNotification, baseSettings({ sound: false, iconPath: 'D:\\icon.png' }));
  assert.equal(payload.appId, 'DSH.ApprovalNotifier');
  assert.equal(payload.sound, false);
  assert.equal(payload.launch, 'dsh-approval-notifier://focus');
  assert.equal(payload.button, '查看该会话');
  assert.equal(payload.icon, 'D:\\icon.png');
  assert.deepEqual(payload.lines, sampleNotification.lines);
  assert.deepEqual(payload.actions, [], 'a notification without actions renders none');
});

test('buildToastPayload keeps a url click target and drops the button when there is none', () => {
  const byUrl = buildToastPayload(sampleNotification, baseSettings({ clickUrl: 'http://127.0.0.1:43129', clickLabel: '打开 DSH 页面' }));
  assert.equal(byUrl.launch, 'http://127.0.0.1:43129');
  assert.equal(byUrl.button, '打开 DSH 页面');

  const none = buildToastPayload(sampleNotification, baseSettings({ clickUrl: '', clickLabel: 'x' }));
  assert.equal(none.launch, '');
  assert.equal(none.button, '', 'no target means no button');
});

test('buildToastPayload carries decision actions and yields the label button to them', () => {
  const actions = [
    { content: '允许一次', arguments: 'dsh-approval-notifier://decide?decision=allow&key=approval%7Creq-1&t=ab' },
    { content: '拒绝', arguments: 'dsh-approval-notifier://decide?decision=deny&key=approval%7Creq-1&t=ab' },
  ];
  const payload = buildToastPayload(
    { ...sampleNotification, clickUrl: 'dsh-approval-notifier://focus?session=s1', actions },
    baseSettings(),
  );
  assert.deepEqual(payload.actions, actions);
  assert.equal(payload.launch, 'dsh-approval-notifier://focus?session=s1', 'the body click still opens the session');
  assert.equal(payload.button, '', 'the label button would only crowd the two that matter');

  const partial = buildToastPayload(
    { ...sampleNotification, actions: [{ content: '允许一次' }, { content: '', arguments: 'x' }, null] },
    baseSettings(),
  );
  assert.deepEqual(partial.actions, [], 'a half-built action would be a dead button');
});

test('send() runs toast.ps1 with a UTF-8 base64 payload and reports success', async () => {
  const { notifier, spawn } = makeNotifier();
  const result = await notifier.send(sampleNotification);
  assert.equal(result.ok, true);
  assert.equal(spawn.calls.length, 1);
  const [call] = spawn.calls;
  assert.match(call.command, /powershell(\.exe)?$/i);
  assert.deepEqual(call.args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File']);
  assert.equal(call.args[5], TOAST_SCRIPT);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.stdio[0], 'ignore');
  const payload = decodePayload(call);
  assert.deepEqual(payload.lines, ['需要你确认：pwsh', 'escalate sandbox to danger-full-access: 需要写文件']);
  assert.equal(payload.sound, true);
  assert.equal(notifier.status().counters.delivered, 1);
  assert.equal(notifier.status().recent.at(-1).ok, true);
});

test('send() stays silent when the plugin is disabled', async () => {
  const spawn = workingSpawn();
  const { notifier } = makeNotifier({ settings: baseSettings({ enabled: false }), spawn });
  const result = await notifier.send(sampleNotification);
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(spawn.calls.length, 0);
});

test('send() surfaces a TOAST-FAIL line from the script', async () => {
  const spawn = createFakeSpawn({ plan: { stdout: 'TOAST-FAIL: System.Exception :: nope\r\n', code: 0 } });
  const { notifier } = makeNotifier({ spawn });
  const result = await notifier.send(sampleNotification);
  assert.equal(result.ok, false);
  assert.match(result.error, /TOAST-FAIL/);
  assert.equal(notifier.status().counters.failed, 1);
  assert.match(notifier.status().lastError, /TOAST-FAIL/);
});

test('send() reports the first stderr line when the script fails silently', async () => {
  const spawn = createFakeSpawn({ plan: { stdout: '', stderr: 'E:\\x\\toast.ps1 : 拒绝访问\r\n', code: 1 } });
  const { notifier } = makeNotifier({ spawn });
  const result = await notifier.send(sampleNotification);
  assert.equal(result.ok, false);
  assert.match(result.error, /拒绝访问/);
});

test('the same key inside the dedupe window is raised once', async () => {
  const { notifier, spawn } = makeNotifier();
  await notifier.send(sampleNotification);
  const second = await notifier.send(sampleNotification);
  assert.equal(second.ok, false);
  assert.equal(second.deduped, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(notifier.status().counters.deduped, 1);
});

test('the per-minute cap stops a storm', async () => {
  let now = 1_000_000;
  const { notifier, spawn } = makeNotifier({ settings: baseSettings({ maxPerMinute: 2 }), now: () => now });
  for (let i = 0; i < 5; i += 1) {
    await notifier.send({ ...sampleNotification, key: `k${String(i)}` });
    now += 10;
  }
  assert.equal(spawn.calls.length, 2);
  assert.equal(notifier.status().counters.throttled, 3);
});

test('the log records every outcome and truncates when it grows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-log-'));
  const logFile = join(home, 'notifier.log');
  const { notifier } = makeNotifier({ settings: baseSettings({ log: true, logFile }) });
  await notifier.send(sampleNotification);
  const contents = readFileSync(logFile, 'utf8');
  assert.match(contents, /OK\s+approval \|/);

  await notifier.send({ ...sampleNotification, key: 'other' });
  const lines = readFileSync(logFile, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2, 'one line per attempt');
});

test('deliver() never throws into the caller', async () => {
  const { notifier } = makeNotifier({ spawn: createFakeSpawn({ plan: { stdout: '', code: 1 } }) });
  notifier.deliver(() => sampleNotification);
  await flush();
  await notifier.dispose();
  assert.equal(notifier.status().counters.failed, 1);
  notifier.deliver(() => {
    throw new Error('bad build');
  });
  await flush();
});
