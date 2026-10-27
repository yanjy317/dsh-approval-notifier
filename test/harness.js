/**
 * The shared host-side test harness: a cordis-shaped context, a session stub,
 * a response recorder, a fake desktop install, and the `boot()` that wires a
 * real `start()` against all of them.
 *
 * @module dsh-approval-notifier/test-harness
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from '../lib/index.js';
import { createFakeReg, workingSpawn } from './helpers.js';

/** A minimal cordis-shaped context that records what the plugin registers. */
export function fakeContext(options = {}) {
  const listeners = new Map();
  const routes = [];
  const effects = [];
  const injections = [];
  const logs = [];
  const lateWebServer = options.lateWebServer === true;
  const ctx = {
    logger: {
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
    },
    on(name, handler, listenerOptions) {
      const entry = { handler, prepend: listenerOptions === true || listenerOptions?.prepend === true };
      const list = listeners.get(name) ?? [];
      list.push(entry);
      listeners.set(name, list);
      return () => {
        const index = list.indexOf(entry);
        if (index >= 0) list.splice(index, 1);
      };
    },
    effect(callback) {
      const disposer = callback();
      if (typeof disposer === 'function') effects.push(disposer);
      return () => {};
    },
    inject(keys, callback) {
      injections.push({ keys, callback });
      if (!lateWebServer) callback(ctx);
    },
    get(key) {
      if (key === 'webServer') return lateWebServer ? undefined : ctx.webServer;
      if (key === 'httpServer') return undefined;
      if (key === 'approval') return ctx.approval;
      return undefined;
    },
    webServer: options.webServer ?? {
      port: options.webPort ?? 43129,
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    approval: undefined,
  };
  // With `lateWebServer` the service is genuinely absent from this context until
  // the injected callback runs, which is the case the routing fix targets.
  if (lateWebServer) {
    Object.defineProperty(ctx, 'webServer', { value: undefined, writable: true, configurable: true });
  }
  return { ctx, listeners, routes, effects, logs, injections };
}

/** A session stub shaped exactly like the parts the plugin reads. */
export function fakeSession({ title = '插件通知调试', cwd = 'D:\\personal_project\\dsh-plugs', id = 'session-1234abcd' } = {}) {
  const log = [
    { type: 'session/title', data: { title } },
    { type: 'turn/start', data: {} },
    { type: 'tool/call', data: { callId: 'call-1', name: 'pwsh', arguments: JSON.stringify({ command: 'Set-Content C:\\tmp\\a.txt -Value 1' }) } },
  ];
  return {
    header: { id, title, cwd },
    get seq() { return log.length; },
    eventAt: (seq) => log[seq],
  };
}

/** A fake HTTP response recording what the handler wrote. */
export function fakeResponse() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? null; },
    end(chunk) { if (chunk !== undefined) this.body = String(chunk); },
    json() { return JSON.parse(this.body); },
  };
}

/**
 * Lay out a fake DSH Desktop installation inside a temp home, so discovery,
 * icon resolution, and the focus registration are exercised deterministically
 * instead of against whatever machine runs the suite.
 *
 * @param home - the temp harness home.
 * @returns the paths the plugin should discover.
 */
export function fakeDesktopTree(home) {
  const root = join(home, 'Programs', 'DSH Desktop');
  const resources = join(root, 'resources');
  const nodeBin = join(resources, 'app', 'node_modules', 'node', 'bin');
  mkdirSync(nodeBin, { recursive: true });
  writeFileSync(join(root, 'DSH Desktop.exe'), '');
  writeFileSync(join(resources, 'icon.png'), '');
  writeFileSync(join(resources, 'harness-node-entry.mjs'), '');
  return {
    root,
    exePath: join(root, 'DSH Desktop.exe'),
    iconPath: join(resources, 'icon.png'),
    execPath: join(nodeBin, 'node.exe'),
    argv: ['node.exe', join(resources, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
  };
}

/** Start the plugin against a temp home, a fake desktop install, and fakes. */
export function boot(options = {}) {
  const home = options.home ?? mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-plugin-'));
  const spawn = options.spawn ?? workingSpawn();
  const reg = options.reg ?? createFakeReg();
  const desktop = fakeDesktopTree(home);
  const { ctx, listeners, routes, effects, logs, injections } = fakeContext({
    lateWebServer: options.lateWebServer,
    webPort: options.webPort,
    webServer: options.webServer,
  });
  const reports = [];
  const handles = start(ctx, options.config, {
    spawn,
    reg,
    execPath: desktop.execPath,
    argv: desktop.argv,
    platform: options.platform ?? 'win32',
    env: { DSH_HOME: home, DSH_WEB_URL: 'http://127.0.0.1:43129', ...options.env },
    home,
    now: options.now,
    autoCreate: options.autoCreate,
    presenceTtlMs: options.presenceTtlMs,
    inboxLimit: options.inboxLimit,
    report: (message) => reports.push(message),
    // The script-host probe launches a real process; tests decide its verdict.
    probeScriptHost: options.probeScriptHost ?? (() => true),
  });
  return { ctx, listeners, routes, effects, logs, injections, reports, spawn, reg, desktop, handles, home };
}

/** A request stub the handlers can read a URL from. */
export function fakeRequest({ method = 'GET', url = '/', body = '' } = {}) {
  const emitter = new EventTarget();
  const request = {
    method,
    url,
    headers: {},
    setEncoding() {},
    on(event, handler) {
      if (event === 'data' && body !== '') setImmediate(() => handler(body));
      if (event === 'end') setImmediate(() => handler());
      if (event === 'error' || event === 'aborted') emitter.addEventListener(event, () => handler());
      return request;
    },
  };
  return request;
}

/** The durable approval event every routing test fires. */
export const approvalEvent = {
  type: 'approval/asked',
  data: {
    id: 'req-1',
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access: 需要写工作区外的文件',
  },
};
