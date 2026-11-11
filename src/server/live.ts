// Live pages (D65): every page with the overlay loaded keeps a small event stream open to the dev
// server (GET /__redline/live), so MCP tools can ask what only the browser knows: the console errors
// it saw, and the DOM around a note's target as it is now. The server sends `ask` events; the page
// answers with a POST to /__redline/live/reply. This machine only; nothing is kept once a page closes.

import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Target } from '../shared/types.ts';

export interface LivePage { id: string; page: string; path: string; title: string; since: number }
interface Conn extends LivePage { res: ServerResponse }
export type LiveAsk = { kind: 'console' } | { kind: 'dom'; target: Target };

export function liveHub() {
  const conns = new Map<string, Conn>();
  const pending = new Map<string, (data: unknown) => void>();
  return {
    /** A page's stream: `hello` with its id, then `ask` events. */
    open(req: IncomingMessage, res: ServerResponse, q: URLSearchParams) {
      const id = randomBytes(9).toString('base64url');
      const c: Conn = { id, res, page: (q.get('page') ?? '').slice(0, 500), path: (q.get('path') ?? '').slice(0, 1000), title: (q.get('title') ?? '').slice(0, 200), since: Date.now() };
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.write(`retry: 3000\n\nevent: hello\ndata: ${JSON.stringify({ id })}\n\n`);
      conns.set(id, c);
      const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
      req.on('close', () => { clearInterval(beat); conns.delete(id); });
    },
    /** A page moved on (client-side routing): its page key and path now. */
    moved(id: string, page: unknown, path: unknown, title: unknown) {
      const c = conns.get(id);
      if (!c) return false;
      if (typeof page === 'string') c.page = page.slice(0, 500);
      if (typeof path === 'string') c.path = path.slice(0, 1000);
      if (typeof title === 'string') c.title = title.slice(0, 200);
      return true;
    },
    reply(req: unknown, data: unknown) {
      const done = typeof req === 'string' ? pending.get(req) : undefined;
      if (!done) return false;
      done(data);
      return true;
    },
    /** The open pages, oldest first; only those showing `page` (a page key) when given. */
    pages(page?: string): LivePage[] {
      return [...conns.values()].filter(c => page === undefined || c.page === page).map(({ res: _, ...p }) => p);
    },
    /** Asks every open page that `which` picks (default: all); each answer, or none after `ms`. */
    async ask(what: LiveAsk, which?: (p: LivePage) => boolean, ms = 3000): Promise<{ page: LivePage; data: unknown }[]> {
      const targets = [...conns.values()].filter(c => !which || which(c));
      return (await Promise.all(targets.map(c => new Promise<{ page: LivePage; data: unknown } | null>(resolve => {
        const req = randomBytes(9).toString('base64url');
        const timer = setTimeout(() => { pending.delete(req); resolve(null); }, ms);
        pending.set(req, data => { clearTimeout(timer); pending.delete(req); const { res: _, ...p } = c; resolve({ page: p, data }); });
        c.res.write(`event: ask\ndata: ${JSON.stringify({ req, ...what })}\n\n`);
      })))).filter((x): x is { page: LivePage; data: unknown } => !!x);
    },
    close() { for (const c of conns.values()) c.res.end(); conns.clear(); },
  };
}
export type LiveHub = ReturnType<typeof liveHub>;
