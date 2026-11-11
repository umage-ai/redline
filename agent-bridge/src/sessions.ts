// Sessions (D53, D58, D63): the agent CLI in a pseudo-terminal (`AgentSession`) or over ACP (acp.ts), and
// a project's sessions (`AgentGroup`): one shared session or a new one per prompt, started on request
// and kept across a host's handler re-creation (a dev server's config restart); they end with the
// process. Status comes from OSC 7501 (program-status.ts), with output activity as the fallback for
// CLIs that don't report. node-pty (optional) is loaded on first start.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import { DA1_REPLY, OscScanner, PROBE_REPLY, ProgramRecords, type ProgramState } from './program-status.ts';
import { Screen, type PromptView } from './screen.ts';
import { adapterFor, choices, claudeCode, commandName, type CliChoice } from './adapters.ts';
import { AcpSession, firstLine, meta, nameSession, probeAcp, usesAcp, type AcpOffer } from './acp.ts';
import type { AgentAdapter, BridgeOptions, CliInfo, GroupInfo, SessionInfo } from './types.ts';
import { Rounds } from './attachments.ts';
import { act, addWorktree, gitTop, leftover, status, type Worktree, type WorktreeAction } from './worktrees.ts';
export { commandName };

// This file's folder: dist/ in a bundle (CommonJS), src/ when run from source (tests).
const HERE = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));

/** Kept for the panel's types: a session as /info and the feed list it. */
export type AgentInfo = SessionInfo;
export type AgentCliInfo = CliInfo;
export type AgentGroupInfo = GroupInfo;

export const DEFAULT_KEYS = { allow: '\r', deny: '\x1b' };
const MAX_SENT = 500;
const KEEP_ENDED = 4;   // ended sessions kept listed (their terminal and status), the oldest dropped first

/** Claude Code: the command's base name (either slash, on any OS). Its menus are the ones `screen.ts` reads (D53). */
export const isClaude = (command: string) => claudeCode.matches(command);

