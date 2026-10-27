// Connect-style middleware: the /__redline HTTP API, the client bundle, and the
// <script> injection into HTML pages. Works in any Node dev server that accepts
// (req, res, next) middleware: Vite, Astro, SvelteKit, Express.

import { promises as fs, existsSync, readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NewNoteRequest, Note, Target } from '../shared/types.ts';
import { API_BASE, STORE_OWNED } from '../shared/types.ts';
import { cleanPatch, createStore, isMarkdownStore, type NotePatch, type NoteStore } from './store.ts';
import { remoteStore } from './remote.ts';
import { appOf, findRoot, real } from './root.ts';
import { defaultWriters, resolveInside, runWriters, type EditRequest, type EditResult, type SourceWriter } from './writers.ts';
import { registerServer } from './registry.ts';
import { cleanLabel, normalizeLabels, type LabelDef, type LabelsSource } from '../shared/labels.ts';
import { GUIDE_PATHS } from '../init.ts';
import { handleMcpMessage, type Backend, type JsonRpcMessage } from '../mcp.ts';

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
  /**
   * The labels a reviewer can tag a note with (chips in the popover, D46): names, or { name, color }.
   * Default Bug, UX, Idea and Copy; false turns labels off. A function is asked on every /config
   * request (`{ req }`), e.g. to load them from a backend; if it throws, the overlay shows none.
   */
  labels?: LabelsSource<IncomingMessage>;
  /**
   * The panel's "Copy prompt for your agent" button (D47). Default: shown with the markdown store (`createStore`),
   * whose files the prompt names; hidden with any other store (remote, custom), where those files don't exist.
   * A string replaces the copied text ({open} = open notes in view, {page} = the page); false or '' hides it.
   */
  prompt?: string | false;
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
  /**
   * What groups notes into pages. 'route' (default): the path, plus the hash when it is a
   * hash route (`#/settings`). 'path': the path only, so a hash-routed app (a slide deck's
   * `#/3`) keeps one notes file and one pin set. Extensions can set a function (`rl.setPageKey`).
   */
  pageKey?: 'route' | 'path';
  /**
   * Bearer tokens for the MCP endpoint (POST /__redline/mcp, D37): plain, or `sha256:<hex>` of one.
   * Without any, only calls from this machine are answered; set them when the dev server is
   * reachable from elsewhere (`--host`) and a remote agent should get the notes.
   */
  mcpTokens?: string[];
  /**
   * Who besides this machine gets the overlay and its API, which has no login (docs/SETUPS.md "Reaching the
   * dev server from elsewhere"). Default in the dev-server plugins (Vite, Astro, Angular, Next): nobody, i.e.
   * a loopback caller with a local Host. A list adds callers: addresses and subnets (`192.168.1.20`,
   * `172.16.0.0/12`, `fd00::/8`) match the caller's address, whatever its Host; host names (`myapp.test`,
   * `*.myapp.test`) match the Host of a call from this machine (a proxy here with its own domain).
   * `true`: everyone, the default of `redlineMiddleware` (a deployed review server gates reviewers itself).
   * MCP keeps its own rule (`mcpTokens`).
   */
  network?: boolean | string[];
  /**
   * The build the pages come from, e.g. a commit hash: recorded on every new note so an agent
   * reads the source lines at that revision. Useful when the overlay runs on a deployed build
   * with source stamps (`buildSource`, D43) rather than on a dev server.
   */
  build?: string;
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


const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;
const LOCAL_HOST = /^(localhost|[^:/]+\.localhost|127(\.\d+){3}|\[::1\])(:\d+)?$/i;

/** The caller's address as the server in front saw it (set by withRedline's API server under Next, D48). */
export const PEER = Symbol.for('umage.redline.peer');
const peerOf = (req: IncomingMessage) => (req as { [PEER]?: string })[PEER] ?? req.socket?.remoteAddress ?? '';

/**
 * A call from this machine: a loopback address, and a local Host (x-forwarded-host behind a proxy), which
 * stops DNS rebinding. Behind Next's rewrite the address is the one Next's own server saw (PEER).
 */
export function localCall(req: IncomingMessage): boolean {
  if (!LOOPBACK.test(peerOf(req))) return false;
  const h = req.headers;
  const host = String(h['x-forwarded-host'] ?? h.host ?? h[':authority'] ?? '').split(',')[0].trim();
  return LOCAL_HOST.test(host);
}

/**
 * The `network` list as a check: an address or subnet entry admits that caller, a host name entry a call
 * from this machine with that Host. Throws on an entry that is neither, so a typo fails at startup.
 */
