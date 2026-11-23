# Plan: `@umage.ai/redline-voice` — voice notes and recorded review sessions

Status: built (2026-11-23), on branch feat/voice-sessions; decisions in docs/DECISIONS.md (D70, D71). Delete this file once it ships.

Two features, one opt-in package (not for everyone, so not in the core):

1. **Voice note** — pick an element, talk instead of typing. The audio is transcribed; the transcript is the
   note's body (agents can't hear audio), the recording is linked for humans. A status shows where the
   transcript is (recording → queued → transcribing → done / failed, retry).
2. **Session recorder** — a recording mode with its own toolbar. Talk while you point, draw, take screenshots
   and browse the app; every action is stamped with the time on the recording. Saved as a session folder in
   `.redline/sessions/<id>/` whose `session.md` interleaves the transcript with what was pointed at, when.

```js
// vite.config.js
import { voice } from '@umage.ai/redline-voice';
redline({ plugins: [voice({ transcribe: { url: 'http://whisper.local:8000/v1', model: 'large-v3' } })] })
```

## WS0 — Core: server plugins and extension API v8 (`src/`)

- New option `plugins?: RedlinePlugin[]` (D70). A plugin is `{ name, setup(ctx) }`; `setup` gets `{ root, dir, base,
  app, serverRoot, notes }` and returns `{ handle?(req, res, path, { local }), extensions?: string[] }`.
  - Routes under `<base>/p/<name>/…`, behind the same guards as the API: `network` refusal, and `x-redline: 1` on
    every non-GET. `local` tells the plugin the caller is this machine.
  - `notes` = create / update / list on the configured store **through the same path as the API** (target
    normalised, store-owned fields dropped, `app`/`build` set, hooks run, live feed notified).
  - `extensions` are appended to `/config`'s list. The overlay loads them like any extension.
  - The agent option stays as it is (not refactored onto this).
