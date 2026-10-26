// The hub's HTTP server (D44). Three parts on one port:
//   /p/<project>/…      the remote store protocol (docs/PROTOCOL.md) for dev servers, through
//                       notesProtocol; Bearer = a person's (or agent's) token for that project
//   /p/<project>/mcp    the Redline MCP tools on that project's notes, same tokens
//   /api/…, /           the hub's own UI and its JSON API, behind a session cookie
// Everything binds to localhost unless the CLI is told otherwise (cli.ts warns).

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { notesProtocol } from '../../src/server/protocol.ts';
import { handleMcpMessage, type Backend, type JsonRpcMessage } from '../../src/mcp.ts';
import type { Db, Project, Token } from './db.ts';
import { cleanSites, DEFAULT_POLICY, HubError, projectStore, type Policy, type ProjectStore, type Status } from './store.ts';
import { page } from './ui.ts';

export const VERSION: string = (() => {
  try { return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version; } catch { return '0'; }
})();

export interface HubOptions {
  db: Db;
  /** The hub's address as dev servers and browsers reach it; used in links and setup snippets. */
  publicUrl?: string;
  now?: () => number;
  policy?: Partial<Policy>;
}

type Req = http.IncomingMessage;
type Res = http.ServerResponse;
interface Who { admin: boolean; token: Token | null }

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const COOKIE = 'redline_hub';

function send(res: Res, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function readJson(req: Req, max = 1024 * 1024): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new HubError(413, 'request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); resolve(v && typeof v === 'object' ? v : {}); }
      catch { reject(new HubError(400, 'expected a JSON body')); }
    });
    req.on('error', reject);
  });
}

const bearer = (req: Req) => /^Bearer\s+(\S+)\s*$/i.exec(String(req.headers.authorization ?? ''))?.[1];
const cookie = (req: Req, name: string) =>
  String(req.headers.cookie ?? '').split(/;\s*/).map(c => c.split('=')).find(([k]) => k === name)?.[1];

/** A browser page on another origin (DNS rebinding included) gets nothing from the token-guarded parts. */
function crossOrigin(req: Req): boolean {
  const origin = req.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== req.headers.host; } catch { return true; }
}

export function slugify(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
}

