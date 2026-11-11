// The agent panel's server (D53, D63): Redline's layer over the agent bridge (agent-bridge/, bundled in).
// The bridge runs the sessions and answers the generic routes (/info, /send, /stream…, its guards
// built in); this file mounts it under `<base>/agent/`, adds the toolbar's own fields to /info (prompt
// buttons, keys) and serves the panel's browser files (panel.js, terminal.js) and the terminal page.

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createBridge } from '../../agent-bridge/src/handler.ts';
import { json } from '../../agent-bridge/src/http.ts';
import type { AgentCommand, AgentOptions, AgentRoutes } from '../../src/server/agent-hook.ts';

// This file's folder: dist/ in the package (CommonJS), src/ when run from source (tests). The browser files are in dist/.
const HERE = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const DIST = path.basename(HERE) === 'dist' ? HERE : path.join(HERE, '../dist');

export const DEFAULT_COMMANDS: AgentCommand[] = [
  { label: 'Apply notes', title: 'Ask the agent to apply the open notes on this page', prompt: 'Apply the open Redline notes {ids} on page {page}, following the redline skill. Mark each one done when it is applied.' },
];

/** The bearer the sessions Redline starts present to its MCP (D66): per process, never shown to a page. */
export const MCP_TOKEN = randomBytes(24).toString('base64url');

/** The terminal page the agent window frames: xterm.js in its own document, out of the app's and the overlay's key handling. */
const terminalPage = (base: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Agent</title>
<style>html,body{margin:0;height:100%;background:#131316;overflow:hidden}#t{position:absolute;inset:4px 2px 2px 8px}</style></head>
<body><div id="t"></div><script type="module" src="${base}/agent/terminal.js"></script></body></html>`;

/** The panel's routes for one project root, under the API base (`/__redline`). */
export function agentRoutes(opts: AgentOptions, root: string, base: string, dir = '.redline'): AgentRoutes {
  const { commands: given, hotkey: hk, key: k, ...bridgeOpts } = opts;
  const commands = (given ?? DEFAULT_COMMANDS).filter(c => c && typeof c.label === 'string' && typeof c.prompt === 'string');
  const hotkey = hk === false ? false : typeof hk === 'string' && hk ? hk : 'alt+shift+a';
  const key = k === false ? false : typeof k === 'string' && k.length === 1 ? k.toLowerCase() : 'a';
  // Session worktrees (D64) in the notes folder, which the dev server's watcher ignores (Vite: `**/.redline/**`)
  // and init gitignores; branches `redline/<session>`.
  // Redline's MCP for the sessions it starts (D66): the dev server's own /mcp, as this machine reached it, with a
  // bearer only these sessions know and their id; REDLINE_AGENT_SESSION in their environment too.
  let origin = '';
  const bridge = createBridge({
    ...bridgeOpts, root, info: () => ({ commands, hotkey, key }), worktreeDir: path.join(path.resolve(root, dir), 'worktrees'), branchPrefix: 'redline/',
    sessionEnv: 'REDLINE_AGENT_SESSION',
    mcp: id => origin ? [{ name: 'redline', url: `${origin}${base}/mcp`, headers: { authorization: `Bearer ${MCP_TOKEN}`, 'x-redline-agent-session': id } }] : [],
  });
  const group = bridge.group;

  return {
    panel: `${base}/agent/panel.js`,
    mcp: {
      token: MCP_TOKEN,
      sessions: () => group.info().sessions,
      tail: (id, lines) => group.sessions.find(s => s.id === id)?.tail(lines) ?? null,
      attach: (id, a) => group.attach(id, a),
      focus: (id, note) => group.focusOn(id, note),
    },
    async handle(req, res, p, allowed) {
      const method = req.method ?? 'GET';
      // The dev server as this machine reaches it: the MCP URL handed to sessions (D66).
      if (allowed && typeof req.headers.host === 'string' && /^[\w.:[\]-]+$/.test(req.headers.host)) origin = `${(req.socket as { encrypted?: boolean }).encrypted ? 'https' : 'http'}://${req.headers.host}`;
      const asset = method === 'GET' && (p === '/agent/panel.js' ? 'panel.js' : p === '/agent/terminal.js' ? 'terminal.js' : null);
      if (asset || (method === 'GET' && p === '/agent/terminal')) {
        // Static, but for this machine only, like everything under /agent.
        if (!allowed) return json(res, 403, { error: 'the agent panel answers this machine only' });
        res.setHeader('cache-control', 'no-store');
        if (!asset) {
          res.setHeader('content-type', 'text/html; charset=utf-8');
          res.end(terminalPage(base));
          return;
        }
        const file = path.join(DIST, asset);
        if (!existsSync(file)) return json(res, 404, { error: 'agent panel not built' });
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.end(await readFile(file));
        return;
      }
      // The rest is the bridge's, its guards included: `allowed` can only narrow them.
      return bridge.handle(req, res, p.slice('/agent'.length), { allowed });
    },
  };
}
