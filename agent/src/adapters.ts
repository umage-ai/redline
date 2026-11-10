// The agent CLIs the panel knows (D55): what is particular to each, behind one interface
// (`AgentAdapter`, src/server/agent-hook.ts). Claude Code: menus read off its screen, instructions
// and the model as flags. OpenCode: 7501 status without `done`, an input box that needs a moment
// after it reports idle, its model from its own config. Anything else: generic (Allow/Deny, the
// terminal, 7501 status when the CLI sends it). Adapters from the `adapters` option are tried first.

import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentAdapter, AgentStart } from '../../src/server/agent-hook.ts';

/** A command's base name, either slash, without a Windows extension: `C:\tools\claude.exe` → `claude`. */
export const baseName = (command: string) => (command.split(/[\\/]/).pop() ?? '').replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase();

const preamble = (o: { args: string[]; model?: string; instructions: { text: string } }, name: string): AgentStart => ({
  args: o.args,
  preamble: o.instructions.text,
  ...(o.model ? { warning: `${name} takes no model flag: it uses the model from its own config (agent option model "${o.model}" ignored)` } : {}),
});

export const claudeCode: AgentAdapter = {
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  matches: (command, app) => baseName(command) === 'claude' || /^claude/i.test(app ?? ''),
  menus: true,
  async start({ args, model, instructions }) {
    const out = [...args];
    if (model && !args.includes('--model')) out.push('--model', model);
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
};

export const generic: AgentAdapter = {
  id: 'generic',
  name: '',
  command: 'claude',
  matches: () => true,
  start: o => preamble(o, 'This CLI'),
};

export const BUILT_IN: AgentAdapter[] = [claudeCode, openCode];

/** The adapter for a command (and the `app` it reported, once it has): yours first, then the built-in ones, else generic. */
export function adapterFor(command: string, app?: string, extra: AgentAdapter[] = []): AgentAdapter {
  return [...extra, ...BUILT_IN].find(a => a.matches(command, app)) ?? generic;
}

/** True when `command` is on PATH (Windows: with PATHEXT). */
export function onPath(command: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  return dirs.some(d => exts.some(e => { try { return statSync(path.join(d, command + e)).isFile(); } catch { return false; } }));
}

/** `agent: true`: the first adapter whose command is installed; `claude` when none is (its "not found" error says so). */
export function defaultCommand(extra: AgentAdapter[] = [], has = (c: string) => onPath(c)): string {
  return [...extra, ...BUILT_IN].find(a => has(a.command))?.command ?? 'claude';
}
