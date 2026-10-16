# Learnings

Last updated: 2026-10-16 · Cap: 200 lines · Format: `## L<n> — symptom` then Cause / Fix / Guard.
Prune entries whose cause is gone from the code.

## L1 — `net::ERR_INVALID_HTTP_RESPONSE` on every HTML page
- **Cause:** the injector replaced `res.writeHead` to hold headers back. Node's own `end()` calls `res.writeHead` internally (`_implicitHeader`), and the wrapper swallowed it, so the body went out with no status line.
- **Fix:** restore the original `writeHead` and `write` right before the final `end()` (`htmlInjector`).
- **Guard:** every e2e test (the page wouldn't load).

## L2 — Astro: no source location although the HTML has `data-astro-source-*`
- **Cause:** Astro's dev toolbar strips those attributes from the DOM after load.
- **Fix:** the injector adds an inline classic `<script>` that snapshots them into `window.__redlineSrc` (WeakMap) during parsing, before any module script runs.
- **Guard:** `frameworks.spec.ts` (astro cases).

## L3 — Clicking some buttons opened no popover
- **Cause:** browsers fire no `click` on disabled form controls. Pointer events still fire.
- **Fix:** pick on `pointerup` (button 0); keep blocking `click` and the rest.
- **Guard:** `overlay.spec.ts` "disabled buttons can be picked".

## L4 — `C`/`T`/`S` typed into the page instead of switching mode
- **Cause:** pages with an autofocused input (e.g. a login form). Mode keys are correctly ignored while typing.
- **Fix:** opening the overlay blurs the active page element.
- **Guard:** `overlay.spec.ts` "blurs an autofocused input".

## L5 — Lowercase JSX isn't always HTML
- **Cause:** react-three-fiber uses `<mesh>`, `<line>`, `<audio>`. An unknown `data-*` prop is applied to the three.js object and breaks.
- **Fix:** `jsx-source.ts` stamps only an HTML-tag allowlist (no `audio`, `video`, `object`, `line`).
- **Guard:** unit "jsx stamping touches only html tags".

## L6 — Vitest runs Vite in serve mode
- `apply: 'serve'` alone would load Redline into unit-test runs (any app that uses Vitest). The plugin returns `[]` when `process.env.VITEST` is set.

## L7 — Blank React page in e2e: 504 "Outdated Optimize Dep"
- **Cause:** fixture dev servers running side by side shared `node_modules/.vite`, so each re-optimisation invalidated the others.
- **Fix:** `cacheDir: '.vite-cache'` per fixture. React deps are also pre-included.
- **Related:** after a config change Vite re-optimises once and may log transient errors (seen with Keystatic in an Astro site). A second start is clean.

## L8 — SvelteKit: element found but no `__svelte_meta`
- **Cause:** the SSR HTML is visible before hydration, and the meta is attached during hydration.
- **Fix (tests):** `openOverlay` waits for `networkidle`. A real user won't click within milliseconds of load.

## L9 — Theme detected as dark on a light page
- **Cause:** the fallback used `prefers-color-scheme`, and headless/OS settings are often dark.
- **Fix:** explicit markers (`.dark`, `data-theme`) first, then page background luminance, then the media query.

## L10 — Inner scroll containers in DOM screenshots
- **Problem:** modern-screenshot clones the DOM, and clones lose their `scrollTop`.
- **Fix:** before capture, mark the children of scrolled containers (and of `<body>` for page scroll) with their offset, then translate the clones in `onCloneEachNode`. Fixed elements are skipped, so sticky headers are still lost.

## L11 — Sketch label added twice; Escape kept it anyway
- **Cause:** removing a focused `<input>` fires `blur` synchronously. Enter → commit → `remove()` → blur → commit again (and `remove()` threw); Escape → `remove()` → blur → commit.
- **Fix:** a `closed` guard in `SketchLayer.textAt`, so the first close wins.
- **Guard:** `overlay.spec.ts` "sketch text label: Enter adds it once, Escape drops it".

## L12 — Source path came out as `../../../../Users/…/index.astro`
- **Cause:** root came from cwd as a Windows 8.3 short path (`C:\Users\MORTEN~1\…`) while the framework reported the long one, and `path.relative` compares strings. Symlinks do the same (macOS `/var` → `/private/var`).
- **Fix:** `normaliseSource` compares `realpathSync.native` of both. (Vite itself 403s on short-path roots, so `test-package.mjs` uses the canonical temp path.)
- **Guard:** unit "source paths are repo-relative even when root is reached through a link".

## L13 — Tooling: shell-quoted code edits on Windows lose backslashes
- Editing code through `node -e "…"` or bash heredocs mangled regexes (`\d` became `d`, `\(` became `(`) and broke theme detection and a filter, with no compile error.
- **Rule:** make code edits with the Edit/Write tools, not shell string-replacement.

## L14 — Keys pressed right after a popover opens are lost or switch modes (tests only)
- **Cause:** the popover focuses its textarea in a `setTimeout`. Typing earlier hits the page: `S` of "Switch" started a new sketch, `Enter` saved nothing. Showed up as CI-only flakiness on the slower Linux runner.
- **Fix:** tests and scripts wait for the textarea to be focused before typing (`comment` helper, text-mode test, `screenshots.mjs`).
- **Guard:** `overlay.spec.ts` text-mode and whole-page tests (every test waits for focus before typing).

## L15 — On a phone the page can't be scrolled in comment/text mode
- **Cause:** the capture listener called `preventDefault()` on `touchstart`, which cancels scrolling.
- **Fix:** `touchstart`/`touchmove` are only hidden from the app (passive, `stopImmediatePropagation`). A scroll fires `pointercancel`, so only a tap reaches the `pointerup` that picks.
- **Guard:** `mobile.spec.ts` "a finger can still scroll the page while picking". Note: CDP `Input.synthesizeScrollGesture` didn't scroll the page at all here; the test uses raw `Input.dispatchTouchEvent`.

## L16 — Sketch toolbar buttons did nothing when clicked or tapped
- **Cause:** `SketchLayer` appended its full-screen `<svg>` to the shadow root after `.rl`, so it painted over `.tools`. Desktop tests only used the `1`–`4`/`Enter` keys.
- **Fix:** the svg is inserted into `.rl` before the toolbar. Also: label inputs are created on `pointerup` for touch (focus opens the keyboard only with user activation).
- **Guard:** `mobile.spec.ts` "sketch on touch…". Test quirk: after a raw CDP touch drag, Chrome drops the `click` of the next synthetic tap, so that test draws last.

## L17 — Shield gotchas: dispatched clicks re-run activation; own blurs must pass
- Re-dispatching a copy of `click` runs activation behaviour again, so a checkbox toggled twice. `click` is only cut at the host bubble phase, never copied.
- The "focus went to body right after pressing the overlay" rule first swallowed the overlay's *own* editor blur, so tapping outside a text edit stopped finishing it. It now skips events from the overlay.
- **Guard:** `overlay.spec.ts` "an open dropdown stays open…" (checkbox step) and `mobile.spec.ts` "text mode: tapping outside…".

## L18 — After a reload with the overlay open, mode keys typed into the page
- **Cause:** the open state is restored from sessionStorage without going through `setOpen`, so an autofocused input kept focus and swallowed `N`/`C`.
- **Fix:** `releaseTextFocus()` also runs at the end of boot when the overlay comes back open.
- **Guard:** `overlay.spec.ts` "the copied prompt works for any agent…" (reloads, then presses `N`).

## L19 — Centred fixed toolbar wrapped its labels at 1280 px
- **Cause:** `position: fixed; left: 50%; transform: translateX(-50%)` sizes shrink-to-fit against the space right of `left`, i.e. 50vw. Once the sketch tools (with colour swatches) passed 640 px, the buttons were squeezed and "▭ Box" broke onto two lines.
- **Fix:** `.tools { width: max-content; max-width: calc(100vw - 16px); flex-wrap: wrap; white-space: nowrap }`: one row when it fits, whole buttons wrap when it doesn't.
- **Guard:** none automated (layout); `mobile.spec.ts` checks the tools fit 360 px. Re-check by eye after adding toolbar items.

## L20 — First tag release: `npm publish` 403 "OIDC permission denied for this action"
- **Cause:** npm trusted publishers allow only `npm stage publish` by default (since Sept 2026); a direct `npm publish` needs "Allow npm publish" ticked in the package's Trusted Publisher settings. Dry runs never authenticate, so they didn't show it.
- **Fix:** ticked (and saved) "Allow npm publish" (D13: fully automatic releases; the alternative is `npm stage publish` + a 2FA approval per release) and re-ran the failed job. The tag didn't need to move.
- **Also:** after a green publish, npm says "being processed"; the version showed up on the registry ~2 minutes later.
- **Guard:** the note at the top of `publish.yml`.

## L21 — Astro 404s a page file created just before the test navigates to it
- **Cause:** Astro's dev server registers new routes from a file watcher; a page written moments before `page.goto` can be requested before the route exists (it passed once, then 404'd).
- **Fix:** the edit e2e pages are permanent fixture files (`test/fixtures/{vanilla/edit.html,astro/src/pages/edit.astro}`) that the test resets before and after, instead of creating and deleting them.
- **Guard:** `extend.spec.ts` (direct edit cases).