- Extension API v8: `rl.describe(el, x?, y?)` (the Target a note would get, enrichers included) and
  `rl.screenshot({ box?, crop?, sketch? })` (the overlay's own capture, PNG data URL). The extension finds its
  plugin's routes from its own `import.meta.url`, so no fetch helper is needed.
- Tests: unit (routing, guards, notes path runs hooks, extensions in /config), e2e for v8.

## WS1 — Package skeleton (`voice/`)

- `voice/` like `agent/`: `src/index.ts` (server, `voice(opts)` → `RedlinePlugin`), `src/extension.ts` (browser,
  bundled to `dist/extension.js`, served by the plugin), `index.d.ts`, README, LICENSE, `package.json`
  (`peerDependencies: @umage.ai/redline >=0.11`). Built by `scripts/build.mjs`; added to the publish workflow.
- Root devDependency `file:voice` so the demo and fixtures can load it.

## WS2 — Transcription (server, `voice/src/transcribe.ts`)

`transcribe` option, one engine or a list tried in order (fallbacks):

| Engine | Spelling | Notes |
|---|---|---|
| Browser | `'browser'` (default) | Web Speech API in Chrome/Edge: live, free, audio goes to the browser vendor. No server work. |
| OpenAI-compatible HTTP | `{ url, model?, apiKey?, language?, prompt? }` | `POST <url>/audio/transcriptions` (multipart). Covers self-hosted Whisper servers (faster-whisper-server/speaches, whisper.cpp `--openai`, LocalAI), OpenAI, Groq, Azure-style gateways. Asks `verbose_json` for timed segments, falls back to `json`/text. |
| Command | `{ command, args? }` | Runs a local tool (whisper.cpp, whisper CLI, …). `{file}`, `{dir}`, `{lang}` in args; stdout read as text, SRT/VTT or JSON (segments kept). |
| Function | `(audio) => text \| { text, segments }` | Anything else. |

- `live: 'auto' | true | false` (default auto): show the browser's live transcript while recording when the
  browser has it, even when a server engine makes the final one. Server engines run after stop.
- A job queue (one at a time by default, `concurrency`), statuses `queued → transcribing → done | failed`,
  with the engine, timings and error. Status lives in the note's `meta.voice` / the session's `session.json`;
  the overlay sees changes through the normal notes poll / live feed. `POST …/retry/<id>` re-runs it.
- Tests: fake OpenAI server (multipart parsed, verbose_json and plain), fake command (text, SRT, JSON),
  fallback order, failure → status.

## WS3 — Voice notes (client mode + server route)

- Toolbar mode **Voice** (key V, `addMode`): pick like Comment (Alt = parent, Shift = whole page). A popover at
  the pick: mic level, timer, live transcript (editable), **Stop & save** (Enter), **Cancel** (Esc).
- `POST …/p/voice/notes` with the note request + audio (base64 webm/opus, 25 MB cap) + the live transcript.
  The server saves the audio as `.redline/voice/<id>.webm`, creates a **comment** note through `ctx.notes`:
  body = transcript (or "🎙 Transcribing… — skip this note until the transcript is in" while pending), then
  `🎙 [Recording 0:12](../voice/<id>.webm)`; `meta.voice = { audio, duration, status, engine, error? }`.
  When the job ends, the body is replaced (unless the reviewer already edited it) and the status set.
- Card decorator: status chip (Transcribing… / Transcribed by whisper / Failed), ▶ play inline. Card action
  **Retry transcription** when failed. `GET …/p/voice/audio/<id>` serves the file to the overlay.
- No core format change: body and `meta` already round-trip (tested anyway).

## WS4 — Session recorder (client)

- A toolbar (`addToolbar`, hotkey alt+shift+v, button **Record** in the main bar). Left to right:
  ● Record / ❚❚ Pause (Space), timer + mic level, **Point** (P: pick like Comment, stays on; each pick = a
  pointer event + a cropped screenshot with the red box), **Draw** (D: pen on a glass layer; on release the
  stroke is a draw event with a screenshot including the ink), **Shot** (S: viewport screenshot),
  **Browse** (B: the app works normally; clicks and route changes are logged, nothing blocked), **Finish** ✓
  (saves) and **Discard**. The attached card shows the last transcript lines and the event chips.
- Time = milliseconds on the recording (pauses excluded), so events line up with the audio and segments.
- Events: `point { t, target, x, y, url, shot }`, `shot`, `draw { svg, shot }`, `click { target }` (browse),
  `nav { url, title }`, `pause`, `resume`; browser live segments `{ start, end, text }`.
- Known gap: a full page load ends the recording (MPA navigation). SPA routes are fine. Later: resume across loads.

## WS5 — Session storage and `session.md` (server)

- `POST …/p/voice/sessions` (audio, events, screenshots, live segments) →
  `.redline/sessions/<YYYY-MM-DD-HHMM>-<slug>/` with `audio.webm`, `shots/01.png…`, `session.json` (raw), and
  `session.md` regenerated when the transcript arrives.
- `session.md`: a preamble saying what it is and how to act on it; header (page, duration, status, engine); a
  **timeline** merging transcript segments and events by time: `**[00:42]** 👉 \`button\` “Checkout” ·
  src/Cart.tsx:42 · [data-testid="checkout"]` + the screenshot, with what was said around it. Without timed
  segments: the transcript first, then the events with their times.
- A **pointer note** (whole-page comment on the start page) through `ctx.notes`: "Recorded session (2:31,
  6 points): read `.redline/sessions/<id>/session.md` …", `meta.session`. So Apply, the MCP tools and
  INDEX.md pick sessions up with no new note type in the core. Ticking it closes the session.
- Tests: timeline merge (timed, untimed, events before speech), file layout, pointer note created and updated.

## WS6 — Agent contract, docs, e2e

- `skill/SKILL.md`: a note may point at a session folder; read `session.md`; a pending voice note waits.
- docs: D70 (plugins), D71 (voice package: transcript as body, sessions as folders + pointer note), STATE,
  OPTIONS (`plugins`, the voice options), USAGE (voice notes, sessions), CLAUDE.md architecture line.
- e2e (`test/e2e/voice.spec.ts`): Chrome's fake mic (`--use-fake-device-for-media-stream`), a command engine
  that echoes a fixed transcript: voice note saved, status goes to done, body replaced; a session with two
  points and a shot writes the folder and the timeline.
- Node only (like the agent panel); .NET later if wanted.

## Order

WS0 → WS1 → WS2 + WS5 server → WS3 → WS4 → WS6. Each step type-checks and tests green before the next.
