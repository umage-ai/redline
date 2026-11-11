// ACP mode (D58): an agent that speaks the Agent Client Protocol (https://agentclientprotocol.com)
// over stdio instead of a terminal: JSON-RPC 2.0, one JSON object per line. The status comes from the
// protocol (a `session/prompt` in flight is working, its reply is done, a `session/request_permission`
// is blocked) and a permission request is the toolbar card's menu with the agent's own options, so
// nothing is read off a screen. There is no terminal: the CLI window shows a transcript (the agent's
// text, tool calls, plan) written as ANSI text, and a line typed there is sent as a prompt.
//
// A small hand-written client, not @agentclientprotocol/sdk (9 MB unpacked, with zod): the panel uses
// six methods. The client advertises no fs or terminal capabilities: the agent uses its own tools.
//
// `AcpSession` has the surface `AgentGroup` and the routes use on a PTY `AgentSession` (server.ts).

import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerResponse } from 'node:http';
import type { AgentOptions } from '../../src/server/agent-hook.ts';
import type { ProgramState } from './program-status.ts';
import type { PromptView, Span } from './screen.ts';
import type { AgentInfo } from './server.ts';
import { adapterFor } from './adapters.ts';
import { commandName, resolveCommand } from './server.ts';

export const ACP_PROTOCOL_VERSION = 1;
const MAX_SCROLLBACK = 512 * 1024;
const MAX_SENT = 500;
const HANDSHAKE_MS = 60_000;

type Json = Record<string, any>;
interface RpcError { code: number; message: string; data?: unknown }

/**
 * JSON-RPC 2.0 over newline-delimited JSON. Requests both ways: ours get a promise, the agent's go
 * to `onRequest` (an answer, or a thrown error). Ids are checked with `!== undefined`: OpenCode's
 * first request to the client has id 0 (L58).
 */
export class JsonRpc {
  private next = 1;
  private pending = new Map<number, { resolve(v: any): void; reject(e: Error): void }>();
  private buf = '';
  private closed = false;
  onRequest: (method: string, params: Json, id: number | string) => unknown = () => { throw Object.assign(new Error('method not found'), { code: -32601 }); };
  onNotification: (method: string, params: Json) => void = () => {};
  private write: (line: string) => void;
  constructor(write: (line: string) => void) { this.write = write; }

  feed(chunk: string) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.message(line);
    }
    if (this.buf.length > 16 * 1024 * 1024) this.buf = '';   // a runaway line: dropped
  }

  private message(line: string) {
    let m: Json;
    try { m = JSON.parse(line); } catch { return; }   // a stray log line on stdout
    if (!m || typeof m !== 'object') return;
    const hasId = m.id !== undefined && m.id !== null;
    if (typeof m.method === 'string') {
      if (!hasId) { try { this.onNotification(m.method, m.params ?? {}); } catch { /* the handler's problem */ } return; }
      void (async () => {
        try { this.send({ jsonrpc: '2.0', id: m.id, result: (await this.onRequest(m.method, m.params ?? {}, m.id)) ?? null }); }
        catch (e) { this.send({ jsonrpc: '2.0', id: m.id, error: { code: (e as { code?: number }).code ?? -32603, message: (e as Error).message } }); }
      })();
      return;
    }
    if (!hasId) return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    if (m.error) p.reject(Object.assign(new Error(String((m.error as RpcError).message ?? 'error')), { code: (m.error as RpcError).code, data: (m.error as RpcError).data }));
    else p.resolve(m.result);
  }

  request<T = Json>(method: string, params: Json, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new Error('the agent has exited'));
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (timeoutMs) timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`no answer to ${method} in ${Math.round(timeoutMs / 1000)} s`)); }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: Json) { if (!this.closed) this.send({ jsonrpc: '2.0', method, params }); }

  private send(m: Json) { try { this.write(JSON.stringify(m) + '\n'); } catch { /* the pipe closed */ } }

  /** The agent exited: every request still waiting fails. */
  close(reason: string) {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}

