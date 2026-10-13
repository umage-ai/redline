# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Redline**: a dev-only overlay for web UIs. A reviewer pins comments, text changes and sketches on the
running app (Alt+Shift+R). The dev server saves them as markdown in the app's `.redline/` folder, and an
AI agent applies them using `skill/SKILL.md`. Product overview and setup: `README.md`.

## Docs map (read before larger changes)

| File | Holds | Cap |
|---|---|---|
| [docs/STATE.md](docs/STATE.md) | What works, consumer integrations, known gaps, next steps | 150 lines |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Numbered decisions (D1…) with the why and when to revisit | 200 lines |
| [docs/LEARNINGS.md](docs/LEARNINGS.md) | Numbered gotchas (L1…): symptom → cause → fix → guarding test | 200 lines |
| [skill/SKILL.md](skill/SKILL.md) | The agent-facing contract for `.redline/` notes (copied into consumer repos) | 120 lines |

**Keep docs current. This is part of "done", in the same change as the code:**
- Behaviour, feature or integration status changed → update `docs/STATE.md` (and `README.md` if user-facing: keys, options, setup).
- Chose between real alternatives, or reversed a choice → add or amend a `D<n>` in `docs/DECISIONS.md`.
- Hit a non-obvious bug or tool quirk → add an `L<n>` to `docs/LEARNINGS.md`, naming the test that now guards it.
- Changed the markdown format or note fields → update `skill/SKILL.md`, the preamble in `src/server/format.ts`, and the unit tests together.
- Bump `Last updated:` in every doc you touch. Stay under the caps: merge or prune old entries rather than append forever.
  One topic per entry, a few lines each, no narrative.
- `npm run check:docs` (part of `npm test`) enforces caps, dates, links, and that this map lists every `docs/*.md`.

## Commands

```bash
npm run build          # esbuild → dist/ (vite.js, astro.js, server.js, cli.js, client.js) + tsc → dist/types/
npm run dev            # rebuild on change
npm run typecheck      # tsc --noEmit (src, test/unit, test/e2e)
npm test               # unit tests (node:test, runs .ts directly) + docs check
npm run test:e2e       # build + Playwright against 4 fixture apps (installed Chrome; PW_CHROMIUM=1 for bundled)
npm run check          # everything: typecheck, unit, docs, e2e. Run before calling work done.
npm run test:package   # pack → install the tarball into temp React/SvelteKit/Astro/node apps → type + browser tests (slow; runs on prepublishOnly)
# Release: bump version, push, publish a GitHub release `v<version>` → .github/workflows/publish.yml (D13). Don't `npm publish` locally.
npm run smoke -- <url> "<selector>"   # pin a throwaway note on any running app, print the saved target
npm run demo           # the fictional demo app (examples/demo, React) on :5173 with Redline loaded
npm run screenshots    # regenerate the README images (docs/images) by driving the demo with Playwright

node --test --test-name-pattern="round-trips" test/unit/format.test.ts   # one unit test
npx playwright test -g "disabled"                                         # one e2e test (run `npm run build` first)
npx playwright test test/e2e/frameworks.spec.ts                           # one spec file
```

The e2e fixtures (`test/fixtures/{vanilla,react,sveltekit,astro}`, ports 5199–5202) load `dist/`, so **rebuild
before e2e**. Playwright reuses fixture servers that are already running locally, so restart them after
changing server-side code (handler/store/plugin). Client-only changes just need a rebuild and a page reload.

## Architecture (the parts that span files)

**Request flow.** `src/vite.ts` (also wrapped by `src/astro.ts`, and by `src/server/index.ts` for other Node servers)
registers two connect middlewares from `src/server/handler.ts`, ahead of the framework's own:
1. `api`: `/__redline/*`. Serves `dist/client.js`, `/config`, `/notes` (GET with ETag; POST/PATCH/DELETE need the
   `x-redline: 1` header), and `/assets/<id>.png|svg`. Normalises `target.source.file` to repo-relative.
2. `inject`: buffers every `text/html` response and inserts the client `<script>`, plus an inline parse-time snapshot
   of Astro source attributes. Working at the HTTP level is what makes one plugin cover SPA, SvelteKit SSR and Astro.

**Storage.** `src/server/store.ts` serialises all mutations through a queue and always does read → parse → modify →
write. The markdown is the source of truth: agents edit it by hand (`[x]`, `> ` replies), and the overlay polls
`/notes` every ~2 s. `src/server/format.ts` owns the format: heading `### [ ]`, `<!-- redline {json} -->` anchor,
body, diff block for text notes, generated image lines, `> ` reply. Files: `.redline/INDEX.md`, `pages/<slug>.md`,
`assets/`. `root` defaults to the nearest `.git` folder.

**Client** (`src/client/`, bundled to one ESM file, shadow root `<redline-root>` on `<html>`):
- `index.ts`: state, modes (comment/text/sketch), event capture, popover, pins, panel, polling.
- `anchor.ts`: describes an element (selector, xpath, test id, role/name, html excerpt, **source + components**)
  and resolves a stored target back to an element.
- `capture.ts`: screenshots (DOM render via modern-screenshot, or tab capture). `sketch.ts`: the SVG drawing layer.

**Source location per framework** (`anchor.ts` `sourceInfo`): React through a dev-only JSX transform
(`src/server/jsx-source.ts` stamps `data-redline-src` on an HTML-tag allowlist), then the fiber chain for components;
Svelte through `__svelte_meta`; Astro through `data-astro-source-*` (from the snapshot, because Astro's toolbar strips them).

**Consumers** install `@umage.ai/redline` as a devDependency and import `@umage.ai/redline/{vite,astro,server}` (D4).
Exports map to the flat `dist/*.js` plus `dist/types/` (tsc declarations). `dist/cli.js init <repo>`
copies the skill, gitignores `.redline/` and adds a CLAUDE.md section.

## Invariants (break these and consumers or agents break)

- Nothing runs outside dev: plugins use `apply: 'serve'`, return `[]` under `VITEST`, and Astro only adds the plugin for `command === 'dev'`.
- Markdown round-trips: `parsePage(serializePage(x))` must deep-equal `x`. Agent-written `[x]` and `> ` lines must survive overlay writes.
- The injector must restore `res.writeHead/write` before its final `end()` (L1). Picking happens on `pointerup`, not `click` (L3).
- The overlay must never let pointer or key events through to the app while picking or typing in the overlay.
- Every bug fix gets a regression test in the cheapest layer that can see it: unit (format/store/jsx) or e2e (browser behaviour, frameworks).
