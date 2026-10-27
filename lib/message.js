/**
 * Pure copy: what a notification says, and the key that identifies it.
 *
 * Everything here is a function of data the host half already has — the durable
 * audit event, the session's own log — so it is exhaustively testable without a
 * subprocess, a registry, or a browser. Lines are truncated by code point
 * rather than by UTF-16 unit, so a CJK title never ends in a broken surrogate.
 *
 * @module dsh-approval-notifier/message
 */

/** One toast shows at most this many lines (Windows truncates the rest). */
export const MAX_LINES = 5;

/** How long one line may be before it is elided. */
export const MAX_LINE_LENGTH = 160;

/**
 * Truncate by code point, so a surrogate pair is never split.
 *
 * @param value - the text to shorten.
 * @param limit - the maximum number of code points.
 * @returns the shortened text, with an ellipsis when anything was cut.
 */
export function truncate(value, limit = MAX_LINE_LENGTH) {
  const text = typeof value === 'string' ? value : String(value ?? '');
  const points = Array.from(text);
  if (points.length <= limit) return text;
  return `${points.slice(0, Math.max(0, limit - 1)).join('')}…`;
}

/**
 * Collapse a tool's arguments into one readable preview line.
 *
 * @param value - the raw argument JSON, when it is known.
 * @returns a single-line preview, or `''`.
 */
export function previewOf(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  let text = value.trim();
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object') {
      const candidate = parsed.command ?? parsed.path ?? parsed.file_path ?? parsed.query;
      if (typeof candidate === 'string' && candidate.trim() !== '') text = candidate;
      else text = JSON.stringify(parsed);
    }
  } catch {
    // Not JSON: the raw text is already the best preview.
  }
  return truncate(text.replace(/\s+/gu, ' ').trim(), MAX_LINE_LENGTH);
}

/** The session line every notice carries, so a toast is self-describing. */
function sessionLine(info) {
  const title = typeof info.title === 'string' && info.title.trim() !== '' ? info.title.trim() : '';
  if (title === '') return '';
  return `会话：${truncate(title, 60)}`;
}

/** Attach the session line and cap the toast at {@link MAX_LINES}. */
function finish(lines) {
  return lines.filter((line) => typeof line === 'string' && line.trim() !== '').slice(0, MAX_LINES);
}

/**
 * Build the record for one permission request.
 *
 * @param data - the `approval/asked` payload (`id`, `toolName`, `callId`, `reason`).
 * @param info - `{ sessionId, title, command }` read from the session log.
 * @returns `{ kind, key, noticeKey, title, lines }`.
 */
export function buildApprovalNotification(data, info = {}) {
  const id = data?.id === undefined || data?.id === null ? '' : String(data.id);
  const toolName = typeof data?.toolName === 'string' && data.toolName !== '' ? data.toolName : '工具';
  const title = `需要你确认：${toolName}`;
  const reason = typeof data?.reason === 'string' ? truncate(data.reason, MAX_LINE_LENGTH) : '';
  const command = previewOf(info.command);
  const key = id === '' ? `approval|${toolName}` : `approval|${id}`;
  return {
    kind: 'approval',
    key,
    noticeKey: key,
    title,
    lines: finish([title, reason, command, sessionLine(info)]),
  };
}

/**
 * Build the record for one pending `ask_user_question`.
 *
 * @param request - the waterfall request (`{ questions, agent }`).
 * @param info - `{ sessionId, title }` read from the session log.
 * @returns `{ kind, key, noticeKey, title, lines }`.
 */
export function buildQuestionNotification(request, info = {}) {
  const questions = Array.isArray(request?.questions) ? request.questions : [];
  const first = questions[0] ?? {};
  const header = typeof first.header === 'string' && first.header !== '' ? first.header : '';
  const text = typeof first.question === 'string' ? first.question : '';
  const title = header === '' ? '需要你的回答' : `需要你的回答：${truncate(header, 40)}`;
  const options = Array.isArray(first.options) ? first.options : [];
  const optionLine = options
    .map((option) => (typeof option?.label === 'string' ? option.label : ''))
    .filter((label) => label !== '')
    .join(' / ');
  const more = questions.length > 1 ? `共 ${questions.length} 个问题` : '';
  // Stable per request: the same pending question must not produce two cards.
  const key = `question|${truncate(text, 80)}|${questions.length}`;
  return {
    kind: 'question',
    key,
    noticeKey: key,
    title,
    lines: finish([title, truncate(text, MAX_LINE_LENGTH), optionLine, more, sessionLine(info)]),
  };
}

/**
 * Build the record the self-test route sends.
 *
 * @param overrides - `{ title?, body? }`.
 * @returns `{ kind, key, noticeKey, title, lines }`.
 */
export function buildTestNotification(overrides = {}) {
  const title = typeof overrides.title === 'string' && overrides.title !== '' ? overrides.title : '测试';
  const body = typeof overrides.body === 'string' && overrides.body !== ''
    ? overrides.body
    : '来自 /dsh-approval-notifier/test';
  return {
    kind: 'test',
    key: 'test|manual',
    noticeKey: 'test|manual',
    title,
    lines: finish([title, body]),
  };
}