// The transcript's look (ANSI, for the xterm in the CLI window).
const C = { dim: '\x1b[2m', bold: '\x1b[1m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', red: '\x1b[31m', orange: '\x1b[38;5;214m', reset: '\x1b[0m' };
const crlf = (s: string) => s.replace(/\r?\n/g, '\r\n');
const oneLine = (s: string, max = 200) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1) + '…' : t; };
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/**
 * ACP or a pseudo-terminal: `protocol` when set; else ACP for a CLI whose adapter says how to start
 * its ACP mode (`acp`: OpenCode's `opencode acp`), a pseudo-terminal for the rest (Claude Code).
 */
export function usesAcp(opts: AgentOptions): boolean {
  if (opts.protocol) return opts.protocol === 'acp';
  return !!adapterFor(opts.command ?? 'claude', undefined, opts.adapters, opts.args).acp;
}

/** A permission request as the toolbar card shows it (the same shape as a menu read off a screen). */
export function permissionView(params: Json): PromptView {
  const tc: Json = params.toolCall ?? {};
  const lines: Span[][] = [];
  const raw: Json = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
  for (const c of Array.isArray(tc.content) ? tc.content : []) {
    if (c?.type === 'diff' && typeof c.path === 'string') {
      lines.push([{ t: c.path, b: true }]);
      for (const l of String(c.oldText ?? '').split('\n').slice(0, 12)) if (c.oldText) lines.push([{ t: `- ${l}`, fg: '#ffb3b3', bg: '#4b1d1d' }]);
      for (const l of String(c.newText ?? '').split('\n').slice(0, 12)) lines.push([{ t: `+ ${l}`, fg: '#b3f0c8', bg: '#173b25' }]);
    } else if (c?.type === 'content' && c.content?.type === 'text' && c.content.text) {
      for (const l of String(c.content.text).split('\n').slice(0, 12)) lines.push([{ t: l }]);
    }
  }
  if (!lines.length && typeof raw.command === 'string') lines.push([{ t: `$ ${raw.command}` }]);
  for (const loc of Array.isArray(tc.locations) ? tc.locations.slice(0, 3) : []) if (typeof loc?.path === 'string' && !lines.length) lines.push([{ t: loc.path, dim: true }]);
  const kind = typeof tc.kind === 'string' && tc.kind !== 'other' ? tc.kind : '';
  const title = typeof tc.title === 'string' && tc.title ? tc.title : typeof tc.name === 'string' ? tc.name : 'a tool';
  const options = (Array.isArray(params.options) ? params.options : []).map((o: Json) => ({
    label: String(o.name ?? o.optionId), selected: false,
    ...(o.kind === 'allow_always' ? { description: 'Allowed from now on in this session' } : o.kind === 'reject_always' ? { description: 'Refused from now on in this session' } : {}),
  }));
  return { lines: lines.slice(0, 30), question: `Allow ${kind ? `${kind}: ` : ''}${title}?`, options, hint: 'Cancel ends the turn' };
}

