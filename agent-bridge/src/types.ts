// The bridge's public types (D63): how a CLI is driven (adapters), what a host configures (BridgeOptions)
// and what a viewer is shown (SessionInfo). No imports: hosts (Redline's agent-hook.ts) re-export these.

/** A model or effort level a CLI offers (D62): `value` as passed to the CLI, `name` for people (default: the value). */
export interface AgentChoice { value: string; name?: string }

/** What an adapter's `start` returns: the arguments, text to type ahead of the first prompt, and a warning to log once. */
export interface AgentStart { args: string[]; preamble?: string; warning?: string }

/**
 * How the bridge drives one agent CLI (D55). Built in: Claude Code (`claude`) and OpenCode (`opencode`);
 * any other command runs with the generic one (Allow/Deny, the terminal, 7501 status if it sends it).
 * Pass your own in `adapters` (tried first).
 */
export interface AgentAdapter {
  /** The id, normally the `app` the CLI names in its OSC 7501 reports: `claude-code`, `opencode`. */
  id: string;
  /** Shown in the toolbar and tooltips: `Claude Code`. */
  name: string;
  /** What to run when the option names no command (`agent: true` picks the first one installed). */
  command: string;
  /** This adapter drives `command` (its base name, without .exe/.cmd) with `args`, or the program that reported `app`. */
  matches(command: string, app?: string, args?: string[]): boolean;
  /** A start's arguments: the model, the effort and the instructions as flags, or the instructions as a preamble. */
  start?(o: { args: string[]; model?: string; effort?: string; instructions: { text: string; file?: string } }): AgentStart | Promise<AgentStart>;
  /**
   * The models the toolbar's settings offer for it (D62), passed to `start` as `model`: Claude Code's
   * aliases. A viewer can pick only these (or the default); ACP agents list their own.
   */
  models?: (string | AgentChoice)[];
  /** The effort levels the settings offer, passed to `start` as `effort` (Claude Code: `--effort`). */
  efforts?: (string | AgentChoice)[];
  /** Its menus are ones `screen.ts` reads into the toolbar's card (permission prompts, stepped questions). */
  menus?: boolean;
  /** What Allow and Deny send when its menus aren't read. Default Enter and Esc. */
  keys?: { allow: string; deny: string };
  /** It reports working, then idle, but never done: the bridge shows done once a turn ends. */
  doneOnIdle?: boolean;
  /** Quiet output (ms) after it reports idle before a prompt is typed: its input box isn't ready at once. */
  settleMs?: number;
  /**
   * The arguments that start its Agent Client Protocol mode (D58: JSON-RPC over stdio, structured
   * status and permission menus, no terminal): OpenCode `['acp']`. Set: ACP by default (`protocol`).
   */
  acp?: string[];
}

/** One CLI in the picker (D59): its command, arguments, name and extra environment. */
export interface AgentCli {
  command: string;
  args?: string[];
  /** The name in the picker, tabs and tooltips. Default: the adapter's (`Claude Code`), else the command and arguments. */
  label?: string;
  /** What a viewer and the `cli` field of a start or prompt call it. Default: the adapter's id (`claude-code`), else the command's base name. */
  id?: string;
  /** Extra environment, on top of `env`. */
  env?: Record<string, string>;
}

/** What the bridge runs and how (everything optional). Redline's `agent` option extends it with its toolbar's. */
export interface BridgeOptions {
  /**
   * The CLI to run, looked up on PATH (Windows: PATHEXT, so `claude` finds claude.exe or claude.cmd).
   * Default: every installed one of the adapters' commands (`claude`, `opencode`), picked per viewer
   * (D59), the first one by default; `claude` if none is. A command set here means just that one.
   */
  command?: string;
  /**
   * The CLIs a viewer can pick from (D59), those installed: an adapter's id or command (`'claude'`,
   * `'opencode'`, with `args`), any other command, or `{ command, args, label }`. The first is the default.
   * Wins over `command`.
   */
  clis?: (string | AgentCli)[];
  /** The model, passed the way the CLI takes it (Claude Code: `--model`). A CLI without a model flag logs a warning and uses its own config. The default for a viewer's settings (D62). */
  model?: string;
  /**
   * The effort level, where the CLI has one (Claude Code: `--effort low|medium|high|xhigh|max`; ACP: the
   * agent's `thought_level` option). The default for a viewer's settings (D62); other CLIs: a warning.
   */
  effort?: string;
  /** Your own adapters, tried before the built-in ones (D55). */
  adapters?: AgentAdapter[];
  args?: string[];
  /** Extra environment for the CLI. */
  env?: Record<string, string>;
  /** The name in window titles and tooltips. Default: the command's base name and arguments (`claude`, `node fake-agent.mjs`). */
  label?: string;
  /** Working directory. Default: the project root. */
  cwd?: string;
  /**
   * The keys Allow and Deny send while the program waits for approval (OSC 7501 blocked, permission).
   * Default Enter and Esc (Claude Code's prompt); false hides both buttons.
   */
  keys?: { allow?: string; deny?: string } | false;
  /**
   * Where a prompt goes. `'fresh'` (default): a new session for every prompt (no context from earlier
   * ones), several at once (`maxSessions`). `'shared'`: one session that keeps its context. Viewers can switch it.
   */
  sessions?: 'shared' | 'fresh';
  /** Sessions running at once with `sessions: 'fresh'` (1–8, default 3). A new one stops the oldest one that has finished; none finished: it says so. */
  maxSessions?: number;
  /**
   * Read the CLI's menus off its screen (every option, typed answers, steps). `'auto'` (default): when
   * the CLI is Claude Code (`app=claude-code` in its OSC 7501 reports, or the command `claude`), whose
   * menus are known. Other CLIs get Allow/Deny (`keys`) and the terminal. `true`: always.
   */
  menus?: 'auto' | boolean;
  /**
   * Extra instructions for the sessions the bridge starts, on top of the project's CLAUDE.md / AGENTS.md:
   * text, or `{ file }` (relative to the project root, read at every start). Claude Code gets them as
   * `--append-system-prompt-file`; any other CLI ahead of the session's first prompt.
   */
  instructions?: string | { file: string };
  /**
   * How the bridge talks to the CLI (D58). `'acp'`: the Agent Client Protocol over stdio (the adapter's
   * `acp` arguments first, then `args`). `'pty'`: the CLI in a pseudo-terminal. Default: `'acp'` for a
   * CLI whose adapter has an ACP mode (OpenCode), else `'pty'` (Claude Code).
   */
  protocol?: 'acp' | 'pty';
  /**
   * A git worktree per new session (D64): each runs on its own branch in its own folder, so parallel
   * sessions never edit the same files; when it ends, a viewer keeps, merges or discards the branch.
   * Default off; a viewer can switch it while the server runs. Not a git repo: off, with the reason.
   * A shared session ignores it. The worktree has no node_modules (install there to run the app or tests).
   */
  worktrees?: boolean;
}

