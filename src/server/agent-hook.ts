// The core's side of the agent panel (D53): the `agent` option's types, and finding the panel itself,
// which ships on its own as @umage.ai/redline-agent (opt in, like the hub). The core never bundles
// it: `agent: true | 'codex' | {…}` loads the package from the project; `agent: agent({…})` (imported
// from the package) hands it over directly. Missing package: a warning with the install command,
// and the dev server runs on without the panel.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const AGENT_PACKAGE = '@umage.ai/redline-agent';

import type { AgentAdapter, AgentChoice, AgentCli, AgentStart, BridgeOptions, SessionInfo } from '../../agent-bridge/src/types.ts';
// The generic types live in the agent bridge (D63); re-exported here, where consumers already import them.
export type { AgentAdapter, AgentChoice, AgentCli, AgentStart, BridgeOptions, SessionInfo };

/** A button in the agent toolbar that sends a prompt; `{page}`, `{url}` and `{ids}` (the open notes on the page) are filled in. A prompt with `{ids}` shows their count and tags those notes "sent". */
export interface AgentCommand { label: string; prompt: string; title?: string }

/**
 * The `agent` option: the bridge's options (which CLIs, model, effort, sessions, instructions,
 * protocol: see `BridgeOptions`) and the agent toolbar's own.
 */
export interface AgentOptions extends BridgeOptions {
  /** The agent toolbar's prompt buttons. Default: one "Apply notes" button for the open notes on the page. */
  commands?: AgentCommand[];
  /** The shortcut that opens the overlay straight in the agent toolbar. Default alt+shift+a; false for none. */
  hotkey?: string | false;
  /**
   * The Agent button's key in Redline's toolbar (a single letter, while the overlay is open). Default 'a'; false
   * for none, when an extension of yours already uses A: the button and `hotkey` still open the agent toolbar.
   */
  key?: string | false;
}

/** The panel's routes in one dev server. */
export interface AgentRoutes {
  /** Answers `/agent/*` (the path after the API base). `allowed`: the caller is on this machine. */
  handle(req: IncomingMessage, res: ServerResponse, p: string, allowed: boolean): Promise<void>;
  /** The overlay extension's URL, listed in `/config` for local callers. */
  panel: string;
}

/** What `agent(opts)` from @umage.ai/redline-agent returns. */
export interface AgentPlugin {
  /** Set up for a project root, the API base (`/__redline`) and the notes folder (`.redline`: session worktrees go in its `worktrees/`, D64). */
  routes(ctx: { root: string; base: string; dir?: string }): AgentRoutes;
}

type AgentModule = { agent(opts?: AgentOptions): AgentPlugin };
const isPlugin = (v: unknown): v is AgentPlugin => !!v && typeof (v as AgentPlugin).routes === 'function';

/** The package, from the project (where the developer installs it) or next to Redline; null when neither has it. */
function loadModule(root: string): AgentModule | null {
  for (const from of [path.join(root, 'package.json'), import.meta.url]) {
    try {
      const m = createRequire(from)(AGENT_PACKAGE) as AgentModule;
      if (typeof m?.agent === 'function') return m;
    } catch { /* next */ }
  }
  return null;
}

let warned = false;
/** The panel's routes for the `agent` option, or null (off, or the package isn't installed: warned once). */
export function agentFor(option: boolean | string | AgentOptions | AgentPlugin | undefined, root: string, base: string, load = loadModule, dir = '.redline'): AgentRoutes | null {
  if (!option) return null;
  if (isPlugin(option)) return option.routes({ root, base, dir });
  const opts: AgentOptions = option === true ? {} : typeof option === 'string' ? { command: option } : option;
  const mod = load(root);
  if (!mod) {
    if (!warned) console.warn(`[redline] the agent option needs ${AGENT_PACKAGE}: npm i -D ${AGENT_PACKAGE}`);
    warned = true;
    return null;
  }
  return mod.agent(opts).routes({ root, base, dir });
}
