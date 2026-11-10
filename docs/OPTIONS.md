# Options

Last updated: 2026-11-10 · Cap: 150 lines · Every option with its default, in one place. Detail lives in [USAGE.md](USAGE.md), [FRAMEWORKS.md](FRAMEWORKS.md) and the linked docs.

The same option is spelled `camelCase` in Node (`redline({ … })`, `withRedline(cfg, { … })`, `redlineMiddleware({ … })`,
the Angular builder's `redline` block) and `PascalCase` in .NET (`AddRedline(o => …)`). "—" means the server doesn't have it.
0.10 changed four defaults (D57); they are marked **0.10**.

## Overlay

| Option (Node / .NET) | Default | What it does |
|---|---|---|
| `hotkey` / `Hotkey` | `alt+shift+r` | Opens and closes the overlay (D12). |
| `launcher` / `Launcher` | `true` | The round button while closed; `false`: hotkey or `data-redline-open` buttons (D51). |
| `launcherSize` / `LauncherSize` | `medium` (32 px) | `small` 26, `large` 40, or px (20–64). |
| `launcherPosition` / `LauncherPosition` | `bottom-right 16` | `'top-left 24'`, `'bottom-center 16 80'`, or `{ x, y, offsetX, offsetY }`. |
| `draggable` / `Draggable` | **0.10:** `true` (was `false`) | Reviewers move the launcher, toolbar and sketch tools; double-click an icon resets (D51). |
| `labels` / `Labels`, `LabelsFrom` | Bug, UX, Idea, Copy | Chips on a note; `false` turns them off; a function of the request (D46, D47). |
| `prompt` / `Prompt` | shown with the markdown store | The panel's **Copy prompt** text (`{open}`, `{page}`); `false` hides it (D47). |
| `pageKey` / `PageKey` | `'route'` | `'path'` keeps hash routes (a deck's `#/3`) on one page (D26). |
| `extensions` / `Extensions`, `ExtensionUrls` | none | Overlay extension modules (D21). |

## Notes and source

| Option (Node / .NET) | Default | What it does |
|---|---|---|
| `root` / `Root` | nearest `.git` folder | Where notes go; source paths are relative to it. |
| `dir` / `Dir` | `.redline` | The notes folder under `root`. |
| `app` / `App` | the dev server's folder | Monorepos: the app's name in notes (D17). |
| `store` / `Store` | markdown in `<root>/<dir>` | Any `NoteStore`; `remoteStore({ url })` for a shared one (D19, D40). |
| `hooks` / — | none | `onCreate`, `onUpdate`, `onRemove`, `onSourceWrite`. |
| `directEdit` / `DirectEdit` | **0.10:** `true` in the dev-server plugins and .NET (was `false`); `false` in `redlineMiddleware` | **Apply to file** for static text, after a dry run (D20). .NET online mode never writes files. |
| — / `Writers` | none | Your own source writers, tried first. |
| `jsxSource`, `vueSource` (Vite) | `true` | Stamp elements with `file:line:col` in dev (D7, D23). |
| `buildSource` (Vite) | `false` | Keep the stamps in `vite build`, for a review build (D43). |
| `build` / `Build` | none | The commit the pages come from, recorded on notes. |

## Access

| Option (Node / .NET) | Default | What it does |
|---|---|---|
| `network` / — | **0.10:** this machine only, in `redlineMiddleware` too (was `true` there) | Adds addresses, subnets, host names, or `true` for all (D9, docs/SETUPS.md). |
| `mcpTokens` / `Mcp.TokenHashes` | none: this machine only | Bearer tokens for `POST /__redline/mcp` (D35, D37). |
| — / `EnabledWhen` | Development only | When the .NET middleware runs. |
| — / `Online`, `Policy`, `Roles`, `AllowedOrigins` | off | Deployed review for signed-in reviewers (D34). |
| — / `ManualPlacement`, `Exclude` | off / none | Where the middleware sits; requests to skip (D31). |

## `mount()` (embedding, D49)

| Option | Default | What it does |
|---|---|---|
| `transport` | `httpTransport()` | Where notes come from and go to. |
| `config` | from `transport.config()` | Any overlay option above, plus `statuses`, `strings`. |
| `captureErrors` | `true` | Console errors attached to notes. |
| `screenshot` | built-in DOM capture | Wrap or replace the screenshot. |
| `shadowMode` / `hostTag` / `namespace` | `open` / `redline-root` / `redline` | Isolation when two overlays share a page. |
| `gate`, `extensions`, `strings`, `theme` | none | Sign-in step, extensions, UI text, CSS tokens (D50). |

## `agent` (`@umage.ai/redline-agent`, D53)

| Option | Default | What it does |
|---|---|---|
| `command`, `args`, `env`, `cwd`, `label` | the first installed of `claude`, `opencode`; none, none, `root`, the command | The CLI to run. |
| `model` | the CLI's own | Passed as the CLI's flag (Claude Code `--model`); OpenCode has none (a warning). |
| `adapters` | built-in: Claude Code, OpenCode | Your own `AgentAdapter`s, tried first (D55). |
| `sessions` | **0.10:** `'fresh'` (was `'shared'`) | A new session per prompt with just its notes; `'shared'` keeps one. |
| `maxSessions` | `3` | Fresh sessions at once (1–8). |
| `commands` | one **Apply notes** button | Prompt buttons (`{page}`, `{url}`, `{ids}`). |
| `keys` | Enter / Esc | What Allow / Deny send to CLIs whose menus aren't read. |
| `menus` | `'auto'` (Claude Code) | Read the CLI's menus into the toolbar's card. |
| `hotkey`, `key` | `alt+shift+a`, `a` | Open the agent toolbar. |
| `instructions` | none | Extra rules for sessions Redline starts. |