/** A session with an ACP agent (D58): the same surface as the PTY `AgentSession`. */
export class AcpSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rpc: JsonRpc | null = null;
  private starting: Promise<void> | null = null;
  private sessionId = '';
  private scrollback = '';
  private viewers = new Set<ServerResponse>();
  private lastStatus = '';
  private state: ProgramState = 'idle';
  private msg: string | undefined;
  private exitCode: number | null | undefined;
  private stopping = false;
  private stderr = '';
  private queued: string[] = [];
  private turn: Promise<void> | null = null;
  private permission: { view: PromptView; options: Json[]; resolve(outcome: Json): void } | null = null;
  private tools = new Map<string, { title: string; status: string }>();
  private said = '';   // the agent's text this turn (the done message is its last line)
  private atLineStart = true;
  private line = '';   // typed in the CLI window, sent on Enter
  private sent = new Set<string>();
  private preamble = '';
  private agentName: string | undefined;

  readonly opts: AgentOptions;
  readonly cwd: string;
  readonly root: string;
  readonly id: string;
  readonly label: string;
  /** The CLI's id in the picker (D59). */
  readonly cli: string;
  /** What the agent offered in `session/new` (its models and effort levels, D62): the toolbar's settings list them. */
  onOffer?: (offer: AcpOffer) => void;
  /** The tab's name and the prompt that started it (D62), set by the first prompt that names them. */
  title?: string;
  task?: string;
  private onChange: () => void;
  constructor(opts: AgentOptions, cwd: string, root: string, n: number, onChange: () => void, cli = '') {
    this.opts = opts; this.cwd = cwd; this.root = root; this.id = `s${n}`; this.label = `#${n}`; this.onChange = onChange; this.cli = cli;
  }

  get running() { return !!this.child || !!this.starting; }
  get resting() { return !!this.child && !this.turn && !this.queued.length && this.state !== 'working' && this.state !== 'blocked'; }
  get command() { return commandName(this.opts); }
  get adapter() { return adapterFor(this.opts.command ?? 'claude', undefined, this.opts.adapters, this.opts.args); }

  info(): AgentInfo {
    const status: AgentInfo['status'] = {
      state: this.state, ...(this.state === 'blocked' ? { kind: 'permission' as const } : {}), ...(this.msg ? { msg: this.msg } : {}),
      records: this.child ? 1 : 0, source: this.child ? 'acp' : 'none',
    };
    return {
      id: this.id, label: this.label, running: !!this.child, ...(this.agentName ? { app: this.agentName } : {}), command: this.command, cli: this.cli, exitCode: this.exitCode,
      status, sent: [...this.sent], ...(this.child && this.permission ? { prompt: this.permission.view } : {}), protocol: 'acp',
      ...meta(this),
    };
  }

  /** The `instructions` option's text, read at every start (a file's edits apply to the next session). */
  private async instructions(): Promise<string> {
    const o = this.opts.instructions;
    if (!o) return '';
    if (typeof o === 'string') return o.trim();
    const file = path.resolve(this.root, o.file);
    try { return (await readFile(file, 'utf8')).trim(); }
    catch { console.warn(`[redline] agent instructions: can't read ${file}`); return ''; }
  }

  /** Spawn the agent, `initialize`, `session/new`, and the model when asked for. */
  async start(_cols?: number, _rows?: number) {
    if (this.child) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const command = this.opts.command ?? 'claude';
      const args = [...(this.adapter.acp ?? []), ...(this.opts.args ?? [])];
      const env = { ...process.env, ...this.opts.env } as NodeJS.ProcessEnv;
      const target = resolveCommand(command, args, env);
      if (!target) throw new Error(`"${command}" was not found on PATH`);
      this.preamble = await this.instructions();
      this.scrollback = ''; this.stderr = ''; this.exitCode = undefined; this.stopping = false;
      this.state = 'idle'; this.msg = undefined; this.tools.clear(); this.permission = null; this.atLineStart = true; this.line = '';
      // Its own process group off Windows, so stop() reaches a CLI's children too (npm shims spawn the real binary).
      const child = spawn(target.file, target.args, { cwd: this.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
      const rpc = new JsonRpc(line => child.stdin.write(line));
      this.child = child; this.rpc = rpc;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => rpc.feed(d));
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => { this.stderr = (this.stderr + d).slice(-4000); });
      child.stdin.on('error', () => { /* exited: handled on exit */ });
      const spawned = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.on('error', () => {});
      child.once('exit', code => this.exited(child, code));
      rpc.onNotification = (method, params) => { if (method === 'session/update' && params.sessionId === this.sessionId) this.update(params.update ?? {}); };
      rpc.onRequest = (method, params) => this.request(method, params);
      this.broadcast('start', this.info());
      this.print(`${C.dim}${this.command}: Agent Client Protocol, starting…${C.reset}\r\n`);
      try {
        await spawned;
        const init = await rpc.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'redline', title: 'Redline', version: '0' },
        }, HANDSHAKE_MS);
        const ai = init?.agentInfo;
        this.agentName = typeof ai?.name === 'string' ? ai.name : undefined;
        const s = await rpc.request('session/new', { cwd: this.cwd, mcpServers: [] }, HANDSHAKE_MS);
        if (typeof s?.sessionId !== 'string') throw new Error('session/new returned no sessionId');
        this.sessionId = s.sessionId;
        this.onOffer?.(offerOf(s));
        await this.setModel(s);
        this.print(`${C.dim}${[this.agentName, ai?.version].filter(Boolean).join(' ') || this.command} ready. Type a prompt and press Enter.${C.reset}\r\n`);
        this.pushStatus();
      } catch (e) {
        const err = e as Error & { code?: number };
        const why = err.code === -32000 ? `${err.message} (log the CLI in first, in a terminal)` : err.message;
        this.fail(child, why);
        throw new Error(`${this.command} (ACP): ${why}`);
      }
    })();
    try { await this.starting; } finally { this.starting = null; }
  }

  /**
   * The `model` and `effort` options (D62): the agent's `model` and `thought_level` config options
   * (`session/set_config_option`), or for the model the older `models` list (`session/set_model`); a
   * value it doesn't offer, or an agent with neither: a warning.
   */
  private async setModel(s: Json) {
    const warn = (w: string) => { console.warn(`[redline] agent: ${w}`); this.print(`${C.yellow}${w}${C.reset}\r\n`); };
    for (const [what, value] of [['model', this.opts.model], ['effort', this.opts.effort]] as const) {
      if (!value || !this.rpc) continue;
      const cfg = configOption(s.configOptions, what);
      try {
        if (cfg) {
          const opt = flatOptions(cfg).find((o: Json) => o?.value === value || o?.name === value);
          if (!opt) { warn(`${this.command} doesn't offer the ${what} "${value}" (it uses ${cfg.currentValue})`); continue; }
          if (opt.value !== cfg.currentValue) await this.rpc.request('session/set_config_option', { sessionId: this.sessionId, configId: cfg.id, value: opt.value }, HANDSHAKE_MS);
          continue;
        }
        const models = s.models;
        if (what === 'model' && Array.isArray(models?.availableModels)) {
          const m = models.availableModels.find((x: Json) => x?.modelId === value || x?.name === value);
          if (!m) { warn(`${this.command} doesn't offer the model "${value}" (it uses ${models.currentModelId})`); continue; }
          if (m.modelId !== models.currentModelId) await this.rpc.request('session/set_model', { sessionId: this.sessionId, modelId: m.modelId }, HANDSHAKE_MS);
          continue;
        }
        warn(`${this.command} offers no ${what} choice over ACP: it uses its own config (agent option ${what} "${value}" ignored)`);
      } catch (e) { warn(`couldn't set the ${what} "${value}": ${(e as Error).message}`); }
    }
  }

  /** The agent's requests to the client: permission only (no fs or terminal capabilities were offered). */
  private request(method: string, params: Json): unknown {
    if (method !== 'session/request_permission') throw Object.assign(new Error(`${method} is not supported by this client`), { code: -32601 });
    const options: Json[] = Array.isArray(params.options) ? params.options : [];
    if (!this.turn || !options.length) return { outcome: { outcome: 'cancelled' } };
    const view = permissionView(params);
    this.print(`\r\n${C.orange}? ${view.question}${C.reset} ${C.dim}(${options.map(o => o.name).join(' / ')})${C.reset}\r\n`);
    this.permission?.resolve({ outcome: 'cancelled' });   // one at a time: an older one is withdrawn
    return new Promise(resolve => {
      this.permission = {
        view, options,
        resolve: (outcome: Json) => {
          if (this.permission?.view !== view) return;
          this.permission = null;
          if (this.state === 'blocked') { this.state = 'working'; this.msg = view.question; }
          resolve({ outcome });
          this.pushStatus();
        },
      };
      this.state = 'blocked'; this.msg = view.question;
      this.pushStatus();
    });
  }

  /** `session/update`: the transcript, and the message the toolbar shows while it works. */
  private update(u: Json) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (!t) return;
        this.said += t;
        this.text(t);
        return;
      }
      case 'agent_thought_chunk': {
        const t = u.content?.type === 'text' ? String(u.content.text ?? '') : '';
        if (t) this.text(t, C.dim);
        return;
      }
      case 'tool_call':
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        const was = this.tools.get(id);
        const title = typeof u.title === 'string' && u.title ? u.title : was?.title ?? 'tool';
        const status = typeof u.status === 'string' ? u.status : was?.status ?? 'pending';
        this.tools.set(id, { title, status });
        if (this.tools.size > 200) this.tools.delete(this.tools.keys().next().value!);
        if (was && was.title === title && was.status === status) return;
        if (status === 'completed' || status === 'failed') {
          if (was && (was.status === 'completed' || was.status === 'failed')) return;
          this.newline();
          this.print(status === 'failed' ? `${C.red}✗ ${title}${C.reset}\r\n` : `${C.green}✓${C.reset} ${C.dim}${title}${C.reset}\r\n`);
        } else if (!was || was.title !== title) {
          this.newline();
          this.print(`${C.yellow}⏺ ${title}${C.reset}\r\n`);
        }
        if (this.state === 'working') { this.msg = oneLine(title, 120); this.pushStatus(); }
        return;
      }
      case 'plan': {
        const entries: Json[] = Array.isArray(u.entries) ? u.entries : [];
        if (!entries.length) return;
        this.newline();
        this.print(`${C.bold}Plan${C.reset}\r\n` + entries.map(e => `  ${e.status === 'completed' ? `${C.green}☒` : e.status === 'in_progress' ? `${C.cyan}▸` : `${C.dim}☐`} ${oneLine(String(e.content ?? ''), 160)}${C.reset}`).join('\r\n') + '\r\n');
        return;
      }
    }
  }

  private text(t: string, style = '') {
    this.print(style + crlf(t) + (style ? C.reset : ''));
    this.atLineStart = /\n$/.test(t);
  }
  private newline() { if (!this.atLineStart) { this.print('\r\n'); this.atLineStart = true; } }

  /** A prompt from a panel button: started when needed; queued while a turn runs (one turn at a time). */
  async send(text: string, notes: string[] = [], about: { title?: unknown; task?: unknown } = {}) {
    const clean = text.replace(CONTROL, '');
    if (!clean.trim()) return;
    this.remember(notes);
    nameSession(this, about);
    this.queued.push(clean);
    if (!this.child) await this.start();
    this.pump();
  }

  private pump() {
    if (this.turn || !this.queued.length || !this.rpc || !this.sessionId) return;
    const text = this.queued.splice(0).join('\n\n');
    const full = this.preamble ? `${this.preamble}\n\n${text}` : text;
    this.preamble = '';
    const rpc = this.rpc;
    this.said = '';
    this.state = 'working'; this.msg = undefined;
    this.newline();
    this.print(`\r\n${C.cyan}${C.bold}› ${C.reset}${C.cyan}${crlf(text)}${C.reset}\r\n`);
    this.pushStatus();
    this.turn = (async () => {
      try {
        const r = await rpc.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text: full }] });
        if (this.rpc !== rpc) return;
        const reason = String(r?.stopReason ?? 'end_turn');
        const last = this.said.trim().split('\n').map(l => l.trim()).filter(Boolean).pop();
        this.newline();
        if (reason === 'cancelled') { this.state = 'idle'; this.msg = 'cancelled'; }
        else { this.state = 'done'; this.msg = reason === 'end_turn' ? (last ? oneLine(last) : undefined) : reason.replace(/_/g, ' '); }
        this.print(`${C.dim}── ${reason === 'end_turn' ? 'done' : reason.replace(/_/g, ' ')}${C.reset}\r\n`);
      } catch (e) {
        if (this.rpc !== rpc) return;
        this.state = 'error'; this.msg = oneLine((e as Error).message);
        this.newline();
        this.print(`${C.red}${(e as Error).message}${C.reset}\r\n`);
      } finally {
        if (this.rpc === rpc) { this.turn = null; this.permission?.resolve({ outcome: 'cancelled' }); this.pushStatus(); this.pump(); }
      }
    })();
  }

  /**
   * Keys from the CLI window: a line editor. Enter sends the line as a prompt; Backspace; Esc or
   * Ctrl+C cancels the turn (a pending permission answered "cancelled").
   */
  write(data: string) {
    if (!this.child) return;
    if (data.startsWith('\x1b[200~')) data = data.replace(/\x1b\[20[01]~/g, '');   // a paste
    if (data === '\x1b' || data === '\x03') { this.cancel(); return; }
    data = data.replace(/\x1b\[[0-9;?]*[A-Za-z~]/g, '');   // arrows and the like: no cursor movement here
    for (const ch of data) {
      if (ch === '\r' || ch === '\n') {
        const line = this.line; this.line = '';
        this.print('\r\n');
        this.atLineStart = true;
        if (line.trim()) void this.send(line);
      } else if (ch === '\x7f' || ch === '\b') {
        if (this.line) { this.line = [...this.line].slice(0, -1).join(''); this.print('\b \b'); }
      } else if (ch >= ' ') {
        this.line += ch;
        this.print(ch);
        this.atLineStart = false;
      }
    }
  }

  /** Stops the turn in flight (`session/cancel`), answering a pending permission "cancelled". */
  cancel() {
    if (!this.turn || !this.rpc) return;
    this.queued = [];
    this.rpc.notify('session/cancel', { sessionId: this.sessionId });
    this.permission?.resolve({ outcome: 'cancelled' });
  }

  resize(_cols: number, _rows: number) { /* no terminal */ }

  /** Allow or Deny: the agent's first allow / reject option. */
  answer(_key: string, choice?: string): boolean {
    const p = this.permission;
    if (!p || (choice !== 'allow' && choice !== 'deny')) return false;
    const want = choice === 'allow' ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
    const o = want.map(k => p.options.find(x => x.kind === k)).find(Boolean);
    if (!o) return false;
    this.pick(o);
    return true;
  }

  /** An option of the card: the agent's own option, by its index. */
  async choose(index: number, _text?: string): Promise<boolean> {
    const o = this.permission?.options[index];
    if (!o) return false;
    this.pick(o);
    return true;
  }

  private pick(o: Json) {
    this.print(`${C.dim}→ ${o.name ?? o.optionId}${C.reset}\r\n`);
    this.permission?.resolve({ outcome: 'selected', optionId: o.optionId });
  }

  stop() {
    const child = this.child;
    if (!child || this.stopping) return;
    this.stopping = true;
    this.cancel();
    try { child.stdin.end(); } catch { /* closed */ }
    kill(child);
  }

  acknowledge() {
    if (this.state === 'done' || (this.state === 'error' && this.child)) { this.state = 'idle'; this.msg = undefined; }
    this.pushStatus();
  }

  attach(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    this.viewers.add(res);
    sse(res, 'hello', { ...this.info(), scrollback: this.scrollback });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    res.on('close', () => { clearInterval(beat); this.viewers.delete(res); });
  }

  dispose() { this.stop(); for (const r of this.viewers) r.end(); this.viewers.clear(); }

  private remember(notes: string[]) {
    for (const id of notes) {
      if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)) continue;
      this.sent.delete(id); this.sent.add(id);
    }
    for (const id of this.sent) { if (this.sent.size <= MAX_SENT) break; this.sent.delete(id); }
  }

  /** A failed start: the process goes, the status says why. */
  private fail(child: ChildProcessWithoutNullStreams, why: string) {
    this.state = 'error'; this.msg = oneLine(why);
    this.print(`${C.red}${why}${C.reset}\r\n`);
    this.stopping = true;
    kill(child);
    if (!child.pid) this.exited(child, null);   // never started (spawn failed): no exit event comes
  }

  private exited(child: ChildProcessWithoutNullStreams, code: number | null) {
    if (this.child !== child) return;
    const rpc = this.rpc;
    this.child = null; this.rpc = null; this.sessionId = ''; this.turn = null; this.queued = [];
    this.permission = null;
    this.exitCode = code;
    const tail = this.stderr.trim().split('\n').pop()?.trim();
    rpc?.close(`${this.command} exited${code !== null ? ` (${code})` : ''}`);
    if (!this.stopping) {
      // Not asked to stop: a crash, shown as failed.
      this.state = 'error'; this.msg = oneLine(`exited${code !== null ? ` with code ${code}` : ''}${tail ? `: ${tail}` : ''}`);
      this.newline();
      this.print(`${C.red}${this.command} ${this.msg}${C.reset}\r\n`);
    } else if (this.state !== 'error') { this.state = 'idle'; this.msg = undefined; }
    this.broadcast('exit', { exitCode: code });
    this.pushStatus();
  }

  private print(s: string) {
    this.scrollback += s;
    if (this.scrollback.length > MAX_SCROLLBACK) {
      const cut = this.scrollback.indexOf('\n', this.scrollback.length - MAX_SCROLLBACK);
      this.scrollback = this.scrollback.slice(cut < 0 ? this.scrollback.length - MAX_SCROLLBACK : cut + 1);
    }
    this.broadcast('data', s);
  }

  private broadcast(event: string, data: unknown) { for (const r of this.viewers) sse(r, event, data); }

  private pushStatus() {
    const info = this.info(), key = JSON.stringify(info);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    this.broadcast('status', info);
    this.onChange();
  }
}