interface Pty {
  pid: number;
  onData(fn: (d: string) => void): { dispose(): void } | void;
  onExit(fn: (e: { exitCode: number; signal?: number }) => void): { dispose(): void } | void;
  write(d: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}
type PtyModule = { spawn(file: string, args: string[], opts: Record<string, unknown>): Pty };

const MAX_SCROLLBACK = 512 * 1024;
const ACTIVE_MS = 1500;

/**
 * node-pty, or the prebuilt `@lydell/node-pty` (Linux without build tools), from the project (where
 * the developer installs it) or next to this bundle; null when neither is there. `require` (both are
 * CommonJS), not `import(name)`: bundlers parsing a config's dependencies (Next) warn on that.
 */
function loadPty(root: string): PtyModule | null {
  for (const from of [path.join(root, 'package.json'), path.join(HERE, 'index.cjs')]) {
    const req = createRequire(from);
    for (const name of ['node-pty', '@lydell/node-pty']) {
      try {
        const m = req(name) as PtyModule;
        if (process.platform === 'darwin') ensureSpawnHelper(path.dirname(req.resolve(`${name}/package.json`)));
        return m;
      } catch { /* next */ }
    }
  }
  return null;
}

/**
 * macOS: node-pty starts programs through its `spawn-helper`, and some installs drop the helper's
 * executable bit (every spawn then fails with "posix_spawnp failed"). Put it back, best effort.
 */
function ensureSpawnHelper(pkgDir: string) {
  for (const f of [path.join(pkgDir, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'), path.join(pkgDir, 'build', 'Release', 'spawn-helper')]) {
    try { if (existsSync(f) && !(statSync(f).mode & 0o111)) chmodSync(f, 0o755); } catch { /* read-only install: spawn will say so */ }
  }
}

/**
 * The file and arguments to spawn. Windows' CreateProcess needs the full name: look `command` up
 * on PATH with PATHEXT, and run .cmd/.bat shims (npm's global installs) through cmd.exe.
 * Elsewhere node-pty's execvp searches PATH itself.
 */
export function resolveCommand(command: string, args: string[], env: NodeJS.ProcessEnv, platform = process.platform): { file: string; args: string[] } | null {
  if (platform !== 'win32') return { file: command, args };
  const isFile = (f: string) => { try { return statSync(f).isFile(); } catch { return false; } };
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase());
  const has = path.extname(command) !== '';
  const dirs = path.isAbsolute(command) || command.includes('\\') || command.includes('/') ? [''] : [process.cwd(), ...(env.PATH ?? env.Path ?? '').split(';').filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of has ? [''] : exts) {
      const f = dir ? path.join(dir, command + ext) : command + ext;
      if (!isFile(f)) continue;
      const e = path.extname(f).toLowerCase();
      if (e === '.cmd' || e === '.bat') return { file: env.ComSpec ?? 'cmd.exe', args: ['/d', '/c', f, ...args] };
      return { file: f, args };
    }
  }
  return null;
}

/**
 * A start's arguments from the CLI's adapter (D55): the `instructions`, `model` and `effort` options as flags
 * where the CLI has them (Claude Code: `--append-system-prompt-file`, `--model`, `--effort`), else the
 * instructions typed ahead of the session's first prompt (`preamble`) and a warning for the model and effort.
 */
export async function withInstructions(command: string, args: string[], extra: { text: string; file?: string }, model?: string, adapters?: AgentAdapter[], effort?: string): Promise<{ args: string[]; preamble: string; warning?: string }> {
  const a = adapterFor(command, undefined, adapters, args);
  const r = a.start ? await a.start({ args, model, ...(effort ? { effort } : {}), instructions: extra }) : { args, preamble: extra.text };
  return { args: r.args, preamble: r.preamble ?? '', ...(r.warning ? { warning: r.warning } : {}) };
}
const WARNED = new Set<string>();

export class AgentSession {
  private pty: Pty | null = null;
  private starting: Promise<void> | null = null;
  private scrollback = '';
  private viewers = new Set<ServerResponse>();
  private scanner = new OscScanner();
  private records = new ProgramRecords();
  private reported = false;   // the program has sent a valid 7501 report: activity no longer counts
  private lastOutput = 0;
  private lastStatus = '';
  private bracketedPaste = false;
  private screen: Screen | null = null;   // a headless copy of the screen, to read menus off (screen.ts)
  private view: PromptView | null = null;
  private screenDirty = false;
  private choosing = false;
  private exitCode: number | null | undefined;
  private cols = 100;
  private rows = 30;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private queued: string[] = [];   // prompts sent before the program was ready for input
  private sent = new Set<string>();
  private app: string | undefined;   // from the program's 7501 reports
  private preamble = '';   // instructions still to go ahead of the first prompt (a CLI without a flag for them)
  private worked = false;   // working was reported since the last prompt (doneOnIdle adapters: idle after it is done)
  /** The tab's name and the prompt that started it (D62), set by the first prompt that names them. */
  title?: string;
  task?: string;

  readonly opts: BridgeOptions;
  /** Where the CLI runs: the project's cwd, or the same folder in its worktree (D64). */
  cwd: string;
  readonly root: string;
  readonly id: string;
  readonly label: string;
  /** Set up before the CLI first starts (D64: its worktree, which also moves `cwd`). */
  prepare?: () => Promise<void>;
  /** Its git worktree (D64), once prepared. */
  worktree?: Worktree;
  /** Its rounds and what it pointed at in each (D56). */
  readonly rounds: Rounds;
  /** The label of the next round (the prompt's `task`). */
  private nextTask?: string;
  private roundWorked = false;   // the round's turn has been seen working: resting again ends it
  private roundLive = false;   // its prompt has been typed: only then does working count (not a CLI still starting up)
  /** The CLI's id (D59); `opts` has its command, arguments and environment. */
  readonly cli: string;
  private onChange: () => void;
  constructor(opts: BridgeOptions, cwd: string, root: string, n: number, onChange: () => void, cli = '') {
    this.opts = opts; this.cwd = cwd; this.root = root; this.id = `s${n}`; this.label = `#${n}`; this.onChange = onChange; this.cli = cli;
    this.rounds = new Rounds(root, cwd, () => this.pushStatus());
  }

  get running() { return !!this.pty || !!this.starting; }
  /** Running, and finished with its turn: nothing queued, not working or asking. */
  get resting() {
    if (!this.pty || this.queued.length) return false;
    const s = this.info().status.state;
    return s === 'idle' || s === 'done' || s === 'error';
  }
  /** The CLI's adapter (D55): by command, or by the `app` its 7501 reports name. */
  get adapter() { return adapterFor(this.opts.command ?? 'claude', this.app, this.opts.adapters, this.opts.args); }
  /** Menus are read off the screen for CLIs whose menus `screen.ts` knows (Claude Code), or when asked to (`menus`). */
  private get menus() {
    const m = this.opts.menus ?? 'auto';
    return m === true || (m === 'auto' && !!this.adapter.menus);
  }

