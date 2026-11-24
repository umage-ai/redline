// How the overlay talks to its note store. The default is the dev server's `/__redline` API
// (handler.ts); an embedding product passes its own object (D49). To change one call, wrap
// the default: `{ ...httpTransport(), create: r => base.create(withTicket(r)) }`.

import type { Note, NewNoteRequest, NotesResponse, Target } from '../shared/types.ts';
import { API_BASE } from '../shared/types.ts';
import type { Token } from '../server/edit.ts';
import type { OverlayConfig } from './options.ts';

export type StoredNote = Note & { file?: string };

export interface Inspection { tokens: Token[]; braces: boolean; selfClose: boolean; spell?: Record<string, string> }
export type EditResult = { ok: true; file: string; line?: number; inspect?: Inspection } | { ok: false; reason: string };
/** What text mode sends to a source writer (D20). */
export interface EditRequest {
  from?: string; to?: string; html?: string; tag: string; url: string;
  source?: unknown; nth?: { index: number; count: number }; cms?: unknown;
}

export interface RedlineTransport {
  /** The overlay's settings (hotkey, labels, prompt…). Anything left out keeps its default. */
  config(): Promise<Partial<OverlayConfig>>;
  /** All notes; `null` when nothing changed since `version` (an ETag). Throw when unreachable. */
  load(version?: string): Promise<NotesResponse | null>;
  create(req: NewNoteRequest): Promise<StoredNote>;
  update(id: string, patch: Partial<Note>): Promise<unknown>;
  remove(id: string): Promise<unknown>;
  /** The URL an image line in a note (`assets/<id>.png`) is shown from. */
  assetUrl(rel: string): string;
  /** When an image can't load from `assetUrl` as is (header auth, D60): a URL it can, e.g. a blob URL. */
  assetSrc?(rel: string): Promise<string>;
  /** Direct source edits (D20). Leave it out and text mode only saves notes. */
  edit?(req: EditRequest, mode: 'inspect' | 'dry' | 'apply'): Promise<EditResult>;
  /** Adds a message to the note's thread (D50). Leave it out and cards show no reply box. */
  message?(id: string, body: string): Promise<unknown>;
  /**
   * A change feed (D41): call `changed` when notes changed elsewhere, `live` with whether the feed
   * is up (polling slows to a backstop while it is). Only used when the config says `events`.
   * Returns the unsubscribe.
   */
  subscribe?(changed: () => void, live: (up: boolean) => void): () => void;
  /**
   * Live pages (D65) and the change feed in one stream per tab (D72): `ask` when an MCP tool wants this
   * page's console errors or the DOM around a note (answer with `reply`), `change` when notes changed
   * (only from a store with a change feed), `up` as it connects and drops. Used when the config says `live`;
   * `httpTransport` has it for a same-origin API without extra headers.
   */
  live?(q: LiveQuery, on: LiveHandlers): LiveConnection;
}

/** Where a live page is: its page key, path and title. */
export interface LiveQuery { page: string; path: string; title: string }
export interface LiveAsk { req: string; kind: string; target?: Target }
export interface LiveHandlers { up(on: boolean): void; ask(a: LiveAsk): void; change(): void }
export interface LiveConnection {
  close(): void;
  reply(req: string, data: unknown): void;
  /** The page moved on (client-side routing). */
  moved(q: LiveQuery): void;
}

/** How `httpTransport` authenticates on another origin (D60). Same-origin setups need neither. */
export interface HttpTransportOptions {
  /** `'include'`: cookies go with every call and the change feed (subdomains, or `SameSite=None; Secure`). */
  credentials?: RequestCredentials;
  /**
   * Sent with every call, e.g. `{ authorization: 'Bearer …' }`, or a function asked before each one (a fresh
   * token). Images then load through `assetSrc` (blob URLs) and the change feed is read with fetch.
   */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
}

const sameOrigin = (base: string) => { try { return new URL(base, location.href).origin === location.origin; } catch { return false; } };

