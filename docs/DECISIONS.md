# Decisions

Last updated: 2026-10-16 · Cap: 200 lines · Format: `## D<n> — title (date)` then Decision / Why / Revisit if.
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

## D6 — Text mode suggests by default; source writes are opt-in (2026-10-13, amended 2026-10-15)
- **Decision:** text edits happen in an overlay `contenteditable` copy and are saved as a `diff` note. The app DOM is never touched. With `directEdit` on, a source writer may write the change to the file instead (D20); the default is unchanged.
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

## D13 — Release from GitHub Actions with npm Trusted Publishing (2026-10-13, amended 2026-10-15)
- **Decision:** `npm run release -- patch|minor|major` on an up-to-date main (`scripts/release.mjs`) bumps the version, commits "Release vX.Y.Z", tags `vX.Y.Z` and pushes. The tag runs `.github/workflows/publish.yml`: tag = package.json and on main, `npm run check`, `npm run test:package`, `npm publish` authenticated by OIDC, then a GitHub release with generated notes. A manual run defaults to `--dry-run`.
- **Amended:** releases used to be triggered by publishing a GitHub release by hand; one command on main is less to forget and keeps version, tag and notes in step.
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

## D19 — Pluggable note store and server hooks; markdown stays the default (2026-10-15)
- **Decision:** the handler talks to a `NoteStore` (`version/list/create/update/remove/asset`, `src/server/store.ts`). Option `store` takes one, or a factory that gets `{ root, dir, app }`; default `createStore` (markdown, D2). `hooks` (`onCreate/onUpdate/onRemove/onSourceWrite`) run after a change is stored; their errors are logged, never returned.
- **Why:** lets notes land elsewhere (a CMS, a DB, a hosted service later) and lets teams log or notify without forking a store. `asset()` replaced the file path the handler used to read, so stores needn't be files.
- **Revisit if:** a remote store needs concurrency control: add a version precondition to `update` rather than a second interface. The agent contract (SKILL.md) assumes markdown; other stores reach agents through `redline mcp` (D22).