  /** The `instructions` option's text ('' for none); a file is read at every start, so edits apply to the next session. */
  private async instructions(): Promise<{ text: string; file?: string }> {
    const o = this.opts.instructions;
    if (!o) return { text: '' };
    if (typeof o === 'string') return { text: o.trim() };
    const file = path.resolve(this.root, o.file);
    try { return { text: (await readFile(file, 'utf8')).trim(), file }; }
    catch { console.warn(`[agent-bridge] instructions: can't read ${file}`); return { text: '' }; }
  }

  /** What the panel calls it: paths shortened to their base names, Windows extensions dropped. */
  get command() { return commandName(this.opts); }

  info(): AgentInfo {
    let s = this.records.status();
    // A CLI that never reports done (OpenCode): idle after a turn it worked on is done.
    if (this.reported && this.worked && s.state === 'idle' && this.adapter.doneOnIdle) s = { ...s, state: 'done' };
    const source = this.reported ? '7501' : this.pty ? 'activity' : 'none';
    const status = source === 'activity' ? { ...s, state: (Date.now() - this.lastOutput < ACTIVE_MS ? 'working' : 'idle') as ProgramState } : s;
    return {
      id: this.id, label: this.label, running: !!this.pty, ...(this.app ? { app: this.app } : {}), command: this.command, cli: this.cli, exitCode: this.exitCode,
      status: { ...status, source }, sent: [...this.sent], ...(this.pty && this.view ? { prompt: this.view } : {}), ...meta(this),
    };
  }

