// A NoteStore that acts as the signed-in reviewer (setup 3/4, docs/SETUPS.md, D45). Every call
// goes to your own notes API with the reviewer's session cookie, taken from the request Redline
// hands the store (`ctx.req`). Your API therefore authorizes each read and write as that person
// and sets what only a store may set (author, mine, resolvedAt, seen, href); a routing mistake
// can at worst show the overlay, never read or write a note.
//
// If your notes API speaks the remote store protocol (docs/PROTOCOL.md), you don't need this
// file: `remoteStore({ url, headers: ctx => ({ cookie: ctx?.req.headers.cookie }) })` does it.
// Write your own when your API is shaped differently (gRPC, GraphQL, a CMS SDK), as here.

import type { NewNoteRequest, Note, NotePatch, NoteStore, StoreContext } from '@umage.ai/redline/server';

export interface ReviewStoreOptions {
  /** Your notes API, as the review server reaches it (an internal URL). */
  api: string;
  /** Where a note opens in your own UI, for the overlay's link (http/https only). */
  noteUrl?: (id: string) => string;
  fetch?: typeof fetch;
}

/** Thrown errors reach the reviewer as written, so give them your API's own sentence. */
class StoreError extends Error {
  status: number;
  constructor(message: string, status: number) { super(message); this.status = status; }
}

export function reviewStore(o: ReviewStoreOptions): NoteStore {
  const f = o.fetch ?? fetch;
  const base = o.api.replace(/\/+$/, '');

  async function call<T>(ctx: StoreContext | undefined, method: string, path: string, body?: unknown): Promise<T> {
    // No request, no reviewer: never fall back to acting as the server.
    if (!ctx) throw new StoreError('Redline: no request to act for.', 500);
    const r = await f(base + path, {
      method,
      headers: { cookie: ctx.req.headers.cookie ?? '', accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 401) throw new StoreError('Your session has ended. Sign in again.', 401);
    if (!r.ok) {
      const msg = await r.json().then((j: { error?: unknown }) => (typeof j?.error === 'string' ? j.error : ''), () => '');
      throw new StoreError(msg || 'The notes service refused the request.', r.status);
    }
    return r.json() as Promise<T>;
  }
  const orNull = async <T, M>(p: Promise<T>, missing: M): Promise<T | M> => {
    try { return await p; } catch (e) { if (e instanceof StoreError && e.status === 404) return missing; throw e; }
  };
  const withLink = (n: Note): Note => (o.noteUrl ? { ...n, href: o.noteUrl(n.id) } : n);

  return {
    dir: 'Review notes',
    // The overlay polls this every few seconds: keep it one indexed read on your side.
    version: async ctx => (await call<{ version: string }>(ctx, 'GET', '/version')).version,
    // Your API decides what a reviewer sees: their project or tenant, open notes, and resolved ones
    // for a while (docs/PROTOCOL.md "Which notes to list").
    list: async ctx => (await call<{ notes: Note[] }>(ctx, 'GET', '/notes')).notes.map(withLink),
    create: async (req: NewNoteRequest, ctx) => withLink(await call<Note>(ctx, 'POST', '/notes', req)),
    update: (id: string, patch: NotePatch, ctx) => orNull(call<Note>(ctx, 'PATCH', `/notes/${encodeURIComponent(id)}`, patch).then(withLink), null),
    remove: (id: string, ctx) => orNull(call(ctx, 'DELETE', `/notes/${encodeURIComponent(id)}`).then(() => true), false),
    async asset(name: string, ctx) {
      if (!ctx || !/^[a-z0-9]{4,24}\.(png|svg)$/.test(name)) return null;
      const r = await f(`${base}/assets/${name}`, { headers: { cookie: ctx.req.headers.cookie ?? '' }, signal: AbortSignal.timeout(10_000) });
      return r.ok ? { type: r.headers.get('content-type') ?? 'image/png', data: Buffer.from(await r.arrayBuffer()) } : null;
    },
  };
}
