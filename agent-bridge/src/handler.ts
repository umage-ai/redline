// The bridge's HTTP routes (D63) as one plain `(req, res, path)` handler, for any Node server:
//
//   const bridge = createBridge({ root: process.cwd() });
//   http.createServer((req, res) => bridge.handle(req, res, new URL(req.url!, 'http://x').pathname));
//
// Paths are relative to wherever the host mounts it (`/info`, `/send`…). Guards, built in and not
// switchable off: callers must be on this machine (a loopback peer asking for a loopback host name),
// a page on another origin is refused, and everything but /info needs the per-process token (header
// `x-agent-token` on POSTs, a custom header, so a cross-site page can't send it without a preflight;
// `?token=` on the event streams). A host can only narrow this (`allowed: false`), never widen it.

import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { foreignOrigin, isLocal, json, readBody } from './http.ts';
import { cliChoices, commandName } from './adapters.ts';
import { checkPick, DEFAULT_KEYS, groupFor, type AgentGroup, type Picked } from './sessions.ts';
import type { AgentAdapter, BridgeOptions } from './types.ts';

/** The header a POST carries the token in. */
export const TOKEN_HEADER = 'x-agent-token';

export interface Bridge {
  /** The per-process token /info hands to local callers. */
  readonly token: string;
  /** The project's sessions. */
  readonly group: AgentGroup;
  /** What GET /info answers (the host's `info` fields merged in). */
  info(): Record<string, unknown>;
  /**
   * Answers one request; `p` is the path after the bridge's mount point (`/send`). `allowed: false`: the
   * host refuses this caller too (a proxy in front, where only the host knows the real peer).
   */
  handle(req: IncomingMessage, res: ServerResponse, p: string, opts?: { allowed?: boolean }): Promise<void>;
}

export interface BridgeSetup extends BridgeOptions {
  /** The project folder: sessions run there (or in `cwd`, relative to it). */
  root: string;
  /** Extra fields for /info, for the host's own viewer (Redline: its prompt buttons and keys). */
  info?: () => Record<string, unknown>;
}

/**
 * The bridge for one project root. Sessions are kept per root and CLI set for the life of the process,
 * so a host that re-creates its handler (a dev server's config restart) gets the same ones back.
 */