## L22 — Angular builder: "Cannot find tsconfig", "Unknown argument: port", builder not loading
- **Cause:** (1) Angular purges `.angular/cache` when the dev server starts, so a tsconfig generated there vanished before the compile. (2) `ng serve --port` flags are parsed against the *builder's* schema; ours listed only `redline`. (3) Architect loads builders with `require()`, so an ESM builder with top-level await fails (`require(esm)` refuses TLA).
- **Fix:** the generated tsconfig lives in `node_modules/.cache/redline/`; `src/angular-schema.json` copies `@angular/build`'s dev-server schema; `src/angular.ts` resolves Angular packages synchronously with `createRequire` from the workspace.
- **Guard:** the Angular fixture is started with `--port` (`test/e2e/fixtures.ts`), and `frameworks.spec.ts` checks the template line.

## L23 — Angular's template locations are 0-based; inline templates report the .ts file
- **Cause:** `data-ng-source-location="src/app/card.ts@o:190,l:6,c:4"`: `l`/`c` are 0-based (ParseLocation), and for an inline template the path and line are the component file's.
- **Fix:** the overlay adds 1 to both; the markup writer edits inline templates in `.ts` files (only with `@Component(`; refuses `` ` ``, `\` and `${` in the new text).
- **Guard:** `frameworks.spec.ts` (inline template line and column), `extend.test.ts` (Angular templates).

## L24 — A fixed bar centred with `left: 50%; translateX(-50%)` wraps at half the viewport
- **Cause:** a shrink-to-fit fixed box only gets the room right of `left`, so once `flex-wrap` is allowed it wraps at 50% width (nowrap had hidden that).
- **Fix:** `left: 8px; right: calc(8px + var(--panel-w)); width: fit-content; margin: 0 auto` centres it with the full room available.
- **Guard:** `extend.spec.ts` ("toolbar moves clear of the panel": centred when closed, wraps beside the panel at 760 px).

## L25 — Same-text edit refused on a Reveal deck ("2 <p> elements have this text") though the DOM has 3
- **Cause:** `nthOf` compared `innerText`, which is `''` for `visibility:hidden` elements, and Reveal hides every slide but the current one, so the hidden copies weren't counted and `nth` was never sent.
- **Fix:** also match on normalised `textContent` (`src/client/index.ts` `nthOf`).
- **Guard:** `extend.spec.ts` ("same-text elements (one hidden, like a Reveal slide)").

## L30 — A note vanished after saving: U+2028 in its anchor JSON
- **Cause:** `JSON.stringify` leaves U+2028/2029 raw, and `.` in the anchor regex doesn't match them, so the `<!-- redline … -->` line no longer parsed and the note was dropped on the next read.
- **Fix:** `anchorJson` escapes them as `\u2028`/`\u2029` (both servers).
- **Guard:** `test/golden/pages/unicode.json` (both test suites).

## L31 — Blazor streamed pages had no overlay
- **Cause:** Blazor's streaming rendering sends `Content-Encoding: identity`; the injector skipped any response with a Content-Encoding header as compressed.
- **Fix:** treat `identity` as plain (`HtmlInjectionStream.Injects`).
- **Guard:** `MiddlewareTests.Streams_split_chunks_identity_encoding_and_pages_without_head`, `dotnet.spec.ts` (weather page).

## L32 — Razor stamp target ran, but stamped nothing
- **Cause:** with both `AfterTargets="_PrepareRazorSourceGenerators"` and `BeforeTargets="GenerateMSBuildEditorConfigFileShouldRun"`, MSBuild ran it before the Razor target (both are "before" the same target), when no Razor AdditionalFiles existed yet.
- **Fix:** `AfterTargets` only.
- **Guard:** `dotnet.spec.ts` (every stamp assertion).

## L33 — Optimizely sample: stored-procedure errors at startup; empty `epi-property` elements
- **Cause:** with minimal hosting, `MapContent()` builds the edit UI's routes before the CMS creates its schema. Separately, `epi-property` only adds edit attributes; it doesn't render the value.
- **Fix:** the sample uses the `Startup` pattern (`ConfigureCmsDefaults` initializes first); views write `<p epi-property="@Model.X">@Model.X</p>`.
- **Guard:** `optimizely.spec.ts` (with `REDLINE_E2E_OPTIMIZELY=1`).

## L34 — servers.json from the .NET server had `"at": "…T22.58.31…"`
- **Cause:** `:` in a .NET custom date format is the culture's time separator; on a Danish machine that is `.`.
- **Fix:** format with `CultureInfo.InvariantCulture` (`ServerRegistry`); every other stamp already did.
- **Guard:** `MiddlewareTests.Registers_in_servers_json_for_redline_mcp`. Checked by hand: `node dist/cli.js mcp` lists notes from the Razor sample.

## L40 — Every page logged an EventSource error when the store had no change feed
- **Cause:** the first version opened `/__redline/events` unconditionally; the markdown store answers 404, and Chrome logs the refused stream on every load.
- **Fix:** `/config` carries `events: !!store.subscribe`, and the overlay opens the stream only then (D41).
- **Guard:** `remote.spec.ts` "without a change feed the overlay never opens /events"; `remote.test.ts` checks `/config`.

## L41 — A live-update test passed without the live update
- **Cause:** the overlay's first poll runs about 1 s after load (`lastPoll` starts at 0), so a note served right after load arrived by polling, not by the pushed event.
- **Fix:** the test waits past the first poll before changing the notes; it was checked to fail with the push removed.
- **Guard:** `remote.spec.ts` "a pushed change shows a colleague's new note at once".

