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

    /** One notice card: the whole card is the jump affordance. */
    function NoticeCard(props) {
      var card = props.card;
      var accent = card.kind === 'question' ? '#1971c2' : '#e8590c';
      return h(
        'div',
        {
          role: 'status',
          title: '点击跳转到「' + card.title + '」所在的会话',
          onClick: function () { props.onOpen(card); },
          style: {
            boxSizing: 'border-box',
            maxWidth: '100%',
            pointerEvents: 'auto',
            cursor: 'pointer',
            background: 'var(--dsw-surface, Canvas)',
            color: 'inherit',
            border: '1px solid rgba(128,128,128,.32)',
            borderLeft: '3px solid ' + accent,
            borderRadius: 10,
            padding: '7px 10px',
            boxShadow: '0 8px 24px rgba(0,0,0,.24)',
            font: 'inherit',
            fontSize: 12.5,
            lineHeight: 1.5,
          },
        },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-start', gap: 8 } },
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { style: { fontWeight: 600, fontSize: 13, wordBreak: 'break-word' } }, card.title),
            card.lines.slice(1, 3).map(function (line, index) {
              return h(
                'div',
                { key: String(index), style: { opacity: 0.72, wordBreak: 'break-word', marginTop: 2 } },
                line,
              );
            }),
          ),
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
            '×',
          ),
        ),
        h(
          'div',
          { style: { marginTop: 5, fontSize: 11, opacity: 0.62 } },
          (card.kind === 'question' ? '需要你的回答' : '需要你确认') + ' · 点击跳转到该会话',
        ),
      );
    }

    /**
     * The notice stack rendered by `shell.overlay`.
     *
     * Only notices about *other* sessions ever reach this component: the store
     * drops the session on screen from its snapshot, so the prompt the
     * conversation is already showing is never duplicated up here — and the
     * buttons that prompt asks about are never covered by a copy of itself.
     */
    function NoticeStack(props) {
      var cards = useCards(props.store);
      if (cards.length === 0) return null;
      return h(
        'div',
        {
          'data-dsh-approval-notifier': 'cards',
          style: STACK_STYLE,
        },
        cards.map(function (card) {
          return h(NoticeCard, {
            key: card.key,
            card: card,
            onOpen: props.onOpen,
            onDismiss: props.onDismiss,
          });
        }),
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
                return h(NoticeStack, { store: store, onOpen: open, onDismiss: dismiss });
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
