// The core's side of the agent panel (D53): the `agent` option's types, and finding the panel itself,
// which ships on its own as @umage.ai/redline-agent (opt in, like the hub). The core never bundles
// it: `agent: true | 'codex' | {…}` loads the package from the project; `agent: agent({…})` (imported
// from the package) hands it over directly. Missing package: a warning with the install command,
// and the dev server runs on without the panel.

import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const AGENT_PACKAGE = '@umage.ai/redline-agent';

/** A button in the agent toolbar that sends a prompt; `{page}`, `{url}` and `{ids}` (the open notes on the page) are filled in. A prompt with `{ids}` shows their count and tags those notes "sent". */
export interface AgentCommand { label: string; prompt: string; title?: string }

export interface AgentOptions {
  /** The CLI to run, looked up on PATH (Windows: PATHEXT, so `claude` finds claude.exe or claude.cmd). Default `claude`. */
  command?: string;
  args?: string[];
  /** Extra environment for the CLI. */
  env?: Record<string, string>;
  /** The name in the window title and tooltips. Default: the command's base name and arguments (`claude`, `node fake-agent.mjs`). */
  label?: string;
  /** Working directory. Default: the project root. */
  cwd?: string;
  /** The agent toolbar's prompt buttons. Default: one "Apply notes" button for the open notes on the page. */
  commands?: AgentCommand[];
  /**
   * The keys the agent toolbar's Allow and Deny send while the program waits for approval (OSC 7501
   * blocked, permission). Default Enter and Esc (Claude Code's prompt); false hides both buttons.
   */
  keys?: { allow?: string; deny?: string } | false;
  /** The shortcut that opens the overlay straight in the agent toolbar. Default alt+shift+a; false for none. */
  hotkey?: string | false;
  /**
   * The Agent button's key in Redline's toolbar (a single letter, while the overlay is open). Default 'a'; false
   * for none, when an extension of yours already uses A: the button and `hotkey` still open the agent toolbar.
   */
  key?: string | false;
  /**
   * Where a prompt button's prompt goes. `'shared'` (default): one session that keeps its context.
   * `'fresh'`: a new session for every prompt, with just those notes (no context from earlier ones),
   * several at once (`maxSessions`). The toolbar can switch it while the dev server runs.
   */
  sessions?: 'shared' | 'fresh';
  /** Sessions running at once with `sessions: 'fresh'` (1–8, default 3). A new one stops the oldest one that has finished; none finished: it says so. */
  maxSessions?: number;
  /**
   * Read the CLI's menus off its screen into the toolbar's card (every option, typed answers, steps).
   * `'auto'` (default): when the CLI is Claude Code (`app=claude-code` in its OSC 7501 reports, or the
   * command `claude`), whose menus are known. Other CLIs get Allow/Deny (`keys`) and the terminal. `true`: always.
   */
  menus?: 'auto' | boolean;
  /**
   * Extra instructions for the sessions started from Redline, on top of the project's CLAUDE.md /
   * AGENTS.md: text, or `{ file }` (relative to the project root, read at every start). Claude Code
   * gets them as `--append-system-prompt-file`; any other CLI ahead of the session's first prompt.
   */
  instructions?: string | { file: string };
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
  /** Set up for a project root and the API base (`/__redline`). */
  routes(ctx: { root: string; base: string }): AgentRoutes;
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
export function agentFor(option: boolean | string | AgentOptions | AgentPlugin | undefined, root: string, base: string, load = loadModule): AgentRoutes | null {
  if (!option) return null;
  if (isPlugin(option)) return option.routes({ root, base });
  const opts: AgentOptions = option === true ? {} : typeof option === 'string' ? { command: option } : option;
  const mod = load(root);
  if (!mod) {
    if (!warned) console.warn(`[redline] the agent option needs ${AGENT_PACKAGE}: npm i -D ${AGENT_PACKAGE}`);
    warned = true;
    return null;
  }
  return mod.agent(opts).routes({ root, base });
}
