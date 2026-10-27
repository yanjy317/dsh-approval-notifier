/**
 * Settings: shipped defaults, three override layers, and a hot-reloaded file.
 *
 * Precedence, lowest first: built-in defaults, the plugin's cordis `config`,
 * `<DSH_HOME>/dsh-approval-notifier.json`, then environment variables. The file
 * is re-read on every notification (mtime + size cached), so day-to-day toggles
 * never need a DSH restart. Nothing here throws: a broken layer is dropped and
 * the previous one keeps applying, because failing to read a preference must
 * never cost a notification.
 *
 * @module dsh-approval-notifier/config
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The settings document this plugin owns inside the harness home. */
export const CONFIG_FILE_NAME = 'dsh-approval-notifier.json';

/** Every accepted setting at its shipped default. */
export const DEFAULTS = Object.freeze({
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
  desktopExePath: '',
  appId: 'DSH.ApprovalNotifier',
  iconPath: '',
  dedupeMs: 1500,
  maxPerMinute: 30,
  timeoutMs: 15000,
  powershellPath: '',
  log: true,
  logFile: '',
});

/** Every accepted `clickAction`, in the order they are tried. */
export const CLICK_ACTIONS = Object.freeze(['auto', 'focus-app', 'open-url', 'none']);

/** One-line explanation shipped inside the generated settings file. */
const README_LINE = [
  'dsh-approval-notifier：每次需要你审批（或回答提问）时弹一条 Windows 通知。',
  '正在看的会话不再打扰，其他会话改用应用内提醒（点一下就跳过去）。',
  '审批通知带「允许一次 / 拒绝」两颗按钮，可以直接在通知里答掉。',
  '改完保存即刻生效，无需重启 DSH。enabled=false 可整体关闭；sound=false 静音。',
].join(' ');

/** Keys whose value must stay a boolean. */
const BOOLEAN_KEYS = [
  'enabled',
  'notifyApprovals',
  'notifyQuestions',
  'notifyInApp',
  'suppressVisible',
  'decideFromToast',
  'sound',
  'includeToolCall',
  'log',
];

/** Keys whose value must stay a positive number. */
const NUMBER_KEYS = ['dedupeMs', 'maxPerMinute', 'timeoutMs'];

/** Keys whose value must stay a string. */
const STRING_KEYS = ['openUrl', 'appId', 'iconPath', 'powershellPath', 'logFile', 'focusScheme', 'desktopExePath'];

/**
 * Resolve the harness home the way the desktop build does.
 *
 * @param env - environment to read.
 * @returns the absolute harness home.
 */
export function resolveHome(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '') return env.DSH_HOME;
  const appData = typeof env.APPDATA === 'string' ? env.APPDATA : '';
  return appData === '' ? process.cwd() : join(appData, 'dsh-desktop', 'harness');
}

/**
 * Coerce one untrusted settings layer into the shipped shapes.
 *
 * Unknown and `_`-prefixed keys are dropped: a typo must not silently become
 * configuration. Invalid values are dropped rather than throwing, so a bad
 * file degrades to the previous layer instead of disabling notifications.
 *
 * @param raw - the candidate layer.
 * @returns a partial settings object.
 */
