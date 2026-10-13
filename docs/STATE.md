# State

Last updated: 2026-10-13 · Cap: 150 lines · Rewrite sections in place; this is a snapshot, not a log.

## Status

v0.1, working, used on several internal apps (Astro, React + Vite, SvelteKit). Being prepared for npm as
`@umage-ai/redline` (D4); not published yet. `npm pack --dry-run` ships only `dist/`, `skill/`, README and LICENSE.

## What works (covered by tests)

| Area | Status | Guarded by |
|---|---|---|
| Markdown format round-trip, agent edits kept, slugs | ✅ | `test/unit/format.test.ts` |
| Store: assets, INDEX.md, update/remove, concurrent agent edits | ✅ | unit |
| JSX source stamping (HTML tags only) | ✅ | unit |
| Script injection, comment mode, app never sees clicks | ✅ | `overlay.spec.ts` |
| Disabled controls pickable; autofocus doesn't eat mode keys | ✅ | `overlay.spec.ts` |
| Parent / whole-page targeting | ✅ | `overlay.spec.ts` |
| Text mode → diff note | ✅ | `overlay.spec.ts` |
| Sketch: scroll recorded, svg + composited png, containing-element anchor | ✅ | `overlay.spec.ts` |
| Live agent replies, done/reopen/delete from the panel (assets removed) | ✅ | `overlay.spec.ts` |
| Source + components: React 19, SvelteKit 2 / Svelte 5, Astro 6 | ✅ | `frameworks.spec.ts` |
| Astro toolbar coexistence (attrs stripped, bar lifted) | ✅ | `frameworks.spec.ts` |
| Pixel-perfect tab capture (getDisplayMedia) | ⚠️ manual only | needs a permission prompt, not automatable |

## Known gaps

- DOM screenshots: WebGL, cross-origin map tiles and video can come out blank; sticky headers are missing when scrolled. Workaround: tab capture.
- Text mode records the change only; it never writes source (by design, D6).
- Notes are keyed by pathname, so `/org/a/agents/1` and `/org/b/agents/1` are separate pages. There's no route-pattern grouping yet.
- Pins re-resolve by selector/testid/xpath/text. Heavily dynamic lists can re-pin onto the wrong row.
- Elements added after hydration in Astro have no source (the snapshot is taken at parse time).

## Next up

1. Before publishing: install the packed tarball into a real app of each framework and run through all modes.
   Verify a dev server behind a reverse proxy (HTML through the proxy, `/__redline` routing, HMR unaffected).
2. Chrome extension reusing `dist/client.js` + `captureVisibleTab`, for non-Vite apps and staging (with a `redline serve` store).
3. Route-pattern grouping (SvelteKit route id, React Router match) so dynamic URLs share one notes file.
4. Optional MCP tools (`list_open_notes`, `close_note`), only if plain files prove insufficient.
