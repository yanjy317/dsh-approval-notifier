/**
 * Read-only session context: what the notification needs to be self-describing.
 *
 * Everything here reads the session's own log through the public `Session`
 * surface (`header`, `seq`, `eventAt`) and never writes, mutates, or blocks on
 * it. A session whose log cannot be read simply yields empty fields: the toast
 * still fires, it just says less.
 *
 * @module dsh-approval-notifier/session-read
 */

/** How far back the tool-call preview looks for its matching `tool/call`. */
const TOOL_CALL_LOOKBACK = 40;

/**
 * The durable title a session is known by.
 *
 * @param session - the session (or its header stub).
 * @returns the title, or `''`.
 */
export function titleOf(session) {
  try {
    const title = session?.header?.title;
    return typeof title === 'string' ? title : '';
  } catch {
    return '';
  }
}

/**
 * The session id the audit event belongs to.
 *
 * @param session - the session.
 * @returns the id, or `''`.
 */
export function sessionIdOf(session) {
  try {
    const id = session?.header?.id;
    return typeof id === 'string' ? id : '';
  } catch {
    return '';
  }
}

/**
 * The arguments of the tool call this approval is about.
 *
 * `approval/asked` carries the call id but not the arguments, so the matching
 * `tool/call` is recovered from the log. Walking backwards from the newest event
 * finds the call that is *currently* pending even when a turn made several.
 *
 * @param session - the session whose log to read.
 * @param callId - the call id from the audit event.
 * @returns the raw argument JSON, or `''`.
 */
export function commandOf(session, callId) {
  if (typeof callId !== 'string' || callId === '') return '';
  try {
    const total = Number(session.seq);
    if (!Number.isFinite(total) || total <= 0) return '';
    const floor = Math.max(0, total - TOOL_CALL_LOOKBACK);
    for (let seq = total - 1; seq >= floor; seq -= 1) {
      const event = session.eventAt(seq);
      if (event?.type !== 'tool/call') continue;
      if (event.data?.callId !== callId) continue;
      const args = event.data?.arguments;
      return typeof args === 'string' ? args : '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * The context a notification is built from.
 *
 * @param session - the requesting session.
 * @param options - `{ callId?, includeToolCall? }`.
 * @returns `{ sessionId, title, command }`.
 */
export function readSessionContext(session, options = {}) {
  const includeToolCall = options.includeToolCall !== false;
  return {
    sessionId: sessionIdOf(session),
    title: titleOf(session),
    command: includeToolCall ? commandOf(session, options.callId) : '',
  };
}

/**
 * Whether a session's approval policy is `never` (prompts are auto-rejected).
 *
 * Such a session never shows a prompt, so notifying about one would be a false
 * alarm — the audit event still fires, and this is what filters it.
 *
 * @param approval - the composed `approval` service, when available.
 * @param session - the session to inspect.
 * @returns true when the policy is `never`.
 */
export function approvalPolicyIsNever(approval, session) {
  try {
    if (approval === undefined || approval === null) return false;
    if (typeof approval.effectivePolicy !== 'function') return false;
    return approval.effectivePolicy(session) === 'never';
  } catch {
    return false;
  }
}
