import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIG_FILE_NAME,
  DEFAULTS,
  createConfigResolver,
  normalizeLayer,
  resolveHome,
  resolveLogFile,
} from '../lib/config.js';

const HOME = 'D:\\home';

test('shipped defaults describe a working notification setup', () => {
  assert.equal(DEFAULTS.enabled, true);
  assert.equal(DEFAULTS.decideFromToast, true, 'the decision buttons are the point of the feature');
  assert.equal(DEFAULTS.suppressVisible, true);
  assert.equal(DEFAULTS.focusScheme, 'dsh-approval-notifier');
});

test('normalizeLayer keeps known keys of the right shape and drops the rest', () => {
  const layer = normalizeLayer({
    _readme: 'ignored',
    unknownKey: 1,
    enabled: false,
    notifyInApp: 'yes',
    decideFromToast: false,
    maxPerMinute: 5,
    dedupeMs: -1,
    clickAction: 'open-url',
    iconPath: 'D:\\icon.png',
  });
  assert.deepEqual(layer, {
    enabled: false,
    decideFromToast: false,
    maxPerMinute: 5,
    clickAction: 'open-url',
    iconPath: 'D:\\icon.png',
  });
});

test('normalizeLayer rejects a non-object layer instead of throwing', () => {
  assert.deepEqual(normalizeLayer(null), {});
  assert.deepEqual(normalizeLayer('nope'), {});
  assert.deepEqual(normalizeLayer([]), {});
});

test('resolveHome prefers DSH_HOME and falls back to the desktop app data', () => {
  assert.equal(resolveHome({ DSH_HOME: HOME }), HOME);
  assert.equal(resolveHome({ APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }), join('C:\\Users\\u\\AppData\\Roaming', 'dsh-desktop', 'harness'));
});

test('resolveLogFile honours an override, a custom path, and being switched off', () => {
  assert.equal(resolveLogFile({ log: true, logFile: '' }, HOME), join(HOME, 'dsh-approval-notifier.log'));
  assert.equal(resolveLogFile({ log: true, logFile: 'D:\\x.log' }, HOME), 'D:\\x.log');
  assert.equal(resolveLogFile({ log: false, logFile: 'D:\\x.log' }, HOME), '');
});

test('the resolver layers defaults, plugin config, the file, then the environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-config-'));
  writeFileSync(join(home, CONFIG_FILE_NAME), JSON.stringify({ sound: false, maxPerMinute: 7 }), 'utf8');
  const resolver = createConfigResolver({
    pluginConfig: { sound: true, includeToolCall: false },
    env: { DSH_HOME: home },
    home,
    autoCreate: false,
  });
  const settings = resolver.current();
  assert.equal(settings.sound, false, 'the file beats the plugin config');
  assert.equal(settings.maxPerMinute, 7);
  assert.equal(settings.includeToolCall, false, 'the plugin config beats the defaults');
  assert.equal(settings.decideFromToast, true, 'defaults fill the rest');
});

test('DSH_APPROVAL_NOTIFIER_DISABLE=1 switches everything off', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-config-'));
  const resolver = createConfigResolver({ env: { DSH_HOME: home, DSH_APPROVAL_NOTIFIER_DISABLE: '1' }, home, autoCreate: false });
  assert.equal(resolver.current().enabled, false);
});

test('the settings file is created once and then left alone', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-config-'));
  const resolver = createConfigResolver({ env: { DSH_HOME: home }, home });
  assert.equal(resolver.ensureFile(), true, 'the first start writes the documented defaults');
  assert.equal(resolver.ensureFile(), false, 'a later start keeps the user edits');
  const written = JSON.parse(readFileSync(join(home, CONFIG_FILE_NAME), 'utf8'));
  assert.equal(written.decideFromToast, true);
  assert.match(written._readme, /审批/);
});

test('a broken settings file degrades to the previous layer and reports why', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-config-'));
  writeFileSync(join(home, CONFIG_FILE_NAME), '{ not json', 'utf8');
  const resolver = createConfigResolver({ env: { DSH_HOME: home }, home, autoCreate: false });
  assert.equal(resolver.current().enabled, true, 'a bad file must not disable notifications');
  assert.notEqual(resolver.describe().error, '');
});

test('the file layer is re-read when it changes, without a restart', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-approval-notifier-config-'));
  const path = join(home, CONFIG_FILE_NAME);
  writeFileSync(path, JSON.stringify({ sound: true }), 'utf8');
  const resolver = createConfigResolver({ env: { DSH_HOME: home }, home, autoCreate: false });
  assert.equal(resolver.current().sound, true);
  writeFileSync(path, JSON.stringify({ sound: false }), 'utf8');
  assert.equal(resolver.current().sound, false, 'the edit applies on the next notification');
});
