// A note store on another server, over the HTTP protocol in docs/PROTOCOL.md (D40). The dev
// server (or the app's own server) holds the token and makes the calls; the browser keeps
// talking to /__redline on its own origin, so the token never reaches the page.
//
//   redline({ store: remoteStore({ url: 'https://notes.example.com/redline', token: process.env.REDLINE_STORE_TOKEN }) })

import type { NewNoteRequest, Note } from '../shared/types.ts';
import type { NotePatch, NoteStore, StoreContext } from './store.ts';

export interface RemoteStoreOptions {
  /** The store's base URL; the protocol's paths (`/version`, `/notes`, …) are appended to it. */
  url: string;
  /** Sent as `Authorization: Bearer <token>`. The server decides whose notes these are. */
  token?: string;
  /**
   * Headers for one call, from the request that caused it (D45): on a site many reviewers use,
   * forward each one's own credentials, e.g. `ctx => ({ cookie: ctx?.req.headers.cookie })` or
   * `{ authorization: 'Bearer ' + tokenOf(ctx.req) }`, so the store knows who is asking. They
   * override `token`. The change feed has no request and uses `token` alone.
   */
  headers?: (ctx?: StoreContext) => Record<string, string | undefined> | undefined;
  /** Shown to the reviewer as where notes go. Default: the URL's host. */
  label?: string;
  /** Per-request timeout in ms. Default 10 000. The change feed has none. */
  timeoutMs?: number;
  /** Replaces the global fetch (tests, proxies). */
  fetch?: typeof fetch;
}

/** The store, and the base URL it talks to. */
export type RemoteStore = NoteStore & { url: string };

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function remoteStore(o: RemoteStoreOptions): RemoteStore {
  if (!/^https?:\/\//.test(o.url)) throw new Error(`redline remoteStore: url must be http(s), got "${o.url}"`);
  const base = o.url.replace(/\/+$/, '');
  const f = o.fetch ?? fetch;
  const timeout = o.timeoutMs ?? 10_000;
  const auth: Record<string, string> = o.token ? { authorization: `Bearer ${o.token}` } : {};

  // Per-call headers, dropping empty ones (a request without a cookie forwards none).
  const forCall = (ctx?: StoreContext): Record<string, string> => {
    const extra = Object.entries(o.headers?.(ctx) ?? {}).filter((e): e is [string, string] => !!e[1]);
    return { ...auth, ...Object.fromEntries(extra) };
  };

  async function call(method: string, path: string, body?: unknown, ctx?: StoreContext): Promise<Response> {
    const r = await f(base + path, {
      method,
      headers: { ...forCall(ctx), accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    return r;
  }
  // The store's own words reach the reviewer (a switched-off feature, a missing permission).
  async function fail(r: Response): Promise<never> {
    const msg = await r.json().then((j: { error?: unknown }) => typeof j?.error === 'string' ? j.error : '', () => '');
    throw new Error(msg || `note store answered ${r.status} ${r.statusText}`.trim());
  }
  async function json<T>(method: string, path: string, body?: unknown, ctx?: StoreContext): Promise<T> {
    const r = await call(method, path, body, ctx);
    if (!r.ok) return fail(r);
    return r.json() as Promise<T>;
  }

  return {
    url: base,
    dir: o.label ?? new URL(base).host,

    async version(ctx) {
      return (await json<{ version: string }>('GET', '/version', undefined, ctx)).version;
    },

    async list(ctx) {
      return (await json<{ notes: Note[] }>('GET', '/notes', undefined, ctx)).notes ?? [];
    },

    create(req: NewNoteRequest, ctx) {
      return json<Note>('POST', '/notes', req, ctx);
    },

    async update(id: string, patch: NotePatch, ctx) {
      const r = await call('PATCH', `/notes/${encodeURIComponent(id)}`, patch, ctx);
      if (r.status === 404) return null;
      if (!r.ok) return fail(r);
      return r.json() as Promise<Note>;
    },

    async remove(id: string, ctx) {
      const r = await call('DELETE', `/notes/${encodeURIComponent(id)}`, undefined, ctx);
      if (r.status === 404) return false;
      if (!r.ok) return fail(r);
      return true;
    },

    async asset(name: string, ctx) {
      if (!/^[a-z0-9]+\.(png|svg)$/.test(name)) return null;
      const r = await f(`${base}/assets/${name}`, { headers: forCall(ctx), signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) return null;
      if (!r.ok) return fail(r);
      return { type: r.headers.get('content-type') ?? (name.endsWith('.svg') ? 'image/svg+xml' : 'image/png'), data: Buffer.from(await r.arrayBuffer()) };
    },

    // The change feed (D41): GET /events as server-sent events, reconnected with backoff. A 404
    // means the store has none; the overlay keeps polling and nothing else changes.
    subscribe(onChange: () => void) {
      let stopped = false;
      let ctrl: AbortController | undefined;
      void (async () => {
        let delay = 1000;
        while (!stopped) {
          ctrl = new AbortController();
          try {
            const r = await f(`${base}/events`, { headers: { ...auth, accept: 'text/event-stream' }, signal: ctrl.signal });
            if (r.status === 404) return;
            if (!r.ok || !r.body) throw new Error(`events: ${r.status}`);
            delay = 1000;
            onChange();   // (re)connected: whatever happened while we were away
            const reader = r.body.getReader();
            const dec = new TextDecoder();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += dec.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
              let i: number;
              while ((i = buf.indexOf('\n\n')) >= 0) {
                const event = buf.slice(0, i);
                buf = buf.slice(i + 2);
                // Comments (": keep-alive") and the retry hint carry no change.
                if (/^(event: *change|data:)/m.test(event)) onChange();
              }
            }
          } catch { /* dropped or refused: retry below */ }
          if (stopped) return;
          await sleep(delay);
          delay = Math.min(delay * 2, 30_000);
        }
      })();
      return () => { stopped = true; ctrl?.abort(); };
    },
  };
}
