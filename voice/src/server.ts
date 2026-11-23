// The voice plugin's server half (D71): saves recordings, transcribes them with the configured engines,
// writes voice notes (a comment whose body is the transcript) and session folders
// (`.redline/sessions/<id>/`: audio, screenshots, session.json, session.md, plus a pointer note).
// Routes, under `<base>/p/voice/`: extension.js, config, notes, sessions, audio/<file>,
// sessions/<id>/<file>, retry/<id>.

import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NewNoteRequest, Note } from '../../src/shared/types.ts';
import type { PluginContext, PluginRoutes, RedlinePlugin } from '../../src/server/plugins.ts';
import { json, readBody } from '../../src/server/http.ts';
import { newId, validId } from '../../src/server/store.ts';
import { engineFormat, engineLabel, queue, runEngine, type Engine, type Segment, type Transcript } from './transcribe.ts';
import { clock, sessionId, sessionMarkdown, type SessionData, type SessionEvent, type TranscriptStatus } from './session.ts';

export interface VoiceOptions {
  /**
   * Speech-to-text engines, tried in order until one returns text. `'browser'` (the default): the live transcript
   * from the browser's Web Speech API (Chrome, Edge; the audio goes to their vendor). `{ url }`: an
   * OpenAI-compatible endpoint (a self-hosted Whisper server, OpenAI, Groq…). `{ command }`: a local tool such as
   * whisper.cpp. Or a function. `[whisper, 'browser']` falls back to the browser's text when Whisper fails.
   */
  transcribe?: Engine | Engine[];
  /** Show the browser's live transcript while recording: 'auto' (default) when the browser has it. */
  live?: 'auto' | boolean;
  /** The spoken language, BCP 47 (`'da-DK'`, `'en-US'`). Default: the browser's; engines get the base code (`da`). */
  language?: string;
  /** Voice notes (the Voice mode, key V). Default true. */
  notes?: boolean;
  /** The session recorder. Default true. */
  sessions?: boolean;
  /** Voice mode's key in the toolbar (default 'v'); false for none. */
  key?: string | false;
  /** Opens the overlay in the session recorder (default 'alt+shift+v'); false for none. */
  hotkey?: string | false;
  /** Longest voice note, in seconds (default 300). Sessions aren't capped. */
  maxSeconds?: number;
  /** Transcriptions at once (default 1). */
  concurrency?: number;
}

const HERE = typeof __dirname === 'string' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const DIST = path.basename(HERE) === 'dist' ? HERE : path.join(HERE, '../dist');

const AUDIO_EXT: Record<string, string> = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
const MIME: Record<string, string> = { webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', png: 'image/png', md: 'text/markdown; charset=utf-8', json: 'application/json; charset=utf-8' };
const extOf = (mime: string) => AUDIO_EXT[mime.split(';')[0].trim().toLowerCase()] ?? 'webm';
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
/** Written whole or not at all: an agent may be reading session.md while the transcript lands. */
async function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, file);
}
const SESSION_ID = /^\d{4}-\d{2}-\d{2}-\d{4}-[a-z0-9-]{1,48}$/;

/** What a voice note keeps in `meta.voice`. */
export interface VoiceMeta {
  audio: string;
  duration?: number;
  status: TranscriptStatus;
  engine?: string;
  error?: string;
  ms?: number;
  /** The transcript, also when the reviewer has rewritten the body. */
  text?: string;
  /** The live transcript the browser sent (the 'browser' engine). */
  live?: string;
  /** The body as last written by the plugin: replaced only while it still matches (the reviewer may have edited it). */
  bodyHash?: string;
}

interface Upload { data: string; mime?: string }
interface LiveText { text?: string; segments?: Segment[] }

