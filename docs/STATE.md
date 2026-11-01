# State

Last updated: 2026-10-28 · Cap: 150 lines · Rewrite sections in place; this is a snapshot, not a log.

## Status

v0.5.0 published to npm as `@umage.ai/redline` (D4), MIT; public repo `umage-ai/redline`. Our internal apps (Astro,
React + Vite 7, SvelteKit) install it as a devDependency. The tarball ships only `dist/` (JS + `dist/types`), `skill/`,
README and LICENSE. Later releases go through `.github/workflows/publish.yml` (Trusted Publishing, D13).
`@umage.ai/redline-hub` (`hub/`, D44) is at 0.1.0, not yet published. The .NET packages (`dotnet/`, not yet published) are `UmageAI.Redline.AspNetCore`, `UmageAI.Redline.Build` and `UmageAI.Redline.Optimizely` (0.1.0).

## What works (covered by tests)

| Area | Status | Guarded by |
|---|---|---|
| Markdown format round-trip, agent edits kept, slugs | ✅ | `test/unit/format.test.ts` |
| Store: assets, INDEX.md, update/remove, concurrent agent edits | ✅ | unit |
| JSX source stamping (HTML tags only, with the enclosing component's name); Vue SFC template stamping | ✅ | `format.test.ts` |
| Script injection, comment mode, app never sees clicks | ✅ | `overlay.spec.ts` |
| Disabled controls pickable; autofocus doesn't eat mode keys | ✅ | `overlay.spec.ts` |
| Monorepos: per-app notes in one root `.redline/`, `init` from any folder (D17) | ✅ | `test/unit/monorepo.test.ts`, `overlay.spec.ts` |
| Any agent: `init` writes Agent Skills + AGENTS.md (+ Claude/Gemini/Copilot extras), asks first in a terminal, `--dry-run`; neutral copied prompt (D16) | ✅ | `test/unit/init.test.ts`, `overlay.spec.ts`, `npm run test:package` |
| Open dropdowns/popovers survive the overlay: toolbar, picking, typing, Escape, hotkey (D14) | ✅ fixture menu; try in `examples/demo` (Export, ⋯, driver filter) | `overlay.spec.ts`; not yet tried against real Radix/Headless UI/MUI |
| Parent / whole-page targeting | ✅ | `overlay.spec.ts` |
| Text mode → diff note | ✅ | `overlay.spec.ts` |
| Note labels (D46): chips above the text (Bug, UX, Idea, Copy; `labels` option, .NET `Labels`), one row that scrolls sideways, `#bug` shortcut; leads the heading, shown on cards and in the hub; same bytes in .NET | ✅ | `labels.test.ts`, `overlay.spec.ts`, golden `labels`, `MiddlewareTests.cs` |
| Labels from a function of the request (Node `labels`, .NET `LabelsFrom`); copy-prompt button hidden with non-markdown stores / online, or custom text via `prompt` (D47) | ✅ | `labels.test.ts`, `overlay.spec.ts`, `MiddlewareTests.cs` |
| Pluggable note store (`store`) and server `hooks`; markdown store is the default (D19) | ✅ | `test/unit/extend.test.ts` |
| The plugins answer this machine only (loopback + local Host; under Next the address Next's server saw, stamped before its proxy); `network` adds addresses, subnets, host names, or `true` for all; `redlineMiddleware` is open by default (D9) | ✅ Node (Docker Desktop checked by hand: callers show as the bridge gateway); not in .NET yet | `network.test.ts` |
| Direct source edits (`directEdit`, opt-in): dry run, **Apply to file**, refusals for computed text and directives; rich editor keeps inline markup (`<b>`, `<a …>`, entities) byte for byte, Ctrl+B/I add tags (D20); full HTML entity set, source entity spelling kept (D24); same-text elements on static .html picked by position (D25) | ✅ static .html, React, SvelteKit, Astro, Vue, Angular (templateUrl; inline templates unit only), Solid, Preact | `edit.test.ts`, `extend.test.ts`, `extend.spec.ts` |
| `redline mcp` (opt-in via `init --mcp`): list/get (with screenshot)/update notes through the running dev server, any store; markdown fallback; dev servers self-register (D22). Same tools over HTTP at `POST /__redline/mcp` (loopback, or `mcpTokens` bearer, D37) | ✅ | `mcp.test.ts` |
| Overlay extensions (`extensions`, `window.redlineExtensions`): buttons + keys, panel sections, events (D21); API v2: `removeButton`, `panelState` + `panel` event, `setPageKey` + `page` event (D26) | ✅ | `extend.test.ts`, `extend.spec.ts` |
| Page key option `pageKey: 'route' \| 'path'` (hash routes as pages, or not) (D26) | ✅ | `page.test.ts`, `extend.test.ts`, `extend.spec.ts` |
| Toolbar centred left of the open notes panel, wraps when short of room (phones: one scrolling row); `HEAD` answered on GET routes | ✅ | `extend.spec.ts`, `mobile.spec.ts`, `extend.test.ts` |
| Sketch: scroll recorded, svg + composited png, containing-element anchor | ✅ | `overlay.spec.ts` |
| Live agent replies, done/reopen/delete from the panel (assets removed) | ✅ | `overlay.spec.ts` |
| Panel cards show relative age ("3 weeks ago", exact stamp on hover); open notes over 14 days flagged amber as possibly stale. Skill asks agents to end replies with the fix commit hash | ✅ | `age.test.ts` |
| Source + components: React 19, SvelteKit 2 / Svelte 5, Astro 7, Vue 3.5, Solid 1.9, Preact 11 (Vite 8), Angular 22 (D23) | ✅ | `frameworks.spec.ts` |
| Angular CLI: `@umage.ai/redline:dev-server` builder wraps `ng serve` (middleware + dev-only template source locations); `ng build` untouched | ✅ Angular 22, real `ng serve` | `frameworks.spec.ts`, `extend.spec.ts`; not in `test:package` yet |
| Astro toolbar coexistence (attrs stripped, bar lifted) | ✅ | `frameworks.spec.ts` |
| Next.js (D48): `withRedline` in next.config + `<Redline />` in the layout; App Router (Server and Client Components) and Pages Router; file:line from stamps; component chain from React's owners + Server Component dev info (route-group layouts too); Apply to file; local MCP through Next too; `withRedline` keeps the config's type | ✅ Next 15.5, webpack and Turbopack (fixtures `next`, `next-turbo`); Next 16.4 checked by hand | `next.test.ts`, `frameworks.spec.ts`, `extend.spec.ts`; not in `test:package` yet |
| Sketch text labels (Enter commits once, Escape drops) | ✅ | `overlay.spec.ts` |
| Sketch colours: one swatch folds out a palette of six (halos), per shape, `C` cycles, remembered; kept in svg + png | ✅ | `overlay.spec.ts`, `mobile.spec.ts` |
| Phones/touch (360 px, Pixel 8 Pro at 125%): everything fits, tap to pick, swipe scrolls while picking, tap outside ends a text edit, sketch by finger, full-width panel, pins kept on screen; `examples/demo` is responsive | ✅ emulated | `mobile.spec.ts`; not yet tried on a real device |
| README screenshots from `examples/demo` | ✅ regenerated by `npm run screenshots` | not a test; rerun after UI changes |
| Promo video (LinkedIn 4:5, web 16:9) from `examples/demo` | ✅ recorded by `npm run promo` (needs ffmpeg); output in `promo/out/`, gitignored | not a test; storyboard in `promo/README.md` |
| Packed tarball installed into fresh React / SvelteKit / Astro / node:http apps, wired as the README says; types (bundler + nodenext); `redline init` | ✅ | `npm run test:package` (also `prepublishOnly`) |
| Markdown format identical in Node and .NET (escaping, numbers, key order, slugs, INDEX) | ✅ | `test/golden` via `golden.test.ts` and `GoldenTests.cs` |
| Direct-edit guards identical in Node and .NET (entities D24, spelling, `nth` D25, refusals); .NET also has `PageKey` (D26) and HEAD | ✅ | `test/golden/edit` via `edit.test.ts` and `EditGoldenTests.cs` |
| .NET (`dotnet/`, D30): API, markdown + SQL stores, hooks, Razor writer, servers.json, streaming injection; .NET 8/9/10 | ✅ | `dotnet test dotnet/tests/UmageAI.Redline.Tests` (net8.0, net10.0) |
| Razor Pages, MVC, Blazor Server/WebAssembly/streaming/enhanced nav: source stamps (D32), notes, `.cshtml` direct edits, dev HTTP MCP | ✅ samples on 5210/5211 | `npx playwright test -c dotnet/playwright.config.ts` |
| Optimizely CMS 12 (13 compiles): CMS content/property in notes, drafts from text mode, no overlay in edit mode (D33) | ✅ sample on 5212 (LocalDB) | `optimizely.spec.ts` with `REDLINE_E2E_OPTIMIZELY=1` |
| Online mode: role/policy-gated overlay and API, SQL store with author, remote MCP with site/personal tokens (D34–D36) | ✅ unit (TestServer, SQLite; SQL Server with `REDLINE_TEST_SQLSERVER`); browser on the Optimizely sample (LocalDB, panel token → MCP) | `OnlineTests.cs`, `StoreTests.cs`, `online.spec.ts`; not yet on a deployed site |
| NuGet packages: `dotnet pack dotnet/Redline.slnx` | ✅ installed into a fresh Razor Pages app (stamps + overlay) | manual; no package test script yet |
| Remote note store over HTTP (docs/PROTOCOL.md, D40): `remoteStore` / `REDLINE_STORE_URL` (Node), `UseRemoteStore` (.NET), reference server `notesProtocol`; store-only fields stripped from pages and kept out of markdown | ✅ | `remote.test.ts`, `RemoteStoreTests.cs` |
| Live changes: store feed → `/__redline/events` (SSE) → overlay re-reads at once; polling 30 s meanwhile (D41) | ✅ Node | `remote.test.ts`, `remote.spec.ts` |
| Resolved notes green with their reply, author on pins and cards, store link, `seen` sent once by the author (D42) | ✅ | `remote.spec.ts` |
| Redline hub (`hub/`, D44): projects, personal member/agent tokens, protocol + live feed at `/p/<project>`, MCP per project, allowed sites, D42 visibility (5 min after seen, 24 h max), UI (notes with screenshots, reply/resolve/archive, tokens with setup snippets), SQLite persistence, localhost default + `--host` warning | ✅ overlay → dev server → hub → green pin, in Chrome | `hub.test.ts`, `hub.spec.ts`, `scripts/test-hub-package.mjs` (in `test:package`) |
| Store calls carry the request (`ctx.req`) and `remoteStore` forwards per-reviewer `headers(ctx)`, so a shared site's notes carry each reviewer's name (D45); `examples/review-frontend`: shapes A (two images + gateway rule + reviewer switch), B (`reviewersOnly` in one server), C (review environment); store acting as the reviewer | ✅ unit; the pattern runs in production in a closed-source app, the example itself is not deployed here | `remote.test.ts`, `review-frontend.test.ts`, typecheck |
| Source stamps in `vite build` with `buildSource` (JSX, Vue, Svelte) and the `build` option on notes (D43) | ✅ unit | `svelte-source.test.ts`, `remote.test.ts`; not yet in an e2e build fixture |
| Pixel-perfect tab capture (getDisplayMedia) | ⚠️ manual only | needs a permission prompt, not automatable |

## Known gaps

- DOM screenshots: WebGL, cross-origin map tiles and video can come out blank; sticky headers are missing when scrolled. Workaround: tab capture.
- Text mode writes source only with `directEdit` and only static content (D20): text plus inline markup. i18n strings stay notes until a writer for them exists; CMS text has one only for Optimizely (drafts, D33). Links can't be added or retargeted in place.
- A custom store reaches agents only through `redline mcp` while a dev server runs (D22); SKILL.md describes the markdown files.
- Notes are keyed by pathname, so `/org/a/agents/1` and `/org/b/agents/1` are separate pages. There's no route-pattern grouping yet.
- CSS-only `:hover` menus still close when the pointer moves to the toolbar. Workaround: open the menu, then press `C` and click.
- Pins re-resolve by selector/testid/xpath/text. Heavily dynamic lists can re-pin onto the wrong row.
- Elements added after hydration in Astro have no source (the snapshot is taken at parse time).
- Remote stores: the .NET middleware has no change feed yet (the overlay polls). The hub is a reference for teams on a private network: plain HTTP, no SSO, rate limits or backups (D44); the .NET client is unit-tested against a stub, not yet against the hub.
- `buildSource` output is unit-tested per framework, not yet through a real `vite build` + `redlineMiddleware` fixture.
- Not supported yet (D23): Nuxt (HTML is rendered outside the Vite middleware), Qwik and Lit source locations. The Angular builder's schema is copied from Angular 22; newer `ng serve` flags need angular.json options until it is refreshed.
- Next.js: the live feed (`/events`, remote stores) and bodies over 10 MB through Next's proxy (it buffers them when the app has `middleware.ts`) are untested; Next before 15 is untested.
- `extend.spec.ts` Astro case once timed out tearing down while all eight fixture servers ran; it passed on rerun and alone.
- .NET: apps under a `PathBase` aren't supported (the client calls `/__redline` at the root); hot reload compiles unstamped files; Optimizely rich text (XhtmlString), local-block property paths and CMS 13 at runtime are untested; online mode not yet tried behind a CDN.

## Next up

1. Verify a dev server behind a reverse proxy (HTML through the proxy, `/__redline` routing, HMR unaffected).
   Run the publish workflow once on GitHub (dry run): the e2e and package tests have only run on Windows so far.
2. Presentations (static Reveal decks on `redlineMiddleware` + a deck writer + an extension): drop its workarounds now
   that Redline has the entity set, nth, API v2 and `pageKey` (D24–D26).
3. Chrome extension reusing `dist/client.js` + `captureVisibleTab`, for non-Vite apps and staging (with a `redline serve` store).
4. Route-pattern grouping (SvelteKit route id, React Router match) so dynamic URLs share one notes file.
5. Try `redline mcp` (stdio and HTTP) with Claude Code, Codex and Copilot on a real app; consider showing in the copied prompt when MCP is set up.
6. Labels (D46): change one after saving, filter the panel by label, colour the pins; see how long lists feel.
7. .NET: a package test (pack → install → browser) like `test:package`; an Optimizely 13 sample; CI for `dotnet test` and the .NET smoke.
