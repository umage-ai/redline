# @umage.ai/redline-voice

Voice notes and recorded review sessions for [Redline](https://github.com/umage-ai/redline)'s dev server. Talk instead
of typing, and point while you talk. Local dev only.

- **Voice note**: **Voice** (V) picks an element like Comment. You talk, Enter saves. The note's body is the
  transcript (coding agents read text, not audio), with a 🎙 link to the recording. Its card shows where the transcript
  is: waiting, transcribing, done, or failed with ↻ to retry.
- **Session recorder**: **Record** (R, or `Alt+Shift+V` from anywhere) opens a toolbar for walking an agent through
  what you want. Talk while you **Point** (P: click elements, it keeps picking), **Draw** (D: ink on the page), take a
  **Shot** (S) or **Browse** (B: the app works normally; clicks and route changes are logged). Space pauses, Enter
  finishes, Discard throws it away (asks once more). Every action is stamped with its time on the recording.

```bash
npm i -D @umage.ai/redline @umage.ai/redline-voice
```

```js
// vite.config.js
import redline from '@umage.ai/redline/vite';
import { voice } from '@umage.ai/redline-voice';

export default defineConfig({
  plugins: [redline({ plugins: [voice({ transcribe: [{ url: 'http://localhost:8000/v1', model: 'large-v3' }, 'browser'] })] })],
});
```

`plugins` is the same in every Node setup (`@umage.ai/redline/astro`, `withRedline` for Next, `redlineMiddleware`). It
needs `@umage.ai/redline` 0.11 or later.

## Transcription

`transcribe` takes one engine or a list, tried in order until one returns text:

| Engine | Example | Notes |
|---|---|---|
| Browser (default) | `'browser'` | The Web Speech API's live transcript (Chrome, Edge). Free and instant, but the browser sends the audio to its vendor's speech service. |
| OpenAI-compatible | `{ url: 'http://whisper:8000/v1', model: 'large-v3' }` | `POST <url>/audio/transcriptions`, so a self-hosted Whisper server (faster-whisper-server/speaches, whisper.cpp's server, LocalAI), OpenAI, Groq. `apiKey` or `apiKeyEnv: 'OPENAI_API_KEY'`, `language`, `prompt` (spelling hints), `fields`, `headers`. Asks for timed segments (`verbose_json`), falls back to `json`. |
| Command | `{ command: 'whisper-cli', args: ['-m', 'models/ggml-base.bin', '-f', '{file}'] }` | A local tool. `{file}`, `{dir}`, `{name}`, `{lang}` are filled in. Gets 16 kHz mono WAV unless `format: 'webm'`. Reads stdout, or `outputFile: '{file}.srt'`: plain text, SRT, VTT, whisper.cpp's `[00:00:01.000 --> …]` lines or JSON. |
| Function | `async ({ file, mime, duration, language }) => 'text'` | Anything else. Return `{ text, segments }` to give timings. |

`[whisper, 'browser']` uses Whisper and falls back to the browser's text when Whisper fails. `['browser', whisper]`
uses the live text when there is one. A server engine runs after you stop recording, one job at a time
(`concurrency`). While you talk, the toolbar shows the browser's live transcript if it has one (`live: 'auto'`).

Other options: `language` (BCP 47, e.g. `'da-DK'`; engines get `da`), `notes` / `sessions` (turn either off), `key`
(Voice mode's key, default `v`), `hotkey` (default `alt+shift+v`), `maxSeconds` (longest voice note, default 300).

## What gets written

A voice note is an ordinary comment in `.redline/pages/<page>.md`, with the audio in `.redline/voice/<id>.webm`:

```markdown
### [ ] Comment · `button` “Pay now” · [data-testid="pay"] · src/Cart.tsx:42
<!-- redline {"id":"…","meta":{"voice":{"audio":"voice/….webm","duration":4.2,"status":"done","engine":"whisper"}},…} -->

Make this button green and move it above the summary.

🎙 [Recording (0:04)](../voice/mwtosz7c2d53.webm)
```

Until the transcript is in, the body says so. If you rewrite the text before the transcript arrives, your text is
kept and the transcript goes into `meta.voice.text`.

A session is a folder, `.redline/sessions/2026-11-23-1042-checkout/`, holding `audio.webm`, `shots/01.png…`,
`session.json` (the raw events and full element targets) and `session.md`:

```markdown
**0:03** “So this button here”

**0:04** 👉 **Pointed at** `button` “Pay now” · [data-testid="pay"] · src/Cart.tsx:42 — `[data-testid="pay"]`

![point at 0:04](shots/01.png)

**0:05** “should be green, and bigger.”
```

A whole-page note on the page where you started points to it, so **Apply**, the MCP tools and `INDEX.md` all see the
session. The agent ticks that note when it has done everything in the session. The `redline` skill (`npx redline init`)
explains voice notes and sessions to agents.

## Limits

- A full page load ends a session recording (the page warns first). Client-side routes are fine.
- With a remote note store the notes are shared, but the audio and session folders stay in the local `.redline/`.
- Recording needs a secure page (https or localhost). The live transcript needs Chrome or Edge and their speech service.