  async start(cols?: number, rows?: number) {
    if (this.pty) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (cols && rows) { this.cols = clampSize(cols, 20, 400); this.rows = clampSize(rows, 5, 200); }
      await this.prepare?.();
      const pty = loadPty(this.root);
      if (!pty) throw new Error('the agent bridge needs node-pty: npm i -D node-pty (Linux without build tools: @lydell/node-pty)');
      const env = { ...process.env, ...this.opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv;
      const command = this.opts.command ?? 'claude';
      const { args, preamble, warning } = await withInstructions(command, this.opts.args ?? [], await this.instructions(), this.opts.model, this.opts.adapters, this.opts.effort);
      if (warning && !WARNED.has(warning)) { WARNED.add(warning); console.warn(`[agent-bridge]: ${warning}`); }
      this.preamble = preamble;
      const spawn = resolveCommand(command, args, env);
      if (!spawn) throw new Error(`"${command}" was not found on PATH`);
      // Windows: the ConPTY shipped with node-pty. The one in Windows drops OSC sequences written
      // to the program's input, so Claude Code would never see the 7501 answer (L53).
      const p = pty.spawn(spawn.file, spawn.args, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env, useConptyDll: true });
      this.pty = p;
      this.startedAt = Date.now();
      this.exitCode = undefined;
      this.reported = false;
      this.records.clear();
      this.worked = false;
      this.scrollback = '';
      this.screen?.dispose();
      this.screen = new Screen(this.cols, this.rows);
      this.view = null;
      this.bracketedPaste = false;
      p.onData(d => this.output(p, d));
      p.onExit(e => {
        if (this.pty !== p) return;   // also the second exit event that release()'s kill() fires on Windows
        const exitCode = typeof e?.exitCode === 'number' ? e.exitCode : null;   // Windows sometimes has none (L54)
        this.pty = null;
        this.exitCode = exitCode;
        this.records.dropTransient();
        void this.rounds.finish();
        this.broadcast('exit', { exitCode });
        this.pushStatus();
        release(p);
      });
      this.timer ??= setInterval(() => { this.readScreen(); this.flush(); this.pushStatus(); }, 250);
      this.broadcast('start', this.info());
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  private output(p: Pty, d: string) {
    // Answered here, in order, before anything reaches a viewer (D53, L53).
    for (const ev of this.scanner.feed(d)) {
      if (ev.type === 'probe') p.write(PROBE_REPLY);
      else if (ev.type === 'da1') p.write(DA1_REPLY);
      else {
        this.reported = true; this.records.apply(ev.report);
        if (ev.report.app) this.app = ev.report.app;
        if (this.records.status().state === 'working') this.worked = true;
      }
    }
    const on = d.lastIndexOf('\x1b[?2004h'), off = d.lastIndexOf('\x1b[?2004l');
    if (on > off) this.bracketedPaste = true; else if (off > on) this.bracketedPaste = false;
    this.lastOutput = Date.now();
    this.rounds.feed(d);
    this.scrollback += d;
    this.screen?.write(d);
    this.screenDirty = true;
    if (this.scrollback.length > MAX_SCROLLBACK) {
      // Cut at a line start, so the replay doesn't begin inside an escape sequence (mostly).
      const cut = this.scrollback.indexOf('\n', this.scrollback.length - MAX_SCROLLBACK);
      this.scrollback = this.scrollback.slice(cut < 0 ? this.scrollback.length - MAX_SCROLLBACK : cut + 1);
    }
    this.broadcast('data', d);
    this.pushStatus();
  }

  write(data: string) { this.pty?.write(data); }

  /**
   * A prompt from a panel button. Not running: started, and the prompt waits until the program is
   * ready for input (it reported idle/done, or its output has been quiet for a moment, up to 30 s).
   */
  async send(text: string, notes: string[] = [], about: { title?: unknown; task?: unknown } = {}) {
    const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');   // no escape sequences, no control keys
    if (!clean.trim()) return;
    this.remember(notes);
    nameSession(this, about);
    if (typeof about.task === 'string' && about.task.trim()) this.nextTask = about.task.trim().slice(0, 80);
    if (!this.pty || !this.ready()) { this.queued.push(clean); await this.start(); this.flush(); return; }
    this.type(clean);
  }

  /** Ready for a prompt: the program reported a resting state, or has been quiet since its first output. */
  private ready() {
    if (!this.pty) return false;
    const now = Date.now();
    if (now - this.startedAt > 30_000) return true;
    if (this.reported) {
      const s = this.records.status().state;
      // Some CLIs report idle before their input takes keys (OpenCode): wait for quiet output too.
      return (s === 'idle' || s === 'done' || s === 'error') && now - this.lastOutput >= (this.adapter.settleMs ?? 0);
    }
    return this.lastOutput > this.startedAt && now - this.lastOutput > 1200;
  }

  private flush() {
    if (!this.queued.length || !this.ready()) return;
    this.type(this.queued.splice(0).join('\n\n'));
  }

  /** Pasted (when the program asked for bracketed paste), then Enter. */
  private type(text: string) {
    const p = this.pty;
    if (!p) return;
    // The instructions, for a CLI without a flag for them: ahead of the session's first prompt.
    const clean = this.preamble ? `${this.preamble.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')}\n\n${text}` : text;
    this.preamble = '';
    this.worked = false;
    // A new round (D56): the working tree's snapshot first, so what the turn changes can be told apart.
    const task = this.nextTask ?? firstLine(text);
    this.nextTask = undefined;
    this.rounds.base = this.worktree?.home ?? this.root; this.rounds.cwd = this.cwd;
    this.roundWorked = false; this.roundLive = false;
    void this.rounds.begin(task).catch(() => {}).then(() => {
      if (this.pty !== p) return;
      this.roundLive = true;
      p.write(this.bracketedPaste ? `\x1b[200~${clean}\x1b[201~` : clean);
      // A separate Enter, a moment later: TUIs treat text + CR in one read as a paste with a newline.
      setTimeout(() => { if (this.pty === p) p.write('\r'); }, 80);
    });
  }

  /** The notes a prompt named: the panel tags them "sent to the agent" until they are done. */
  private remember(notes: string[]) {
    let changed = false;
    for (const id of notes) {
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) continue;
      this.sent.delete(id); this.sent.add(id); changed = true;
    }
    for (const id of this.sent) { if (this.sent.size <= MAX_SENT) break; this.sent.delete(id); }
    if (changed) this.pushStatus();
  }

  /** Allow or Deny from the agent toolbar: the configured key, only while it waits for approval. */
  answer(key: string, _choice?: string): boolean {
    if (!this.pty || this.info().status.state !== 'blocked') return false;
    this.pty.write(key);
    return true;
  }

