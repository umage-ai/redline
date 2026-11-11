// The agent CLIs the panel knows (D55): what is particular to each, behind one interface
// (`AgentAdapter`, src/server/agent-hook.ts). Claude Code: menus read off its screen, instructions,
// the model and the effort as flags (the toolbar's settings offer its aliases and levels, D62). OpenCode: 7501 status without `done`, an input box that needs a moment
// after it reports idle, its model from its own config. Anything else: generic (Allow/Deny, the
// terminal, 7501 status when the CLI sends it). Adapters from the `adapters` option are tried first.

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentChoice, AgentCli, AgentOptions, AgentStart } from '../../src/server/agent-hook.ts';

/** A command's base name, either slash, without a Windows extension: `C:\tools\claude.exe` → `claude`. */
export const baseName = (command: string) => (command.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();

const preamble = (o: { args: string[]; model?: string; effort?: string; instructions: { text: string } }, name: string): AgentStart => {
  const ignored = [o.model && `model "${o.model}"`, o.effort && `effort "${o.effort}"`].filter(Boolean).join(', ');
  return {
    args: o.args,
    preamble: o.instructions.text,
    ...(ignored ? { warning: `${name} takes no model or effort flag: it uses its own config (agent option ${ignored} ignored)` } : {}),
  };
};

/** An adapter's `models` / `efforts` as choices: strings become `{ value }`, empty and repeated values are dropped. */
export function choices(list: (string | AgentChoice)[] | undefined): AgentChoice[] {
  const out: AgentChoice[] = [], seen = new Set<string>();
  for (const c of list ?? []) {
    const value = typeof c === 'string' ? c : c?.value;
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    out.push(typeof c === 'string' || !c.name ? { value } : { value, name: String(c.name) });
  }
  return out;
}

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  matches: (command, app) => baseName(command) === 'claude' || /^claude/i.test(app ?? ''),
  menus: true,
  // `claude --help`: --model takes an alias for the latest model ("fable", "opus", "sonnet") or a full
  // name (the `model` option); --effort low, medium, high, xhigh or max.
  models: [{ value: 'fable', name: 'Fable' }, { value: 'opus', name: 'Opus' }, { value: 'sonnet', name: 'Sonnet' }],
  efforts: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra high' }, { value: 'max', name: 'Max' }],
  async start({ args, model, effort, instructions }) {
    const out = [...args];
    if (model && !args.includes('--model')) out.push('--model', model);
    if (effort && !args.includes('--effort')) out.push('--effort', effort);
    if (!instructions.text) return { args: out };
    // A file, not an argument: no quoting through cmd.exe. Text is written to a temp file.
    let file = instructions.file;
    if (!file) {
      file = path.join(os.tmpdir(), `redline-agent-${createHash('sha1').update(instructions.text).digest('hex').slice(0, 12)}.md`);
      await writeFile(file, instructions.text);
    }
    return { args: [...out, '--append-system-prompt-file', file] };
  },
};

export const openCode: AgentAdapter = {
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  matches: (command, app) => baseName(command) === 'opencode' || app === 'opencode',
  // OpenCode 2.2 reports working and idle, never done (anomalyco/opencode#60411), and reports idle
  // before its input box takes keys (a prompt typed then is lost).
  doneOnIdle: true,
  settleMs: 1000,
  start: o => preamble(o, 'OpenCode'),
  // `opencode acp` (D58): its permission requests become the card's menu, status without screen reading.
  acp: ['acp'],
};

export const generic: AgentAdapter = {
  id: 'generic',
  name: '',
  command: 'claude',
  matches: () => true,
  start: o => preamble(o, 'This CLI'),
};

export const BUILT_IN: AgentAdapter[] = [claudeCode, openCode];

/** The adapter for a command (with its arguments, and the `app` it reported once it has): yours first, then the built-in ones, else generic. */
export function adapterFor(command: string, app?: string, extra: AgentAdapter[] = [], args?: string[]): AgentAdapter {
  return [...extra, ...BUILT_IN].find(a => a.matches(command, app, args)) ?? generic;
}

/** True when `command` is on PATH (Windows: with PATHEXT). */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  return dirs.some(d => exts.some(e => { try { return statSync(path.join(d, command + e)).isFile(); } catch { return false; } }));
}

/** The first adapter whose command is installed; `claude` when none is (its "not found" error says so). */
export function defaultCommand(extra: AgentAdapter[] = [], has = (c: string) => onPath(c)): string {
  return [...extra, ...BUILT_IN].find(a => has(a.command))?.command ?? 'claude';
}

/** What the panel calls the CLI: paths shortened to their base names, Windows extensions dropped. */
export const commandName = (opts: { command?: string; args?: string[]; label?: string }) => opts.label ?? [opts.command ?? 'claude', ...(opts.args ?? [])]
  .map((a, i) => (i === 0 || /[\\/]/.test(a) ? path.basename(a).replace(/\.(exe|cmd|bat|com)$/i, '') : a)).join(' ');

/** A command is installed: a path that exists, or a name on PATH. */
export const installed = (command: string) => (/[\\/]/.test(command) ? existsSync(command) : onPath(command));

/** One CLI the toolbar can run (D59): `id` for the panel and the `cli` field, `name` for people. */
export interface CliChoice { id: string; name: string; command: string; args: string[]; label?: string; env?: Record<string, string> }

const MISSING = new Set<string>();
/**
 * The CLIs the toolbar offers (D59), the default first. `clis`: those of them installed. Else
 * `command`: that one alone (no picker; a missing one fails at start, saying so). Else every adapter
 * whose command is installed; `claude` when none is. The option's `args` go with `command`, the
 * detected CLIs and the `clis` given as strings; an object in `clis` has its own.
 */
export function cliChoices(opts: AgentOptions, has: (command: string) => boolean = installed): CliChoice[] {
  const known = [...(opts.adapters ?? []), ...BUILT_IN];
  const args = opts.args ?? [];
  let list: AgentCli[];
  if (opts.clis?.length) {
    const given = opts.clis.filter(c => typeof c === 'string' ? !!c : !!c && typeof c.command === 'string' && !!c.command)
      .map(c => typeof c === 'string' ? { command: known.find(a => a.id === c || a.command === c)?.command ?? c, args } : c);
    list = given.filter(c => has(c.command));
    const missing = given.filter(c => !list.includes(c)).map(c => c.command).join(', ');
    if (missing && !MISSING.has(missing)) { MISSING.add(missing); console.warn(`[redline] agent clis: not installed, left out of the picker: ${missing}`); }
    if (!list.length) list = given.slice(0, 1);
  } else if (opts.command) list = [{ command: opts.command, args, label: opts.label }];
  else list = known.filter(a => has(a.command)).map(a => ({ command: a.command, args }));
  if (!list.length) list = [{ command: 'claude', args }];
  const out: CliChoice[] = [], ids = new Set<string>(), seen = new Set<string>();
  for (const c of list) {
    const a = c.args ?? [];
    const key = JSON.stringify([c.command, a]);
    if (seen.has(key)) continue;
    seen.add(key);
    const adapter = adapterFor(c.command, undefined, opts.adapters, a);
    const base = c.id || (adapter !== generic ? adapter.id : baseName(c.command) || 'cli');
    let id = base;
    for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
    ids.add(id);
    const name = c.label ?? (adapter !== generic ? adapter.name : commandName({ command: c.command, args: a }));
    out.push({ id, name, command: c.command, args: a, ...(c.label ? { label: c.label } : {}), ...(c.env ? { env: c.env } : {}) });
  }
  return out;
}
