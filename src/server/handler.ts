// Connect-style middleware: the /__redline HTTP API, the client bundle, and the
// <script> injection into HTML pages. Works in any Node dev server that accepts
// (req, res, next) middleware: Vite, Astro, SvelteKit, Express.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NewNoteRequest, Target } from '../shared/types.ts';
import { API_BASE } from '../shared/types.ts';
import { createStore, type Store } from './store.ts';
import { pageFile } from './format.ts';
import { appOf, findRoot, real } from './root.ts';
import { GUIDE_PATHS } from '../init.ts';

export type Next = (err?: unknown) => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

export interface RedlineOptions {
  /** Project root for notes and repo-relative source paths. Default: nearest folder with .git, else the dev server root. */
  root?: string;
  /** Notes folder relative to root. Default: .redline */
  dir?: string;
  /** Keyboard shortcut to toggle the overlay, e.g. "alt+shift+r" (default). */
  hotkey?: string;
  /** Show the small launcher button when the overlay is closed. Default true. */
  launcher?: boolean;
  /** Monorepos: the app's name in notes. Default: the dev server's folder relative to root ("apps/web"); "" at the root. */
  app?: string;
}

const MARK = 'data-redline-client';

// Runs while the page parses, before any module script: Astro's dev toolbar strips
// data-astro-source-* from the DOM, so keep a copy for the overlay.
const SNAPSHOT = '<script>(function(){var m=window.__redlineSrc=window.__redlineSrc||new WeakMap();' +
  'document.querySelectorAll("[data-astro-source-file]").forEach(function(e){' +
  'm.set(e,[e.getAttribute("data-astro-source-file"),e.getAttribute("data-astro-source-loc")||""])})})()</script>';
const MAX_BODY = 30 * 1024 * 1024;

export { findRoot };