  /** The menu on screen now (a tick after output: the headless terminal parses asynchronously). */
  private readScreen() {
    // Not mid-parse: a read then would keep a menu the program already closed, until its next output (L56).
    if (!this.screenDirty || !this.screen || this.screen.busy) return;
    this.screenDirty = false;
    this.view = this.menus ? this.screen.prompt() : null;   // another CLI: Allow/Deny and the terminal
  }

  /**
   * Picks option `index` of the menu on screen, the way a person would: arrow keys to it (one at a
   * time, checking the ❯ arrived), then Enter. `text` for an input option ("Type something"): typed
   * into it before Enter. False when there is no such menu, or a choice is already on its way.
   */
  async choose(index: number, text?: string): Promise<boolean> {
    const p = this.pty, screen = this.screen;
    if (!p || !screen || this.choosing || !this.menus) return false;
    this.choosing = true;
    try {
      await screen.settled();   // the screen as the program last drew it
      const view = screen.prompt();
      if (!view?.options[index]) return false;
      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
      const at = async () => { await screen.settled(); return screen.prompt()?.options.findIndex(o => o.selected) ?? -1; };
      let cur = view.options.findIndex(o => o.selected);
      for (let tries = 0; cur !== index && tries < 3 * view.options.length; tries++) {
        p.write(cur < index ? '\x1b[B' : '\x1b[A');
        const was = cur;
        for (let w = 0; w < 20 && (await at()) === was; w++) await sleep(25);
        cur = await at();
        if (cur < 0) return false;   // the menu went away meanwhile
      }
      if (cur !== index) return false;
      if (text) { p.write(text.replace(/[\x00-\x1f\x7f]/g, ' ')); await sleep(80); }
      p.write('\r');
      this.screenDirty = true;
      return true;
    } finally { this.choosing = false; }
  }

  resize(cols: number, rows: number) {
    this.cols = clampSize(cols, 20, 400); this.rows = clampSize(rows, 5, 200);
    try { this.pty?.resize(this.cols, this.rows); } catch { /* exited meanwhile */ }
    this.screen?.resize(this.cols, this.rows);
    this.screenDirty = true;
  }

  stop() {
    const p = this.pty;
    if (!p || KILLED.has(p)) return;
    KILLED.add(p);
    try { p.kill(); } catch { /* gone */ }
  }

  acknowledge() {
    this.records.acknowledge();
    if (this.adapter.doneOnIdle && this.records.status().state === 'idle') this.worked = false;   // a seen done is idle again
    this.pushStatus();
  }

  /** A terminal viewer: output and status. */
  attach(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.viewers.add(res);
    send(res, 'hello', { ...this.info(), scrollback: this.scrollback });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    res.on('close', () => { clearInterval(beat); this.viewers.delete(res); });
  }

  private broadcast(event: string, data: unknown) {
    for (const r of this.viewers) send(r, event, data);
  }

  private pushStatus() {
    const info = this.info();
    // A round (D56) ends when the turn rests again after working; a turn typed in the CLI window starts one.
    const st = info.status.state, r = this.rounds.current;
    if (r && !r.done) {
      if (!this.roundLive) { /* the prompt isn't typed yet */ }
      else if (st === 'working' || st === 'blocked') this.roundWorked = true;
      else if (this.roundWorked && !this.queued.length) { this.roundWorked = false; void this.rounds.finish(); }
    } else if (st === 'working' && this.pty && this.reported) { this.roundWorked = true; this.roundLive = true; void this.rounds.begin('typed in the CLI window'); }
    const key = JSON.stringify(info);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.broadcast('status', info);
    this.onChange();
    if (!this.pty && this.timer) { clearInterval(this.timer); this.timer = null; this.queued = []; }
  }