/** One line, safe as a markdown note body (no "> " reply lines, headings or image lines). */
const safeLine = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/^([>#!]|<!--)/, '\\$1');

function noteBody(m: VoiceMeta, link: string, engineName: string): string {
  const rec = `🎙 [Recording (${clock(m.duration ?? 0)})](${link})`;
  if (m.status === 'done') return `${safeLine(m.text ?? '')}\n\n${rec}`;
  if (m.status === 'failed') return `_🎙 The transcript failed (${safeLine(m.error ?? 'unknown error')}). Listen to the recording, or retry from the overlay._${m.live ? `\n\nLive transcript: ${safeLine(m.live)}` : ''}\n\n${rec}`;
  if (m.status === 'none') return `_🎙 No transcript (no speech engine was available). Listen to the recording._\n\n${rec}`;
  return m.live
    ? `${safeLine(m.live)}\n\n_(Live transcript; the final one from ${engineName} is on its way.)_\n\n${rec}`
    : `_🎙 Transcribing this voice note (${engineName})… Wait for the transcript before acting on it._\n\n${rec}`;
}

export function voice(opts: VoiceOptions = {}): RedlinePlugin {
  return { name: 'voice', setup: ctx => voiceRoutes(opts, ctx) };
}

export function voiceRoutes(opts: VoiceOptions, ctx: PluginContext): PluginRoutes {
  const engines: Engine[] = (Array.isArray(opts.transcribe) ? opts.transcribe : [opts.transcribe ?? 'browser']).filter(Boolean);
  const server = engines.filter(e => e !== 'browser');
  const wantsWav = server.some(e => engineFormat(e) === 'wav');
  const firstServer = server[0] ? engineLabel(server[0]) : 'the browser';
  const lang = opts.language?.split(/[-_]/)[0].toLowerCase();
  const run = queue(Math.max(1, Math.min(8, opts.concurrency ?? 1)));
  const voiceDir = path.join(ctx.dirPath, 'voice');
  const sessionsDir = path.join(ctx.dirPath, 'sessions');
  const base = `${ctx.base}/p/voice`;
  // A link from a page file (`.redline/pages/x.md`) to a file of ours; through the API when notes aren't those files.
  const linkTo = (rel: string, route: string) => ctx.markdown ? `../${rel}` : `${base}/${route}`;

  /** Runs the engines in order on a recording; 'browser' takes the page's live transcript. */
  async function transcribe(files: { main: string; mime: string; wav?: string }, duration: number, live?: LiveText): Promise<{ status: TranscriptStatus; engine?: string; error?: string; ms?: number } & Partial<Transcript>> {
    const errors: string[] = [];
    for (const e of engines) {
      const label = engineLabel(e);
      if (e === 'browser') {
        if (live?.text?.trim()) return { status: 'done', engine: 'browser', text: live.text.trim(), segments: live.segments };
        continue;
      }
      const file = engineFormat(e) === 'wav' ? files.wav : files.main;
      if (!file) { errors.push(`${label}: no WAV copy of the recording`); continue; }
      const t0 = Date.now();
      try {
        const t = await runEngine(e, { file, mime: file === files.wav ? 'audio/wav' : files.mime, duration, language: lang });
        if (t.text) return { status: 'done', engine: label, ms: Date.now() - t0, ...t };
        errors.push(`${label}: no speech found`);
      } catch (err) {
        errors.push(`${label}: ${(err as Error)?.message ?? err}`);
        console.warn(`[redline-voice] ${label} failed:`, (err as Error)?.message ?? err);
      }
    }
    return errors.length ? { status: 'failed', error: errors.join('; ') } : { status: 'none' };
  }

  async function save(file: string, b64: string) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, Buffer.from(b64.replace(/^data:[^,]*,/, ''), 'base64'));
  }

  // ---- voice notes ----

  async function setNote(id: string, m: VoiceMeta, req?: IncomingMessage) {
    const n = await ctx.notes.get(id, req);
    if (!n) return;
    const prev = (n.meta?.voice ?? {}) as VoiceMeta;
    const body = noteBody(m, linkTo(m.audio, `audio/${path.basename(m.audio)}`), firstServer);
    // The reviewer rewrote the text: keep theirs; the transcript stays in meta.voice.text.
    const ours = !prev.bodyHash || prev.bodyHash === hash(n.body);
    const meta = { ...n.meta, voice: { ...m, bodyHash: ours ? hash(body) : prev.bodyHash } };
    await ctx.notes.update(id, ours && body !== n.body ? { body, meta } : { meta }, req);
  }

  async function transcribeNote(id: string, m: VoiceMeta) {
    await run(async () => {
      await setNote(id, { ...m, status: 'transcribing' });
      const main = path.join(ctx.dirPath, m.audio);
      const wav = main.replace(/\.[^.]+$/, '.wav');
      const r = await transcribe({ main, mime: MIME[path.extname(main).slice(1)] ?? 'audio/webm', wav: existsSync(wav) ? wav : undefined }, m.duration ?? 0, { text: m.live });
      await setNote(id, { audio: m.audio, duration: m.duration, live: m.live, status: r.status, engine: r.engine, error: r.error, ms: r.ms, text: r.text });
      if (r.status === 'done' && wav !== main) await fs.rm(wav, { force: true });
    }).catch(err => console.warn('[redline-voice] transcription failed:', err));
  }

  async function createVoiceNote(req: IncomingMessage, body: { request: NewNoteRequest; audio: Upload; wav?: string; duration?: number; live?: LiveText }) {
    if (!body?.request?.note?.page || !body.audio?.data) throw new Error('request and audio are required');
    const id = newId();
    const ext = extOf(body.audio.mime ?? 'audio/webm');
    const rel = `voice/${id}.${ext}`;
    await save(path.join(ctx.dirPath, rel), body.audio.data);
    if (body.wav) await save(path.join(voiceDir, `${id}.wav`), body.wav);
    const duration = Math.round((Number(body.duration) || 0) * 10) / 10;
    const live = body.live?.text?.trim() ? safeLine(body.live.text) : undefined;
    // Only the browser's text and no server engine: done at once.
    const now = server.length ? null : await transcribe({ main: path.join(ctx.dirPath, rel), mime: body.audio.mime ?? 'audio/webm' }, duration, body.live);
    const m: VoiceMeta = now
      ? { audio: rel, duration, status: now.status, engine: now.engine, error: now.error, text: now.text, live }
      : { audio: rel, duration, status: 'queued', live };
    const text = noteBody(m, linkTo(rel, `audio/${id}.${ext}`), firstServer);
    m.bodyHash = hash(text);
    const request: NewNoteRequest = { ...body.request, note: { ...body.request.note, id, type: 'comment', body: text, meta: { ...body.request.note.meta, voice: m } } };
    const note = await ctx.notes.create(request, req);
    if (!now) void transcribeNote(note.id, m);
    return note;
  }

  // ---- sessions ----

  const sessionFile = (id: string) => path.join(sessionsDir, id, 'session.json');
  const readSession = async (id: string): Promise<SessionData | null> => {
    try { return JSON.parse(await fs.readFile(sessionFile(id), 'utf8')); } catch { return null; }
  };

  function pointerBody(s: SessionData): string {
    const points = s.events.filter(e => e.kind === 'point').length;
    const shots = s.events.filter(e => 'shot' in e && e.shot).length;
    const t = s.transcript;
    const state = t.status === 'done' ? `transcribed by ${t.engine}` : t.status === 'failed' ? `transcription failed: ${safeLine(t.error ?? '')}` : t.status === 'none' ? 'no transcript' : `transcribing (${firstServer})…`;
    const md = `${ctx.dir}/sessions/${s.id}/session.md`;
    let out = `🎬 **Recorded review session**: ${clock(s.duration)}, ${points} pointer${points === 1 ? '' : 's'}, ${shots} screenshot${shots === 1 ? '' : 's'}; ${state}.\n\n`;
    out += `Read [${md}](${linkTo(`sessions/${s.id}/session.md`, `sessions/${s.id}/session.md`)}): what the reviewer said, lined up with what they pointed at. Do what it asks, then tick this note.`;
    if (t.status !== 'done' && t.status !== 'none' && t.status !== 'failed') out += ' Wait until the transcript is in.';
    if (t.status === 'done' && t.text) out += `\n\nIt starts: “${safeLine(t.text).slice(0, 240)}${t.text.length > 240 ? '…' : ''}”`;
    return out;
  }

  async function writeSession(s: SessionData, req?: IncomingMessage) {
    const dir = path.join(sessionsDir, s.id);
    await fs.mkdir(dir, { recursive: true });
    // session.md first: its status follows session.json, so whoever sees "done" there finds the timeline written.
    await writeAtomic(path.join(dir, 'session.md'), sessionMarkdown(s));
    await writeAtomic(sessionFile(s.id), JSON.stringify(s, null, 2));
    if (!s.note) return;
    const n = await ctx.notes.get(s.note, req);
    if (!n) return;
    const prev = n.meta?.session as { bodyHash?: string } | undefined;
    const body = pointerBody(s);
    const ours = !prev?.bodyHash || prev.bodyHash === hash(n.body);
    const meta = { ...n.meta, session: { id: s.id, status: s.transcript.status, engine: s.transcript.engine, error: s.transcript.error, duration: s.duration, audio: s.audio, bodyHash: ours ? hash(body) : prev!.bodyHash } };
    await ctx.notes.update(s.note, ours && body !== n.body ? { body, meta } : { meta }, req);
  }

  async function transcribeSession(id: string, live?: LiveText) {
    await run(async () => {
      const s = await readSession(id);
      if (!s?.audio) return;
      s.transcript = { ...s.transcript, status: 'transcribing' };
      await writeSession(s);
      const main = path.join(sessionsDir, id, s.audio);
      const wav = path.join(sessionsDir, id, 'audio.wav');
      const r = await transcribe({ main, mime: MIME[path.extname(main).slice(1)] ?? 'audio/webm', wav: existsSync(wav) ? wav : undefined }, s.duration, live ?? (s.transcript.text ? { text: s.transcript.text, segments: s.transcript.segments } : undefined));
      // Keep the browser's text if the engines found nothing better.
      s.transcript = r.status === 'done' ? { status: 'done', engine: r.engine, text: r.text, segments: r.segments, ms: r.ms } : { ...s.transcript, status: r.status, error: r.error };
      await writeSession(s);
      if (r.status === 'done' && existsSync(wav)) await fs.rm(wav, { force: true });
    }).catch(err => console.warn('[redline-voice] session transcription failed:', err));
  }

  async function createSession(req: IncomingMessage, body: {
    request: NewNoteRequest; started?: string; duration?: number; audio?: Upload; wav?: string;
    events?: SessionEvent[]; shots?: Record<string, string>; live?: LiveText;
  }) {
    if (!body?.request?.note?.page) throw new Error('request is required');
    const started = new Date(body.started ?? Date.now());
    const id = sessionId(isNaN(+started) ? new Date() : started, body.request.note.page, x => existsSync(path.join(sessionsDir, x)));
    const dir = path.join(sessionsDir, id);
    await fs.mkdir(path.join(dir, 'shots'), { recursive: true });
    // Screenshots: the page names them; we keep only names we gave out (shots/NN.png).
    const names = new Map<string, string>();
    let i = 0;
    for (const [name, data] of Object.entries(body.shots ?? {})) {
      if (typeof data !== 'string' || !data.startsWith('data:image/png;base64,')) continue;
      const file = `shots/${String(++i).padStart(2, '0')}.png`;
      await fs.writeFile(path.join(dir, file), Buffer.from(data.slice(22), 'base64'));
      names.set(name, file);
    }
    const events = (Array.isArray(body.events) ? body.events : []).filter(e => e && typeof e.t === 'number' && typeof e.kind === 'string').map(e => {
      const x = { ...e } as SessionEvent & { shot?: string };
      if ('shot' in x && x.shot) x.shot = names.get(x.shot);
      if (x.shot === undefined) delete x.shot;
      return x as SessionEvent;
    }).sort((a, b) => a.t - b.t);
    let audio: string | undefined;
    if (body.audio?.data) {
      audio = `audio.${extOf(body.audio.mime ?? 'audio/webm')}`;
      await save(path.join(dir, audio), body.audio.data);
      if (body.wav) await save(path.join(dir, 'audio.wav'), body.wav);
    }
    const live = body.live?.text?.trim() ? { text: body.live.text.trim(), segments: body.live.segments } : undefined;
    const r = body.request.note;
    const s: SessionData = {
      id, page: r.page, url: r.url, title: r.title, app: ctx.app || undefined, started: started.toISOString(),
      duration: Math.round((Number(body.duration) || 0) * 10) / 10, audio, events, viewport: r.viewport,
      transcript: !audio ? { status: 'none' } : server.length ? { status: 'queued', ...live } : { status: live ? 'done' : 'none', engine: live ? 'browser' : undefined, ...live },
    };
    const note = await ctx.notes.create({ note: { ...r, type: 'comment', whole: true, target: undefined, body: pointerBody(s), meta: { ...r.meta, session: { id, status: s.transcript.status } } } }, req);
    s.note = note.id;
    await writeSession(s, req);
    if (audio && server.length) void transcribeSession(id, live);
    return { id, note: note.id, dir: `${ctx.dir}/sessions/${id}` };
  }

  // Picks up what a restart interrupted: queued or running voice notes and sessions.
  let resumed = false;
  async function resume() {
    if (resumed || !server.length) return;
    resumed = true;
    for (const n of await ctx.notes.list().catch(() => [] as Note[])) {
      const m = n.meta?.voice as VoiceMeta | undefined;
      if (m && (m.status === 'queued' || m.status === 'transcribing') && existsSync(path.join(ctx.dirPath, m.audio))) void transcribeNote(n.id, m);
    }
    for (const id of await fs.readdir(sessionsDir).catch(() => [] as string[])) {
      const s = SESSION_ID.test(id) ? await readSession(id) : null;
      if (s && (s.transcript.status === 'queued' || s.transcript.status === 'transcribing')) void transcribeSession(id);
    }
  }

  async function sendFile(res: ServerResponse, file: string) {
    const type = MIME[path.extname(file).slice(1)];
    if (!type || !existsSync(file)) return json(res, 404, { error: 'not found' });
    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'no-store');
    res.end(await fs.readFile(file));
  }

  const keyOf = (k: string | false | undefined, d: string) => k === false ? false : typeof k === 'string' && k.length === 1 ? k.toLowerCase() : d;

  return {
    extensions: [`${base}/extension.js`],
    async handle(req, res, p) {
      void resume();
      const method = req.method ?? 'GET';
      const read = method === 'GET' || method === 'HEAD';
      try {
        if (read && p === '/extension.js') {
          const file = path.join(DIST, 'extension.js');
          if (!existsSync(file)) return json(res, 404, { error: 'voice extension not built' });
          res.setHeader('content-type', 'text/javascript; charset=utf-8');
          res.setHeader('cache-control', 'no-store');
          res.end(await fs.readFile(file));
          return;
        }
        if (read && p === '/config') return json(res, 200, {
          notes: opts.notes !== false, sessions: opts.sessions !== false,
          live: opts.live ?? 'auto', browser: engines.includes('browser'), engines: engines.map(engineLabel),
          wav: wantsWav, language: opts.language ?? null, maxSeconds: opts.maxSeconds ?? 300,
          key: keyOf(opts.key, 'v'), hotkey: opts.hotkey === false ? false : opts.hotkey || 'alt+shift+v',
        });
        const audio = /^\/audio\/([a-z0-9]+\.(webm|ogg|m4a|mp3|wav))$/.exec(p);
        if (read && audio) return sendFile(res, path.join(voiceDir, audio[1]));
        const sf = /^\/sessions\/([a-z0-9-]+)\/((?:shots\/)?[a-z0-9.]+)$/.exec(p);
        if (read && sf && SESSION_ID.test(sf[1])) return sendFile(res, path.join(sessionsDir, sf[1], sf[2]));
        if (method === 'POST' && p === '/notes') {
          if (opts.notes === false) return json(res, 404, { error: 'voice notes are off' });
          return json(res, 200, await createVoiceNote(req, JSON.parse(await readBody(req, 60 * 1024 * 1024))));
        }
        if (method === 'POST' && p === '/sessions') {
          if (opts.sessions === false) return json(res, 404, { error: 'sessions are off' });
          return json(res, 200, await createSession(req, JSON.parse(await readBody(req, 300 * 1024 * 1024))));
        }
        const retry = /^\/retry\/([a-z0-9-]+)$/.exec(p);
        if (method === 'POST' && retry) {
          if (validId(retry[1])) {
            const n = await ctx.notes.get(retry[1], req);
            const m = n?.meta?.voice as VoiceMeta | undefined;
            if (!m) return json(res, 404, { error: 'not a voice note' });
            if (m.status === 'queued' || m.status === 'transcribing') return json(res, 409, { error: 'already transcribing' });
            await setNote(n!.id, { ...m, status: 'queued', error: undefined }, req);
            void transcribeNote(n!.id, { ...m, status: 'queued' });
            return json(res, 200, { ok: true });
          }
          const s = SESSION_ID.test(retry[1]) ? await readSession(retry[1]) : null;
          if (!s) return json(res, 404, { error: 'unknown session' });
          s.transcript = { ...s.transcript, status: 'queued', error: undefined };
          await writeSession(s, req);
          void transcribeSession(s.id);
          return json(res, 200, { ok: true });
        }
        json(res, 404, { error: 'unknown voice route' });
      } catch (err) {
        if (!res.headersSent) json(res, 400, { error: String((err as Error)?.message ?? err) });
      }
    },
  };
}
