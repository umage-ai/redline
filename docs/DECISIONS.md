# Decisions

Last updated: 2026-10-15 · Cap: 200 lines · Format: `## D<n> — title (date)` then Decision / Why / Revisit if.
Amend an entry when it changes; mark superseded ones `(superseded by Dn)` instead of deleting them.

## D1 — Dev-server plugin first, Chrome extension later (2026-10-13)
- **Decision:** ship as a Vite plugin (plus an Astro wrapper and a generic connect middleware) that serves the client and writes files.
- **Why:** the dev server can write straight into the repo and knows the root. It's dev-only by construction, and all the apps we built it for run on Vite. An extension can't write to disk without a helper process.
- **Revisit if:** we need non-Vite apps or staging/prod URLs. The extension would reuse `dist/client.js`.

## D2 — Markdown is the source of truth, with JSON anchors in HTML comments (2026-10-13)
- **Decision:** one `.md` per page; each note is a `### [ ]` heading, a `<!-- redline {json} -->` anchor, the body and a `> ` reply. No separate JSON store.
- **Why:** agents read, grep, diff and edit it directly; humans can read it. The format is modelled on an earlier in-house
  slide-review tool (a REVIEW.md checklist with sketches, applied by an agent skill), where it had already proven itself.
- **Revisit if:** concurrent multi-user editing is needed (it would want a real store or a CRDT).

## D3 — `.redline/` is gitignored (2026-10-13)
- **Decision:** `redline init` adds `.redline/` to `.gitignore`.
- **Why:** user call. Feedback is a local work queue, merge collisions on shared markdown would be painful, and team knowledge belongs elsewhere.

## D4 — Distribute as the public npm package `@umage.ai/redline` (2026-10-13, amended)
- **Decision:** publish to npmjs under MIT; apps add it as a normal devDependency and import `@umage.ai/redline/vite` (or `/astro`, `/server`).
- **Before:** consumers dynamically imported `<REDLINE_PATH | ../redline>/dist/...` from a sibling checkout and skipped it if absent,
  because a `file:` devDependency breaks `npm ci` on CI runners without the sibling. That still works for hacking on Redline itself.
- **Why changed:** more than one team and app want it, and a registry package needs no sibling checkout. The unscoped name `redline` is taken; the npm org is `umage.ai`, hence the dotted scope.

## D5 — Inject via HTTP response buffering, not framework hooks (2026-10-13)
- **Decision:** a middleware buffers `text/html` responses and inserts the script before `</body>`.
- **Why:** Vite's `transformIndexHtml` doesn't run for SvelteKit SSR or Astro pages. One mechanism covers all of them.
- **Cost:** must handle `writeHead` and content-length correctly (L1). Compressed responses are skipped.

## D6 — Text mode suggests, never writes source (2026-10-13)
- **Decision:** text edits happen in an overlay `contenteditable` copy and are saved as a `diff` note. The app DOM is never touched.
- **Why:** mapping DOM text back to source is unreliable across frameworks and content stores (i18n, CMS). Mutating framework-owned DOM breaks React reconciliation. The agent applies it with full context.

## D7 — Source location via framework dev metadata, plus a JSX stamp for React (2026-10-13)
- **Decision:** use `__svelte_meta` and `data-astro-source-*` as given. For React, a dev-only transform stamps `data-redline-src` on known HTML tags.
- **Why:** React 19 removed `_debugSource`. An allowlist avoids breaking renderers that use lowercase JSX (react-three-fiber).

## D8 — DOM screenshots by default, tab capture opt-in (2026-10-13)
- **Decision:** modern-screenshot renders the viewport and recreates page and inner scroll offsets. A panel toggle switches to `getDisplayMedia` tab capture.
- **Why:** no prompts in the common case. Tab capture is pixel-perfect (WebGL, maps) but Chrome asks once per page load.

## D9 — Mutations require an `x-redline: 1` header, not an Origin check (2026-10-13)
- **Why:** behind a reverse proxy (e.g. YARP) the Host doesn't match the browser Origin. A custom header forces a CORS preflight from other sites, which we never answer.

## D10 — Single package, flat `dist/`, client served by the middleware (2026-10-13)
- **Decision:** one package with subpath entries (`vite`, `astro`, `server`, `client.js`). The client is a prebuilt bundle read from disk by the handler.
- **Why:** linking by path is trivial, and the consumer's bundler never resolves Redline's client deps.

## D11 — Tests: node:test for logic, Playwright with one fixture app per framework (2026-10-13)
- **Why:** node:test runs `.ts` with no extra tooling. Fixture apps (vanilla, React, SvelteKit, Astro) catch framework-specific breakage that unit tests can't. They run serially because each fixture owns one `.redline/`.
- **Versions:** the fixtures track the apps we use it on: Vite 8 (7 also in use), SvelteKit pinned to 2.x (3.x exists), Svelte 5, React 19, Astro 6.

