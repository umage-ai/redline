# Learnings

Last updated: 2026-10-15 · Cap: 200 lines · Format: `## L<n> — symptom` then Cause / Fix / Guard.
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
