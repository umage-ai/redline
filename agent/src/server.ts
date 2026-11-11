// The agent panel's server (D53, D63): Redline's layer over the agent bridge (agent-bridge/, bundled in).
// The bridge runs the sessions and answers the generic routes (/info, /send, /stream…, its guards
// built in); this file mounts it under `<base>/agent/`, adds the toolbar's own fields to /info (prompt
// buttons, keys) and serves the panel's browser files (panel.js, terminal.js) and the terminal page.

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

/** The terminal page the agent window frames: xterm.js in its own document, out of the app's and the overlay's key handling. */
const terminalPage = (base: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Agent</title>
<style>html,body{margin:0;height:100%;background:#131316;overflow:hidden}#t{position:absolute;inset:4px 2px 2px 8px}</style></head>
<body><div id="t"></div><script type="module" src="${base}/agent/terminal.js"></script></body></html>`;

/** The panel's routes for one project root, under the API base (`/__redline`). */
export function agentRoutes(opts: AgentOptions, root: string, base: string): AgentRoutes {
  const { commands: given, hotkey: hk, key: k, ...bridgeOpts } = opts;
  const commands = (given ?? DEFAULT_COMMANDS).filter(c => c && typeof c.label === 'string' && typeof c.prompt === 'string');
  const hotkey = hk === false ? false : typeof hk === 'string' && hk ? hk : 'alt+shift+a';
  const key = k === false ? false : typeof k === 'string' && k.length === 1 ? k.toLowerCase() : 'a';
  const bridge = createBridge({ ...bridgeOpts, root, info: () => ({ commands, hotkey, key }) });

  return {
    panel: `${base}/agent/panel.js`,
    async handle(req, res, p, allowed) {
      const method = req.method ?? 'GET';
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