## D20 — Direct source edits: opt-in writers, dry run first, refuse anything not static (2026-10-15)
- **Decision:** `directEdit: true` (or a `SourceWriter[]`) adds **Apply to file** to the text popover. The overlay sends `POST /__redline/edit?dry=1` first and offers the button only if a writer accepts; otherwise it says why and the edit stays a note. Built-ins: `markupWriter` (element at the framework's `file:line:col` in .astro/.svelte/.jsx/.tsx/.vue/.html) and `staticHtmlWriter` (plain .html served from disk: the one element of that tag whose text matches). A write needs the element's source content to be static and its text equal to what the page showed: no `{…}` (in text or attributes), no comments, components or block elements; the file must be unchanged since the check and inside the root (not node_modules/.git/notes).
- **Inline markup (rich edits):** when text mode opens, `?inspect=1` returns the content as tokens (text + inline tags from an allowlist). The overlay then edits a copy that holds those tags, each tagged with its token index, and serialises back with the original tags byte for byte (JSX `className`, quotes, attribute order) and unchanged text verbatim (entities kept). The server accepts only the original tags plus `<b> <i> <u> <s> <em> <strong> <br>`, balanced, with text matching. Paste is plain text. This is the presentations editor's idea (`../presentations/shared/editor.js`: source HTML in the editor, re-check at commit) without its positional alignment, since we have `file:line` or a unique text match.
- **Why:** reviewers fix copy faster than an agent round trip, but only where the text is truly static; refusing is cheap because the note path still works. Writers are replaceable per stack (i18n JSON, a CMS such as Optimizely). Rebuilding tags from the DOM would rewrite JSX attributes and entities; keeping raw tokens makes the diff only what the reviewer changed.
- **Revisit if:** reviewers need to add links or change attributes (needs a small link UI and attribute validation), or a writer must handle text split across components.

## D21 — Overlay extensions: ES modules with a small API (2026-10-15)
- **Decision:** option `extensions` lists browser modules (file paths served at `/__redline/ext/<i>.js`, or `{ url }` for a dev-server URL such as a Vite-compiled `.ts`); scripts can also `(window.redlineExtensions ||= []).push(fn)`. The default export gets `RedlineApi` (`src/shared/extension.ts`): toolbar buttons with keys, panel sections, events (`open/close/mode/notes/noteCreated/sourceWritten`), and open/close/mode/toast/notes/refresh. Built-in keys win; extension errors are caught.
- **Why:** the presentations editor needs deck-specific actions (deck switcher, go-to-slide, preview, + Slide, settings, studio jobs) to move onto Redline and get its updates. Loading by the dev server keeps it dev-only.
- **Revisit if:** extensions need to change notes before save or add modes; extend the API, don't expose internals.

## D22 — `redline mcp`: notes as MCP tools, through the running dev server (2026-10-15)
- **Decision:** a stdio MCP server in the CLI (`src/mcp.ts`, hand-rolled JSON-RPC, no SDK dependency) with `list_notes`, `get_note` (note as the markdown section + screenshot image) and `update_note` (reply, done). It finds dev servers in `<root>/.redline/servers.json` (each registers on listen and on its first `/__redline` request; dead pids pruned) and uses the first that answers. With none, it uses the markdown store directly; with `--url`, it fails clearly instead. `init --mcp` registers it (`.mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.cursor/mcp.json`), as `node <path to the installed cli.js> mcp` when inside the repo (no `npx`/`cmd /c` issues on Windows).
- **Why:** with a custom store (D19) the files aren't there for the agent. Going through the dev server's API keeps one source of truth for every store, and is the same API a hosted version would expose. The skill (files) stays the zero-setup path; MCP is opt-in.
- **Revisit if:** agents need notes while no dev server runs and the store isn't markdown (then stores need a CLI-side factory), or MCP gains a standard way to push note changes (subscriptions).

## D30 — .NET: a C# port of the server, not a proxy to Node (2026-10-16)
- **Decision:** `dotnet/` holds NuGet packages (`Umage.Redline.AspNetCore`, `.Build`, `.Optimizely`) that reimplement the server side in C#: the `/__redline` API with the same routes and JSON, the markdown store, writers, `servers.json`. The browser bundle is not forked: `dist/client.js` is embedded at build time (the csproj runs `npm run build` if it's missing).
- **Why:** a .NET team shouldn't need Node at runtime, and Optimizely sites deploy as plain ASP.NET Core. The format is the risky part, so `test/golden` holds fixtures both test suites must reproduce byte for byte (JS `JSON.stringify` escaping, number printing and key order are ported in `Js.cs`).
- **Revisit if:** the two servers drift in behaviour beyond the format (then share behaviour fixtures for the API too), or a hosted Redline makes per-stack servers unnecessary.

## D31 — .NET injects the overlay as the response streams, before `</head>` (2026-10-16)
- **Decision:** the middleware runs first in the pipeline (an `IStartupFilter`; `ManualPlacement` + `app.UseRedline()` to move it) and wraps the body in a stream that inserts the script before the first `</head>` (else `</body>`, else at the end), holding back at most a partial tag between writes. Content-Length is dropped in `OnStarting`.
- **Why:** Blazor's streaming rendering and enhanced navigation flush the page in parts; buffering whole responses (as the Node injector does) would hold them back. The client already re-mounts its root if a DOM patch removes it, and an ES module runs once, so enhanced navigation keeps one overlay.
- **Revisit if:** an app compresses responses before Redline sees them (they pass through without the overlay today).

## D32 — Razor source lines: compile stamped copies in Debug builds (2026-10-16)
- **Decision:** an MSBuild task (`Umage.Redline.Build`) runs after the Razor SDK collects its inputs and swaps each `.cshtml`/`.razor` AdditionalFile for a copy in `obj/…/redline-src/` whose HTML elements carry `data-redline-src="path:line:col"` (repo-relative), keeping all item metadata (TargetPath, CssScope). Lines don't move, and `PathMap` maps the copies back so PDBs name the originals. Only lowercase tags from the same allowlist as the JSX stamp; a conservative scanner follows Razor's `@` transitions and C# strings, and leaves a file it can't follow unstamped. Off in Release, design-time builds and `dotnet watch`.
- **Why:** Razor has no runtime source metadata (no `__svelte_meta`, no fiber `_debugSource`), and a tag helper can't see line numbers. Rewriting copies needs no change to the app's files, works the same for MVC, Razor Pages and Blazor (also WebAssembly, by referencing the build package in the `.Client` project), and the existing client reads the attribute unchanged.
- **Revisit if:** the Razor compiler gains a source-mapping hook, or hot reload of stamped files is needed (it compiles the originals).

## D33 — Optimizely: name the CMS content in notes, edit drafts, stay out of edit mode (2026-10-16)
- **Decision:** `AddRedlineOptimizely()` (CMS 12 on .NET 8, CMS 13 on .NET 10) keeps the overlay out of the CMS UI and edit/preview frames, and on overlay pages only stamps `data-redline-cms="<content>|<property>"` from `PropertyFor` (a `display:contents` wrapper), `epi-property` (tag helper) and content area items. Before a note is stored, a hook adds the content's name, type, language and edit link (`target.cms`); the heading then names the CMS property instead of the template line. Text mode on a plain string property saves a draft via `IContentRepository` (`SaveAction.Default` on the common draft, `AccessLevel.Edit`), never publishes.
- **Why:** on a CMS page most text is content: a `.cshtml` line sends the agent to the wrong place. Edit mode already has Optimizely's own overlay and `data-epi-*`; running inside it would fight over clicks. View mode has no property markup, so we add our own, only where the reviewer sees the overlay.
- **Revisit if:** rich text (XhtmlString) edits are wanted (needs an HTML-aware writer), or local blocks need full property paths.

## D34 — Online mode: overlay and API only for authorized reviewers (2026-10-16)
- **Decision:** `o.Online = true` runs Redline in any environment, but only for users who pass `Policy` (or have one of `Roles`; Optimizely defaults to the editor roles). Everyone else gets no script and 404 from `/__redline` (not 401: the endpoint isn't advertised). The middleware authenticates with the default scheme itself, so it can sit before `UseAuthentication`. Mutations need `x-redline: 1` and a same-origin `Origin` (or `Sec-Fetch-Site`); overlay pages get `Cache-Control: no-store, private`. File writers are off; content writers run under the user's rights. Notes record `author`.
- **Why:** reviewing a staging or production site is the common CMS workflow. A custom header plus origin check stops cross-site requests under cookie auth without changing the client (no antiforgery token plumbing). Never caching overlay pages keeps a CDN from serving the script to visitors.
- **Revisit if:** sites need CORS (a separate admin origin) or reviewers outside the site's own login.

## D35 — Remote MCP over HTTP with bearer tokens (2026-10-16)
- **Decision:** `POST /__redline/mcp` serves the `redline mcp` tools over MCP's Streamable HTTP transport, stateless (JSON responses, no sessions or SSE; GET is 405). Callers need `Authorization: Bearer`: site tokens configured as SHA-256 hashes (`o.Mcp.TokenHashes`), or personal tokens a reviewer creates in the overlay panel (an extension served by the package, D21), stored hashed with the notes and acting as that user. In development, loopback calls need no token unless site tokens are set. The reviewer's cookie never authorizes MCP.
- **Why:** agents can't read a production database's notes from files, and a bearer header is what Claude Code, Cursor and VS Code send for HTTP MCP servers. Hashes mean a database or config leak doesn't leak tokens.
- **Revisit if:** clients expect OAuth for remote MCP, or the Node handler gets the same endpoint (planned: same tools, same auth).

## D36 — Online notes in SQL over plain ADO.NET, assets in the database (2026-10-16)
- **Decision:** `SqlNoteStore` keeps notes, screenshots/sketches, personal tokens and a version counter in four `Redline*` tables, created on first use, through `DbConnection` (SQL Server and SQLite dialects). A note row stores the same JSON the markdown anchor holds. Optimizely uses the CMS database by default.
- **Why:** an Optimizely site already has SQL Server; EF Core would add a dependency and migrations for four tables, and its `EnsureCreated` does nothing in an existing database. Dynamic Data Store is CMS-only and slow to query. Assets are small PNGs and a review tool's volume is low, so a blob provider isn't worth the setup.
- **Revisit if:** many reviewers or large screenshots make the database the wrong place for assets (move them to the CMS blob provider behind `AssetAsync`).
