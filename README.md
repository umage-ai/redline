# Redline

**Mark up a running web UI, and let an AI agent apply the changes.**

![Commenting on a button: the popover shows the element and its React source, App.tsx:32](docs/images/comment.png)

Redline is a dev-only overlay for any web app. Press **Alt+Shift+R** in the browser, then pin
comments on elements, rewrite text in place, or sketch on the page. Each note is saved by the
dev server as markdown under `.redline/` with everything an agent needs to find the code:
- the URL
- a CSS selector and XPath
- the test id
- the **source file:line** and the **component chain**
- the viewport and theme
- recent console errors
- a screenshot with the target outlined

Any coding agent (Claude Code, Codex, Cursor, Copilot, Gemini CLI, …) works through the notes with
the bundled `redline` skill. It ticks each note off and
replies inline, and the replies show up live in the overlay.

It works with Vite, SvelteKit, Astro and React, and was built on real apps in each of them. Nothing ships to production: the plugin only runs under `vite dev` / `astro dev`.

## Modes

| Key | Mode | What you do | What's saved |
|---|---|---|---|
| `C` | **Comment** | Click an element and type. `Alt`+click picks its parent, `Shift`+click comments on the whole page. Use **↑ Parent** to widen the target. | The instruction plus element context and a cropped screenshot |
| `T` | **Text** | Click any text and edit it in place. `Enter` (or clicking outside) keeps the edit. | A `diff` block (`-` old / `+` new) plus an optional note |
| `S` | **Sketch** | Draw with box `1`, arrow `2`, pen `3` and text `4`, in six colours (tap the colour dot to fold out the palette, or `C` to cycle). `Ctrl+Z` undoes, `Enter` finishes. | The SVG plus a viewport screenshot with the sketch drawn on top |
| `N` | **Notes** | Open the panel: this page or all pages, done/reopen, edit, delete, agent replies, and **Copy prompt for your agent**. | |
| `Esc` | | Steps back one level: draft → mode → panel → closed. | |

Saving a note returns to idle, so the app is usable again; press `C` (or tap **Comment**) for the next one.
Clicks never reach the app while you're picking, and the app never sees you using the overlay,
so an open dropdown, popover or combobox stays open: open it, then press `C` (or click **Comment**)
and click the item. The demo (`npm run demo`) has three to try: the **Export** menu, the **⋯** row
menus and the **Filter by driver** autocomplete. Notes show as numbered pins that follow their
element, and hovering a pin shows the note and the agent's reply.

**Phones and tablets** work too: open the app over your LAN (`vite --host`), tap the launcher, then
tap the mode buttons. On touch screens the toolbars drop the key hints and grow their targets, a tap
picks an element while a swipe still scrolls, the popover stays above the on-screen keyboard, and the
notes panel goes full width. Use **↑ Parent** and **Page** in place of `Alt`/`Shift`+click.

| Text: edit in place, saved as a diff | Sketch: box, arrow, pen and labels |
|---|---|
| ![Text mode diff](docs/images/text.png) | ![Sketch mode](docs/images/sketch.png) |

