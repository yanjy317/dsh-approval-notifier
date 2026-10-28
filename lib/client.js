/**
 * Browser half of dsh-approval-notifier.
 *
 * The host half owns every decision (it is the side that sees each prompt
 * durably, including prompts in sessions this page has never opened). This half
 * does four things and nothing else:
 *
 * 1. reports `{ clientId, sessionId, visible }` — what it is showing and
 *    whether it is in front — so the host knows when a prompt is already on
 *    screen and when a Windows toast would only duplicate it;
 * 2. streams `/events` with a cursor, so an approval raised in *another*
 *    session shows as a card here, a toast click made while the window was
 *    behind arrives as a `navigate` instruction, and a 允许一次 / 拒绝 button
 *    pressed on a notification arrives as a `decide` instruction — answered
 *    through this page's own pending approval, exactly as its card would;
 * 3. renders those cards in `shell.overlay`, each one click-to-jump into its
 *    session (`uiWorkspace.openSession`) — at the top of the frame, never in the
 *    composer's corner, and never for the session already on screen;
 * 4. keeps a trace of what it could not do, once per distinct message.
 *
 * Every path is defensive: without the host routes, or without the `sessions`
 * service, the page simply has no cards — it never breaks the renderer.
 *
 * @module dsh-approval-notifier/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-approval-notifier',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    'use strict';

    var React = require('react');
    var h = React.createElement;

    /** Route prefix shared with the host half. */
    var ROUTE = '/dsh-approval-notifier';

    /** How long each `/events` request is held open waiting for news. */
    var POLL_WAIT_SECONDS = 25;

    /** Re-report the page state at least this often. */
    var HEARTBEAT_MS = 15000;

    /** Most cards on screen at once. */
    var MAX_CARDS = 3;

    /** A card nobody acted on disappears by itself. */
    var CARD_TTL_MS = 120000;

    /**
     * Where the stack sits, and how it takes the pointer.
     *
     * Top-center under the Windows titlebar, i.e. the app's own toast band
     * (`client-ui-primitives` parks its transient banner at `top:40px`). The
     * bottom of the window is where the composer lives, and an approval request
     * *takes the composer over* with its 允许 / 拒绝 buttons — so a notice
     * anchored to the bottom corner sits on the very controls the user has to
     * press, whether it describes this session or another one.
     *
     * The frame-wide overlay layer is painted above the whole app, so placement
     * is the only thing that can keep a notice out of the app's way. Hence: no
     * `z-index` of our own (an entry that wants to sit above us still can), and
     * the container stays click-through — only the cards themselves take the
     * pointer.
     */
    var STACK_STYLE = {
      position: 'fixed',
      top: 'calc(var(--dsh-windows-titlebar-height, 0px) + 12px)',
      left: '50%',
      transform: 'translateX(-50%)',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: 8,
      width: 'min(420px, calc(100vw - 32px))',
      pointerEvents: 'none',
    };

    /** Backoff after a failed poll or a suspiciously fast empty one. */
    var RETRY_MS = 2500;

    /** Messages already reported, so each distinct problem is logged once. */
    var warned = new Set();

    /**
     * Report one diagnostic without ever throwing, once per distinct message.
     *
     * Not once per page: the first problem a page hit used to silence every
     * later one, which hid exactly the failures worth reading.
     */
    function warn(message, error) {
      if (warned.has(message)) return;
      warned.add(message);
      try {
        if (typeof console !== 'undefined' && console.warn) console.warn('dsh-approval-notifier: ' + message, error);
      } catch {
        // A console failure must not affect the page.
      }
    }

    /** A short random id identifying this page to the host half. */
    function randomId() {
      return 'page-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    }

    /** A quiet, theme-neutral button. */
    var quietButton = {
      border: 0,
      background: 'transparent',
      color: 'inherit',
      opacity: 0.55,
      cursor: 'pointer',
      font: 'inherit',
      lineHeight: 1,
      padding: '2px 4px',
    };

    /** How many cards the stack draws before folding the rest away. */
    var VISIBLE_CARDS = 3;

    /** Longest a single preview line may run before it is clipped. */
    var PREVIEW_CHARS = 96;

    /** Per-kind presentation: accent colour, badge glyph, and wording. */
    var KINDS = {
      approval: {
        accent: '#e8590c',
        tint: 'rgba(232,89,12,.10)',
        glyph: '\u26A0',
        label: '\u5BA1\u6279',
        action: '\u9700\u8981\u4F60\u786E\u8BA4',
      },
      question: {
        accent: '#1971c2',
        tint: 'rgba(25,113,194,.10)',
        glyph: '\u003F',
        label: '\u63D0\u95EE',
        action: '\u9700\u8981\u4F60\u56DE\u7B54',
      },
    };

    /** The presentation for one card's kind (anything odd reads as approval). */
    function kindOf(card) {
      return card.kind === 'question' ? KINDS.question : KINDS.approval;
    }

    /**
     * Clip one preview line to a readable single line.
     *
     * Commands and reasons arrive as arbitrary text: a long `pwsh` invocation
     * used to wrap across the whole card and push the session it belonged to
     * out of sight. The full text stays behind the card's expander.
     *
     * @param value - the raw line.
     * @returns `{ text, clipped }`.
     */
    function previewLine(value) {
      var text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
      if (text.length <= PREVIEW_CHARS) return { text: text, clipped: false };
      return { text: text.slice(0, PREVIEW_CHARS).trimEnd() + '\u2026', clipped: true };
    }

    /**
     * A short "how long ago" label.
     *
     * A card that has been sitting there for ten minutes must not look like it
     * just arrived, so the age is always spelled out.
     *
     * @param at - when the card was first raised.
     * @param now - the current time.
     * @returns a human label.
     */
    function ageLabel(at, now) {
      var seconds = Math.max(0, Math.round((now - at) / 1000));
      if (seconds < 10) return '\u521A\u521A';
      if (seconds < 60) return seconds + ' \u79D2\u524D';
      var minutes = Math.round(seconds / 60);
      if (minutes < 60) return minutes + ' \u5206\u949F\u524D';
      return Math.round(minutes / 60) + ' \u5C0F\u65F6\u524D';
    }

    /** Build one inline action button: quiet, readable, never a full-width block. */
    function action(label, options) {
      var primary = options.primary === true;
      return h(
        'button',
        {
          type: 'button',
          'aria-label': options.ariaLabel || label,
          title: options.title || label,
          onClick: function (event) {
            event.stopPropagation();
            options.onPress();
          },
          style: {
            border: primary ? '0' : '1px solid rgba(128,128,128,.38)',
            background: primary ? KINDS.approval.accent : 'transparent',
            color: primary ? '#fff' : 'inherit',
            borderRadius: 7,
            padding: '4px 10px',
            font: 'inherit',
            fontSize: 12,
            fontWeight: primary ? 600 : 400,
            lineHeight: 1.4,
            cursor: 'pointer',
            opacity: primary ? 1 : 0.82,
            whiteSpace: 'nowrap',
          },
        },
        label,
      );
    }

    /**
     * The card store: a tiny observable list, kept outside React so the poll
     * loop can write to it without a component being mounted yet.
     *
     * The store also holds the page's own state — which session is on screen
     * and whether the window is in front — because that is what decides which
     * of the queued cards may be drawn: a notice about the prompt you are
     * already looking at is the conversation's own card, and a second copy of
     * it is at best noise and at worst sits on the buttons that card is asking
     * you to press. Keeping the rule here (rather than at the moment an event
     * arrives) means it is re-evaluated on every focus and selection change: a
     * notice held back this way is still queued, so it reappears if you navigate
     * while its prompt is still pending.
     *
     * @param options - `{ now?, maxCards?, ttlMs? }`.
     * @returns `{ getSnapshot, subscribe, add, drop, dropSession, prune, size, setView }`.
     */
    function createNoticeStore(options) {
      var config = options || {};
      var now = config.now || function () { return Date.now(); };
      var maxCards = config.maxCards > 0 ? config.maxCards : MAX_CARDS;
      var ttlMs = config.ttlMs > 0 ? config.ttlMs : CARD_TTL_MS;
      var cards = [];
      var listeners = new Set();
      /** What the page is showing; the default assumes no page is in front. */
      var view = { sessionId: '', foreground: false };
      /** The filtered slice handed to React, rebuilt when either input moves. */
      var drawn = null;

      function publish() {
        listeners.forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            warn('a card subscriber threw', error);
          }
        });
      }

      function indexOf(key) {
        for (var i = 0; i < cards.length; i += 1) if (cards[i].key === key) return i;
        return -1;
      }

      /** Drop the cached slice: the cards or the page state just changed. */
      function invalidate() {
        drawn = null;
      }

      /** The cards the stack may draw: never the prompt already on screen. */
      function visibleCards() {
        if (view.foreground !== true || view.sessionId === '') return cards;
        return cards.filter(function (card) {
          return card.sessionId !== view.sessionId;
        });
      }

      /** The cached visible slice, rebuilt on demand. */
      function snapshot() {
        if (drawn === null) drawn = visibleCards();
        return drawn;
      }

      return {
        getSnapshot: snapshot,
        subscribe: function (listener) {
          listeners.add(listener);
          return function () {
            listeners.delete(listener);
          };
        },
        /** Add or refresh one card; newest first, capped, oldest dropped. */
        add: function (notice) {
          var at = indexOf(String(notice.key));
          var previous = at >= 0 ? cards[at] : undefined;
          var card = {
            key: String(notice.key),
            kind: notice.kind === 'question' ? 'question' : 'approval',
            sessionId: typeof notice.sessionId === 'string' ? notice.sessionId : '',
            title: typeof notice.title === 'string' ? notice.title : '需要你处理',
            lines: Array.isArray(notice.lines) ? notice.lines.slice(0, 4) : [],
            // Carried through so an in-card 允许一次 / 拒绝 can prove it is
            // answering *this* approval and not a later one in the same session.
            callId: typeof notice.callId === 'string' ? notice.callId : '',
            toolName: typeof notice.toolName === 'string' ? notice.toolName : '',
            // Only a real approval may be answered from the card. A self-test
            // notice is drawn in the approval skin (so the layout can be
            // previewed) but names no pending interaction, so its buttons could
            // only ever do nothing — offering them would be a lie.
            decidable: notice.kind === 'approval',
            // A re-published notice keeps its original age, so a refresh does
            // not restart its dismissal timer or move it in the stack.
            at: previous === undefined ? now() : previous.at,
          };
          var next = cards.slice();
          if (at >= 0) next[at] = card;
          else next.unshift(card);
          cards = next.slice(0, maxCards);
          invalidate();
          publish();
          return card;
        },
        /** Drop one card by key; true when something went. */
        drop: function (key) {
          var at = indexOf(key);
          if (at < 0) return false;
          cards = cards.filter(function (card) { return card.key !== key; });
          invalidate();
          publish();
          return true;
        },
        /**
         * Flag one card as no longer answerable, with a reason to show.
         *
         * A card whose approval has already been answered (in the conversation,
         * from the toast, or by a later approval replacing it) must not just
         * swallow the click: the buttons stop working and the card explains why,
         * and it stops offering buttons that cannot do anything.
         *
         * @param key - the notice key.
         * @param reason - a short message for the card.
         * @returns true when the card was there.
         */
        markStale: function (key, reason) {
          var at = indexOf(key);
          if (at < 0) return false;
          var card = cards[at];
          if (card.decidable !== true) return false;
          var next = cards.slice();
          next[at] = Object.assign({}, card, {
            decidable: false,
            staleReason: typeof reason === 'string' ? reason : '',
          });
          cards = next;
          invalidate();
          publish();
          return true;
        },
        /** Drop every card pointing at one session (it is on screen now). */
        dropSession: function (sessionId) {
          if (typeof sessionId !== 'string' || sessionId === '') return false;
          var kept = cards.filter(function (card) { return card.sessionId !== sessionId; });
          if (kept.length === cards.length) return false;
          cards = kept;
          invalidate();
          publish();
          return true;
        },
        /** Drop cards nobody acted on. */
        prune: function () {
          var time = now();
          var kept = cards.filter(function (card) { return time - card.at <= ttlMs; });
          if (kept.length === cards.length) return false;
          cards = kept;
          invalidate();
          publish();
          return true;
        },
        /**
         * Record what this page is showing, so the cards follow it.
         *
         * @param next - `{ sessionId?, foreground? }`.
         * @returns true when the page state actually moved.
         */
        setView: function (next) {
          var sessionId = next !== null && next !== undefined && typeof next.sessionId === 'string' ? next.sessionId : '';
          var foreground = next !== null && next !== undefined && next.foreground === true;
          if (view.sessionId === sessionId && view.foreground === foreground) return false;
          view = { sessionId: sessionId, foreground: foreground };
          invalidate();
          publish();
          return true;
        },
        /** How many cards the stack would draw right now. */
        size: function () {
          return snapshot().length;
        },
      };
    }

    /**
     * Apply one `/events` entry to the store.
     *
     * Whether a notice is *drawn* is the store's call, not this function's: the
     * store holds the page state, so a card for the session on screen — now or
     * after the next focus change — is simply never part of its snapshot.
     *
     * `decide` is not a card at all: it is a 允许一次 / 拒绝 button pressed on the
     * notification, and it is answered through `view.decide` so the page resolves
     * the very approval its own card is showing.
     *
     * @param event - a queued entry (`kind`, `key`, `sessionId`, …).
     * @param store - the card store.
     * @param view - `{ navigate, decide }`, the channel's way into the page.
     * @returns true when something changed.
     */
    function reduceEvent(event, store, view) {
      if (event === null || typeof event !== 'object') return false;
      if (event.kind === 'navigate') {
        if (typeof event.sessionId !== 'string' || event.sessionId === '') return false;
        if (typeof view.navigate === 'function') view.navigate(event.sessionId);
        return store.dropSession(event.sessionId);
      }
      if (event.kind === 'decide') {
        if (typeof view.decide !== 'function') return false;
        return view.decide(event);
      }
      if (event.kind === 'clear') return store.drop(event.key);
      if (typeof event.key !== 'string' || event.key === '') return false;
      store.add(event);
      return true;
    }

    /**
     * Create the page's channel to the host half: state reports in, notices out.
     *
     * @param options - `{ ctx, store, fetch?, document?, window?, now?, setTimeout?, clearTimeout? }`.
     * @returns `{ start, stop, report, wake, navigate, decide, cursor }`.
     */
    function createChannel(options) {
      var ctx = options.ctx;
      var store = options.store;
      var doFetch = options.fetch || (typeof fetch === 'function' ? fetch : undefined);
      var doc = options.document || (typeof document !== 'undefined' ? document : undefined);
      var win = options.window || (typeof window !== 'undefined' ? window : undefined);
      var setTimer = options.setTimeout || setTimeout;
      var clearTimer = options.clearTimeout || clearTimeout;
      var clientId = options.clientId || randomId();
      var cursor = 0;
      var stopped = true;
      var timer = null;
      var heartbeat = null;
      var controller = null;

      /**
       * The session this page is showing right now.
       *
       * The Session Controller carries **no** "current session" selection:
       * `sessions.list` is the catalog, and the page's view is published as a
       * retention count on the row it displays (`retainedBy.mainView`, owned by
       * the Workspace UI). Reading a `current` field off that snapshot — the
       * pre-0.9 shape — yields undefined forever, which makes every report say
       * "no session": the host can then never match a prompt to the session on
       * screen, so it falls through to the in-app card every time.
       *
       * Same derivation as ui-layout / ui-session / ui-workspace / ui-cordis.
       */
      function sessionId() {
        try {
          var snapshot = ctx.sessions.list.getSnapshot();
          var byId = snapshot?.byId;
          if (byId === undefined || byId === null) return '';
          var rows = Object.values(byId);
          for (var i = 0; i < rows.length; i += 1) {
            var row = rows[i];
            if (row !== null && row !== undefined && (row.retainedBy?.mainView ?? 0) > 0) {
              return typeof row.id === 'string' ? row.id : '';
            }
          }
          return '';
        } catch (error) {
          return '';
        }
      }

      /** Whether this page is on screen and its window is the front one. */
      function foreground() {
        try {
          if (doc === undefined || doc.visibilityState !== 'visible') return false;
          return typeof doc.hasFocus === 'function' ? doc.hasFocus() === true : true;
        } catch (error) {
          return false;
        }
      }

      /** The Workspace UI service — the owner of "which session is on screen". */
      function uiWorkspace() {
        try {
          if (typeof ctx.get === 'function') return ctx.get('uiWorkspace');
          return ctx.uiWorkspace;
        } catch (error) {
          return undefined;
        }
      }

      /** The Session UI service — the owner of "what is pending in this session". */
      function uiSession() {
        try {
          if (typeof ctx.get === 'function') return ctx.get('uiSession');
          return ctx.uiSession;
        } catch (error) {
          return undefined;
        }
      }

      /**
       * Hand the page's current state to the card store.
       *
       * The store decides what may be drawn from it, so this runs on every
       * focus, visibility and selection change — the moments at which a card
       * for the session on screen has to stop being drawn, or may come back.
       */
      function syncView() {
        store.setView({ sessionId: sessionId(), foreground: foreground() });
      }

      /** Tell the host what this page is showing. */
      function report() {
        if (doFetch === undefined) return;
        try {
          var promise = doFetch(ROUTE + '/client-state', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ clientId: clientId, sessionId: sessionId(), visible: foreground() }),
            cache: 'no-store',
          });
          if (promise && typeof promise.catch === 'function') promise.catch(function () {});
        } catch (error) {
          warn('client-state report failed', error);
        }
      }

      /** Apply one response body to the store; returns whether it changed. */
      function apply(data) {
        if (data === null || typeof data !== 'object' || data.ok !== true) return false;
        if (typeof data.cursor === 'number' && data.cursor > cursor) cursor = data.cursor;
        var events = Array.isArray(data.events) ? data.events : [];
        syncView();
        var view = { navigate: navigate, decide: decide };
        var changed = false;
        for (var i = 0; i < events.length; i += 1) {
          changed = reduceEvent(events[i], store, view) || changed;
        }
        return changed;
      }

      /**
       * Switch this page to a session the host asked for.
       *
       * Navigation belongs to the Workspace UI (`uiWorkspace.openSession`) — the
       * Session Controller only owns the catalog. There is no
       * `sessions.open(id)`, so that call throws on every click and the toast's
       * "jump to that session" silently degrades to bringing the window forward.
       */
      function navigate(id) {
        var ui = uiWorkspace();
        if (ui === undefined || ui === null || typeof ui.openSession !== 'function') {
          warn('no uiWorkspace service, so a clicked notice cannot switch sessions');
          return false;
        }
        try {
          ui.openSession(id);
        } catch (error) {
          warn('could not open session ' + id, error);
          return false;
        }
        store.dropSession(id);
        report();
        return true;
      }

      /**
       * Answer the pending approval a notification button was pressed for.
       *
       * The button does not decide anything itself: the page resolves the very
       * request its own card is showing (`kind === 'approval'`), which is the
       * path every in-app 允许一次 / 拒绝 takes. That keeps one authority — the
       * user's approval card — instead of racing the host's answerer waterfall,
       * which would have answered the host while leaving this card on screen.
       *
       * Nothing here is fatal: a click that arrives after the user already
       * answered in the app simply finds no pending approval and is ignored.
       *
       * @param event - the `decide` entry (`sessionId`, `decision`, `callId`).
       * @returns true when an approval was actually answered.
       */
      function decide(event) {
        var service = uiSession();
        if (service === undefined || service === null) {
          warn('no uiSession service, so a notification decision cannot be applied');
          return false;
        }
        var outcome = event.decision === 'rejected' ? 'rejected' : 'allowed-once';
        try {
          var status = service.sessionStatus?.getSnapshot?.();
          var entry = typeof status?.get === 'function' ? status.get(event.sessionId) : undefined;
          var pending = entry?.pendingInteraction;
          if (pending === null || pending === undefined) return false;
          if (pending.kind !== 'approval') return false;
          // A stale button must not answer a *later* approval in the same
          // session: when both sides know the call id, they have to agree.
          var expected = typeof event.callId === 'string' ? event.callId : '';
          var actual = typeof pending.callId === 'string' ? pending.callId : '';
          if (expected !== '' && actual !== '' && expected !== actual) return false;
          if (typeof pending.answer !== 'function') return false;
          pending.answer(outcome);
          store.drop(event.key);
          return true;
        } catch (error) {
          warn('could not apply a notification decision', error);
          return false;
        }
      }

      /** Ask the host for news again as soon as possible. */
      function wake() {
        if (stopped) return;
        if (controller !== null && typeof controller.abort === 'function') {
          try {
            controller.abort();
          } catch {
            // An aborted request is the point.
          }
        }
      }

      /** One long-poll round; re-arms itself until stopped. */
      function poll() {
        if (stopped || doFetch === undefined) return;
        var startedAt = Date.now();
        controller = typeof AbortController === 'function' ? new AbortController() : null;
        var url = ROUTE + '/events?cursor=' + cursor + '&client=' + encodeURIComponent(clientId) + '&wait=' + POLL_WAIT_SECONDS;
        var request;
        try {
          request = doFetch(url, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            signal: controller === null ? undefined : controller.signal,
          });
        } catch (error) {
          schedule(RETRY_MS);
          return;
        }
        Promise.resolve(request)
          .then(function (response) {
            if (!response || response.ok !== true) throw new Error('HTTP ' + (response ? response.status : '?'));
            return response.json();
          })
          .then(function (data) {
            if (stopped) return;
            var events = data && Array.isArray(data.events) ? data.events.length : 0;
            apply(data);
            store.prune();
            // An immediate empty answer (a host that ignores `wait`) must not
            // become a busy loop, so it goes through the backoff path. A
            // response that actually carried news re-arms the poll directly:
            // a minimized page has its timers throttled, and the next request
            // must not wait on one.
            if (events === 0 && Date.now() - startedAt < 1000) schedule(RETRY_MS);
            else poll();
          })
          .catch(function () {
            schedule(RETRY_MS);
          });
      }

      /** Arm the next round: immediately when caught up, later after a fault. */
      function schedule(delay) {
        if (stopped) return;
        if (timer !== null) clearTimer(timer);
        timer = setTimer(poll, delay > 0 ? delay : 0);
      }

      /**
       * Follow focus, visibility and selection.
       *
       * Both halves care: the host half needs the report to route the next
       * notification, and the card store needs the same state to decide which
       * queued cards may be drawn. Nothing is thrown away here — a card for the
       * session you just switched to is held back, not deleted, so it is still
       * there when you leave that session with its prompt unanswered.
       */
      function onContextChange() {
        syncView();
        report();
      }

      var disposers = [];

      return {
        start: function () {
          if (!stopped) return;
          stopped = false;
          syncView();
          report();
          // The selection lives in a snapshot store on the sessions service.
          try {
            var unsubscribe = ctx.sessions.list.subscribe(onContextChange);
            if (typeof unsubscribe === 'function') disposers.push(unsubscribe);
          } catch (error) {
            warn('could not follow the session selection', error);
          }
          if (doc !== undefined && typeof doc.addEventListener === 'function') {
            doc.addEventListener('visibilitychange', onContextChange);
            disposers.push(function () { doc.removeEventListener('visibilitychange', onContextChange); });
          }
          if (win !== undefined && typeof win.addEventListener === 'function') {
            win.addEventListener('focus', onContextChange);
            win.addEventListener('blur', onContextChange);
            disposers.push(function () {
              win.removeEventListener('focus', onContextChange);
              win.removeEventListener('blur', onContextChange);
            });
          }
          heartbeat = setTimer(function tick() {
            if (stopped) return;
            syncView();
            report();
            store.prune();
            heartbeat = setTimer(tick, HEARTBEAT_MS);
          }, HEARTBEAT_MS);
          poll();
        },
        stop: function () {
          stopped = true;
          if (timer !== null) clearTimer(timer);
          if (heartbeat !== null) clearTimer(heartbeat);
          timer = null;
          heartbeat = null;
          wake();
          for (var i = 0; i < disposers.length; i += 1) {
            try {
              disposers[i]();
            } catch {
              // Already torn down.
            }
          }
          disposers = [];
        },
        report: report,
        wake: wake,
        navigate: navigate,
        decide: decide,
        cursor: function () { return cursor; },
        clientId: function () { return clientId; },
      };
    }

    /** Subscribe a component to the card store. */
    function useCards(store) {
      var pair = React.useState(function () { return store.getSnapshot(); });
      var snapshot = pair[0];
      var setSnapshot = pair[1];
      React.useEffect(function () {
        setSnapshot(store.getSnapshot());
        return store.subscribe(function () { setSnapshot(store.getSnapshot()); });
      }, [store]);
      return snapshot;
    }

    /**
     * One notice card: the whole card is the jump affordance.
     *
     * Hierarchy, top to bottom: a kind badge and the age, then the title, then
     * one clipped preview line, then an optional expander for the full text,
     * then the actions row. An approval card also carries 允许一次 / 拒绝, which
     * answer the *same* pending approval the conversation's own card is showing
     * — the channel's `decide` path, not a second authority.
     */
    function NoticeCard(props) {
      var card = props.card;
      var skin = kindOf(card);
      var body = card.lines.slice(1).filter(function (line) {
        return typeof line === 'string' && line.trim() !== '';
      });
      var preview = body.length > 0 ? previewLine(body[0]) : null;
      var rest = body.slice(1);
      var expandable = rest.length > 0 || (preview !== null && preview.clipped);
      var expanded = props.expanded === true;
      var hovered = props.hovered === true;

      return h(
        'div',
        {
          role: 'status',
          'data-kind': card.kind,
          title: '点击跳转到「' + card.title + '」所在的会话',
          onClick: function () { props.onOpen(card); },
          onMouseEnter: function () { props.onHover(card.key, true); },
          onMouseLeave: function () { props.onHover(card.key, false); },
          style: {
            boxSizing: 'border-box',
            maxWidth: '100%',
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: 'var(--dsw-surface, Canvas)',
            color: 'inherit',
            border: '1px solid ' + (hovered ? skin.accent : 'rgba(128,128,128,.32)'),
            borderLeft: '3px solid ' + skin.accent,
            borderRadius: 10,
            padding: '8px 11px',
            boxShadow: hovered
              ? '0 10px 28px rgba(0,0,0,.30)'
              : '0 8px 24px rgba(0,0,0,.24)',
            font: 'inherit',
            fontSize: 12.5,
            lineHeight: 1.5,
            transform: hovered ? 'translateY(-1px)' : 'none',
            transition: 'transform .16s ease, box-shadow .16s ease, border-color .16s ease',
            animation: 'dsh-approval-notifier-in .22s cubic-bezier(.2,.7,.3,1) both',
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 } },
          h(
            'span',
            {
              'aria-hidden': 'true',
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 15,
                height: 15,
                borderRadius: 4,
                background: skin.tint,
                color: skin.accent,
                fontSize: 10,
                fontWeight: 700,
                lineHeight: 1,
                flex: '0 0 auto',
              },
            },
            skin.glyph,
          ),
          h(
            'span',
            {
              style: {
                color: skin.accent,
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '.02em',
                flex: '0 0 auto',
              },
            },
            skin.label,
          ),
          h('span', { style: { fontSize: 11, opacity: 0.55, flex: '0 0 auto' } }, ageLabel(card.at, props.now)),
          h('span', { style: { flex: 1, minWidth: 0 } }),
          h(
            'button',
            {
              type: 'button',
              'aria-label': '忽略',
              title: '忽略',
              onClick: function (event) {
                event.stopPropagation();
                props.onDismiss(card.key);
              },
              style: quietButton,
            },
            '\u00D7',
          ),
        ),
        h('div', { style: { fontWeight: 600, fontSize: 13, wordBreak: 'break-word' } }, card.title),
        preview === null || preview.text === ''
          ? null
          : h(
            'div',
            {
              style: {
                opacity: 0.74,
                marginTop: 2,
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                fontSize: 11.5,
              },
            },
            preview.text,
          ),
        expanded && expandable
          ? h(
            'div',
            {
              style: {
                marginTop: 4,
                paddingLeft: 8,
                borderLeft: '2px solid ' + skin.tint,
                opacity: 0.72,
                wordBreak: 'break-word',
                maxHeight: 168,
                overflowY: 'auto',
                fontSize: 11.5,
              },
            },
            // The first line again, unwrapped: the preview above cut it at
            // PREVIEW_CHARS, and expanding is how the full text comes back. A
            // notice that carried exactly one over-long line has nothing else
            // to add, so showing only `rest` here left the toggle doing nothing.
            preview !== null && preview.clipped
              ? h('div', { key: 'full', style: { marginTop: 2 } }, body[0])
              : null,
            rest.map(function (line, index) {
              return h('div', { key: String(index), style: { marginTop: 2 } }, line);
            }),
          )
          : null,
        h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              marginTop: 7,
              flexWrap: 'wrap',
            },
          },
          expandable
            ? h(
              'button',
              {
                type: 'button',
                'aria-expanded': expanded ? 'true' : 'false',
                onClick: function (event) {
                  event.stopPropagation();
                  props.onToggleExpanded(card.key);
                },
                style: {
                  border: 0,
                  background: 'transparent',
                  color: 'inherit',
                  opacity: 0.62,
                  cursor: 'pointer',
                  font: 'inherit',
                  fontSize: 11,
                  lineHeight: 1,
                  padding: '2px 2px',
                  textDecoration: 'underline dotted',
                },
              },
              expanded ? '\u6536\u8D77' : '\u5C55\u5F00',
            )
            : null,
          h('span', { style: { flex: 1, minWidth: 0 } }),
          card.decidable === true
            ? action('\u62D2\u7EDD', {
              ariaLabel: '\u62D2\u7EDD\u8FD9\u6B21\u5BA1\u6279',
              title: '\u4E0E\u5728\u8BE5\u4F1A\u8BDD\u91CC\u70B9\u62D2\u7EDD\u7B49\u6548',
              onPress: function () { props.onDecide(card, 'rejected'); },
            })
            : null,
          card.decidable === true
            ? action('\u5141\u8BB8\u4E00\u6B21', {
              primary: true,
              ariaLabel: '\u5141\u8BB8\u4E00\u6B21\u8FD9\u6B21\u5BA1\u6279',
              title: '\u4E0E\u5728\u8BE5\u4F1A\u8BDD\u91CC\u70B9\u5141\u8BB8\u4E00\u6B21\u7B49\u6548',
              onPress: function () { props.onDecide(card, 'allowed-once'); },
            })
            : null,
          card.decidable === true
            ? null
            : h(
              'span',
              {
                style: {
                  fontSize: 11,
                  opacity: 0.62,
                  color: card.staleReason ? KINDS.approval.accent : 'inherit',
                },
              },
              card.staleReason || (skin.action + ' \u00B7 \u70B9\u51FB\u8DF3\u8F6C'),
            ),
        ),
      );
    }

    /**
     * The one stylesheet the stack injects.
     *
     * Inline styles cannot declare `@keyframes`, so the enter animation needs a
     * real rule. It is scoped by the stack's own data attribute and names only
     * our animation, so it cannot leak into the app's styling.
     *
     * @returns the CSS text.
     */
    function stackCss() {
      return '@keyframes dsh-approval-notifier-in{'
        + 'from{opacity:0;transform:translateY(-6px) scale(.985)}'
        + 'to{opacity:1;transform:none}}'
        + '@media (prefers-reduced-motion: reduce){'
        + '[data-dsh-approval-notifier="cards"] *{animation:none!important;'
        + 'transition:none!important}}';
    }

    /**
     * The notice stack rendered by `shell.overlay`.
     *
     * Only notices about *other* sessions ever reach this component: the store
     * drops the session on screen from its snapshot, so the prompt the
     * conversation is already showing is never duplicated up here — and the
     * buttons that prompt asks about are never covered by a copy of itself.
     *
     * At most {@link VISIBLE_CARDS} cards are drawn, so a burst cannot blanket
     * the window; the remainder fold behind one "另有 N 条" row.
     */
    function NoticeStack(props) {
      var cards = useCards(props.store);
      var expandedPair = React.useState({});
      var expanded = expandedPair[0];
      var setExpanded = expandedPair[1];
      var showAllPair = React.useState(false);
      var showAll = showAllPair[0];
      var setShowAll = showAllPair[1];
      var hoverPair = React.useState({});
      var hovered = hoverPair[0];
      var setHovered = hoverPair[1];
      var clock = typeof props.now === 'function' ? props.now : Date.now;

      if (cards.length === 0) return null;

      var shown = cards.slice(0, showAll ? cards.length : VISIBLE_CARDS);
      var hidden = cards.length - shown.length;

      var toggleExpanded = function (key) {
        setExpanded(function (previous) {
          var next = {};
          for (var k in previous) {
            if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k];
          }
          if (next[key]) delete next[key];
          else next[key] = true;
          return next;
        });
      };

      var setHover = function (key, on) {
        setHovered(function (previous) {
          if (previous[key] === on) return previous;
          var next = {};
          for (var k in previous) {
            if (Object.prototype.hasOwnProperty.call(previous, k)) next[k] = previous[k];
          }
          if (on) next[key] = true;
          else delete next[key];
          return next;
        });
      };

      var cardNodes = shown.map(function (card) {
        return h(NoticeCard, {
          key: card.key,
          card: card,
          now: clock(),
          hovered: hovered[card.key] === true,
          expanded: expanded[card.key] === true,
          onOpen: props.onOpen,
          onDismiss: props.onDismiss,
          onDecide: props.onDecide,
          onToggleExpanded: toggleExpanded,
          onHover: setHover,
        });
      });

      var foldRow = hidden > 0
        ? h(
          'button',
          {
            type: 'button',
            'data-dsh-approval-notifier': 'fold',
            onClick: function () { setShowAll(true); },
            style: {
              pointerEvents: 'auto',
              cursor: 'pointer',
              border: '1px dashed rgba(128,128,128,.42)',
              background: 'var(--dsw-surface, Canvas)',
              color: 'inherit',
              opacity: 0.82,
              borderRadius: 8,
              padding: '4px 12px',
              font: 'inherit',
              fontSize: 11.5,
              lineHeight: 1.5,
              boxShadow: '0 4px 14px rgba(0,0,0,.16)',
            },
          },
          '\u53E6\u6709 ' + hidden + ' \u6761\u63D0\u9192',
        )
        : null;

      var collapseRow = showAll && cards.length > VISIBLE_CARDS
        ? h(
          'button',
          {
            type: 'button',
            'data-dsh-approval-notifier': 'collapse',
            onClick: function () { setShowAll(false); },
            style: {
              pointerEvents: 'auto',
              cursor: 'pointer',
              border: 0,
              background: 'transparent',
              color: 'inherit',
              opacity: 0.6,
              padding: '2px 8px',
              font: 'inherit',
              fontSize: 11,
              lineHeight: 1.5,
            },
          },
          '\u6536\u8D77',
        )
        : null;

      return h(
        'div',
        {
          'data-dsh-approval-notifier': 'cards',
          style: STACK_STYLE,
        },
        h('style', null, stackCss()),
        cardNodes,
        foldRow,
        collapseRow,
      );
    }

    /**
     * Register the card stack and start the channel.
     *
     * @param ctx - the client context (`inject: ['slots', 'sessions']`).
     */
    function apply(ctx) {
      var store = createNoticeStore({});
      var channel = createChannel({ ctx: ctx, store: store });
      var open = function (card) {
        if (card === null || card === undefined) return;
        // A notice without a session id (an old host half) can only be dropped.
        if (typeof card.sessionId !== 'string' || card.sessionId === '') store.drop(card.key);
        else channel.navigate(card.sessionId);
      };
      var dismiss = function (key) {
        store.drop(key);
      };
      /**
       * Answer the approval an in-card button belongs to.
       *
       * This deliberately reuses the same `channel.decide` entry a notification
       * button produces: the page resolves the pending interaction its own
       * conversation card is showing, so there is still exactly one authority
       * over the approval. If that approval has already been answered, or has
       * been replaced by a later one in the same session, `decide` returns false
       * and the card stays put rather than pretending it succeeded — but it says
       * so, because a button that swallows a click reads as a broken button.
       *
       * @param card - the notice card.
       * @param decision - `allowed-once` or `rejected`.
       */
      var decideFromCard = function (card, decision) {
        if (card === null || card === undefined) return;
        var answered = channel.decide({
          key: card.key,
          sessionId: card.sessionId,
          callId: card.callId,
          decision: decision,
        });
        if (answered) {
          store.drop(card.key);
          return;
        }
        store.markStale(card.key, '\u8FD9\u6761\u5BA1\u6279\u5DF2\u4E0D\u5728\u5F85\u5904\u7406\u72B6\u6001');
      };

      ctx.effect(function () {
        channel.start();
        return function () {
          channel.stop();
        };
      }, 'dsh-approval-notifier: event stream');

      var slots = ctx.slots || ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
        warn('the slots service is unavailable, so cards have no surface');
        return;
      }
      try {
        ctx.effect(function () {
          return slots.inject('shell.overlay', function () {
            return slots.register(
              {
                name: 'shell.overlay',
                id: 'dsh-approval-notifier',
                order: 80,
                label: function () { return '审批提醒'; },
              },
              function () {
                return h(NoticeStack, {
                  store: store,
                  onOpen: open,
                  onDismiss: dismiss,
                  onDecide: decideFromCard,
                });
              },
            );
          });
        });
      } catch (error) {
        // A shell without that slot costs the cards, never the renderer.
        warn('could not register the card stack', error);
      }
    }

    // Without declared service dependencies the fiber activates before `slots`
    // and `sessions` exist, and every lookup silently misses.
    exports.inject = ['slots', 'sessions'];
    exports.apply = apply;
    exports.name = 'dsh-approval-notifier';
    exports.NoticeStack = NoticeStack;
    exports.NoticeCard = NoticeCard;
    exports.__internals = {
      ROUTE,
      MAX_CARDS,
      STACK_STYLE,
      createNoticeStore,
      createChannel,
      reduceEvent,
    };
    return module.exports;
  },
});