/** A session's tab name, prompt, model and effort for its info (D62). */
export const meta = (s: { title?: string; task?: string; opts: AgentOptions }) => ({
  ...(s.title ? { title: s.title } : {}), ...(s.task ? { task: s.task } : {}),
  ...(s.opts.model ? { model: s.opts.model } : {}), ...(s.opts.effort ? { effort: s.opts.effort } : {}),
});
/** The first prompt that names the session sets its tab name and prompt label: no control characters, 80 characters at most. */
export function nameSession(s: { title?: string; task?: string }, about: { title?: unknown; task?: unknown }) {
  const clean = (v: unknown) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
  if (!s.title && clean(about.title)) s.title = clean(about.title);
  if (!s.task && clean(about.task)) s.task = clean(about.task);
}

/** The models and effort levels an ACP agent offers (D62), from its `session/new` reply. */
export interface AcpOffer { models: { value: string; name?: string }[]; efforts: { value: string; name?: string }[] }
/** The config option for the model (`category: 'model'`) or the effort (`category: 'thought_level'`). */
function configOption(list: unknown, what: 'model' | 'effort'): Json | undefined {
  const all: Json[] = Array.isArray(list) ? list : [];
  return what === 'model' ? all.find(o => o?.category === 'model' || o?.id === 'model') : all.find(o => o?.category === 'thought_level' || o?.id === 'effort' || o?.id === 'thought_level');
}
/** A select option's values, groups flattened. */
const flatOptions = (cfg: Json): Json[] => (Array.isArray(cfg.options) ? cfg.options : []).flatMap((o: Json) => Array.isArray(o?.options) ? o.options : [o]);
/** The lists for the settings: values as the agent takes them ("default" is the settings' own Default), at most 500. */
export function offerOf(s: Json): AcpOffer {
  const list = (what: 'model' | 'effort') => {
    const cfg = configOption(s?.configOptions, what);
    const opts: Json[] = cfg ? flatOptions(cfg) : what === 'model' && Array.isArray(s?.models?.availableModels) ? s.models.availableModels.map((m: Json) => ({ value: m?.modelId, name: m?.name })) : [];
    const seen = new Set<string>();
    return opts.filter(o => typeof o?.value === 'string' && o.value && o.value !== 'default' && !seen.has(o.value) && !!seen.add(o.value))
      .slice(0, 500).map(o => ({ value: String(o.value).slice(0, 200), ...(typeof o.name === 'string' && o.name !== o.value ? { name: o.name.slice(0, 200) } : {}) }));
  };
  return { models: list('model'), efforts: list('effort') };
}