  dispose() { this.stop(); for (const r of this.viewers) r.end(); this.viewers.clear(); }
}

/**
 * Windows: after the program exits, node-pty keeps its output socket and the conout worker thread
 * (it only disposes the worker on data that never comes), which holds the Node process open (L54).
 * kill() closes the socket (once: a second one aborts Node); the worker is unref'd, best effort, through node-pty's internals.
 */
const KILLED = new WeakSet<Pty>();
function release(p: Pty) {
  if (process.platform !== 'win32') return;
  // Never a second kill() after stop(): node-pty then aborts the whole process (native assertion, L54).
  if (!KILLED.has(p)) { KILLED.add(p); try { p.kill(); } catch { /* already closed */ } }
  try { (p as unknown as { _agent?: { _conoutSocketWorker?: { _worker?: { unref?(): void } } } })._agent?._conoutSocketWorker?._worker?.unref?.(); } catch { /* internals changed */ }
}

/** A viewer's model and effort for a new session (D62), already checked against the CLI's offer. */
export type Picked = { model?: string; effort?: string };

/**
 * The model and effort a prompt or start asks for (D62), checked against what the settings offered
 * for that CLI: never free text into the CLI's arguments. Absent or empty: the options' default.
 */
export function checkPick(body: Record<string, unknown>, offer: AcpOffer, cli: string): Picked | { error: string } {
  const out: Picked = {};
  for (const [key, list] of [['model', offer.models], ['effort', offer.efforts]] as const) {
    const v = body[key];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string' || !list.some(c => c.value === v)) return { error: `${cli} offers no ${key} ${JSON.stringify(String(v).slice(0, 80))}` };
    out[key] = v;
  }
  return out;
}

const clampSize = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A project's sessions (D53): one that keeps its context ('shared'), or a new one for every prompt
 * ('fresh'), several at once. One token for all of them; the toolbar watches them through one feed.
 */
export class AgentGroup {
  readonly token = randomBytes(18).toString('base64url');
  readonly sessions: (AgentSession | AcpSession)[] = [];
  mode: 'shared' | 'fresh';
  private n = 0;
  private watchers = new Set<ServerResponse>();
  private last = '';
  readonly opts: BridgeOptions;
  readonly cwd: string;
  readonly root: string;
  /** The CLIs a session can run (D59), the default first. */
  readonly clis: CliChoice[];
  /** Worktrees (D64): on for new fresh sessions; where they go and their branches' prefix; the repo, or why there is none. */
  private wt: { on: boolean; dir: string; prefix: string; git: { top: string } | { why: string } | null };
  /** Worktrees of ended sessions, waiting for keep, merge or discard (D64). */
  private left: (Worktree & { session?: string; title?: string })[] = [];
  constructor(opts: BridgeOptions, cwd: string, root: string, clis: CliChoice[], wt: { dir?: string; prefix?: string } = {}) {
    this.opts = opts; this.cwd = cwd; this.root = root; this.clis = clis;
    this.mode = opts.sessions === 'shared' ? 'shared' : 'fresh';
    this.wt = { on: !!opts.worktrees, dir: wt.dir ?? path.join(root, '.agent-worktrees'), prefix: wt.prefix ?? 'agent/', git: null };
    void gitTop(root).then(async g => {
      this.wt.git = g;
      // Worktrees an earlier run left (its process ended before anyone decided): listed again.
      if ('top' in g) for (const w of await leftover({ root, dir: this.wt.dir, prefix: this.wt.prefix })) if (!this.left.some(x => x.dir === w.dir)) this.left.push(w);
      for (const w of this.left) await this.refresh(w);
      this.push();
    });
  }
  get max() { return clampSize(this.opts.maxSessions ?? 3, 1, 8); }

  /** A session by id; no id: the newest. */
  get(id?: unknown): AgentSession | AcpSession | undefined {
    return typeof id === 'string' && id ? this.sessions.find(s => s.id === id) : this.sessions[this.sessions.length - 1];
  }

