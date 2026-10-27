import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approvalPolicyIsNever,
  commandOf,
  readSessionContext,
  sessionIdOf,
  titleOf,
} from '../lib/session-read.js';

/** A session whose log holds the given events. */
function sessionOf(events, header = { id: 'session-1', title: '插件通知调试' }) {
  return {
    header,
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
  };
}

test('the session id and title come off the header', () => {
  const session = sessionOf([], { id: 'session-9', title: '标题' });
  assert.equal(sessionIdOf(session), 'session-9');
  assert.equal(titleOf(session), '标题');
  assert.equal(titleOf({ header: {} }), '');
  assert.equal(sessionIdOf(undefined), '');
});

test('the tool arguments are recovered from the matching tool/call', () => {
  const session = sessionOf([
    { type: 'tool/call', data: { callId: 'call-1', arguments: '{"command":"first"}' } },
    { type: 'tool/call', data: { callId: 'call-2', arguments: '{"command":"second"}' } },
  ]);
  assert.equal(commandOf(session, 'call-2'), '{"command":"second"}');
  assert.equal(commandOf(session, 'call-1'), '{"command":"first"}');
  assert.equal(commandOf(session, 'call-missing'), '');
  assert.equal(commandOf(session, ''), '');
});

test('the newest matching call wins when a turn repeated one', () => {
  const session = sessionOf([
    { type: 'tool/call', data: { callId: 'call-1', arguments: 'old' } },
    { type: 'tool/call', data: { callId: 'call-1', arguments: 'new' } },
  ]);
  assert.equal(commandOf(session, 'call-1'), 'new');
});

test('a session whose log cannot be read yields empty fields, never a throw', () => {
  const broken = {
    header: { id: 'session-1' },
    get seq() { throw new Error('gone'); },
    eventAt: () => { throw new Error('gone'); },
  };
  assert.equal(commandOf(broken, 'call-1'), '');
  const context = readSessionContext(broken, { callId: 'call-1' });
  assert.equal(context.sessionId, 'session-1');
  assert.equal(context.command, '');
});

test('includeToolCall: false keeps the command out of the notification', () => {
  const session = sessionOf([{ type: 'tool/call', data: { callId: 'call-1', arguments: '{"command":"x"}' } }]);
  assert.equal(readSessionContext(session, { callId: 'call-1' }).command, '{"command":"x"}');
  assert.equal(readSessionContext(session, { callId: 'call-1', includeToolCall: false }).command, '');
});

test('approvalPolicyIsNever reads the composed approval service defensively', () => {
  const neverService = { effectivePolicy: () => 'never' };
  const askService = { effectivePolicy: () => 'ask' };
  assert.equal(approvalPolicyIsNever(neverService, {}), true);
  assert.equal(approvalPolicyIsNever(askService, {}), false);
  assert.equal(approvalPolicyIsNever(undefined, {}), false);
  assert.equal(approvalPolicyIsNever({}, {}), false);
  assert.equal(
    approvalPolicyIsNever({ effectivePolicy: () => { throw new Error('boom'); } }, {}),
    false,
    'a broken service must not silence notifications',
  );
});
