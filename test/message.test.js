import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_LINES,
  buildApprovalNotification,
  buildQuestionNotification,
  buildTestNotification,
  previewOf,
  truncate,
} from '../lib/message.js';

test('truncate never splits a surrogate pair and marks what it cut', () => {
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(truncate('abcdef', 4), 'abc…');
  // An emoji is one code point but two UTF-16 units: slicing by unit would
  // leave a lone surrogate, which Windows renders as a replacement glyph.
  const emoji = '😀😀😀';
  const cut = truncate(emoji, 2);
  assert.equal(Array.from(cut).length, 2);
  assert.equal(Array.from(cut)[0], '😀');
  assert.doesNotMatch(cut, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u);
});

test('previewOf reduces a tool call to one readable line', () => {
  assert.equal(previewOf(JSON.stringify({ command: 'Set-Content C:\\tmp\\a.txt -Value 1' })), 'Set-Content C:\\tmp\\a.txt -Value 1');
  assert.equal(previewOf(JSON.stringify({ path: 'D:\\a\\b.txt' })), 'D:\\a\\b.txt');
  assert.equal(previewOf('  raw   text  '), 'raw text', 'whitespace collapses');
  assert.equal(previewOf(''), '');
  assert.equal(previewOf(undefined), '');
  assert.equal(previewOf(JSON.stringify({ unrelated: 1 })), '{"unrelated":1}');
});

test('an approval notification names the tool, the reason, the command and the session', () => {
  const notification = buildApprovalNotification(
    { id: 'req-1', toolName: 'pwsh', callId: 'call-1', reason: '需要写工作区外的文件' },
    { sessionId: 'session-1', title: '插件通知调试', command: JSON.stringify({ command: 'Set-Content C:\\tmp\\a.txt -Value 1' }) },
  );
  assert.equal(notification.kind, 'approval');
  assert.equal(notification.key, 'approval|req-1');
  assert.equal(notification.noticeKey, 'approval|req-1');
  assert.equal(notification.title, '需要你确认：pwsh');
  assert.deepEqual(notification.lines, [
    '需要你确认：pwsh',
    '需要写工作区外的文件',
    'Set-Content C:\\tmp\\a.txt -Value 1',
    '会话：插件通知调试',
  ]);
});

test('an approval without an id still gets a stable key', () => {
  const notification = buildApprovalNotification({ toolName: 'bash' }, { sessionId: 's' });
  assert.equal(notification.key, 'approval|bash');
  assert.equal(notification.lines[0], '需要你确认：bash');
});

test('a notification never exceeds the line budget', () => {
  const notification = buildApprovalNotification(
    { id: 'req-1', toolName: 'pwsh', reason: 'x'.repeat(400) },
    { title: 'y'.repeat(200), command: 'z'.repeat(400) },
  );
  assert.ok(notification.lines.length <= MAX_LINES);
  for (const line of notification.lines) assert.ok(Array.from(line).length <= 200);
});

test('a question notification carries the header, the text and the options', () => {
  const notification = buildQuestionNotification(
    {
      questions: [
        {
          header: '系统通知',
          question: '看到了吗？',
          options: [{ label: '看到了' }, { label: '没看到' }],
        },
        { header: '第二问', question: '然后呢？' },
      ],
    },
    { sessionId: 's', title: '插件通知调试' },
  );
  assert.equal(notification.kind, 'question');
  assert.equal(notification.title, '需要你的回答：系统通知');
  assert.deepEqual(notification.lines, [
    '需要你的回答：系统通知',
    '看到了吗？',
    '看到了 / 没看到',
    '共 2 个问题',
    '会话：插件通知调试',
  ]);
  assert.match(notification.key, /^question\|看到了吗？\|2$/u, 'the same pending question keeps one card');
});

test('a question notification tolerates a bare request', () => {
  const notification = buildQuestionNotification({}, {});
  assert.equal(notification.title, '需要你的回答');
  assert.deepEqual(notification.lines, ['需要你的回答']);
});

test('the self-test record uses the overrides it is given', () => {
  const plain = buildTestNotification({});
  assert.equal(plain.kind, 'test');
  assert.deepEqual(plain.lines, ['测试', '来自 /dsh-approval-notifier/test']);
  const custom = buildTestNotification({ title: '标题', body: '正文' });
  assert.deepEqual(custom.lines, ['标题', '正文']);
});