  /**
   * A new session of a CLI (default: the first), over ACP when its options say so (D58), with the
   * viewer's model and effort (D62; checked against `offer` by the route) over the options'; ended
   * ones past KEEP_ENDED are dropped, oldest first.
   */
  create(cli: CliChoice = this.clis[0], pick: Picked = {}): AgentSession | AcpSession {
    const ended = this.sessions.filter(s => !s.running);
    for (const s of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED + 1))) this.drop(s);
    if (!this.sessions.length) this.n = 0;   // all closed: numbering starts over at #1
    const opts: BridgeOptions = { ...this.opts, command: cli.command, args: cli.args, label: cli.label, env: { ...this.opts.env, ...cli.env }, ...pick };
    const s = new (usesAcp(opts) ? AcpSession : AgentSession)(opts, this.cwd, this.root, ++this.n, () => this.push(), cli.id);
    if (s instanceof AcpSession) s.onOffer = o => this.offered(cli, o);   // a real session/new: the freshest list
    // Its own worktree (D64), made when the CLI first starts (by then the first prompt has named the session).
    if (this.mode === 'fresh' && this.wt.on && this.wt.git && 'top' in this.wt.git) {
      s.prepare = async () => {
        if (s.worktree) return;
        const w = await addWorktree({ root: this.root, cwd: this.cwd, dir: this.wt.dir, prefix: this.wt.prefix, name: s.title || s.id });
        s.worktree = w; s.cwd = w.cwd;
      };
    }
    this.sessions.push(s);
    this.push();
    return s;
  }

  /**
   * The session for a prompt or a start: 'shared' reuses `id` (or the newest), 'fresh' makes room and
   * starts a new one. `cli` (D59): 'fresh' starts that CLI; 'shared' switching to another CLI stops the
   * shared session (refused while it works or asks) and starts the new one, so one session still runs.
   */
  forPrompt(id?: unknown, cli?: CliChoice, pick: Picked = {}): AgentSession | AcpSession {
    if (this.mode === 'shared') {
      const s = this.get(id);
      if (s && (!cli || s.cli === cli.id)) return s;   // its model and effort as started: the settings apply to new sessions
      if (s?.running) {
        if (!s.resting) throw Object.assign(new Error(`${s.command} is busy: wait until it is done, or end it, to switch to ${cli!.name}`), { status: 409 });
        s.stop();
      }
      return this.create(cli, pick);
    }
    const running = this.sessions.filter(s => s.running);
    if (running.length >= this.max) {
      const done = running.find(s => s.resting);
      if (!done) throw Object.assign(new Error(`${running.length} sessions are busy: stop one, or wait until one is done`), { status: 409 });
      done.stop();
    }
    return this.create(cli, pick);
  }

  /** The CLI a prompt or start goes to: the one named, else the shared session's, else the default. */
  target(id: unknown, cli?: CliChoice): CliChoice {
    const s = this.mode === 'shared' || (typeof id === 'string' && id) ? this.get(id) : undefined;
    return cli ?? this.clis.find(c => c.id === s?.cli) ?? this.clis[0];
  }

  // What the settings offer per CLI (D62): an adapter's own lists, or what an ACP agent says in
  // session/new (asked once in the background, `probeAcp`; a real session's reply updates it).
  private offers = new Map<string, AcpOffer & { pending?: boolean }>();
  offer(cli: CliChoice): AcpOffer & { pending?: boolean } {
    const known = this.offers.get(cli.id);
    if (known) return known;
    const opts: BridgeOptions = { ...this.opts, command: cli.command, args: cli.args, env: { ...this.opts.env, ...cli.env } };
    if (!usesAcp(opts)) {
      const a = adapterFor(cli.command, undefined, this.opts.adapters, cli.args);
      const o = { models: choices(a.models), efforts: choices(a.efforts) };
      this.offers.set(cli.id, o);
      return o;
    }
    const pending = { models: [], efforts: [], pending: true };
    this.offers.set(cli.id, pending);
    void probeAcp(opts, this.cwd).then(o => { if (this.offers.get(cli.id) === pending) this.offered(cli, o); });
    return pending;
  }
  private offered(cli: CliChoice, o: AcpOffer) {
    const was = this.offers.get(cli.id);
    if (was && !was.pending && JSON.stringify(was) === JSON.stringify(o)) return;
    this.offers.set(cli.id, o);
    const info = this.clisInfo();
    for (const r of this.watchers) send(r, 'clis', info);
  }
  /** The CLIs for /agent/info and the feed: names and what each offers. */
  clisInfo(): AgentCliInfo[] {
    return this.clis.map(c => { const o = this.offer(c); return { id: c.id, name: c.name, command: commandName(c), models: o.models, efforts: o.efforts, ...(o.pending ? { pending: true } : {}) }; });
  }

  drop(s: AgentSession | AcpSession) {
    const i = this.sessions.indexOf(s);
    if (i < 0) return;
    this.sessions.splice(i, 1);
    s.dispose();
    // Its worktree stays until someone decides what happens to the branch (D64).
    if (s.worktree && !this.left.some(w => w.dir === s.worktree!.dir)) {
      const w = { ...s.worktree, session: s.label, ...(s.title ? { title: s.title } : {}) };
      this.left.push(w);
      void this.refresh(w).then(() => this.push());
    }
    this.push();
  }

  setMode(mode: 'shared' | 'fresh') { this.mode = mode; this.push(); }

  /** New fresh sessions get a worktree (D64); refused when the project isn't a git repo. */
  setWorktrees(on: boolean) {
    const g = this.wt.git;
    if (on && g && 'why' in g) throw Object.assign(new Error(`worktrees need a git repository: ${g.why}`), { status: 409 });
    this.wt.on = on;
    this.push();
  }

  /**
   * An attachment the agent points at (D56: Redline's MCP `attach`, the /attach route): a file inside the
   * session's folder (relative to where it runs, or absolute) or an http(s) URL, with an optional title.
   */
  attach(id: string, a: { path?: unknown; url?: unknown; title?: unknown }): { ok: true; attachment: import('./types.ts').Attachment } | { error: string } {
    const s = this.get(id);
    if (!s || s.id !== id) return { error: `no agent session ${id}` };
    const title = typeof a.title === 'string' && a.title.trim() ? a.title.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200) : undefined;
    if (typeof a.url === 'string' && a.url) {
      const item = s.rounds.addUrl(a.url.trim(), 'explicit', title);
      return item ? { ok: true, attachment: item } : { error: 'url must be http or https' };
    }
    if (typeof a.path !== 'string' || !a.path) return { error: 'give path (a file in the project) or url' };
    const item = s.rounds.addFile(a.path, 'explicit', title);
    return item ? { ok: true, attachment: item } : { error: `${a.path} is not a file inside the project${s.worktree ? ` (this session works in ${s.worktree.path})` : ''}` };
  }

  /** Keep, merge or discard an ended session's worktree (D64); see worktrees.ts `act`. */
  async worktree(branch: string, action: WorktreeAction, confirm = false) {
    const w = this.left.find(x => x.branch === branch);
    if (!w) throw Object.assign(new Error(`no ended session's worktree on ${branch}`), { status: 404 });
    const r = await act(w, action, confirm);
    if (!r.kept || action === 'keep') this.left.splice(this.left.indexOf(w), 1);
    else await this.refresh(w);
    this.push();
    return r;
  }

  private async refresh(w: Worktree) {
    try { const st = await status(w); w.dirty = st.dirty; w.ahead = st.ahead; } catch { /* unknown */ }
  }

  info(): AgentGroupInfo {
    const g = this.wt.git;
    return {
      mode: this.mode, max: this.max,
      worktrees: {
        on: this.wt.on && !(g && 'why' in g), git: !!g && 'top' in g, ...(g && 'why' in g ? { why: g.why } : !g ? { why: 'checking…' } : {}),
        left: this.left.map(w => ({ branch: w.branch, path: w.path, base: w.base, ...(w.dirty !== undefined ? { dirty: w.dirty } : {}), ...(w.ahead !== undefined ? { ahead: w.ahead } : {}), ...(w.session ? { session: w.session } : {}), ...(w.title ? { title: w.title } : {}) })),
      },
      sessions: this.sessions.map(s => s.info()),
    };
  }

  /** The toolbar's feed: every session's status, whenever one changes. */
  watch(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.watchers.add(res);
    send(res, 'hello', this.info());
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    res.on('close', () => { clearInterval(beat); this.watchers.delete(res); });
  }

  private push() {
    const info = this.info(), key = JSON.stringify(info);
    if (key === this.last) return;
    this.last = key;
    for (const r of this.watchers) send(r, 'status', info);
  }

  dispose() { for (const s of this.sessions) s.dispose(); for (const r of this.watchers) r.end(); this.watchers.clear(); }
}

// One group per project and command, kept across handler re-creation (Vite restarts the server on
// a config change; the agents should not), and killed when the dev server process exits.
const GROUPS = Symbol.for('umage.agentBridge.groups');
const g = globalThis as { [GROUPS]?: Map<string, AgentGroup> };
export function groupFor(opts: BridgeOptions, cwd: string, root: string, clis: CliChoice[], wt: { dir?: string; prefix?: string } = {}): AgentGroup {
  const map = g[GROUPS] ??= (() => {
    const m = new Map<string, AgentGroup>();
    process.once('exit', () => { for (const s of m.values()) s.dispose(); });
    return m;
  })();
  const key = JSON.stringify([cwd, clis.map(c => [c.command, c.args, usesAcp({ ...opts, command: c.command })])]);
  let s = map.get(key);
  if (!s) { s = new AgentGroup(opts, cwd, root, clis, wt); map.set(key, s); }
  return s;
}

