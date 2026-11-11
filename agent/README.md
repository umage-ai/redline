# @umage.ai/redline-agent

The agent panel for [Redline](https://github.com/umage-ai/redline)'s dev server. It runs your agent CLI
(Claude Code, OpenCode, or any terminal program; any [ACP](https://agentclientprotocol.com) agent without a terminal) on the dev
server and drives it from the overlay, so reviewers never need to open a terminal:

![The agent toolbar: the CLI asks to edit src/App.tsx; the card shows the diff and its three options](https://raw.githubusercontent.com/umage-ai/redline/main/docs/images/agent.png)

- **The agent toolbar**: **Agent** (A) in Redline's toolbar, or `Alt+Shift+A` from anywhere. It shows the
  agent's state and its own message, **Apply 3 notes** and your own prompt buttons, **CLI** for its
  terminal (xterm.js), and End (stop the CLI and close the session in one; × on a tab).
- **Its questions in a card** on the toolbar: when the CLI shows a menu (a permission prompt with its diff, Claude Code's
  stepped questions, a trust dialog), the card shows the context, the question and every option, with a field for
  "Type something". It is read off the CLI's screen, so it is exactly what the terminal shows; a click moves the
  CLI's cursor and presses Enter. This is for Claude Code (detected from its OSC 7501 reports or the command
  `claude`). ACP agents (OpenCode by default) send their permission requests as data, so the card shows their own
  options too; other CLIs get **Allow**/**Deny** and the terminal (`menus: true` tries it anyway).
- **Several CLIs**: every installed one is offered; a ▾ next to the prompt buttons picks one, remembered in this browser.
- **Live status** from the CLI's OSC 7501 reports (Claude Code sends them) or the ACP session: a light sweeping round the toolbar
  and a turning ring on the closed launcher while it works, an orange glow while it waits for you, green when done.
- **Fresh sessions** (the default since 0.10; the toolbar's **Fresh** switches): every prompt starts its own session with
  only its notes (none that a running session already has), several at once, a tab each (3 shown, the rest
  behind **+N**, a list of every session; on phones one session button opens it). `sessions: 'shared'` (or Fresh off) keeps one
  session that keeps its context; either way a note goes to one running session at a time.
- **The notes panel** tags each note it was sent: being worked on, waiting for your answer, sent, or done.
- **← and ✕**: ← goes back to the main toolbar (Esc too), ✕ closes the overlay.

Local dev only: it answers this machine only (whatever Redline's `network` option says), and every call needs a
per-process token. The CLI keeps its own permission prompts.

## Install

```bash
npm i -D @umage.ai/redline @umage.ai/redline-agent
```

node-pty comes with it (an optional dependency: prebuilt on Windows and macOS, compiled on Linux). Linux without
build tools: `npm i -D @lydell/node-pty` instead.

## Use

Turn it on with Redline's `agent` option, in any setup (Vite, Astro, Next, Angular, the Node server):

```js
redline({ agent: true })                 // every installed one of claude, opencode: ▾ picks (below)
redline({ agent: 'opencode' })           // one CLI by name, no picker (any CLI runs; see Adapters below)
redline({ agent: { clis: ['claude', 'opencode', { command: 'codex', label: 'Codex' }] } })   // the picker's list
redline({
  agent: {
    command: 'claude', args: ['--permission-mode', 'acceptEdits'],
    model: 'opus',                        // the CLI's model flag (Claude Code --model; OpenCode: its own config)
    commands: [{ label: 'Review page', prompt: 'Review page {page} against the open Redline notes {ids}' }],
    keys: { allow: '\r', deny: '\x1b' },  // what Allow / Deny send (Claude Code's prompt)
    hotkey: 'alt+shift+a',
    key: 'a',                             // the Agent button's key in the toolbar; false when an extension uses A
    sessions: 'fresh', maxSessions: 3,    // a new session per prompt (the default; 'shared': one session)
    instructions: { file: 'redline-agent.md' },  // or a string; see below
  },
})
```

Redline finds this package in your project. Or hand it over yourself (typed, and bundler-friendly):

```js
import { agent } from '@umage.ai/redline-agent';
redline({ agent: agent({ command: 'codex' }) })
```

### Several CLIs

With more than one CLI (`agent: true` with Claude Code and OpenCode both installed, or a `clis` list), a ▾ next to
the prompt buttons opens the list (arrow keys and Enter work too). Your pick is remembered in this browser and named
on the prompt button's tooltip; each session runs the CLI it was started with (OpenCode over ACP) and its tab says which. With Fresh,
sessions of different CLIs run side by side; with one shared session, a prompt for another CLI stops the shared
one (between turns, not while it works or asks; its tab stays, ended) and starts the new one. `clis` takes adapter ids or commands
(`'claude'`, `'opencode'`, with the option's `args`), any other command, or `{ command, args, label, id, env }`;
the installed ones are offered, the first is the default. A `command` alone means just that CLI.

### Adapters

What is particular to a CLI sits in an adapter (`AgentAdapter`): Claude Code (menus read into the card,
`--model`, instructions as `--append-system-prompt-file`) and OpenCode (over ACP by default, below; in a
terminal with `protocol: 'pty'`: status from its OSC 7501 reports, Allow/Deny for its prompts). Any other CLI
runs as is: Allow/Deny, the terminal, and 7501 status if it sends it. Add or tune your own, tried before the built-in ones:

```js
import { agent, openCode } from '@umage.ai/redline-agent';
redline({ agent: agent({ command: 'opencode', adapters: [{ ...openCode, settleMs: 2000 }] }) })
```

### ACP mode

Agents that speak the [Agent Client Protocol](https://agentclientprotocol.com) run without a terminal
(`protocol: 'acp'`; OpenCode does by default, as `opencode acp`). Redline talks JSON-RPC to them over stdio:
working while a prompt runs, done when it returns, and a permission request shows in the card with the agent's
own options ("Allow once", "Always allow", "Reject"); Cancel ends the turn. The CLI window shows a transcript
(the agent's text, tool calls, its plan) and a line typed there is sent as a prompt. `model` is set through the
agent's model option (OpenCode: `provider/model`, as in `opencode models`); `instructions` go ahead of the first
prompt. Any other ACP agent: `{ command: 'my-acp-agent', args: [...], protocol: 'acp' }`. Claude Code stays in
the terminal (its ACP mode is a separate adapter package).

OpenCode asks before nothing by default. To approve its shell commands and edits from the card, set
`"permission": { "bash": "ask", "edit": "ask" }` in OpenCode's config, or for Redline's sessions only:
`env: { OPENCODE_CONFIG_CONTENT: '{"permission":{"bash":"ask","edit":"ask"}}' }`.

Prompts fill in `{page}`, `{url}` and `{ids}` (the open notes on the page); a prompt with `{ids}` shows their count
and tags those notes "sent". Prompts wait until the CLI is ready for input.

`instructions` adds your own rules to the sessions Redline starts, on top of the project's CLAUDE.md / AGENTS.md
(say "don't commit", "run the tests for the files you touch"). Text, or `{ file }` relative to the project root,
read at every start. Claude Code gets it as `--append-system-prompt-file`; any other CLI ahead of the session's
first prompt. The agent starts in the project root (where `.redline/` is), or `cwd`.

How it works and why: [D53, D55, D59](https://github.com/umage-ai/redline/blob/main/docs/DECISIONS.md). MIT licensed.

---

Part of **Redline** ([umage.ai/products/redline](https://umage.ai/products/redline)): [all packages](https://github.com/umage-ai/redline#packages), [source](https://github.com/umage-ai/redline).