/**
 * What an ACP agent offers (D62), asked once for the toolbar's settings: spawn it, `initialize`,
 * `session/new`, read its config options, stop it. Empty lists when it fails or takes over `ms`.
 */
export async function probeAcp(opts: AgentOptions, cwd: string, ms = 30_000): Promise<AcpOffer> {
  const command = opts.command ?? 'claude';
  const args = [...(adapterFor(command, undefined, opts.adapters, opts.args).acp ?? []), ...(opts.args ?? [])];
  const env = { ...process.env, ...opts.env } as NodeJS.ProcessEnv;
  const target = resolveCommand(command, args, env);
  const none: AcpOffer = { models: [], efforts: [] };
  if (!target) return none;
  let child: ChildProcessWithoutNullStreams;
  try { child = spawn(target.file, target.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' }); }
  catch { return none; }
  const rpc = new JsonRpc(line => child.stdin.write(line));
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => rpc.feed(d));
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => {});
  child.on('error', () => rpc.close('failed'));
  child.once('exit', () => rpc.close('exited'));
  try {
    await rpc.request('initialize', { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'redline', title: 'Redline', version: '0' } }, ms);
    return offerOf(await rpc.request('session/new', { cwd, mcpServers: [] }, ms));
  } catch { return none; }
  finally { rpc.close('done'); try { child.stdin.end(); } catch { /* closed */ } kill(child); }
}

const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

/** The agent and what it started: Windows' cmd.exe shim (npm) has the real CLI as a child, so the tree. */
function kill(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    // Synchronous: this also runs in the dev server's exit handler.
    const r = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    if (r.error || r.status !== 0) { try { child.kill(); } catch { /* gone */ } }
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* gone */ } }
}
