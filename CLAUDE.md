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
npm run test:e2e       # build + Playwright against 8 fixture apps (installed Chrome; PW_CHROMIUM=1 for bundled; PW_FIXTURES=vue,angular starts only those)
npm run check          # everything: typecheck, unit, docs, e2e. Run before calling work done.
npm run test:package   # pack → install the tarball into temp React/SvelteKit/Astro/node apps → type + browser tests (slow; runs on prepublishOnly)
# Release: on main, `npm run release -- patch|minor|major` → tag v<version> → .github/workflows/publish.yml publishes (D13). Never `npm publish` locally.
npm run smoke -- <url> "<selector>"   # pin a throwaway note on any running app, print the saved target
node dist/cli.js mcp [dir]            # the MCP server (stdio) agents use; finds dev servers via .redline/servers.json (D22); dev servers also answer POST /__redline/mcp (D37)
npm run demo           # the fictional demo app (examples/demo, React) on :5173 with Redline loaded
npm run screenshots    # regenerate the README images (docs/images) by driving the demo with Playwright

node --test --test-name-pattern="round-trips" test/unit/format.test.ts   # one unit test
npx playwright test -g "disabled"                                         # one e2e test (run `npm run build` first)
npx playwright test test/e2e/frameworks.spec.ts                           # one spec file

# .NET (dotnet/; needs dist/client.js, which the csproj embeds: run `npm run build` first after client changes)
dotnet test dotnet/tests/Umage.Redline.Tests            # unit + TestServer tests, net8.0 and net10.0 (incl. test/golden)
npx playwright test -c dotnet/playwright.config.ts      # browser smoke: Razor/Blazor samples on 5210/5211; REDLINE_E2E_OPTIMIZELY=1 adds Optimizely (LocalDB) on 5212/5213
dotnet pack dotnet/Redline.slnx                         # the NuGet packages
```

The e2e fixtures (`test/fixtures/{vanilla,react,sveltekit,astro,angular,vue,solid,preact}`, ports 5199–5206) load `dist/`, so **rebuild
before e2e**. They use the root `node_modules`, except Angular (own TypeScript major): `serve.mjs` installs its own on first run. Playwright reuses fixture servers that are already running locally, so restart them after
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
`assets/`. `root` defaults to the nearest `.git` folder (`src/server/root.ts`); in a monorepo each dev server tags notes with its
`app` folder and page files get an app prefix (D17).

**Client** (`src/client/`, bundled to one ESM file, shadow root `<redline-root>` on `<html>`):
- `index.ts`: state, modes (comment/text/sketch), event capture, popover, pins, panel, polling.
- `anchor.ts`: describes an element (selector, xpath, test id, role/name, html excerpt, **source + components**)
  and resolves a stored target back to an element.
- `capture.ts`: screenshots (DOM render via modern-screenshot, or tab capture). `sketch.ts`: the SVG drawing layer.

**Extension points** (all opt-in, D19–D21): the handler talks to a `NoteStore` (markdown `createStore` by default)
and runs `hooks`; `POST /__redline/edit` runs `SourceWriter`s (`src/server/writers.ts`, pure guards in `edit.ts`);
`/__redline/ext/<i>.js` serves overlay extensions, which get `RedlineApi` (`src/shared/extension.ts`).

**Source location per framework** (`anchor.ts` `sourceInfo`, D7/D23): JSX through a dev-only transform
(`src/server/jsx-source.ts` stamps `data-redline-src="file:line:col Component"` on an HTML-tag allowlist), Vue SFC templates
likewise (`vue-source.ts`, the app's own `vue/compiler-sfc`). Components: React's fiber chain, Vue's `__vueParentComponent`,
Solid/Preact from the stamps' component names. Svelte through `__svelte_meta`; Astro through `data-astro-source-*` (from the
snapshot, because Astro's toolbar strips them); Angular through `data-ng-source-location` (the builder in `src/angular.ts`
turns on `enableTemplateSourceLocations` in dev) plus the `ng` debug global. One parser reads `data-redline-src`
(`file:line:col[ Component]`); without a name (Razor/Blazor) the file's base name is the component.

**.NET** (`dotnet/`, D30–D36): a C# port of the server (`Umage.Redline.AspNetCore`: API, stores, writers, streaming
injector, HTTP MCP), Razor/Blazor source stamps from an MSBuild task (`Umage.Redline.Build`, same `data-redline-src` format,
no component name) and `Umage.Redline.Optimizely`. The browser bundle is shared. `test/golden` fixtures keep the markdown
byte-identical in both servers: a format change must pass `golden.test.ts` and `GoldenTests.cs`; an edit-guard change goes in
`test/golden/edit/cases.json` (`edit.test.ts`, `EditGoldenTests.cs`). After changing `src/server/entities.ts`, run `node scripts/entities-cs.mjs`.

**Consumers** install `@umage.ai/redline` as a devDependency and import `@umage.ai/redline/{vite,astro,server}` (D4);
Angular uses the `@umage.ai/redline:dev-server` builder (package.json `builders` → `dist/builders.json`, D23).
Exports map to the flat `dist/*.js` plus `dist/types/` (tsc declarations). `dist/cli.js init <repo>`
(`src/init.ts`) installs the skill for any agent (Agent Skills + AGENTS.md, plus Claude/Gemini/Copilot extras, D16) and gitignores `.redline/`.

## Invariants (break these and consumers or agents break)

- Nothing runs outside dev: plugins use `apply: 'serve'`, return `[]` under `VITEST`, and Astro only adds the plugin for `command === 'dev'`.
- Markdown round-trips: `parsePage(serializePage(x))` must deep-equal `x`. Agent-written `[x]` and `> ` lines must survive overlay writes.
- The injector must restore `res.writeHead/write` before its final `end()` (L1). Picking happens on `pointerup`, not `click` (L3).
- The overlay must never let pointer or key events through to the app while picking or typing in the overlay.
- Every bug fix gets a regression test in the cheapest layer that can see it: unit (format/store/jsx) or e2e (browser behaviour, frameworks).
