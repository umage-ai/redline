// Long-lived streams to the dev server, held only while they are needed (D72). Over HTTP/1.1 a browser
// keeps at most 6 connections per server, shared by every tab, and each open EventSource holds one for
// good: a few dev tabs, and the app's own requests queue behind them (the dev server seems to hang).
// So a stream opens while it is wanted and the tab is visible, closes once the tab has been hidden a
// while (or it is no longer wanted), and reopens when the tab comes back, with a catch-up. A stall check
// probes the server once a stream is opening: when a plain request can't get through either, the
// connections are used up; the stream lets go of its own and the caller explains (a toast).
// Used by the overlay (live pages + change feed), and by the agent toolbar and its CLI window.

export interface GatedFeed {
  /** Checks again whether the stream should be open (call when `want` may have changed). */
  update(): void;
  /** Closes the stream for good. */
  stop(): void;
  /** The stream is open now (connecting or connected). */
  readonly opened: boolean;
}

export interface GatedFeedOptions {
  /** Opens the stream; call `up(true)` once it is connected, `up(false)` when it drops. Returns its close. */
  open(up: (on: boolean) => void): () => void;
  /** Wanted besides the tab being visible (e.g. while the overlay is open). Default: always. */
  want?: () => boolean;
  /** How long a hidden (or no longer wanted) tab keeps the stream. Default 15 s. */
  graceMs?: number;
  /** Called when the stream opens again after being closed by the gate: catch up on what was missed. */
  resumed?: () => void;
  /**
   * The stall check: `probe` is a small request to the same server. When the stream isn't connected
   * `ms` after opening (default 5 s) and the probe also gets no answer within `ms`, or the probe stalls
   * right after the stream connected (it took the last free connection), `stalled` is called once and
   * the stream is closed until the tab is shown again (or a minute passes).
   */
  stall?: { probe: () => Promise<unknown>; ms?: number; stalled: () => void };
}

const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function gatedFeed(o: GatedFeedOptions): GatedFeed {
  const grace = o.graceMs ?? 15_000;
  const stallMs = o.stall?.ms ?? 5000;
  let close: (() => void) | null = null;
  let leaving: ReturnType<typeof setTimeout> | undefined;
  let checking: ReturnType<typeof setTimeout> | undefined;
  let everOpened = false, stopped = false, blockedUntil = 0, warned = false, gen = 0;

  const disconnect = () => {
    clearTimeout(leaving); leaving = undefined;
    clearTimeout(checking); checking = undefined;
    gen++;
    const c = close; close = null;
    try { c?.(); } catch { /* already gone */ }
  };

  // Is a plain request stuck too? Then the browser has no connection left for this server.
  const check = (mine: number) => {
    const s = o.stall;
    if (!s || mine !== gen) return;
    let answered = false;
    void Promise.resolve().then(s.probe).then(() => { answered = true; }, () => { answered = true; });
    checking = setTimeout(() => {
      if (answered || mine !== gen || stopped) return;
      blockedUntil = Date.now() + 60_000;
      disconnect();
      if (!warned) { warned = true; try { s.stalled(); } catch { /* the caller's */ } }
    }, stallMs);
  };

  const connect = () => {
    const mine = ++gen;
    let connected = false;
    close = o.open(on => {
      if (mine !== gen) return;
      // Connected: still probe once, since this stream may have taken the last free connection.
      if (on && !connected) { connected = true; clearTimeout(checking); check(mine); }
      if (!on) connected = false;
    });
    if (everOpened) { try { o.resumed?.(); } catch { /* the caller's */ } }
    everOpened = true;
    if (o.stall) checking = setTimeout(() => { if (!connected) check(mine); }, stallMs);
  };

  const update = () => {
    if (stopped) return;
    const wanted = visible() && (o.want?.() ?? true) && Date.now() >= blockedUntil;
    if (wanted) {
      clearTimeout(leaving); leaving = undefined;
      if (!close) connect();
    } else if (close && !leaving) {
      leaving = setTimeout(disconnect, grace);
    }
  };

  const onVisibility = () => { if (visible()) blockedUntil = 0; update(); };
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  update();
  return {
    update,
    stop() {
      stopped = true;
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
      disconnect();
    },
    get opened() { return !!close; },
  };
}