export function normalizeLayer(raw) {
  const layer = {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return layer;
  for (const key of BOOLEAN_KEYS) {
    if (typeof raw[key] === 'boolean') layer[key] = raw[key];
  }
  for (const key of NUMBER_KEYS) {
    const value = Number(raw[key]);
    if (Number.isFinite(value) && value > 0) layer[key] = value;
  }
  for (const key of STRING_KEYS) {
    if (typeof raw[key] === 'string') layer[key] = raw[key];
  }
  if (typeof raw.clickAction === 'string' && CLICK_ACTIONS.includes(raw.clickAction)) {
    layer.clickAction = raw.clickAction;
  }
  return layer;
}

/**
 * Resolve the log file, which may be overridden or disabled entirely.
 *
 * @param settings - merged settings.
 * @param home - harness home.
 * @returns the absolute log path, or `''` when logging is off.
 */
export function resolveLogFile(settings, home) {
  if (settings.log === false) return '';
  if (typeof settings.logFile === 'string' && settings.logFile !== '') return settings.logFile;
  return join(home, 'dsh-approval-notifier.log');
}

/**
 * The URL a click should open when settings name no explicit target.
 *
 * @param merged - merged settings.
 * @param env - environment to read.
 * @returns the fallback URL, or `''`.
 */
function resolveOpenUrl(merged, env) {
  if (typeof merged.openUrl === 'string' && merged.openUrl !== '') return merged.openUrl;
  const fromEnv = typeof env.DSH_WEB_URL === 'string' ? env.DSH_WEB_URL : '';
  return fromEnv;
}

/**
 * The documented default document, written once when the file is absent.
 *
 * Keys the profile already sets are left out: the file outranks the plugin
 * config, so writing a default into it would silently override what the profile
 * asked for (a generated `decideFromToast: true` beating
 * `config: { decideFromToast: false }` looks like a bug in the feature). An
 * empty or absent key simply keeps falling through to the layer below.
 *
 * @param pluginLayer - the keys the profile already sets.
 * @returns the JSON text to write.
 */
function defaultFileContents(pluginLayer = {}) {
  const document = {
    _readme: README_LINE,
    enabled: DEFAULTS.enabled,
    notifyApprovals: DEFAULTS.notifyApprovals,
    notifyQuestions: DEFAULTS.notifyQuestions,
    notifyInApp: DEFAULTS.notifyInApp,
    suppressVisible: DEFAULTS.suppressVisible,
    decideFromToast: DEFAULTS.decideFromToast,
    sound: DEFAULTS.sound,
    includeToolCall: DEFAULTS.includeToolCall,
    clickAction: DEFAULTS.clickAction,
    openUrl: DEFAULTS.openUrl,
    focusScheme: DEFAULTS.focusScheme,
    desktopExePath: DEFAULTS.desktopExePath,
    appId: DEFAULTS.appId,
    iconPath: DEFAULTS.iconPath,
    dedupeMs: DEFAULTS.dedupeMs,
    maxPerMinute: DEFAULTS.maxPerMinute,
    timeoutMs: DEFAULTS.timeoutMs,
    powershellPath: DEFAULTS.powershellPath,
    log: DEFAULTS.log,
    logFile: DEFAULTS.logFile,
  };
  for (const key of Object.keys(pluginLayer)) delete document[key];
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Create a live settings resolver.
 *
 * @param options - `{ pluginConfig?, env?, home?, filePath?, autoCreate? }`.
 * @returns `{ path, current(), describe(), ensureFile() }`.
 */
export function createConfigResolver(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? resolveHome(env);
  const filePath = typeof options.filePath === 'string' && options.filePath !== ''
    ? options.filePath
    : join(home, CONFIG_FILE_NAME);
  const pluginLayer = normalizeLayer(options.pluginConfig);
  const autoCreate = options.autoCreate !== false;

  /** Cached file layer, invalidated by mtime/size. */
  let cache = { mtimeMs: -1, size: -1, layer: {}, error: '' };

  /** Write the documented defaults when the file is absent. */
  function ensureFile() {
    if (!autoCreate) return false;
    try {
      statSync(filePath);
      return false;
    } catch {
      // Absent (or unreadable): create the documented default document.
    }
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(filePath, defaultFileContents(pluginLayer), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /** Read the file layer, reusing the cache while it is unchanged. */
  function fileLayer() {
    let stats;
    try {
      stats = statSync(filePath);
    } catch {
      cache = { mtimeMs: -1, size: -1, layer: {}, error: '' };
      return cache;
    }
    if (stats.mtimeMs === cache.mtimeMs && stats.size === cache.size) return cache;
    let layer = {};
    let error = '';
    try {
      const raw = JSON.parse(readFileSync(filePath, 'utf8'));
      layer = normalizeLayer(raw);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    }
    cache = { mtimeMs: stats.mtimeMs, size: stats.size, layer, error };
    return cache;
  }

  /** The merged settings this notification will use. */
  function current() {
    const file = fileLayer();
    const merged = { ...DEFAULTS, ...pluginLayer, ...file.layer };
    const envDisable = env.DSH_APPROVAL_NOTIFIER_DISABLE;
    if (typeof envDisable === 'string' && envDisable !== '' && envDisable !== '0' && envDisable !== 'false') {
      merged.enabled = false;
    }
    merged.openUrl = resolveOpenUrl(merged, env);
    merged.logFile = resolveLogFile(merged, home);
    return merged;
  }

  return {
    path: filePath,
    home,
    current,
    /** `{ path, error }` for the diagnostics route. */
    describe() {
      const file = fileLayer();
      return { path: filePath, error: file.error };
    },
    ensureFile,
  };
}
