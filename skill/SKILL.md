---
name: redline
description: Work through UI feedback left with the Redline overlay — comments, sketches and text changes pinned on the running web app and stored in .redline/. Use when the user asks to apply/handle/go through Redline notes, UI feedback, review notes, or pastes "Apply the open Redline notes…".
---

# Applying Redline UI feedback

Redline is a dev-only overlay (toggle **Alt+Shift+R** in the browser) where a person pins
notes on the running UI. Each note is stored as markdown that you read and close.

## Where things are

```
.redline/                      (at the repo root; gitignored)
  INDEX.md                     page → open/done counts. Start here.
  pages/<page-slug>.md         the notes for one URL path
  assets/<id>.png              screenshot, target outlined in red (sketches drawn on top)
  assets/<id>.svg              raw sketch, viewport coordinates
```

Monorepos: every app's notes share the root `.redline/`. Page files are prefixed with the app
(`pages/apps-web--settings.md`), INDEX.md has an App column, each anchor has `"app":"apps/web"`
(the dev server's folder), and `source.file` is relative to the repo root.

## Anatomy of a note

```markdown
### [ ] Comment · `button` “Save draft” · [data-testid="agent-save"] · src/lib/AgentForm.svelte:142
<!-- redline {"id":"…","type":"comment","url":"…","target":{"selector":"…","source":{"file":"…","line":142},"components":["AgentForm","Settings"],…},"viewport":[1440,900,2],"theme":"dark",…} -->

Make this secondary; Publish should be the primary action.

![screenshot](../assets/mv6e4kcda9b3.png)

> (your reply goes here)
```

- `### [ ]` = open, `### [x]` = done. Only act on open notes.
- Types: **Comment** (an instruction), **Text change** (a ```diff block: `-` current text,
  `+` wanted text; the body, if any, adds context), **Sketch** (a drawing; read the
  screenshot, which has the sketch drawn on top).
- `whole page` in the heading = the note is about the page, not one element.

## Finding the code — in this order

1. **`target.source`** (`file:line`) — the element's location in source, from framework dev
   metadata (Svelte `__svelte_meta`, Astro `data-astro-source-*`, React via the plugin's JSX
   stamp). Usually exact. For shared UI components it points at the *component's* markup;
   check `target.components` (innermost first) to find the call site that needs changing.
2. **`target.testid`** / `target.id` — grep for it.
3. **Text** — grep for `target.text` (or the `-` line of a text change). Trust the quoted text
   over line numbers; the file may have moved since.
4. `target.selector`, `target.html`, `target.role`/`name` — for confirming you're on the right element.
5. Text that lives in content/i18n files (markdown, JSON, CMS): change it there, not in the template.

Use `url`, `viewport` (w, h, devicePixelRatio) and `theme` to reproduce what the reviewer saw,
e.g. a dark-mode-only or mobile-width issue. `errors` lists console errors seen on the page
when the note was written; they may or may not be related.

## Workflow

1. Read `.redline/INDEX.md`, then the page files with open notes. Look at each note's
   screenshot (open the PNG) — it shows exactly what the reviewer pointed at.
2. Make the change. Keep it to what the note asks; follow the repo's own conventions
   (AGENTS.md / CLAUDE.md, design guidelines, component library).
3. Close the note in the markdown:
   - tick it: `### [ ]` → `### [x]`
   - add a one-line `> ` reply under it saying what changed and where, e.g.
     `> Button now variant="secondary"; Publish is primary (AgentForm.svelte:142).`
4. If a note is ambiguous, conflicts with another note or the design system, or would need a
   larger decision: leave it open (`[ ]`) and put your question in the `> ` reply. The
   reviewer sees replies live in the overlay.
5. Verify in the browser where you can (the dev server is usually already running; the
   overlay picks up your file edits within a couple of seconds).
6. Report what you applied and what you left open, with the questions.

## Rules

- Never edit or delete the `<!-- redline {…} -->` line — the overlay uses it to place pins.
- Never reorder or delete notes, and don't rewrite the reviewer's text. Only tick boxes and
  add/replace `> ` reply lines.
- Don't edit `INDEX.md`; it's regenerated on the next change made from the overlay.
- Several notes on one element can conflict; apply them in file order (oldest first) and
  mention the conflict in the reply.
- `.redline/` is gitignored: never `git add` it.
