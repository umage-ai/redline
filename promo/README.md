# Promo video

A silent product video for LinkedIn, recorded from the fictional demo app (`examples/demo`) with Playwright.
It is fully scripted, so after any UI change you can regenerate it with one command:

```bash
npm run promo                  # builds dist/, records, encodes → promo/out/redline-promo.mp4 + redline-promo-poster.png
PROMO_HEADED=1 npm run promo   # show the browser windows while recording
PROMO_FORMAT=web npm run promo # the 16:9 web version → promo/out/redline-promo-web.mp4 + its poster
PROMO_PORT=5291 npm run promo  # another port for the demo app, when 5211 is taken (the .NET samples use it)
```

Needs `ffmpeg` on PATH and installed Chrome (`PW_CHROMIUM=1` uses Playwright's bundled Chromium instead).
It takes about a minute. `promo/out/` is gitignored.

## Spec

| | |
|---|---|
| Audience | Developers and product people scrolling LinkedIn with the sound off |
| Message | Mark up your running UI. Your AI agent applies it. |
| Format | MP4 · H.264 · yuv420p · 1080×1350 (4:5, the tallest feed format) · 30 fps · no audio track · ~58 s. `PROMO_FORMAT=web`: 1920×1080 (16:9) for web pages, same storyboard |
| Thumbnail | `redline-promo-poster.png` (the title card at 1.5 s). Upload it as the custom thumbnail. |
| Sound-off rules | Every scene has a large caption (step label + one sentence) and shows the keys pressed |
| Layout | Caption on top · the app in a browser frame · a live panel underneath: the real `.redline` markdown file, then the agent's terminal |
| Honesty | Every overlay interaction and saved note is real. The agent step is scripted: the script edits `App.tsx` (HMR shows it), ticks the notes and writes the replies, the way `skill/SKILL.md` describes. The terminal lines are illustrative. |

## Storyboard

Captions live in `S` at the top of `record.mjs`; the agent's edits and replies in `AGENT`. Keep this table in step.

| # | ~Time | Caption | What happens |
|---|---|---|---|
| 0 | 0–3 s | Title card: **Redline** · Mark up your running UI. Your AI agent applies it. | |
| 1 | 3–7 s | 01 · Open: *Press a hotkey in your running dev app.* `Alt` `Shift` `R` | The cursor moves into the app and the toolbar opens |
| 2 | 7–17 s | 02 · Comment: *Click any element, pick a label, say what you want.* `C` | Picks "New route", picks the **UX** label and types the comment. On save, the note appears in the markdown panel → *Saved as markdown, with the selector, source file:line and a screenshot.* |
| 3 | 17–29 s | 03 · Text: *Rewrite copy right on the page.* `T` | Rewrites the lead paragraph and clicks **Apply to file** (`directEdit`); the panel shows the App.tsx diff → *Static copy? Written straight into the source file.* |
| 4 | 27–39 s | 04 · Sketch: *Draw boxes, arrows and labels on the page.* `S` | Box around the chart, an arrow, a text label, then a note |
| 5 | 41–51 s | 05 · Agent: *Your AI agent picks up the notes over MCP.* | The terminal shows `list_notes` / `get_note` / `update_note` for the 2 notes. The button changes live through HMR; the comment gets `[x]` and a reply, the sketch a question → *Ticked off, with replies, live in the overlay.* The notes panel opens with "Show done" |
| 6 | 51–56 s | End card: `npm i -D @umage.ai/redline` · React, Vue, Svelte, Astro, Angular, Solid, Preact · github.com/umage-ai/redline | ASP.NET Core, Blazor and Optimizely join the chips once the NuGet packages are published |

## How it works

Why this approach: [D38](../docs/DECISIONS.md). ffmpeg quirk: [L35](../docs/LEARNINGS.md).

- **Two pages, composited.** The overlay never runs inside an iframe (`src/client/index.ts`), so the app can't be
  embedded in the stage. The script records the app page (1360×760) and `stage.html` (1440×1800) separately.
  ffmpeg overlays the app at (40, 330), fades it with the title and end cards, and scales the result to 1080×1350.
- **Frames come from CDP `Page.startScreencast`**, with timestamps. Each page only sends frames when it changes. The
  frame durations come from the timestamps, so pacing is real time and both pages share one clock.
  Playwright's `recordVideo` is lower quality, and it can't line up two pages.
- **The cursor and click ripple are drawn into the page** (`fakeCursor`), because screencasts have no pointer.
  `glide()` moves the mouse with easing, at a speed you can follow.
- The script resets `examples/demo/.redline/`, edits `examples/demo/src/App.tsx` for the agent step, and restores it
  in `finally`.

## Changing it

- **Copy, timing:** the captions in `S`, the typed text (`COMMENT`, `LEAD`, `SKETCH_*`), `TYPE_DELAY`, and the
  `hold(ms)` calls in each scene block.
- **Look:** `stage.html` (CSS tokens on `:root`, the cards in `window.stage.card`). The app's position on the stage is
  in three places, which must agree: `.win`/`.hole` in `stage.html`, the app viewport in `record.mjs`, and `overlay=40:330`.
- **Formats:** `FORMATS` in `record.mjs` holds each format's stage size, app position and output size; `stage.html`
  lays out the web format under `html.web` (`?format=web`): the app on the right, caption and panel in a column on its
  left, caption line breaks dropped so the column wraps them. A new format (1:1, say) is one entry there plus its CSS.
- The demo's own overlay extension (`examples/demo/redline.ext.js`, a **Copy list** button) is stubbed out while
  recording, so the video shows Redline's stock toolbar.
- After a change, check it frame by frame:
  `ffmpeg -i promo/out/redline-promo.mp4 -vf "fps=1/3,scale=360:-1,tile=6x4" -frames:v 1 promo/out/sheet.png`.
