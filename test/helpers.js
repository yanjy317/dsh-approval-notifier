/**
 * Process doubles: spawn, reg.exe, the clock, and payload decoding.
 *
 * These stand in for everything the plugin shells out to, so the suite never
 * launches PowerShell, touches the registry, or depends on the wall clock.
 *
 * @module dsh-approval-notifier/test-helpers
 */

import { EventEmitter } from 'node:events';

/** Settings every payload test starts from. */
export function baseSettings(overrides = {}) {
  return {
    enabled: true,
    notifyApprovals: true,
    notifyQuestions: true,
    notifyInApp: true,
    suppressVisible: true,
    decideFromToast: true,
    sound: true,
    includeToolCall: true,
    clickAction: 'auto',
    openUrl: '',
    focusScheme: 'dsh-approval-notifier',
    desktopExePath: 'D:\\soft\\DSH Desktop\\DSH Desktop.exe',
    appId: 'DSH.ApprovalNotifier',
    iconPath: '',
    dedupeMs: 1500,
    maxPerMinute: 30,
    timeoutMs: 15000,
    powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    log: false,
    logFile: '',
    clickUrl: 'dsh-approval-notifier://focus',
    clickLabel: '查看该会话',
    clickScheme: true,
    ...overrides,
  };
}

/** Decode the base64 payload a spawn call carried. */
export function decodePayload(call) {
  const at = call.args.indexOf('-Payload');
  if (at < 0) throw new Error('the spawn call carried no -Payload');
  return JSON.parse(Buffer.from(call.args[at + 1], 'base64').toString('utf8'));
}

/**
 * A spawn stand-in: a child-process shaped object that answers on the next tick.
 *
 * @param options - `{ plan?: { stdout?, stderr?, code? } }`.
 * @returns the spawn function, with a `calls` array of what it was asked to run.
 */
export function createFakeSpawn(options = {}) {
  const calls = [];
  const plan = options.plan ?? { stdout: 'TOAST-OK\r\n', stderr: '', code: 0 };
  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      if (plan.stdout !== '') child.stdout.emit('data', plan.stdout);
      if (plan.stderr !== '') child.stderr.emit('data', plan.stderr);
      child.emit('close', plan.code ?? 0);
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

/** The default spawn: a toast that succeeded. */
export function workingSpawn() {
  return createFakeSpawn();
}

/**
 * A `reg.exe` stand-in backed by an in-memory key store.
 *
 * Values are keyed by `path\0name` because a key holds several of them (the
 * scheme carries both its description and `URL Protocol`). `defaults` exposes
 * the `(Default)` value per key, which is what the plugin compares against.
 *
 * @returns the runner, with `values` and `defaults` maps of what is registered.
 */
export function createFakeReg() {
  const values = new Map();
  const storeKey = (key, name) => `${key}\u0000${name}`;
  const run = (args) => {
    const [verb, key, flag] = args;
    if (verb === 'query') {
      const value = values.get(storeKey(key, '(Default)'));
      if (value === undefined) return { ok: false, code: 1, stdout: '', stderr: 'not found', error: '' };
      return { ok: true, code: 0, stdout: `\r\n    (Default)    REG_SZ    ${value}\r\n\r\n`, stderr: '', error: '' };
    }
    if (verb === 'add') {
      // `add <key> /ve /d <value> /f` or `add <key> /v <name> /d <value> /f`
      const at = args.indexOf('/d');
      if (at < 0) return { ok: false, code: 1, stdout: '', stderr: 'no data', error: '' };
      const name = flag === '/v' ? args[3] : '(Default)';
      values.set(storeKey(key, name), args[at + 1]);
      return { ok: true, code: 0, stdout: 'ok', stderr: '', error: '' };
    }
    if (verb === 'delete') {
      // `reg delete <key> /f` removes the key and everything under it.
      let existed = false;
      for (const stored of [...values.keys()]) {
        const [storedKey] = stored.split('\u0000');
        if (storedKey === key || storedKey.startsWith(`${key}\\`)) {
          values.delete(stored);
          existed = true;
        }
      }
      return { ok: existed, code: existed ? 0 : 1, stdout: '', stderr: '', error: '' };
    }
    return { ok: false, code: 1, stdout: '', stderr: `unsupported: ${flag ?? ''}`, error: '' };
  };
  run.values = values;
  /** The `(Default)` value of one key, or undefined. */
  run.defaultOf = (key) => values.get(storeKey(key, '(Default)'));
  /** Every value stored under a key (diagnostics). */
  run.valuesOf = (key) => [...values.keys()].filter((stored) => stored.startsWith(`${key}\u0000`));
  return run;
}

/** A controllable clock. */
export function createClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
      return now;
    },
  };
}

/** Let queued promise callbacks run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));
