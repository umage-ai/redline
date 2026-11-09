// The agent panel's server (D53): the developer's own agent CLI (claude, codex, gemini, aider…)
// in a pseudo-terminal on the dev server, streamed to a terminal window in the overlay. Per project
// root, one shared session or a new one per prompt (`sessions`, AgentGroup), started from the panel and
// kept across page reloads and dev-server config restarts; they end with the dev server process. Status comes from OSC 7501
// (program-status.ts), with output activity as the fallback for CLIs that don't report.
//
// Local dev only: every call must come from this machine (whatever `network` allows), POSTs need
// the x-redline header (a cross-site page can't send it without a preflight) and the session token,
// and the stream needs the token too. node-pty (an optional dependency of this package) is loaded on first start.

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, readBody } from '../../src/server/http.ts';
import { DA1_REPLY, OscScanner, PROBE_REPLY, ProgramRecords, type ProgramState, type ProgramStatus } from './program-status.ts';
import { Screen, type PromptView } from './screen.ts';

import type { AgentCommand, AgentOptions, AgentRoutes } from '../../src/server/agent-hook.ts';

// This file's folder: dist/ in the package (CommonJS), src/ when run from source (tests). The browser files are in dist/.
const HERE = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const DIST = path.basename(HERE) === 'dist' ? HERE : path.join(HERE, '../dist');

export const DEFAULT_COMMANDS: AgentCommand[] = [
  { label: 'Apply notes', title: 'Ask the agent to apply the open notes on this page', prompt: 'Apply the open Redline notes {ids} on page {page}, following the redline skill. Mark each one done when it is applied.' },
];

/** What a viewer shows: the session's state and the program's status. */
export interface AgentInfo {
  /** `s1`, `s2`… in this dev server. */
  id: string;
  /** `#1`, `#2`…: the toolbar's tab when there are several. */
  label: string;
  running: boolean;
  /** The program's name from its OSC 7501 reports (`claude-code`), once it reported one. */
  app?: string;
  command: string;
  /** Exit code of the last run, when it has ended. */
  exitCode?: number | null;
  status: ProgramStatus & { source: '7501' | 'activity' | 'none' };
  /** Notes handed to the agent in this dev-server session (by a prompt that named them), oldest first. */
  sent: string[];
  /** The menu on the agent's screen (a permission prompt, stepped questions), read off it; while running. */
  prompt?: PromptView;
}

/** All of a project's sessions: what the toolbar shows. */
export interface AgentGroupInfo {
  mode: 'shared' | 'fresh';
  /** Sessions running at once in 'fresh' mode. */
  max: number;
  /** Oldest first. */
  sessions: AgentInfo[];
}

export const DEFAULT_KEYS = { allow: '\r', deny: '\x1b' };
const MAX_SENT = 500;
const KEEP_ENDED = 4;   // ended sessions kept listed (their terminal and status), the oldest dropped first

