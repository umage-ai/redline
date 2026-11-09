# @umage.ai/redline-agent

The agent panel for [Redline](https://github.com/umage-ai/redline)'s dev server. It runs your agent CLI
(Claude Code by default; Codex, Gemini CLI, aider… any terminal program) in a pseudo-terminal on the dev
server and drives it from the overlay, so reviewers never need to open a terminal:

- **The agent toolbar**: **Agent** (A) in Redline's toolbar, or `Alt+Shift+A` from anywhere. It shows the
  agent's state and its own message, **Apply 3 notes** and your own prompt buttons, **CLI** for its
  terminal (xterm.js), and stop.
- **Its questions in a card** on the toolbar: when the CLI shows a menu (a permission prompt with its diff, Claude Code's
  stepped questions, a trust dialog), the card shows the context, the question and every option, with a field for
  "Type something". It is read off the CLI's screen, so it is exactly what the terminal shows; a click moves the
  CLI's cursor and presses Enter. This is for Claude Code (detected from its OSC 7501 reports or the command
  `claude`); other CLIs get **Allow**/**Deny** and the terminal (`menus: true` tries it anyway).
- **Live status** from the CLI's OSC 7501 reports (Claude Code sends them): a light sweeping round the toolbar
  and a turning ring on the closed launcher while it works, an orange glow while it waits for you, green when done.
- **Fresh sessions** (the toolbar's **Fresh**, or `sessions: 'fresh'`): every prompt starts its own session with
  only its notes (none that a running session already has), several at once, a tab each (3 shown, the rest
  behind **+N**, a list of every session; on phones one session button opens it). The default is one shared
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
redline({ agent: true })                 // claude
redline({ agent: 'codex' })              // another CLI
redline({
  agent: {
    command: 'claude', args: ['--permission-mode', 'acceptEdits'],
    commands: [{ label: 'Review page', prompt: 'Review page {page} against the open Redline notes {ids}' }],
    keys: { allow: '\r', deny: '\x1b' },  // what Allow / Deny send (Claude Code's prompt)
    hotkey: 'alt+shift+a',
    key: 'a',                             // the Agent button's key in the toolbar; false when an extension uses A
    sessions: 'fresh', maxSessions: 3,    // a new session per prompt (default 'shared': one session)
    instructions: { file: 'redline-agent.md' },  // or a string; see below
  },
})
```

Redline finds this package in your project. Or hand it over yourself (typed, and bundler-friendly):

```js
import { agent } from '@umage.ai/redline-agent';
redline({ agent: agent({ command: 'codex' }) })
```

Prompts fill in `{page}`, `{url}` and `{ids}` (the open notes on the page); a prompt with `{ids}` shows their count
and tags those notes "sent". Prompts wait until the CLI is ready for input.

`instructions` adds your own rules to the sessions Redline starts, on top of the project's CLAUDE.md / AGENTS.md
(say "don't commit", "run the tests for the files you touch"). Text, or `{ file }` relative to the project root,
read at every start. Claude Code gets it as `--append-system-prompt-file`; any other CLI ahead of the session's
first prompt. The agent starts in the project root (where `.redline/` is), or `cwd`.

How it works and why: [D53](https://github.com/umage-ai/redline/blob/main/docs/DECISIONS.md). MIT licensed.

---

Part of **Redline** ([umage.ai/products/redline](https://umage.ai/products/redline)): [all packages](https://github.com/umage-ai/redline#packages), [source](https://github.com/umage-ai/redline).