export function createBridge(setup: BridgeSetup): Bridge {
  const { root, info: extra, ...options } = setup;
  // The CLIs to pick from (D59): `clis`, else `command`, else every adapter's installed one; the default first.
  const clis = cliChoices(options);
  const opts: BridgeOptions = { ...options, command: clis[0].command, args: clis[0].args, label: clis[0].label ?? options.label };
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const group = groupFor(opts, cwd, root, clis);
  // Allow and Deny: the keys of the session's CLI (its adapter's), the option's over them.
  const keysFor = (s: { adapter: AgentAdapter }) => opts.keys === false ? false : { ...DEFAULT_KEYS, ...s.adapter.keys, ...opts.keys };
  const info = () => ({
    ...group.info(), command: commandName(opts), clis: group.clisInfo(), cli: group.clis[0].id, token: group.token, approve: opts.keys !== false,
    // The project's settings (D62): what a viewer's "reset" goes back to.
    defaults: { sessions: opts.sessions === 'shared' ? 'shared' : 'fresh', ...(opts.model ? { model: opts.model } : {}), ...(opts.effort ? { effort: opts.effort } : {}) },
    ...extra?.(),
  });

  return {
    token: group.token,
    group,
    info,
    async handle(req, res, p, { allowed = true } = {}) {
      const method = req.method ?? 'GET';
      if (!allowed || !isLocal(req)) return json(res, 403, { error: 'the agent bridge answers this machine only' });
      // A page on another origin (DNS rebinding included) never gets here: Host is checked by isLocal,
      // and Origin, when the browser sends one, must be this server.
      if (foreignOrigin(req)) return json(res, 403, { error: 'cross-origin agent request' });
      if (method === 'GET' && p === '/info') return json(res, 200, info());

      const url = new URL(req.url ?? '', 'http://x');
      const token = method === 'GET' ? url.searchParams.get('token') : req.headers[TOKEN_HEADER];
      if (token !== group.token) return json(res, 403, { error: 'missing or stale agent token' });
      if (method === 'GET' && p === '/stream') {
        if (url.searchParams.get('status') === '1') { group.watch(res); return; }
        const s = group.get(url.searchParams.get('id'));
        if (!s) return json(res, 404, { error: 'no such agent session' });
        s.attach(res);
        return;
      }

      if (method !== 'POST') return json(res, 405, { error: 'POST' });
      let body: Record<string, unknown> = {};
      try { body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}'); } catch { return json(res, 400, { error: 'bad JSON' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'expected a JSON object' });
      const failed = (e: unknown) => json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
      const named = typeof body.id === 'string' && !!body.id;
      // The session a call is for: `id`, or the newest.
      const session = group.get(body.id);
      if (named && !session) return json(res, 404, { error: 'no such agent session' });
      // The CLI a new session runs (D59): `cli`, an id from /info's `clis`. None: the default (shared: the session's own).
      const cli = typeof body.cli === 'string' && body.cli ? group.clis.find(c => c.id === body.cli) : undefined;
      if (body.cli !== undefined && body.cli !== '' && !cli) return json(res, 400, { error: `no such agent CLI: ${String(body.cli)}` });
      // The viewer's model and effort (D62): only what the settings offered for the CLI the session runs.
      let pick: Picked = {};
      if (p === '/start' || p === '/send') {
        const target = group.target(body.id, cli);
        const r = checkPick(body, group.offer(target), target.name);
        if ('error' in r) return json(res, 400, { error: r.error });
        pick = r;
      }
      switch (p) {
        case '/start': {
          // A named session (re)starts; none named: 'shared' the one session, 'fresh' a new one.
          try {
            const s = named ? session! : group.forPrompt(undefined, cli, pick);
            await s.start(Number(body.cols), Number(body.rows));
            return json(res, 200, s.info());
          } catch (e) { return failed(e); }
        }
        case '/send': {
          if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text is required' });
          try {
            const s = group.forPrompt(body.id, cli, pick);
            await s.send(body.text, Array.isArray(body.notes) ? body.notes.slice(0, 200) as string[] : [], { title: body.title, task: body.task });
            return json(res, 200, { ok: true, id: s.id });
          } catch (e) { return failed(e); }
        }
        case '/mode':
          if (body.mode !== 'shared' && body.mode !== 'fresh') return json(res, 400, { error: 'mode must be shared or fresh' });
          group.setMode(body.mode);
          return json(res, 200, group.info());
        case '/end':
          // Stop and close in one: the session named, or (no id) every one.
          for (const s of named ? [session!] : [...group.sessions]) group.drop(s);
          return json(res, 200, { ok: true });
        case '/stop':
          // One session, or (no id) all of them; it stays listed as ended (a terminal's Restart).
          if (named) session!.stop(); else for (const s of group.sessions) s.stop();
          return json(res, 200, { ok: true });
        case '/dismiss':
          if (!named) return json(res, 400, { error: 'id is required' });
          if (session!.running) return json(res, 409, { error: 'stop the session first' });
          group.drop(session!);
          return json(res, 200, { ok: true });
      }
      if (!session) return json(res, 409, { error: 'no agent session' });
      switch (p) {
        case '/input':
          if (typeof body.data === 'string') session.write(body.data);
          return json(res, 200, { ok: true });
        case '/resize':
          session.resize(Number(body.cols), Number(body.rows));
          return json(res, 200, { ok: true });
        case '/answer': {
          const keys = keysFor(session), key = keys && (body.choice === 'allow' ? keys.allow : body.choice === 'deny' ? keys.deny : undefined);
          if (!key) return json(res, 400, { error: 'choice must be allow or deny' });
          if (!session.answer(key, body.choice as string)) return json(res, 409, { error: 'the agent is not waiting for approval' });
          return json(res, 200, { ok: true });
        }
        case '/choose': {
          const index = Number(body.index);
          if (!Number.isInteger(index) || index < 0) return json(res, 400, { error: 'index is required' });
          if (!(await session.choose(index, typeof body.text === 'string' ? body.text.slice(0, 4000) : undefined))) return json(res, 409, { error: 'no such option on the agent\'s screen' });
          return json(res, 200, { ok: true });
        }
        case '/ack':
          session.acknowledge();
          return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'unknown agent endpoint' });
    },
  };
}