/** Claude Code: the command's base name (either slash, on any OS). Its menus are the ones `screen.ts` reads (D53). */
export const isClaude = (command: string) => /^claude$/i.test((command.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com)$/i, ''));

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
 * the developer installs it) or next to Redline; null when neither is there. `require` (both are
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
 * The `instructions` option for a start: Claude Code takes them as a system-prompt file (a file, not
 * an argument: no quoting through cmd.exe; text is written to a temp file); any other CLI gets them
 * ahead of the session's first prompt (`preamble`).
 */
export async function withInstructions(command: string, args: string[], extra: { text: string; file?: string }): Promise<{ args: string[]; preamble: string }> {
  if (!extra.text) return { args, preamble: '' };
  if (!isClaude(command)) return { args, preamble: extra.text };
  let file = extra.file;
  if (!file) {
    file = path.join(os.tmpdir(), `redline-agent-${createHash('sha1').update(extra.text).digest('hex').slice(0, 12)}.md`);
    await writeFile(file, extra.text);
  }
  return { args: [...args, '--append-system-prompt-file', file], preamble: '' };
}

class AgentSession {
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

  readonly opts: AgentOptions;
  readonly cwd: string;
  readonly root: string;
  readonly id: string;
  readonly label: string;
  private onChange: () => void;
  constructor(opts: AgentOptions, cwd: string, root: string, n: number, onChange: () => void) {
    this.opts = opts; this.cwd = cwd; this.root = root; this.id = `s${n}`; this.label = `#${n}`; this.onChange = onChange;
  }

  get running() { return !!this.pty || !!this.starting; }
  /** Running, and finished with its turn: nothing queued, not working or asking. */
  get resting() {
    if (!this.pty || this.queued.length) return false;
    const s = this.info().status.state;
    return s === 'idle' || s === 'done' || s === 'error';
  }
  /** Menus are read off the screen for Claude Code (whose menus `screen.ts` knows), or when asked to (`menus`). */
  private get menus() {
    const m = this.opts.menus ?? 'auto';
    return m === true || (m === 'auto' && (isClaude(this.opts.command ?? 'claude') || /^claude/i.test(this.app ?? '')));
  }

  /** The `instructions` option's text ('' for none); a file is read at every start, so edits apply to the next session. */
  private async instructions(): Promise<{ text: string; file?: string }> {
    const o = this.opts.instructions;
    if (!o) return { text: '' };
    if (typeof o === 'string') return { text: o.trim() };
    const file = path.resolve(this.root, o.file);
    try { return { text: (await readFile(file, 'utf8')).trim(), file }; }
    catch { console.warn(`[redline] agent instructions: can't read ${file}`); return { text: '' }; }
  }

  /** What the panel calls it: paths shortened to their base names, Windows extensions dropped. */
  get command() { return commandName(this.opts); }

  info(): AgentInfo {
    const s = this.records.status();
    const source = this.reported ? '7501' : this.pty ? 'activity' : 'none';
    const status = source === 'activity' ? { ...s, state: (Date.now() - this.lastOutput < ACTIVE_MS ? 'working' : 'idle') as ProgramState } : s;
    return {
      id: this.id, label: this.label, running: !!this.pty, ...(this.app ? { app: this.app } : {}), command: this.command, exitCode: this.exitCode,
      status: { ...status, source }, sent: [...this.sent], ...(this.pty && this.view ? { prompt: this.view } : {}),
    };
  }

  async start(cols?: number, rows?: number) {
    if (this.pty) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      if (cols && rows) { this.cols = clampSize(cols, 20, 400); this.rows = clampSize(rows, 5, 200); }
      const pty = loadPty(this.cwd);
      if (!pty) throw new Error('the agent panel needs node-pty: npm i -D node-pty (Linux without build tools: @lydell/node-pty)');
      const env = { ...process.env, ...this.opts.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' } as NodeJS.ProcessEnv;
      const command = this.opts.command ?? 'claude';
      const { args, preamble } = await withInstructions(command, this.opts.args ?? [], await this.instructions());
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
      else { this.reported = true; this.records.apply(ev.report); if (ev.report.app) this.app = ev.report.app; }
    }
    const on = d.lastIndexOf('\x1b[?2004h'), off = d.lastIndexOf('\x1b[?2004l');
    if (on > off) this.bracketedPaste = true; else if (off > on) this.bracketedPaste = false;
    this.lastOutput = Date.now();
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
  async send(text: string, notes: string[] = []) {
    const clean = text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');   // no escape sequences, no control keys
    if (!clean.trim()) return;
    this.remember(notes);
    if (!this.pty || !this.ready()) { this.queued.push(clean); await this.start(); this.flush(); return; }
    this.type(clean);
  }

  /** Ready for a prompt: the program reported a resting state, or has been quiet since its first output. */
  private ready() {
    if (!this.pty) return false;
    const now = Date.now();
    if (now - this.startedAt > 30_000) return true;
    if (this.reported) { const s = this.records.status().state; return s === 'idle' || s === 'done' || s === 'error'; }
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
    p.write(this.bracketedPaste ? `\x1b[200~${clean}\x1b[201~` : clean);
    // A separate Enter, a moment later: TUIs treat text + CR in one read as a paste with a newline.
    setTimeout(() => { if (this.pty === p) p.write('\r'); }, 80);
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
  answer(key: string): boolean {
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

  acknowledge() { this.records.acknowledge(); this.pushStatus(); }

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

const clampSize = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number(n) || lo)));
const send = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/**
 * A project's sessions (D53): one that keeps its context ('shared'), or a new one for every prompt
 * ('fresh'), several at once. One token for all of them; the toolbar watches them through one feed.
 */
class AgentGroup {
  readonly token = randomBytes(18).toString('base64url');
  readonly sessions: AgentSession[] = [];
  mode: 'shared' | 'fresh';
  private n = 0;
  private watchers = new Set<ServerResponse>();
  private last = '';
  readonly opts: AgentOptions;
  readonly cwd: string;
  readonly root: string;
  constructor(opts: AgentOptions, cwd: string, root: string) {
    this.opts = opts; this.cwd = cwd; this.root = root;
    this.mode = opts.sessions === 'fresh' ? 'fresh' : 'shared';
  }
  get max() { return clampSize(this.opts.maxSessions ?? 3, 1, 8); }

  /** A session by id; no id: the newest. */
  get(id?: unknown): AgentSession | undefined {
    return typeof id === 'string' && id ? this.sessions.find(s => s.id === id) : this.sessions[this.sessions.length - 1];
  }

  /** A new session; ended ones past KEEP_ENDED are dropped, oldest first. */
  create(): AgentSession {
    const ended = this.sessions.filter(s => !s.running);
    for (const s of ended.slice(0, Math.max(0, ended.length - KEEP_ENDED + 1))) this.drop(s);
    if (!this.sessions.length) this.n = 0;   // all closed: numbering starts over at #1
    const s =new AgentSession(this.opts, this.cwd, this.root, ++this.n, () => this.push());
    this.sessions.push(s);
    this.push();
    return s;
  }

  /** The session for a prompt or a start: 'shared' reuses `id` (or the newest), 'fresh' makes room and starts a new one. */
  forPrompt(id?: unknown): AgentSession {
    if (this.mode === 'shared') return this.get(id) ?? this.create();
    const running = this.sessions.filter(s => s.running);
    if (running.length >= this.max) {
      const done = running.find(s => s.resting);
      if (!done) throw Object.assign(new Error(`${running.length} sessions are busy: stop one, or wait until one is done`), { status: 409 });
      done.stop();
    }
    return this.create();
  }

  drop(s: AgentSession) {
    const i = this.sessions.indexOf(s);
    if (i < 0) return;
    this.sessions.splice(i, 1);
    s.dispose();
    this.push();
  }

  setMode(mode: 'shared' | 'fresh') { this.mode = mode; this.push(); }

  info(): AgentGroupInfo { return { mode: this.mode, max: this.max, sessions: this.sessions.map(s => s.info()) }; }

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
const GROUPS = Symbol.for('umage.redline.agentGroups');
const g = globalThis as { [GROUPS]?: Map<string, AgentGroup> };
function groupFor(opts: AgentOptions, cwd: string, root: string): AgentGroup {
  const map = g[GROUPS] ??= (() => {
    const m = new Map<string, AgentGroup>();
    process.once('exit', () => { for (const s of m.values()) s.dispose(); });
    return m;
  })();
  const key = JSON.stringify([cwd, opts.command ?? 'claude', opts.args ?? []]);
  let s = map.get(key);
  if (!s) { s = new AgentGroup(opts, cwd, root); map.set(key, s); }
  return s;
}

/** What the panel calls the CLI: paths shortened to their base names, Windows extensions dropped. */
export const commandName = (opts: AgentOptions) => opts.label ?? [opts.command ?? 'claude', ...(opts.args ?? [])]
  .map((a, i) => (i === 0 || /[\\/]/.test(a) ? path.basename(a).replace(/\.(exe|cmd|bat|com)$/i, '') : a)).join(' ');

/** The terminal page the agent window frames: xterm.js in its own document, out of the app's and the overlay's key handling. */
const terminalPage = (base: string) => `<!doctype html><html><head><meta charset="utf-8"><title>Agent</title>
<style>html,body{margin:0;height:100%;background:#131316;overflow:hidden}#t{position:absolute;inset:4px 2px 2px 8px}</style></head>
<body><div id="t"></div><script type="module" src="${base}/agent/terminal.js"></script></body></html>`;

/** The panel's routes for one project root, under the API base (`/__redline`). */
export function agentRoutes(opts: AgentOptions, root: string, base: string): AgentRoutes {
  const cwd = opts.cwd ? path.resolve(root, opts.cwd) : root;
  const group = groupFor(opts, cwd, root);
  const commands = (opts.commands ?? DEFAULT_COMMANDS).filter(c => c && typeof c.label === 'string' && typeof c.prompt === 'string');
  const keys = opts.keys === false ? false : { ...DEFAULT_KEYS, ...opts.keys };
  const hotkey = opts.hotkey === false ? false : typeof opts.hotkey === 'string' && opts.hotkey ? opts.hotkey : 'alt+shift+a';
  const key = opts.key === false ? false : typeof opts.key === 'string' && opts.key.length === 1 ? opts.key.toLowerCase() : 'a';

  return {
    panel: `${base}/agent/panel.js`,
    async handle(req, res, p, allowed) {
      const method = req.method ?? 'GET';
      if (!allowed) return json(res, 403, { error: 'the agent panel answers this machine only' });
      // A page on another origin (DNS rebinding included) never gets here: Host is checked by `allowed`,
      // and Origin, when the browser sends one, must be this server.
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && (() => { try { return new URL(origin).host !== req.headers.host; } catch { return true; } })()) return json(res, 403, { error: 'cross-origin agent request' });

      const asset = method === 'GET' && (p === '/agent/panel.js' ? 'panel.js' : p === '/agent/terminal.js' ? 'terminal.js' : null);
      if (asset) {
        const file = path.join(DIST, asset);
        if (!existsSync(file)) return json(res, 404, { error: 'agent panel not built' });
        res.setHeader('content-type', 'text/javascript; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(await readFile(file));
        return;
      }
      if (method === 'GET' && p === '/agent/terminal') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.setHeader('cache-control', 'no-store');
        res.end(terminalPage(base));
        return;
      }
      if (method === 'GET' && p === '/agent/info') return json(res, 200, { ...group.info(), command: commandName(opts), token: group.token, commands, approve: !!keys, hotkey, key });

      const url = new URL(req.url ?? '', 'http://x');
      const token = method === 'GET' ? url.searchParams.get('token') : req.headers['x-redline-agent'];
      if (token !== group.token) return json(res, 403, { error: 'missing or stale agent token' });
      if (method === 'GET' && p === '/agent/stream') {
        if (url.searchParams.get('status') === '1') { group.watch(res); return; }
        const s = group.get(url.searchParams.get('id'));
        if (!s) return json(res, 404, { error: 'no such agent session' });
        s.attach(res);
        return;
      }

      if (method !== 'POST') return json(res, 405, { error: 'POST' });
      if (req.headers['x-redline'] !== '1') return json(res, 403, { error: 'missing x-redline header' });
      let body: Record<string, unknown> = {};
      try { body = JSON.parse((await readBody(req, 1024 * 1024)) || '{}'); } catch { return json(res, 400, { error: 'bad JSON' }); }
      const failed = (e: unknown) => json(res, (e as { status?: number }).status ?? 500, { error: (e as Error).message });
      const named = typeof body.id === 'string' && !!body.id;
      // The session a call is for: `id`, or the newest.
      const session = group.get(body.id);
      if (named && !session) return json(res, 404, { error: 'no such agent session' });
      switch (p) {
        case '/agent/start': {
          // A named session (re)starts; none named: 'shared' the one session, 'fresh' a new one.
          try {
            const s = named ? session! : group.forPrompt();
            await s.start(Number(body.cols), Number(body.rows));
            return json(res, 200, s.info());
          } catch (e) { return failed(e); }
        }
        case '/agent/send': {
          if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text is required' });
          try {
            const s = group.forPrompt(body.id);
            await s.send(body.text, Array.isArray(body.notes) ? body.notes.slice(0, 200) as string[] : []);
            return json(res, 200, { ok: true, id: s.id });
          } catch (e) { return failed(e); }
        }
        case '/agent/mode':
          if (body.mode !== 'shared' && body.mode !== 'fresh') return json(res, 400, { error: 'mode must be shared or fresh' });
          group.setMode(body.mode);
          return json(res, 200, group.info());
        case '/agent/stop':
          // One session, or (no id) all of them.
          if (named) session!.stop(); else for (const s of group.sessions) s.stop();
          return json(res, 200, { ok: true });
        case '/agent/dismiss':
          if (!named) return json(res, 400, { error: 'id is required' });
          if (session!.running) return json(res, 409, { error: 'stop the session first' });
          group.drop(session!);
          return json(res, 200, { ok: true });
      }
      if (!session) return json(res, 409, { error: 'no agent session' });
      switch (p) {
        case '/agent/input':
          if (typeof body.data === 'string') session.write(body.data);
          return json(res, 200, { ok: true });
        case '/agent/resize':
          session.resize(Number(body.cols), Number(body.rows));
          return json(res, 200, { ok: true });
        case '/agent/answer': {
          const key = keys && (body.choice === 'allow' ? keys.allow : body.choice === 'deny' ? keys.deny : undefined);
          if (!key) return json(res, 400, { error: 'choice must be allow or deny' });
          if (!session.answer(key)) return json(res, 409, { error: 'the agent is not waiting for approval' });
          return json(res, 200, { ok: true });
        }
        case '/agent/choose': {
          const index = Number(body.index);
          if (!Number.isInteger(index) || index < 0) return json(res, 400, { error: 'index is required' });
          if (!(await session.choose(index, typeof body.text === 'string' ? body.text.slice(0, 4000) : undefined))) return json(res, 409, { error: 'no such option on the agent\'s screen' });
          return json(res, 200, { ok: true });
        }
        case '/agent/ack':
          session.acknowledge();
          return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'unknown agent endpoint' });
    },
  };
}