/** The dev server's API (or any server speaking it, docs/PROTOCOL.md) at `base`. */
export function httpTransport(base = API_BASE, opts: HttpTransportOptions = {}): RedlineTransport {
  const credentials = opts.credentials;
  const extra = async (): Promise<Record<string, string>> => {
    const h = typeof opts.headers === 'function' ? await opts.headers() : opts.headers;
    return h && typeof h === 'object' ? h : {};
  };
  // Nothing set: the same calls as always (no credentials key, no extra headers).
  const send = async (url: string, init: RequestInit = {}) => fetch(url, {
    ...init, ...(credentials ? { credentials } : {}),
    ...(opts.headers ? { headers: { ...(init.headers as Record<string, string> | undefined), ...await extra() } } : {}),
  });
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await send(base + path, { method, headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  }
  const assetUrl = (rel: string) => `${base}/assets/${rel.split('/').pop()}`;
  const blobs = new Map<string, Promise<string>>();
  return {
    config: async () => (await send(`${base}/config`)).json(),
    async load(version) {
      const r = await send(`${base}/notes`, { headers: version ? { 'if-none-match': `"${version}"` } : {}, cache: 'no-store' });
      if (r.status === 304) return null;
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
      return r.json();
    },
    create: req => api('POST', '/notes', req),
    update: (id, patch) => api('PATCH', `/notes/${id}`, patch),
    remove: id => api('DELETE', `/notes/${id}`),
    // A thread reply (D52): a patch that appends to the note's messages.
    message: (id, body) => api('PATCH', `/notes/${id}`, { message: { body } }),
    assetUrl,
    // An <img> can't send a header: with `headers`, images are fetched with them into blob URLs (one per asset).
    ...(opts.headers ? {
      assetSrc(rel: string) {
        const url = assetUrl(rel);
        if (!blobs.has(url)) blobs.set(url, send(url).then(async r => {
          if (!r.ok) throw new Error(r.statusText);
          return URL.createObjectURL(await r.blob());
        }).catch(e => { blobs.delete(url); throw e; }));
        return blobs.get(url)!;
      },
    } : {}),
    edit: (req, mode) => api('POST', mode === 'apply' ? '/edit' : mode === 'dry' ? '/edit?dry=1' : '/edit?inspect=1', req),
    ...(sameOrigin(base) && !opts.headers ? {
      live(q: LiveQuery, on: LiveHandlers): LiveConnection {
        let id = '';
        const es = new EventSource(`${base}/live?${new URLSearchParams({ ...q })}`);
        es.addEventListener('open', () => on.up(true));
        es.addEventListener('hello', e => { id = JSON.parse((e as MessageEvent).data).id; });
        es.addEventListener('ask', e => on.ask(JSON.parse((e as MessageEvent).data)));
        es.addEventListener('change', () => on.change());
        // A server without live pages answers 404: EventSource stops by itself (no retry on a failed open).
        es.addEventListener('error', () => on.up(false));
        const post = (p: string, body: object) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: JSON.stringify(body) }).catch(() => {});
        return {
          close: () => es.close(),
          reply: (req, data) => void post('/live/reply', { conn: id, req, data }),
          moved: q2 => { if (id) void post('/live/moved', { conn: id, ...q2 }); },
        };
      },
    } : {}),
    subscribe(changed, live) {
      if (opts.headers) return readFeed(`${base}/events`, send, changed, live);
      if (typeof EventSource !== 'function') return () => {};
      const es = new EventSource(`${base}/events`, credentials === 'include' ? { withCredentials: true } : undefined);
      es.addEventListener('open', () => live(true));
      es.addEventListener('change', () => changed());
      es.addEventListener('error', () => live(false));
      return () => es.close();
    },
  };
}

/**
 * The change feed read with fetch, for header auth (EventSource can't send headers): `event: change`
 * calls `changed`; a dropped stream reconnects after 5 s. Returns the stop.
 */
function readFeed(url: string, send: (url: string, init?: RequestInit) => Promise<Response>, changed: () => void, live: (up: boolean) => void): () => void {
  let stopped = false, ctrl: AbortController | null = null, timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    ctrl = new AbortController();
    try {
      const r = await send(url, { headers: { accept: 'text/event-stream' }, cache: 'no-store', signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error(r.statusText);
      live(true);
      const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value.replace(/\r\n?/g, '\n');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (/^event:\s*change\s*$/m.test(block)) changed();
        }
      }
    } catch { /* closed, refused or offline: retried below */ }
    if (stopped) return;
    live(false);
    timer = setTimeout(run, 5000);
  };
  void run();
  return () => { stopped = true; clearTimeout(timer); ctrl?.abort(); };
}