## D12 — Toggle with Alt+Shift+R; single-letter keys only while the overlay is open (2026-10-13)
- **Decision:** a global chord opens and closes the overlay. `C`/`T`/`S`/`N`/`Esc` work only while it's open and focus isn't in a field. The hotkey is configurable (`hotkey` option).
- **Why:** the slide-review tool used bare letters, which collide with typing and app shortcuts in real web apps. A small launcher button is shown by default (`launcher: false` hides it).

## D13 — Release from GitHub Actions with npm Trusted Publishing (2026-10-13)
- **Decision:** a published GitHub release `v<version>` runs `.github/workflows/publish.yml`: `npm run check`, `npm run test:package`, then `npm publish` authenticated by OIDC. A manual run defaults to `--dry-run`.
- **Why:** no long-lived npm token to leak or rotate (npm warns against bypass-2FA tokens), the account's 2FA stays on, and public-repo releases get provenance. The first version (0.1.0) was published by hand because a trusted publisher can only be configured on an existing package.
- **Revisit if:** releases need to come from somewhere other than this repo's workflow.

## D14 — Shield the app from the overlay's own events (2026-10-15)
- **Decision:** `shieldApp` in `src/client/index.ts` hides overlay input from the app: bubble listeners are cut at the host, document capture listeners at `window` (our pointerdown/pointerup/keydown are re-dispatched as non-composed copies inside the shadow root), and app blur/focusout/pointerout towards the overlay are hidden. Opening the overlay only blurs text fields, quietly.
- **Why:** dropdowns, popovers and comboboxes close on any outside press, focus move or Escape, so reviewers couldn't comment on them. Alternatives: an iframe toolbar (window blur still closes Headless UI menus) or a "comment in 3 s" timer (clumsy; still a fallback for CSS `:hover` menus, which no event shield can keep open).
- **Revisit if:** an app listens on `window` in the capture phase before Redline loads, or a kit dismisses on `click` in the capture phase without a preceding pointerdown.

## D15 — Saving a note returns to idle (2026-10-15)
- **Decision:** after a comment or text note is saved, the mode goes back to idle (sketch already did). Cancelling a draft keeps the mode, since that usually means re-picking.
- **Why:** staying in comment mode surprised reviewers: the next tap made another note instead of using the app, which is what you want between notes (open a menu, navigate). `C` or one tap on **Comment** starts the next one.
- **Revisit if:** people batch many comments in a row and ask for a "keep mode" option.

## D16 — Agent-neutral: open standards first, per-agent extras on top (2026-10-15)
- **Decision:** `redline init` always writes the skill to `.agents/skills/redline/SKILL.md` (Agent Skills) and a section to `AGENTS.md`; Claude (skill + CLAUDE.md), Gemini CLI (GEMINI.md + `/redline` command) and Copilot (`/redline` prompt file) are added when detected or asked for with `--agents`. Cursor, Codex, Windsurf, Zed, Amp, Jules… need nothing extra. The panel's prompt names the installed guide (`/config` → `guide`) or spells out the contract inline.
- **Why:** teams use different agents. Those two files are read natively by most of them; per-agent files only where they add a command or the agent ignores AGENTS.md. One guide file avoids drift; new CLAUDE.md files import AGENTS.md.
- **Revisit if:** Claude Code or Gemini CLI read `.agents/skills` and AGENTS.md by default (drop the extras), or an MCP server becomes worth it (STATE next-up).

## D17 — Monorepos: one `.redline/` at the repo root, notes tagged per app (2026-10-15)
- **Decision:** root stays the nearest `.git`. Each handler derives `app` = its dev server folder relative to root (`apps/web`; option `app` overrides). The server stamps it on new notes, page files get an app prefix (`apps-web--index.md`), INDEX.md gains an App column, and the overlay pins/numbers only its own app's notes. `init` installs at the repo root unless `--here`.
- **Why:** agents usually run at the repo root and need one inbox; repo-relative source paths also cover shared packages. A `.redline/` per app would split the inbox and need per-app guides. Single-app repos keep `app: ""` and their old file names.
- **Revisit if:** two dev servers serve the same app folder (e.g. Storybook + app) and should be told apart; set `app` explicitly meanwhile.

## D18 — No hint line above the toolbar; extras in tooltips (2026-10-15)
- **Decision:** the per-mode hint above the bottom bar is gone. Buttons show their keys; the non-obvious bits (Alt+click = parent, Shift+click = whole page, Ctrl+Z, Esc) are in the button tooltips, and the popover's **↑ Parent** / **Page** buttons cover touch.
- **Why:** it mostly repeated the visible key labels and sat over the page. Less chrome over the app being reviewed.
- **Revisit if:** new users miss the modifiers; then a one-time first-run tip, not a permanent line.