export function networkAllows(entries: string[]): (req: IncomingMessage) => boolean {
  const ips = new net.BlockList();
  const hosts: string[] = [];
  for (const e of entries) {
    const [addr, bits, extra] = e.trim().split('/');
    const family = net.isIP(addr);
    try {
      if (family && extra === undefined && (bits === undefined || /^\d+$/.test(bits))) {
        const type = family === 6 ? 'ipv6' : 'ipv4';
        if (bits === undefined) ips.addAddress(addr, type); else ips.addSubnet(addr, Number(bits), type);
        continue;
      }
    } catch { /* a prefix out of range: reported below */ }
    if (bits === undefined && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/i.test(addr)) { hosts.push(addr.toLowerCase()); continue; }
    throw new Error(`[redline] network: "${e}" is not an address, a subnet (10.0.0.0/8) or a host name`);
  }
  return req => {
    const peer = peerOf(req);
    const family = net.isIP(peer);
    if (family && ips.check(peer, family === 6 ? 'ipv6' : 'ipv4')) return true;
    if (!hosts.length || !LOOPBACK.test(peer)) return false;
    const h = req.headers;
    const host = String(h['x-forwarded-host'] ?? h.host ?? h[':authority'] ?? '').split(',')[0].trim().toLowerCase().replace(/:\d+$/, '');
    return hosts.some(x => (x.startsWith('*.') ? host.endsWith(x.slice(1)) : host === x));
  };
}

/** Who may call the MCP endpoint: a configured bearer token, or (no tokens configured) a loopback caller. */
export function mcpAllowed(req: IncomingMessage, tokens: string[] | undefined): boolean {
  const auth = String(req.headers.authorization ?? '');
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1];
  if (tokens?.length) {
    if (!bearer) return false;
    const got = sha256(bearer);
    // Hash both sides, so the comparison is constant-time whatever the token lengths.
    // A malformed sha256: entry never matches (Buffer.from(hex) would silently shorten it).
    const want = (t: string) => !t.startsWith('sha256:') ? sha256(t) : /^[0-9a-f]{64}$/i.test(t.slice(7)) ? Buffer.from(t.slice(7), 'hex') : null;
    return tokens.some(t => { const w = want(t); return !!w && timingSafeEqual(got, w); });
  }
  return !bearer && LOOPBACK.test(peerOf(req));
}

let pkgVersion: string | undefined;
function versionOf(clientFile: string): string {
  try { return pkgVersion ??= JSON.parse(readFileSync(path.join(path.dirname(clientFile), '..', 'package.json'), 'utf8')).version ?? '0'; }
  catch { return '0'; }
}