function json(res: ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(s);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Turn whatever path a framework reported into a repo-relative, forward-slash path. */
export function normaliseSource(file: string, root: string, serverRoot: string): string {
  let f = file.replace(/^file:\/\//, '').replace(/[?#].*$/, '');
  if (/^\/[A-Za-z]:\//.test(f)) f = f.slice(1);               // /C:/x → C:/x
  if (/^\/@fs\//.test(f)) f = f.slice(4);                      // vite /@fs/abs/path
  let abs: string;
  if (path.isAbsolute(f) && existsSync(f)) abs = f;
  else if (existsSync(path.join(serverRoot, f))) abs = path.join(serverRoot, f);
  else if (existsSync(path.join(root, f))) abs = path.join(root, f);
  else return f.replace(/\\/g, '/');
  // Compare canonical paths: the framework and the dev server can spell the same folder differently
  // (symlinks such as macOS /var → /private/var, Windows junctions and 8.3 short names).
  return path.relative(real(root), real(abs)).replace(/\\/g, '/');
}


export function createHandler(opts: RedlineOptions & { serverRoot: string; clientFile: string }): { api: Middleware; inject: Middleware; store: Store; root: string } {
  const root = opts.root ? path.resolve(opts.root) : findRoot(opts.serverRoot);
  const store = createStore({ root, dir: opts.dir });
  const app = opts.app ?? appOf(root, opts.serverRoot);
  const config = { hotkey: opts.hotkey ?? 'alt+shift+r', launcher: opts.launcher !== false, dir: store.dir, app };

  const fixTarget = (t?: Target) => {
    if (t?.source?.file) t.source.file = normaliseSource(t.source.file, root, opts.serverRoot);
  };

  const api: Middleware = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(API_BASE + '/')) return next();
    const [p] = url.slice(API_BASE.length).split('?');
    const method = req.method ?? 'GET';

    (async () => {
      if (method === 'GET' && p === '/client.js') {
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(await fs.readFile(opts.clientFile));
        return;
      }
      // guide: the agent guide `redline init` installed, so the copied prompt can point at it.
      if (method === 'GET' && p === '/config') return json(res, 200, { ...config, guide: GUIDE_PATHS.find(g => existsSync(path.join(root, g))) ?? null });
      if (method === 'GET' && p.startsWith('/assets/')) {
        const file = store.assetPath(p.slice(8));
        if (!file || !existsSync(file)) return json(res, 404, { error: 'not found' });
        res.setHeader('content-type', file.endsWith('.svg') ? 'image/svg+xml' : 'image/png');
        res.setHeader('cache-control', 'no-store');
        res.end(await fs.readFile(file));
        return;
      }
      if (method === 'GET' && p === '/notes') {
        const version = await store.version();
        if (req.headers['if-none-match'] === `"${version}"`) { res.statusCode = 304; res.end(); return; }
        res.setHeader('etag', `"${version}"`);
        return json(res, 200, { version, root: store.dir, notes: await store.list() });
      }

      // Mutations need the custom header: a cross-site page can't send it without a
      // CORS preflight, which we never answer.
      if (req.headers['x-redline'] !== '1') return json(res, 403, { error: 'missing x-redline header' });

      if (method === 'POST' && p === '/notes') {
        const body = JSON.parse(await readBody(req)) as NewNoteRequest;
        if (!body?.note?.page || !body.note.type) return json(res, 400, { error: 'note.page and note.type are required' });
        fixTarget(body.note.target);
        body.note.app = app || undefined;   // set here, never by the page
        const note = await store.create(body);
        return json(res, 200, { ...note, file: `${store.dir}/pages/${pageFile(note.page, note.app)}` });
      }
      const m = /^\/notes\/([a-z0-9]+)$/.exec(p);
      if (m && method === 'PATCH') {
        const n = await store.update(m[1], JSON.parse(await readBody(req)));
        return n ? json(res, 200, n) : json(res, 404, { error: 'not found' });
      }
      if (m && method === 'DELETE') {
        return (await store.remove(m[1])) ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
      }
      json(res, 404, { error: 'unknown endpoint' });
    })().catch(err => {
      if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
    });
  };

  return { api, inject: htmlInjector(SNAPSHOT + `<script type="module" src="${API_BASE}/client.js" ${MARK}></script>`), store, root };
}

/**
 * Buffers text/html responses and adds the client <script> before </body>.
 * Done at the HTTP level so it works for SPAs, SSR (SvelteKit) and Astro alike,
 * none of which share an HTML transform hook.
 */
export function htmlInjector(tag: string): Middleware {
  return (req, res, next) => {
    const accept = String(req.headers.accept ?? '');
    if (req.method !== 'GET' || !accept.includes('text/html') || (req.url ?? '').startsWith(API_BASE)) return next();

    const origWrite = res.write.bind(res) as (...a: unknown[]) => boolean;
    const origEnd = res.end.bind(res) as (...a: unknown[]) => ServerResponse;
    const origWriteHead = res.writeHead.bind(res) as (...a: unknown[]) => ServerResponse;
    const chunks: Buffer[] = [];
    let html: boolean | null = null;

    const isHtml = () => {
      if (html === null)
        html = String(res.getHeader('content-type') ?? '').includes('text/html') && !res.getHeader('content-encoding');
      return html;
    };
    const toBuf = (c: unknown, enc?: unknown) =>
      Buffer.isBuffer(c) ? c : c instanceof Uint8Array ? Buffer.from(c) : Buffer.from(String(c), typeof enc === 'string' ? enc as BufferEncoding : 'utf8');

    // Hold headers back so content-length can still change.
    res.writeHead = ((status: number, ...rest: unknown[]) => {
      res.statusCode = status;
      const headers = rest.find(r => r && typeof r === 'object');
      const msg = rest.find(r => typeof r === 'string');
      if (msg) res.statusMessage = msg as string;
      if (Array.isArray(headers)) for (let i = 0; i < headers.length; i += 2) res.setHeader(headers[i], headers[i + 1]);
      else if (headers) for (const [k, v] of Object.entries(headers)) if (v !== undefined) res.setHeader(k, v as string);
      if (!isHtml()) return origWriteHead(res.statusCode, res.statusMessage);
      return res;
    }) as typeof res.writeHead;

    res.write = ((chunk: unknown, enc?: unknown, cb?: unknown) => {
      if (!isHtml()) return origWrite(chunk, enc, cb);
      chunks.push(toBuf(chunk, enc));
      const done = typeof enc === 'function' ? enc : cb;
      if (typeof done === 'function') queueMicrotask(done as () => void);
      return true;
    }) as typeof res.write;

    res.end = ((chunk?: unknown, enc?: unknown, cb?: unknown) => {
      if (!isHtml()) return origEnd(chunk, enc, cb);
      if (chunk && typeof chunk !== 'function') chunks.push(toBuf(chunk, enc));
      let body = Buffer.concat(chunks).toString('utf8');
      if (body && !body.includes(MARK)) {
        const i = body.lastIndexOf('</body>');
        body = i >= 0 ? body.slice(0, i) + tag + body.slice(i) : body + tag;
      }
      if (!res.headersSent) {
        res.removeHeader('content-length');
        res.setHeader('content-length', Buffer.byteLength(body));
      }
      const done = [chunk, enc, cb].find(a => typeof a === 'function');
      // Node writes the held-back headers through res.writeHead from inside end().
      res.writeHead = origWriteHead as typeof res.writeHead;
      res.write = origWrite as typeof res.write;
      return origEnd(body, 'utf8', done);
    }) as typeof res.end;

    next();
  };
}