export function createHub(opts: HubOptions) {
  const { db } = opts;
  const now = opts.now ?? Date.now;
  const policy: Policy = { ...DEFAULT_POLICY, ...opts.policy };
  const hub = { publicUrl: (opts.publicUrl ?? 'http://localhost').replace(/\/+$/, '') };
  const listeners = new Map<number, Set<() => void>>();

  const storeFor = (p: Project): ProjectStore => {
    let set = listeners.get(p.id);
    if (!set) listeners.set(p.id, set = new Set());
    return projectStore(db, p, { now, policy, listeners: set, href: id => `${hub.publicUrl}/#/p/${p.slug}/n/${id}` });
  };
  const urls = (p: Project) => ({ store: `${hub.publicUrl}/p/${p.slug}`, mcp: `${hub.publicUrl}/p/${p.slug}/mcp` });

  /* ---------- /p/<project>: protocol and MCP, for dev servers and agents ---------- */

  async function projectApi(req: Req, res: Res, p: Project, rest: string) {
    const store = storeFor(p);
    const tokenOf = (r: Req) => { const t = bearer(r); const row = t ? db.tokenFor(t, now()) : null; return row?.project === p.id ? row : null; };

    if (rest === '/mcp') {
      if (crossOrigin(req)) return send(res, 403, { error: 'cross-origin MCP request' });
      const t = tokenOf(req);
      if (!t) { res.setHeader('www-authenticate', 'Bearer realm="redline-hub"'); return send(res, 401, { error: `a token for project "${p.slug}" is required` }); }
      if (req.method !== 'POST') { res.statusCode = 405; res.setHeader('allow', 'POST'); res.end(); return; }
      let msg: JsonRpcMessage | JsonRpcMessage[];
      try { msg = JSON.parse((await readRaw(req)) || 'null'); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); }
      const backend: Backend = {
        label: `Redline hub, project ${p.name}`,
        async list() { return store.all('all').filter(n => !n.archived); },
        update: (id, patch) => store.update(id, patch),
        asset: name => store.asset(name),
      };
      const handle = (m: JsonRpcMessage) => handleMcpMessage(m, { backend: async () => backend, version: VERSION });
      const replies = Array.isArray(msg)
        ? (await Promise.all(msg.filter(m => m && typeof m === 'object').map(handle))).filter(r => r !== null)
        : msg && typeof msg === 'object' ? await handle(msg) : undefined;
      if (replies === undefined) return send(res, 400, { error: 'expected a JSON-RPC message' });
      if (replies === null || (Array.isArray(replies) && !replies.length)) { res.statusCode = 202; res.end(); return; }
      return send(res, 200, replies);
    }

    if (crossOrigin(req)) return send(res, 403, { error: 'the store protocol is for servers, not browser pages' });
    const serve = notesProtocol(store, { base: `/p/${p.slug}`, authorize: r => tokenOf(r)?.person ?? null, unauthorized: `a token for project "${p.slug}" is required (REDLINE_STORE_TOKEN); ask the hub admin for one` });
    serve(req, res, () => send(res, 404, { error: 'unknown endpoint' }));
  }

  /* ---------- /api: the hub's UI ---------- */

  function who(req: Req): Who | null {
    const id = cookie(req, COOKIE);
    const s = id ? db.session(id, now()) : null;
    if (!s) return null;
    if (s.token === null) return { admin: true, token: null };
    const t = db.tokenById(s.token);
    return t ? { admin: false, token: t } : null;
  }

  function setCookie(res: Res, value: string, maxAge: number) {
    const secure = hub.publicUrl.startsWith('https:') ? '; Secure' : '';
    res.setHeader('set-cookie', `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure}`);
  }

  const projectJson = (p: Project, full: boolean) => {
    const s = storeFor(p);
    const all = s.all('all');
    return {
      slug: p.slug, name: p.name, sites: p.sites, ...urls(p),
      open: all.filter(n => !n.done && !n.archived).length,
      resolved: all.filter(n => n.done && !n.archived).length,
      people: full ? db.tokens(p.id).length : undefined,
    };
  };

  async function api(req: Req, res: Res, path: string) {
    const method = req.method ?? 'GET';
    // Writes need this header: a cross-site form or fetch can't send it without a preflight we never answer.
    if (method !== 'GET' && req.headers['x-redline-hub'] !== '1') return send(res, 403, { error: 'missing x-redline-hub header' });

    if (path === '/login' && method === 'POST') {
      const key = String((await readJson(req)).key ?? '').trim();
      const t = key.startsWith('rht_') ? db.tokenFor(key, now()) : null;
      if (!t && !db.isAdminKey(key)) return send(res, 401, { error: 'That is not the admin key or a member token for this hub.' });
      if (t && t.kind !== 'member') return send(res, 403, { error: 'Agent tokens are for MCP, not the UI.' });
      setCookie(res, db.createSession(t ? t.id : null, now()), 30 * 86_400);
      return send(res, 200, { ok: true });
    }
    if (path === '/logout' && method === 'POST') {
      const id = cookie(req, COOKIE);
      if (id) db.endSession(id);
      setCookie(res, '', 0);
      return send(res, 200, { ok: true });
    }

    const w = who(req);
    if (!w) return send(res, 401, { error: 'Sign in with the admin key or your member token.' });
    const memberOf = w.token ? db.projects().find(p => p.id === w.token!.project) ?? null : null;
    const forbid = () => send(res, 403, { error: 'Only the hub admin can do that.' });

    if (path === '/me') return send(res, 200, { admin: w.admin, person: w.token?.person, project: memberOf?.slug, version: VERSION, publicUrl: hub.publicUrl });

    if (path === '/projects') {
      if (method === 'GET') return send(res, 200, { projects: (w.admin ? db.projects() : memberOf ? [memberOf] : []).map(p => projectJson(p, w.admin)) });
      if (method === 'POST') {
        if (!w.admin) return forbid();
        const b = await readJson(req);
        const name = String(b.name ?? '').trim();
        if (!name) throw new HubError(400, 'Give the project a name.');
        const slug = String(b.slug ?? '').trim() || slugify(name);
        if (!SLUG.test(slug)) throw new HubError(400, 'The short name takes lowercase letters, digits and dashes (up to 40).');
        if (db.project(slug)) throw new HubError(409, `There is already a project "${slug}".`);
        return send(res, 200, projectJson(db.createProject(slug, name, cleanSites(b.sites), now()), true));
      }
    }

    const m = /^\/projects\/([a-z0-9-]+)(\/.*)?$/.exec(path);
    if (!m) return send(res, 404, { error: 'unknown endpoint' });
    const p = db.project(m[1]);
    if (!p || (!w.admin && memberOf?.id !== p.id)) return send(res, 404, { error: `No project "${m[1]}".` });
    const sub = m[2] ?? '';
    const store = storeFor(p);

    if (sub === '') {
      if (method === 'GET') return send(res, 200, projectJson(p, w.admin));
      if (!w.admin) return forbid();
      if (method === 'PATCH') {
        const b = await readJson(req);
        const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : p.name;
        db.updateProject(p.id, name, b.sites === undefined ? p.sites : cleanSites(b.sites));
        return send(res, 200, projectJson(db.project(p.slug)!, true));
      }
      if (method === 'DELETE') { db.deleteProject(p.id); listeners.delete(p.id); return send(res, 200, { ok: true }); }
    }

    if (sub === '/notes' && method === 'GET') {
      const status = new URL(req.url ?? '', 'http://x').searchParams.get('status') ?? 'open';
      if (!['open', 'resolved', 'archived', 'all'].includes(status)) throw new HubError(400, 'status is open, resolved, archived or all');
      return send(res, 200, { notes: store.all(status as Status) });
    }
    const n = /^\/notes\/([a-z0-9]{4,24})$/.exec(sub);
    if (n && method === 'PATCH') {
      const b = await readJson(req);
      const patch: Parameters<ProjectStore['update']>[1] = {};
      if (typeof b.reply === 'string') patch.reply = b.reply.replace(/\s*\n\s*/g, ' ').trim();
      if (typeof b.done === 'boolean') patch.done = b.done;
      if (typeof b.archived === 'boolean') patch.archived = b.archived;
      const note = await store.update(n[1], patch);
      return note ? send(res, 200, note) : send(res, 404, { error: 'No such note.' });
    }
    if (n && method === 'DELETE') return (await store.remove(n[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such note.' });

    const a = /^\/assets\/([a-z0-9]{4,24}\.(?:png|svg))$/.exec(sub);
    if (a && method === 'GET') {
      const asset = await store.asset(a[1]);
      if (!asset) return send(res, 404, { error: 'not found' });
      res.setHeader('content-type', asset.type);
      res.setHeader('cache-control', 'private, max-age=3600');
      res.setHeader('x-content-type-options', 'nosniff');
      // A sketch is reviewer-made SVG: opened on its own it must not run script in the hub's origin.
      res.setHeader('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
      res.end(asset.data);
      return;
    }

    if (sub === '/events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 5000\n\n');
      const stop = store.subscribe(() => res.write('event: change\ndata: {}\n\n'));
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); stop(); });
      return;
    }

    if (sub === '/tokens' || sub.startsWith('/tokens/')) {
      if (!w.admin) return forbid();
      if (sub === '/tokens' && method === 'GET') return send(res, 200, { tokens: db.tokens(p.id) });
      if (sub === '/tokens' && method === 'POST') {
        const b = await readJson(req);
        const person = String(b.person ?? '').trim().slice(0, 120);
        if (!person) throw new HubError(400, 'Name the person (or agent) the token is for.');
        const kind = b.kind === 'agent' ? 'agent' : 'member';
        const { token, id } = db.createToken(p.id, person, kind, now());
        return send(res, 200, { id, person, kind, token, ...urls(p) });
      }
      const t = /^\/tokens\/(\d+)$/.exec(sub);
      if (t && method === 'DELETE') return db.deleteToken(p.id, Number(t[1])) ? send(res, 200, { ok: true }) : send(res, 404, { error: 'No such token.' });
    }
    send(res, 404, { error: 'unknown endpoint' });
  }

  /* ---------- the page ---------- */

  function ui(res: Res) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.statusCode = 200;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.setHeader('content-security-policy', `default-src 'self'; img-src 'self' data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`);
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-content-type-options', 'nosniff');
    res.end(page(nonce));
  }

  const handler = (req: Req, res: Res) => {
    const path = (req.url ?? '/').split('?')[0];
    (async () => {
      const pm = /^\/p\/([^/]+)(\/.*)?$/.exec(path);
      if (pm) {
        const p = SLUG.test(pm[1]) ? db.project(pm[1]) : null;
        if (!p) return send(res, 404, { error: `This hub has no project "${pm[1]}". Check REDLINE_STORE_URL.` });
        return await projectApi(req, res, p, pm[2] ?? '');
      }
      if (path.startsWith('/api/')) return await api(req, res, path.slice(4));
      if (path === '/' && (req.method === 'GET' || req.method === 'HEAD')) return ui(res);
      send(res, 404, { error: 'not found' });
    })().catch(err => {
      if (res.headersSent) return;
      const status = err instanceof HubError ? err.status : 500;
      send(res, status, { error: status === 500 ? `hub error: ${err?.message ?? err}` : err.message });
    });
  };

  return {
    handler,
    get publicUrl() { return hub.publicUrl; },
    set publicUrl(u: string) { hub.publicUrl = u.replace(/\/+$/, ''); },
    /** Listen; resolves with the server once it is up. Port 0 picks a free one. */
    listen(port: number, host: string): Promise<http.Server> {
      const server = http.createServer(handler);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          if (!opts.publicUrl) {
            const a = server.address() as AddressInfo;
            const h = host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
            hub.publicUrl = `http://${h}:${a.port}`;
          }
          resolve(server);
        });
      });
    },
  };
}

function readRaw(req: Req, max = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new HubError(413, 'request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