export function createHandler(opts: RedlineOptions & { serverRoot: string; clientFile: string }): { api: Middleware; inject: Middleware; store: NoteStore; root: string; register(url: string): void } {
  const root = opts.root ? path.resolve(opts.root) : findRoot(opts.serverRoot);
  const dir = opts.dir ?? '.redline';
  const app = opts.app ?? appOf(root, opts.serverRoot);
  // REDLINE_STORE_URL (+ REDLINE_STORE_TOKEN) picks a remote store without touching the config,
  // so the token stays in the environment, out of a committed vite.config (D40).
  const envStore = process.env.REDLINE_STORE_URL
    ? remoteStore({ url: process.env.REDLINE_STORE_URL, token: process.env.REDLINE_STORE_TOKEN || undefined })
    : undefined;
  const store: NoteStore = typeof opts.store === 'function' ? opts.store({ root, dir, app }) : opts.store ?? envStore ?? createStore({ root, dir });
  const writers = opts.directEdit === true ? defaultWriters() : Array.isArray(opts.directEdit) ? opts.directEdit : [];
  const extFiles = (opts.extensions ?? []).map(e => typeof e === 'string' ? path.resolve(opts.serverRoot, e) : null);
  const extensions = (opts.extensions ?? []).map((e, i) => typeof e === 'string' ? `${API_BASE}/ext/${i}.js` : e.url);
  const prompt = opts.prompt !== undefined ? opts.prompt || false : isMarkdownStore(store) ? undefined : false;
  const fixedLabels = typeof opts.labels === 'function' ? null : normalizeLabels(opts.labels);
  const labelsFor = async (req: IncomingMessage): Promise<LabelDef[]> => {
    if (fixedLabels) return fixedLabels;
    try { return normalizeLabels(await (opts.labels as Extract<LabelsSource<IncomingMessage>, Function>)({ req })); }
    catch (e) { console.warn('[redline] labels() failed:', e); return []; }
  };
  const config = { hotkey: opts.hotkey ?? 'alt+shift+r', launcher: opts.launcher !== false, prompt, dir: store.dir, app, directEdit: writers.length > 0, extensions, pageKey: opts.pageKey === 'path' ? 'path' : 'route', events: !!store.subscribe };

  const fixTarget = (t?: Target) => {
    if (t?.source?.file) t.source.file = normaliseSource(t.source.file, root, opts.serverRoot);
  };
  const hook = async <K extends keyof RedlineHooks>(name: K, ...args: Parameters<NonNullable<RedlineHooks[K]>>) => {
    try { await (opts.hooks?.[name] as ((...a: unknown[]) => unknown) | undefined)?.(...args); }
    catch (err) { console.warn(`[redline] hooks.${name} failed:`, err); }
  };

  // Live changes (D41): one subscription to the store, shared by every open overlay, held only
  // while at least one is listening. Each gets `event: change` and re-reads /notes.
  const listeners = new Set<ServerResponse>();
  let unsubscribe: (() => void) | null = null;
  const broadcast = () => { for (const r of listeners) r.write('event: change\ndata: {}\n\n'); };
  const listen = (res: ServerResponse) => {
    listeners.add(res);
    if (!unsubscribe && store.subscribe) unsubscribe = store.subscribe(broadcast);
  };
  const unlisten = (res: ServerResponse) => {
    listeners.delete(res);
    if (!listeners.size && unsubscribe) { unsubscribe(); unsubscribe = null; }
  };

  // Let `redline mcp` find this server (D22): registered once per host it is reached on.
  const hosts = new Set<string>();
  const register = (url: string) => { if (!hosts.has(url)) { hosts.add(url); void registerServer(root, dir, url, app); } };

  // The MCP endpoint's tools read and write this server's own store, with the same hooks as the API.
  const mcpBackend = (req: IncomingMessage): Backend => ({
    label: `dev server http://${req.headers.host ?? 'localhost'}${app ? ` (app ${app})` : ''}`,
    list: () => store.list({ req }),
    async update(id, patch) { const n = await store.update(id, patch, { req }); if (n) await hook('onUpdate', n, patch); return n; },
    async asset(name) { const a = await store.asset(name, { req }); return a ? { type: a.type, data: Buffer.from(a.data) } : null; },
  });

  // Other machines get a 403 (and no script injected), with one line in the dev server's log saying why.
  const listed = Array.isArray(opts.network) ? networkAllows(opts.network) : () => false;
  let warned = false;
  const refused = (req: IncomingMessage) => {
    if (opts.network === true || localCall(req) || listed(req)) return false;
    if (!warned) {
      warned = true;
      const peer = peerOf(req), host = req.headers['x-forwarded-host'] ?? req.headers.host;
      console.warn(`[redline] refused a call from ${peer} (host ${host}): only this machine gets the overlay. To let it in, add ${LOOPBACK.test(peer) ? `'${String(host).replace(/:\d+$/, '')}'` : `'${peer.replace(/^::ffff:(?=\d)/, '')}'`} to the network option (or network: true for everyone).`);
    }
    return true;
  };

  const api: Middleware = (req, res, next) => {
    const url = req.url ?? '';
    if (!url.startsWith(API_BASE + '/')) return next();
    if (!url.startsWith(`${API_BASE}/mcp`) && refused(req)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'Redline answers this machine only; set the network option to allow others' }));
      return;
    }
    if (req.headers.host) register(`${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`);
    const [p] = url.slice(API_BASE.length).split('?');
    const method = req.method ?? 'GET';
    // HEAD answers like GET (Node drops the body): link checkers and proxies probe with it.
    const read = method === 'GET' || method === 'HEAD';

    (async () => {
      if (read && p === '/client.js') {
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(await fs.readFile(opts.clientFile));
        return;
      }
      // guide: the agent guide `redline init` installed, so the copied prompt can point at it.
      if (read && p === '/config') return json(res, 200, { ...config, labels: await labelsFor(req), guide: GUIDE_PATHS.find(g => existsSync(path.join(root, g))) ?? null });
      if (read && p.startsWith('/assets/')) {
        const a = await store.asset(p.slice(8), { req });
        if (!a) return json(res, 404, { error: 'not found' });
        res.setHeader('content-type', a.type);
        res.setHeader('cache-control', 'no-store');
        res.end(a.data);
        return;
      }
      const ext = /^\/ext\/(\d+)\.js$/.exec(p);
      if (read && ext) {
        const file = extFiles[+ext[1]];
        if (!file || !existsSync(file)) return json(res, 404, { error: 'not found' });
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(await fs.readFile(file));
        return;
      }
      if (read && p === '/notes') {
        const version = await store.version({ req });
        if (req.headers['if-none-match'] === `"${version}"`) { res.statusCode = 304; res.end(); return; }
        res.setHeader('etag', `"${version}"`);
        return json(res, 200, { version, root: store.dir, notes: await store.list({ req }) });
      }
      // Server-sent events (D41): only when the store can tell us about changes; the overlay
      // falls back to polling on a 404.
      if (read && p === '/events') {
        if (!store.subscribe) return json(res, 404, { error: 'this store has no change feed; the overlay polls' });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 5000\n\n');
        listen(res);
        // A comment every 25 s keeps proxies from closing an idle stream.
        const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
        req.on('close', () => { clearInterval(beat); unlisten(res); });
        return;
      }

      // MCP over Streamable HTTP (D37): stateless JSON-RPC, the same tools as `redline mcp`, on this server's store.
      if (p === '/mcp') {
        // A browser page on another origin (DNS rebinding included) must not reach the tools.
        const origin = req.headers.origin;
        if (origin && origin !== 'null' && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return json(res, 403, { error: 'cross-origin MCP request' });
        if (!mcpAllowed(req, opts.mcpTokens)) {
          res.setHeader('www-authenticate', 'Bearer realm="redline"');
          return json(res, 401, { error: opts.mcpTokens?.length ? 'a valid bearer token is required' : 'MCP answers local calls only; set mcpTokens to allow remote agents' });
        }
        if (method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return; }   // no SSE stream: tools are request/response
        let msg: JsonRpcMessage | JsonRpcMessage[];
        try { msg = JSON.parse(await readBody(req)); } catch { return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
        const handle = (m: JsonRpcMessage) => handleMcpMessage(m, { backend: async () => mcpBackend(req), version: versionOf(opts.clientFile) });
        const replies = Array.isArray(msg)
          ? (await Promise.all(msg.filter(m => m && typeof m === 'object').map(handle))).filter(r => r !== null)
          : msg && typeof msg === 'object' ? await handle(msg) : undefined;
        if (replies === undefined) return json(res, 400, { error: 'expected a JSON-RPC message' });
        if (replies === null || (Array.isArray(replies) && !replies.length)) { res.statusCode = 202; res.end(); return; }
        return json(res, 200, replies);
      }

      // Mutations need the custom header: a cross-site page can't send it without a
      // CORS preflight, which we never answer.
      if (req.headers['x-redline'] !== '1') return json(res, 403, { error: 'missing x-redline header' });

      if (method === 'POST' && p === '/notes') {
        const body = JSON.parse(await readBody(req)) as NewNoteRequest;
        if (!body?.note?.page || !body.note.type) return json(res, 400, { error: 'note.page and note.type are required' });
        fixTarget(body.note.target);
        // Who wrote it, whether it is resolved, its link: the store's to say, never the page's.
        for (const k of STORE_OWNED) delete (body.note as Record<string, unknown>)[k];
        body.note.app = app || undefined;   // set here, never by the page
        body.note.build = opts.build || undefined;
        body.note.label = cleanLabel(body.note.label) || undefined;
        const note = await store.create(body, { req });
        await hook('onCreate', note);
        return json(res, 200, note);
      }
      const m = /^\/notes\/([a-z0-9]+)$/.exec(p);
      if (m && method === 'PATCH') {
        const patch: NotePatch = cleanPatch(JSON.parse(await readBody(req)));
        const n = await store.update(m[1], patch, { req });
        if (n) await hook('onUpdate', n, patch);
        return n ? json(res, 200, n) : json(res, 404, { error: 'not found' });
      }
      if (m && method === 'DELETE') {
        const ok = await store.remove(m[1], { req });
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
          nth: Number.isInteger(body.nth?.index) && Number.isInteger(body.nth?.count) ? { index: body.nth!.index, count: body.nth!.count } : undefined,
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

  const injector = htmlInjector(SNAPSHOT + `<script type="module" src="${API_BASE}/client.js" ${MARK}></script>`);
  const inject: Middleware = (req, res, next) => (refused(req) ? next() : injector(req, res, next));
  return { api, inject, store, root, register };
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
