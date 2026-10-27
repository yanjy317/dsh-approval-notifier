/**
 * The in-app notice queue: what the browser half should put on screen.
 *
 * The host half owns this queue because it is the only side that sees every
 * prompt durably — including the ones raised in a session the page has never
 * opened. Each entry is a small JSON record:
 *
 *   `{ seq, at, kind, key, sessionId, title, lines }`  a notice to show
 *   `{ seq, at, kind: 'clear', key, sessionId }`       retire that notice
 *   `{ seq, at, kind: 'navigate', sessionId }`         switch to that session
 *   `{ seq, at, kind: 'decide', … }`                   answer that pending approval
 *
 * The page reads it with a cursor (`seq`), so a reconnecting page resumes
 * instead of replaying, and entries age out so a fresh page never inherits a
 * prompt the user answered ten minutes ago. `onPush` is what makes the route's
 * long poll return the instant something is queued instead of after a timeout.
 *
 * @module dsh-approval-notifier/inbox
 */

/** Most entries retained at once (a storm stays bounded). */
export const DEFAULT_INBOX_LIMIT = 50;

/** How long a show/clear/decide notice stays readable. */
export const DEFAULT_NOTICE_TTL_MS = 300000;

/** How long a queued "switch to this session" click stays actionable. */
export const DEFAULT_NAVIGATE_TTL_MS = 120000;

/**
 * Create the notice queue.
 *
 * @param options - `{ now?, limit?, ttlMs?, navigateTtlMs? }`.
 * @returns `{ push, resolve, since, cursor, onPush, size, recent, clear }`.
 */
export function createInbox(options = {}) {
  const now = options.now ?? Date.now;
  const limit = Number.isFinite(options.limit) && options.limit > 0 ? options.limit : DEFAULT_INBOX_LIMIT;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_NOTICE_TTL_MS;
  const navigateTtlMs = Number.isFinite(options.navigateTtlMs) && options.navigateTtlMs > 0
    ? options.navigateTtlMs
    : DEFAULT_NAVIGATE_TTL_MS;

  /** Queued entries, oldest first. */
  let entries = [];
  /** Notice keys with a show entry that has not been retired yet. */
  const outstanding = new Set();
  /** Monotonic sequence handed to readers as a cursor. */
  let seq = 0;
  const listeners = new Set();

  /** How long one entry stays readable. */
  const ttlOf = (entry) => (entry.kind === 'navigate' ? navigateTtlMs : ttlMs);

  /** Drop aged-out and over-limit entries; returns whether anything went. */
  function trim(time) {
    const kept = entries.filter((entry) => time - entry.at <= ttlOf(entry));
    const bounded = kept.length > limit ? kept.slice(kept.length - limit) : kept;
    const dropped = bounded.length !== entries.length;
    entries = bounded;
    return dropped;
  }

  /** Wake every waiter; a throwing waiter must not block the others. */
  function notify() {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // A broken waiter is dropped by its own unsubscribe.
      }
    }
  }

  /**
   * Queue one entry.
   *
   * @param entry - the notice fields (`kind`, `key`, `sessionId`, `title`, `lines`).
   * @returns the stored event, including its `seq` and `at`.
   */
  function push(entry) {
    const time = now();
    seq += 1;
    const event = { seq, at: time, ...entry };
    entries.push(event);
    if (event.kind === 'clear' || event.kind === 'decide') outstanding.delete(event.key);
    else if (event.kind !== 'navigate') outstanding.add(event.key);
    trim(time);
    notify();
    return event;
  }

  /**
   * Retire one visible notice, if it is still outstanding.
   *
   * @param key - the notice key (e.g. `approval|req-1`).
   * @param sessionId - the owning session, carried for the reader's benefit.
   * @returns the `clear` event, or undefined when nothing matched.
   */
  function resolve(key, sessionId = '') {
    if (typeof key !== 'string' || key === '') return undefined;
    if (!outstanding.has(key)) return undefined;
    return push({ kind: 'clear', key, sessionId });
  }

  /**
   * Every retained entry newer than a cursor.
   *
   * @param cursor - the last `seq` the reader processed (`0` for a new reader).
   * @returns the entries to apply, oldest first.
   */
  function since(cursor) {
    const time = now();
    trim(time);
    const from = Number.isFinite(Number(cursor)) ? Number(cursor) : 0;
    return entries.filter((entry) => entry.seq > from);
  }

  return {
    push,
    resolve,
    since,
    /** The sequence of the newest entry (a reader's next cursor). */
    cursor: () => seq,
    /**
     * Subscribe to "something was queued".
     *
     * @param listener - called with no arguments.
     * @returns the unsubscriber.
     */
    onPush(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** How many entries are retained right now. */
    size() {
      trim(now());
      return entries.length;
    },
    /** The newest entries (diagnostics only). */
    recent(count = 10) {
      trim(now());
      return entries.slice(-Math.max(0, count));
    },
    /** Drop everything (disposal). */
    clear() {
      entries = [];
      outstanding.clear();
      seq = 0;
    },
  };
}
