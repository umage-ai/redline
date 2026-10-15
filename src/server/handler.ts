// Connect-style middleware: the /__redline HTTP API, the client bundle, and the
// <script> injection into HTML pages. Works in any Node dev server that accepts
// (req, res, next) middleware: Vite, Astro, SvelteKit, Express.

import { promises as fs, existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NewNoteRequest, Note, Target } from '../shared/types.ts';
import { API_BASE } from '../shared/types.ts';
import { createStore, type NotePatch, type NoteStore } from './store.ts';
import { appOf, findRoot, real } from './root.ts';
import { defaultWriters, resolveInside, runWriters, type EditRequest, type EditResult, type SourceWriter } from './writers.ts';
import { registerServer } from './registry.ts';
import { GUIDE_PATHS } from '../init.ts';

export type Next = (err?: unknown) => void;
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/** Called after the change is stored. Errors are logged, never shown to the reviewer. */
export interface RedlineHooks {
  onCreate?(note: Note): unknown;
  onUpdate?(note: Note, patch: NotePatch): unknown;
  onRemove?(id: string): unknown;
  onSourceWrite?(edit: EditRequest, result: Extract<EditResult, { ok: true }>): unknown;
}

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
  /** Where notes go. Default: markdown in <root>/<dir> (createStore). A function gets the resolved root. */
  store?: NoteStore | ((ctx: { root: string; dir: string; app: string }) => NoteStore);
  /** Run after notes are created, updated or removed, and after direct source edits. */
  hooks?: RedlineHooks;
  /**
   * Text mode can write the change straight into source when the text is static there (D20).
   * true = the built-in writers (Astro/Svelte/JSX/Vue markup, static .html); or your own list,
   * e.g. [myCmsWriter(), ...defaultWriters()]. Default false: text edits are notes only.
   */
  directEdit?: boolean | SourceWriter[];
  /**
   * Overlay extensions (D21): browser ES modules whose default export gets the extension API.
   * A string is a file path (relative to the dev server root), served as-is, so plain JS;
   * { url } is loaded from that URL instead (e.g. { url: '/src/redline.ext.ts' } to let Vite compile it).
   */
  extensions?: (string | { url: string })[];
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


export function createHandler(opts: RedlineOptions & { serverRoot: string; clientFile: string }): { api: Middleware; inject: Middleware; store: NoteStore; root: string; register(url: string): void } {
  const root = opts.root ? path.resolve(opts.root) : findRoot(opts.serverRoot);
  const dir = opts.dir ?? '.redline';
  const app = opts.app ?? appOf(root, opts.serverRoot);
  const store: NoteStore = typeof opts.store === 'function' ? opts.store({ root, dir, app }) : opts.store ?? createStore({ root, dir });
  const writers = opts.directEdit === true ? defaultWriters() : Array.isArray(opts.directEdit) ? opts.directEdit : [];
  const extFiles = (opts.extensions ?? []).map(e => typeof e === 'string' ? path.resolve(opts.serverRoot, e) : null);
  const extensions = (opts.extensions ?? []).map((e, i) => typeof e === 'string' ? `${API_BASE}/ext/${i}.js` : e.url);
  const config = { hotkey: opts.hotkey ?? 'alt+shift+r', launcher: opts.launcher !== false, dir: store.dir, app, directEdit: writers.length > 0, extensions };

  const fixTarget = (t?: Target) => {
    if (t?.source?.file) t.source.file = normaliseSource(t.source.file, root, opts.serverRoot);
  };
  const hook = async <K extends keyof RedlineHooks>(name: K, ...args: Parameters<NonNullable<RedlineHooks[K]>>) => {
    try { await (opts.hooks?.[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args); }
    catch (err) { console.warn(`[redline] hooks.${name} failed:`, err); }
  };

  // Let `redline mcp` find this server (D22): registered once per host it is reached on.
  const hosts = new Set<string>();
  const register = (url: string) => { if (!hosts.has(url)) { hosts.add(url); void registerServer(root, dir, url, app); } };

  const api: Middleware = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(API_BASE + '/')) return next();
    if (req.headers.host) register(`${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`);
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
        const a = await store.asset(p.slice(8));
        if (!a) return json(res, 404, { error: 'not found' });
        res.setHeader('content-type', a.type);
        res.setHeader('cache-control', 'no-store');
        res.end(a.data);
        return;
      }
      const ext = /^\/ext\/(\d+)\.js$/.exec(p);
      if (method === 'GET' && ext) {
        const file = extFiles[+ext[1]];
        if (!file || !existsSync(file)) return json(res, 404, { error: 'not found' });
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
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
        await hook('onCreate', note);
        return json(res, 200, note);
      }
      const m = /^\/notes\/([a-z0-9]+)$/.exec(p);
      if (m && method === 'PATCH') {
        const patch = JSON.parse(await readBody(req)) as NotePatch;
        const n = await store.update(m[1], patch);
        if (n) await hook('onUpdate', n, patch);
        return n ? json(res, 200, n) : json(res, 404, { error: 'not found' });
      }
      if (m && method === 'DELETE') {
        const ok = await store.remove(m[1]);
        if (ok) await hook('onRemove', m[1]);
        return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: 'not found' });
      }
      // Direct source edit (D20). ?inspect=1 returns the element's source tokens (for the rich
      // editor); ?dry=1 only checks, so the overlay can offer "Apply to file" or not.
      if (method === 'POST' && p === '/edit') {
        if (!writers.length) return json(res, 404, { error: 'direct edits are off (directEdit option)' });
        const body = JSON.parse(await readBody(req)) as EditRequest;
        const inspect = /[?&]inspect=1/.test(url);
        if (typeof body?.from !== 'string' || typeof body.tag !== 'string' || (!inspect && typeof body.to !== 'string')) return json(res, 400, { error: 'from, to and tag are required' });
        const edit: EditRequest = {
          from: body.from, to: inspect ? body.from : body.to, html: typeof body.html === 'string' ? body.html : undefined,
          tag: body.tag.toLowerCase(), url: String(body.url ?? ''), source: body.source?.file ? { ...body.source } : undefined,
          cms: body.cms && typeof body.cms === 'object' ? { ...body.cms } : undefined,
        };
        if (edit.source) edit.source.file = normaliseSource(edit.source.file, root, opts.serverRoot);
        const dryRun = inspect || /[?&]dry=1/.test(url);
        const result = await runWriters(writers, edit, { root, serverRoot: opts.serverRoot, dryRun, inspect, resolve: rel => resolveInside(root, dir, rel) });
        if (result.ok && !dryRun) await hook('onSourceWrite', edit, result);
        return json(res, 200, result);
      }
      json(res, 404, { error: 'unknown endpoint' });
    })().catch(err => {
      if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
    });
  };

  return { api, inject: htmlInjector(SNAPSHOT + `<script type="module" src="${API_BASE}/client.js" ${MARK}></script>`), store, root, register };
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