/** A run of text with its colours, as read off the screen. */
export interface Span { t: string; fg?: string; bg?: string; b?: true; dim?: true }
export interface Line { text: string; spans?: Span[] }
export interface PromptOption { label: string; description?: string; selected: boolean; n?: number; input?: true }
export interface PromptStep { label: string; state: 'todo' | 'done' | 'submit'; current: boolean }
export interface PromptView {
  /** Context above the question (a diff, a command), with colours. */
  lines: Span[][];
  question?: string;
  options: PromptOption[];
  steps?: PromptStep[];
  hint?: string;
}

/** One OSC 7501 / ACP status, as a viewer shows it. */
export type SessionState = 'idle' | 'working' | 'done' | 'blocked' | 'error';

/** A session's git worktree (D64): its branch and folder, and how it compares with the branch it came from. */
export interface WorktreeInfo {
  branch: string;
  /** Relative to the project root, forward slashes. */
  path: string;
  /** The branch it was made from (a merge goes back into it). */
  base: string;
  /** Uncommitted changes in the worktree, and commits not on `base` (checked when the session ends). */
  dirty?: boolean;
  ahead?: number;
}

/** One file, link or image a session pointed at in a round (D56; attachments.ts). */
export interface Attachment {
  /** `<round>-<n>`, unique in the session. */
  id: string;
  /** The round (one prompt and its turn) it came in, from 1. */
  round: number;
  /** explicit (the agent said so: MCP `attach`, ACP content), changed (git, this round), link (OSC 8), mentioned (in the text). */
  source: 'explicit' | 'changed' | 'link' | 'mentioned';
  kind: 'file' | 'image' | 'url' | 'diff';
  /** A file: relative to the session's folder (its worktree, or the project root), forward slashes. */
  path?: string;
  url?: string;
  title?: string;
  /** A changed file: lines added and removed, git's status letter (A, M, D). */
  added?: number;
  removed?: number;
  status?: string;
}

/** What a viewer shows: the session's state and the program's status. */
export interface SessionInfo {
  /** `s1`, `s2`… in this server. */
  id: string;
  /** `#1`, `#2`…: its tab when there are several. */
  label: string;
  running: boolean;
  /** The program's name from its OSC 7501 reports (`claude-code`), once it reported one. */
  app?: string;
  command: string;
  /** The CLI it runs: its id in `clis` of /info (D59). */
  cli: string;
  /** Exit code of the last run, when it has ended. */
  exitCode?: number | null;
  status: {
    state: SessionState; kind?: 'permission' | 'question' | 'auth'; progress?: number; app?: string; title?: string; msg?: string; records: number;
    source: '7501' | 'activity' | 'acp' | 'none';
  };
  /** Ids a prompt named (the host's: Redline's notes), oldest first: a viewer tags them as handed over. */
  sent: string[];
  /** The menu on the agent's screen (a permission prompt, stepped questions), read off it; while running. */
  prompt?: PromptView;
  /** 'acp': an Agent Client Protocol session (D58), no terminal; absent: a pseudo-terminal. */
  protocol?: 'acp';
  /** The tab's name and the prompt that started it, from the viewer (D62). */
  title?: string;
  task?: string;
  /** The model and effort it was started with, when either was set (D62). */
  model?: string;
  effort?: string;
  /** Its git worktree (D64), when it runs in one. */
  worktree?: WorktreeInfo;
  /** Rounds so far and attachments worth counting in them (D56: all but mentions); the list is GET /attachments. */
  rounds?: number;
  attachments?: number;
}

/** A CLI in /info (D59, D62): what the settings offer for it. `pending`: an ACP agent not asked yet. */
export interface CliInfo { id: string; name: string; command: string; models: AgentChoice[]; efforts: AgentChoice[]; pending?: boolean }

/** All of a project's sessions. */
export interface GroupInfo {
  mode: 'shared' | 'fresh';
  /** Sessions running at once in 'fresh' mode. */
  max: number;
  /**
   * Worktrees (D64): `on` for new sessions (fresh ones only); `git: false` when the project isn't a git
   * repo (why); `left`: worktrees of sessions that have ended, waiting for keep, merge or discard.
   */
  worktrees: { on: boolean; git: boolean; why?: string; left: (WorktreeInfo & { session?: string; title?: string })[] };
  /** Oldest first. */
  sessions: SessionInfo[];
}