![The notes panel with an agent's reply on a done note](docs/images/panel.png)

<sub>Screenshots are from the fictional demo app in [`examples/demo`](examples/demo). Run it with `npm run demo`;
regenerate the images with `npm run screenshots`.</sub>

## Setup in a repo

```bash
npm install -D @umage.ai/redline
npx redline init        # agent guide + AGENTS.md section, .redline/ in .gitignore (see Coding agents)
```

**Vite / React** (`vite.config.ts`). Put Redline first, before the framework plugin:

```ts
import redline from '@umage.ai/redline/vite'

export default defineConfig({ plugins: [redline(), react()] })
```

**SvelteKit**: the same, placed before `sveltekit()`.

**Astro** (`astro.config.mjs`). It only activates under `astro dev`:

```js
import redline from '@umage.ai/redline/astro'

export default defineConfig({ integrations: [redline()] })
```

**Other Node dev servers**: `@umage.ai/redline/server` exports `redlineMiddleware()` → `{ api, inject }`.

**Working on Redline itself**: build a checkout (`npm run dev`) and `npm link` it, or import
`<checkout>/dist/vite.js` directly from the app's config.

Options: `redline({ root, dir: '.redline', hotkey: 'alt+shift+r', launcher: true, jsxSource: true })`.
- `root` is where notes go and what source paths are relative to. It defaults to the nearest folder with `.git`.
- Set `launcher: false` to hide the small round button and rely on the hotkey only.
- `app` names the app in a monorepo; it defaults to the dev server's folder relative to `root`, e.g. `apps/web`.

**Monorepos** work without extra setup. Each app adds the plugin to its own dev server as above. Notes
from every app go to one `.redline/` at the repo root, tagged with the app (`pages/apps-web--settings.md`),
so two apps' `/` pages don't collide, and each app only pins its own notes (the panel's **All** tab
lists the others). Source paths are repo-relative (`apps/web/src/…`, `packages/ui/src/…`). Run
`npx redline init` anywhere in the repo: it sets up the repo root (`--here` installs in the current
folder instead, for when `root` points there).

### Extending

All optional and dev-only; without them Redline behaves as described above. Types (`RedlineApi`, `NoteStore`,
`SourceWriter`, …) come from `@umage.ai/redline/server`.

- **`directEdit: true`**: the text popover gets **Apply to file** when the edited text is static in source (Astro,
  Svelte, JSX, Vue, plain `.html`). Inline markup such as `<b>` and links is kept as written; Ctrl+B / Ctrl+I add it.
  Expressions like `{t('title')}`, components and rendered or translated text are refused with the reason, and you
  save a note as usual. `[myWriter(), ...defaultWriters()]` adds your own writers (i18n files, a CMS).
- **`store`**: a `NoteStore` (`version`, `list`, `create`, `update`, `remove`, `asset`), or `({ root, dir, app }) => store`,
  to keep notes elsewhere than markdown. **`hooks`**: `onCreate`, `onUpdate`, `onRemove`, `onSourceWrite`, run after each change.
- **`extensions`**: browser ES modules that add toolbar buttons (with keys), panel sections and event listeners.
  A file path is served as plain JS; `{ url: '/src/redline.ext.ts' }` lets Vite compile it. Scripts can also push
  onto `window.redlineExtensions`.

## Coding agents

Redline isn't tied to one agent. The notes are plain markdown, and `npx redline init` installs the
guide where agents look for it:

| Written | Read by |
|---|---|
| `.agents/skills/redline/SKILL.md` (always) | Agent Skills: Codex, Cursor, GitHub Copilot / VS Code, OpenCode, … |
| a Redline section in `AGENTS.md` (always; created if missing) | Codex, Cursor, Copilot, Windsurf, Zed, Amp, Jules, Devin, Factory, … |
| `.claude/skills/redline/SKILL.md` + a `CLAUDE.md` section | Claude Code (the skill also shows up as `/redline`) |
| a `GEMINI.md` section + `.gemini/commands/redline.toml` | Gemini CLI (`/redline`) |
| `.github/prompts/redline.prompt.md` | Copilot Chat in VS Code (`/redline`) |

The last three are added when the repo already uses that agent (`CLAUDE.md` or `.claude/`, `GEMINI.md`
or `.gemini/`, `.github/copilot-instructions.md`…), or when you ask: `npx redline init --agents=claude,gemini`
(`all` / `none` work too). Re-running `init` refreshes the guide after an upgrade.

**Copy prompt for your agent** in the notes panel copies a ready prompt, e.g. *Apply the open Redline
notes in .redline/pages/settings.md (3 open). Follow .agents/skills/redline/SKILL.md.* Without
`init`, the prompt spells out the note format itself, so any agent can work from it.

**MCP server** (optional): `npx redline init --mcp` registers `redline mcp` (`.mcp.json`, plus VS Code, Gemini, Cursor)
with `list_notes`, `get_note` (with the screenshot) and `update_note`. It goes through the running dev server, so a custom
`store` works; without one it reads `.redline/`. Codex: `codex mcp add redline -- npx -y @umage.ai/redline mcp`.

## What gets written

```
.redline/
  INDEX.md               page → open/done counts (regenerated on every change)
  pages/<page>.md        one file per URL path
  assets/<id>.png|svg    screenshots and sketches
```

```markdown
### [ ] Comment · `button` “Next” · src/components/LoginForm.tsx:48
<!-- redline {"id":"…","type":"comment","url":"http://localhost:5173/login","target":{"selector":"div > form > button",
  "source":{"file":"src/components/LoginForm.tsx","line":48,"col":9},"components":["LoginForm"],…},"viewport":[1366,860,1],"theme":"dark",…} -->

Make this full-width on mobile only.

![screenshot](../assets/mv6em12i784f.png)

> Added `sm:w-auto`; full width below 640px (LoginForm.tsx:48).
```

The markdown is the source of truth. Every write from the overlay re-reads the file first,
so an agent's ticks and replies are never overwritten. The overlay polls about every 2 s,
which is why replies appear without a reload.

## How source locations are found

| Stack | Source of `file:line` | Components |
|---|---|---|
| Svelte 5 / SvelteKit | `__svelte_meta` (built into Svelte dev builds) | `__svelte_meta.parent` chain |
| Astro | `data-astro-source-file/-loc` (snapshotted at parse time, because Astro's dev toolbar strips them) | `.astro` files up the tree |
| React 19 (Vite) | The plugin stamps `data-redline-src="file:line:col"` on HTML elements in `.jsx`/`.tsx` during dev | Fiber owner chain, with router and provider plumbing filtered out |
| Anything else | n/a | n/a. The selector, test id and text still identify the element. |

## Screenshots

By default the DOM is rendered to a canvas with
[modern-screenshot](https://github.com/qq15725/modern-screenshot). Page scroll and inner scroll
containers are reproduced. WebGL canvases, cross-origin map tiles and video may come out blank
this way. For those apps, tick **Pixel-perfect screenshots (tab capture)** in the panel. It
captures the real tab pixels, and Chrome asks once per page load.

## Develop

```bash
npm run dev         # rebuild dist/ on change (reload the app for client changes, restart it for server changes)
npm test            # unit tests (node:test) + docs check
npm run test:e2e    # Playwright against fixture apps: vanilla, React, SvelteKit, Astro
npm run check       # typecheck + unit + docs + e2e
npm run test:package   # install the packed tarball into fresh apps per framework and test it end to end
npm run smoke -- <url> "<selector>"   # pin a throwaway note on any running app
```

Releasing: on an up-to-date `main`, run `npm run release -- patch` (or `minor`, `major`, `x.y.z`). It bumps the
version, tags `v<version>` and pushes; [`publish.yml`](.github/workflows/publish.yml) then runs every check,
publishes to npm through Trusted Publishing and creates the GitHub release with generated notes.

Contributor and agent guidance is in [CLAUDE.md](CLAUDE.md). Project state, decisions, learnings and the
roadmap are in [docs/](docs/STATE.md#next-up).

## License

[MIT](LICENSE)
