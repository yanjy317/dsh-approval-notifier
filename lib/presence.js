/**
 * Presence: which page is showing which session, and whether it is in front.
 *
 * The browser half reports `{ clientId, sessionId, visible }` whenever the
 * selection, the window focus, or the tab visibility changes, and keeps that
 * report fresh while its event stream is polling. The host half reads the
 * result to answer one question per notification:
 *
 * - the page is in front and already showing that session → the prompt is on
 *   screen, so nothing is raised at all;
 * - the page is in front but showing another session → an in-app notice, never
 *   a Windows toast (the toast is for when the window is *not* in front);
 * - no page is in front (or none is connected) → the OS toast, as before.
 *
 * Nothing here ever throws into the approval hot path: a malformed report is
 * rejected, and a stale one simply stops counting as live.
 *
 * @module dsh-approval-notifier/presence
 */

/** How long a report stays valid without a newer one. */
export const DEFAULT_PRESENCE_TTL_MS = 60000;

/** The three ways a notification can be raised. */
export const DELIVERY = Object.freeze({
  /** A Windows toast: the page is not in front (or no page is connected). */
  TOAST: 'toast',
  /** An in-app notice: the window is in front, but on another session. */
  IN_APP: 'in-app',
  /** Nothing: the pending prompt is already on screen. */
  SILENT: 'silent',
});

/**
 * Create the registry of connected pages.
 *
 * @param options - `{ now?, ttlMs? }` (both injectable for tests).
 * @returns `{ report, touch, showing, foreground, live, snapshot }`.
 */
export function createPresence(options = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : DEFAULT_PRESENCE_TTL_MS;
  /** clientId -> `{ sessionId, visible, at }`. */
  const pages = new Map();

  /** Whether one entry still counts as live at `time`. */
  const liveAt = (entry, time) => time - entry.at <= ttlMs;

  /** Forget every entry that went quiet. */
  const prune = (time) => {
    for (const [id, entry] of pages) {
      if (!liveAt(entry, time)) pages.delete(id);
    }
  };

  return {
    /**
     * Record one page's state.
     *
     * @param state - `{ clientId, sessionId?, visible? }`.
     * @returns true when the report was accepted.
     */
    report(state) {
      const clientId = typeof state?.clientId === 'string' ? state.clientId.trim() : '';
      if (clientId === '') return false;
      const time = now();
      pages.set(clientId, {
        sessionId: typeof state.sessionId === 'string' ? state.sessionId : '',
        visible: state.visible === true,
        at: time,
      });
      prune(time);
      return true;
    },

    /**
     * Refresh one page's liveness (its event stream is still being served).
     *
     * @param clientId - the page's id.
     * @returns true when that page was known.
     */
    touch(clientId) {
      const id = typeof clientId === 'string' ? clientId.trim() : '';
      const entry = id === '' ? undefined : pages.get(id);
      if (entry === undefined) return false;
      const time = now();
      entry.at = time;
      prune(time);
      return true;
    },

    /**
     * Whether a page is in front *and* already showing this session.
     *
     * @param sessionId - the session asking for attention.
     * @returns true when the prompt is already on screen.
     */
    showing(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return false;
      const time = now();
      for (const entry of pages.values()) {
        if (liveAt(entry, time) && entry.visible && entry.sessionId === sessionId) return true;
      }
      return false;
    },

    /** Whether any live page is in front. */
    foreground() {
      const time = now();
      for (const entry of pages.values()) {
        if (liveAt(entry, time) && entry.visible) return true;
      }
      return false;
    },

    /** Whether any page is connected at all. */
    live() {
      const time = now();
      for (const entry of pages.values()) {
        if (liveAt(entry, time)) return true;
      }
      return false;
    },

    /** A JSON-able snapshot for the diagnostics route. */
    snapshot() {
      const time = now();
      const entries = [];
      for (const [clientId, entry] of pages) {
        if (!liveAt(entry, time)) continue;
        entries.push({
          clientId,
          sessionId: entry.sessionId,
          visible: entry.visible,
          ageMs: time - entry.at,
        });
      }
      return { ttlMs, pages: entries };
    },
  };
}

/**
 * Pick how one notification should be raised.
 *
 * The two switches are the user's own: `suppressVisible` (never raise a prompt
 * that is already on screen) and `notifyInApp` (fall back to a toast rather
 * than an in-app notice). Absence of a connected page always means "toast",
 * so an older browser half, a closed window, or a headless run keeps working.
 *
 * @param sessionId - the session the notification belongs to.
 * @param presence - a {@link createPresence} instance.
 * @param settings - merged plugin settings.
 * @returns one of {@link DELIVERY}.
 */
export function decideDelivery(sessionId, presence, settings = {}) {
  if (!presence.live()) return DELIVERY.TOAST;
  if (settings.suppressVisible !== false && presence.showing(sessionId)) return DELIVERY.SILENT;
  if (settings.notifyInApp !== false && presence.foreground()) return DELIVERY.IN_APP;
  return DELIVERY.TOAST;
}
