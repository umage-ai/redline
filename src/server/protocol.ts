// The remote store protocol (docs/PROTOCOL.md, D40) served over any NoteStore: the reference
// implementation the protocol tests run against, and a way to share one store between
// several dev servers (point each at it with `remoteStore`).
//
//   import { notesProtocol, createStore } from '@umage.ai/redline/server'
//   const serve = notesProtocol(createStore({ root }), { base: '/redline', authorize: req => userFor(req) })
//   http.createServer((req, res) => serve(req, res, () => { res.statusCode = 404; res.end(); })).listen(8080)
//
// It does what every implementation must: authenticate the caller, set `author` from the
// caller (never from the request), and say which notes are the caller's (`mine`). Which notes are
// visible (resolved ones fading out, D42) is the store's policy, not the protocol's.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { STORE_OWNED, type NewNoteRequest } from '../shared/types.ts';
import { cleanPatch, type NoteStore } from './store.ts';
import type { Middleware } from './handler.ts';

export interface ProtocolOptions {
  /** Path the protocol is served under, e.g. '/redline'. Default: the root. */
  base?: string;
  /**
   * Who is calling: a user name for a valid caller, or null to answer 401. Default: everyone,
   * anonymously (notes then have no author). Read the bearer token from `req.headers.authorization`.
   */
  authorize?(req: IncomingMessage): string | null | Promise<string | null>;
  /** What a refused caller (401) is told; it reaches the reviewer as written. */
  unauthorized?: string;
  /** Largest request body, in bytes (screenshots travel inside it). Default 30 MiB. */
  maxBody?: number;
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage, max: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

export function notesProtocol(store: NoteStore, opts: ProtocolOptions = {}): Middleware {
  const base = (opts.base ?? '').replace(/\/+$/, '');
  const max = opts.maxBody ?? 30 * 1024 * 1024;

  return (req, res, next) => {
    const url = req.url ?? '';
    if (base && url !== base && !url.startsWith(base + '/')) return next();
    const p = url.slice(base.length).split('?')[0] || '/';
    const method = req.method ?? 'GET';

    (async () => {
      const user = opts.authorize ? await opts.authorize(req) : undefined;
      if (user === null) {
        res.setHeader('www-authenticate', 'Bearer realm="redline"');
        return send(res, 401, { error: opts.unauthorized ?? 'a valid bearer token is required' });
      }

      if (method === 'GET' && p === '/version') return send(res, 200, { version: await store.version({ req }) });
      if (method === 'GET' && p === '/notes') {
        const notes = (await store.list({ req })).map(n => ({ ...n, file: undefined, mine: user !== undefined && n.author === user }));
        return send(res, 200, { version: await store.version({ req }), notes });
      }
      if (method === 'POST' && p === '/notes') {
        const body = await readJson(req, max) as NewNoteRequest | null;
        if (!body?.note?.page || !body.note.type) return send(res, 400, { error: 'note.page and note.type are required' });
        for (const k of STORE_OWNED) delete (body.note as Record<string, unknown>)[k];
        if (user) body.note.author = user;
        return send(res, 200, { ...(await store.create(body, { req })), file: undefined, mine: !!user });
      }
      const m = /^\/notes\/([a-z0-9]{4,24})$/.exec(p);
      if (m && method === 'PATCH') {
        const patch = cleanPatch(await readJson(req, max));
        // `seen` means the author has seen it resolved (D42): from anyone else it is dropped.
        if (patch.seen !== undefined && (await store.list({ req })).find(x => x.id === m[1])?.author !== user) delete patch.seen;
        const n = await store.update(m[1], patch, { req });
        return n ? send(res, 200, { ...n, mine: user !== undefined && n.author === user }) : send(res, 404, { error: 'not found' });
      }
      if (m && method === 'DELETE') return (await store.remove(m[1], { req })) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'not found' });
      if (method === 'GET' && p.startsWith('/assets/')) {
        const a = await store.asset(p.slice(8), { req });
        if (!a) return send(res, 404, { error: 'not found' });
        res.setHeader('content-type', a.type);
        res.setHeader('cache-control', 'no-store');
        res.end(a.data);
        return;
      }
      if (method === 'GET' && p === '/events') {
        if (!store.subscribe) return send(res, 404, { error: 'no change feed' });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write('retry: 5000\n\n');
        const stop = store.subscribe(() => res.write('event: change\ndata: {}\n\n'));
        const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        req.on('close', () => { clearInterval(beat); stop(); });
        return;
      }
      send(res, 404, { error: 'unknown endpoint' });
    })().catch(err => {
      if (res.headersSent) return;
      // A store refuses with its own status and words (`err.status` 4xx), e.g. 403 for a site it takes no notes from.
      const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
      send(res, status, { error: String(err?.message ?? err) });
    });
  };
}
