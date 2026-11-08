# @umage.ai/redline-agent

The agent panel for [Redline](https://github.com/umage-ai/redline)'s dev server. It runs your agent CLI
(Claude Code by default; Codex, Gemini CLI, aider… any terminal program) in a pseudo-terminal on the dev
server and drives it from the overlay, so reviewers never need to open a terminal:

- **The agent toolbar**: **Agent** (A) in Redline's toolbar, or `Alt+Shift+A` from anywhere. It shows the
  agent's state and its own message, **Apply 3 notes** and your own prompt buttons, **Allow**/**Deny** when
  it asks for approval, **CLI** for its terminal (xterm.js), and stop.
- **Live status** from the CLI's OSC 7501 reports (Claude Code sends them): a light sweeping round the toolbar
  and a turning ring on the closed launcher while it works, an orange glow while it waits for you, green when done.
- **The notes panel** tags the notes it was sent and the ones it has done.

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

How it works and why: [D53](https://github.com/umage-ai/redline/blob/main/docs/DECISIONS.md). MIT licensed.
