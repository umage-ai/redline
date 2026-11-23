// Speech to text for voice notes and sessions. Engines are tried in the order given; the first that
// returns text wins. 'browser' is the live transcript the page sent (Web Speech API), so
// `['browser', whisper]` prefers it and `[whisper, 'browser']` falls back to it.

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** A stretch of speech, in seconds from the start of the recording. */
export interface Segment { start: number; end: number; text: string }
export interface Transcript { text: string; segments?: Segment[] }

/** The recording handed to an engine. */
export interface AudioInput {
  /** Absolute path of the file in the format the engine asked for. */
  file: string;
  mime: string;
  /** Seconds. */
  duration?: number;
  language?: string;
}

/** An OpenAI-compatible `/audio/transcriptions` endpoint: self-hosted Whisper servers, OpenAI, Groq… */
export interface HttpEngine {
  /** The API base (`http://localhost:8000/v1`) or the full `…/audio/transcriptions` URL. */
  url: string;
  /** Default `whisper-1`. */
  model?: string;
  /** Sent as `Authorization: Bearer …`. */
  apiKey?: string;
  /** Read the key from this environment variable (keeps it out of a committed config). */
  apiKeyEnv?: string;
  language?: string;
  /** Spelling hints: product names, jargon. */
  prompt?: string;
  /** Extra form fields (`temperature`, …). */
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  /** What to send: the browser's recording (default) or 16 kHz mono WAV. */
  format?: 'webm' | 'wav';
  /** Default 600 s. */
  timeoutMs?: number;
  /** Shown in the status chip (default the URL's host). */
  label?: string;
}

/**
 * A local tool, e.g. whisper.cpp: `{ command: 'whisper-cli', args: ['-m', 'models/ggml-base.bin', '-f', '{file}', '-nt'] }`.
 * `{file}`, `{dir}`, `{name}` (file name without extension) and `{lang}` are filled in; without `{file}`, the path goes last.
 * Output: stdout, or `outputFile` read after the run; plain text, SRT, VTT, whisper.cpp's `[00:00:01.000 --> …]` lines, or JSON.
 */
export interface CommandEngine {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** A file the tool writes, e.g. `'{file}.srt'` (whisper.cpp `-osrt`). Read instead of stdout. */
  outputFile?: string;
  /** What to hand the tool (default `wav`, 16 kHz mono: what whisper.cpp reads). */
  format?: 'webm' | 'wav';
  language?: string;
  timeoutMs?: number;
  label?: string;
}

export type TranscribeFn = (audio: AudioInput) => Promise<string | Transcript>;
export type Engine = 'browser' | HttpEngine | CommandEngine | TranscribeFn | { transcribe: TranscribeFn; label?: string; format?: 'webm' | 'wav' };

export const engineLabel = (e: Engine): string => {
  if (e === 'browser') return 'browser';
  if (typeof e === 'function') return e.name || 'custom';
  if ('transcribe' in e) return e.label ?? 'custom';
  if ('url' in e) { if (e.label) return e.label; try { return new URL(e.url).host; } catch { return 'http'; } }
  return e.label ?? path.basename(e.command).replace(/\.(exe|cmd|bat)$/i, '');
};

/** The format an engine wants its audio in. */
export const engineFormat = (e: Engine): 'webm' | 'wav' => {
  if (e === 'browser' || typeof e === 'function') return 'webm';
  if ('transcribe' in e || 'url' in e) return e.format ?? 'webm';
  return e.format ?? 'wav';
};

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Runs one engine. 'browser' isn't run here: the caller has the page's transcript. */
export async function runEngine(e: Exclude<Engine, 'browser'>, audio: AudioInput): Promise<Transcript> {
  const out = typeof e === 'function' ? await e(audio)
    : 'transcribe' in e ? await e.transcribe(audio)
    : 'url' in e ? await viaHttp(e, audio)
    : await viaCommand(e, audio);
  const t: Transcript = typeof out === 'string' ? parseOutput(out) : out;
  return { text: clean(t.text ?? ''), segments: t.segments?.filter(s => s && clean(s.text)).map(s => ({ start: +s.start || 0, end: +s.end || +s.start || 0, text: clean(s.text) })) };
}

async function viaHttp(e: HttpEngine, audio: AudioInput): Promise<Transcript> {
  const url = /\/audio\/transcriptions\/?$/.test(e.url) ? e.url : e.url.replace(/\/+$/, '') + '/audio/transcriptions';
  const key = e.apiKey ?? (e.apiKeyEnv ? process.env[e.apiKeyEnv] : undefined);
  const data = await fs.readFile(audio.file);
  const send = async (format: string) => {
    const form = new FormData();
    form.append('file', new Blob([data], { type: audio.mime }), path.basename(audio.file));
    form.append('model', e.model ?? 'whisper-1');
    form.append('response_format', format);
    const lang = e.language ?? audio.language;
    if (lang) form.append('language', lang);
    if (e.prompt) form.append('prompt', e.prompt);
    if (format === 'verbose_json') form.append('timestamp_granularities[]', 'segment');
    for (const [k, v] of Object.entries(e.fields ?? {})) form.append(k, v);
    return fetch(url, {
      method: 'POST', body: form, signal: AbortSignal.timeout(e.timeoutMs ?? 600_000),
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...e.headers },
    });
  };
  let r = await send('verbose_json');
  // Some servers only know json/text.
  if (r.status === 400 || r.status === 422) r = await send('json');
  const body = await r.text();
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${body.slice(0, 300)}`);
  try {
    const j = JSON.parse(body) as { text?: string; segments?: Segment[] };
    return { text: j.text ?? (j.segments ?? []).map(s => s.text).join(' '), segments: j.segments };
  } catch { return parseOutput(body); }
}

const fill = (s: string, audio: AudioInput) => s
  .replaceAll('{file}', audio.file).replaceAll('{dir}', path.dirname(audio.file))
  .replaceAll('{name}', path.basename(audio.file).replace(/\.[^.]+$/, '')).replaceAll('{lang}', audio.language ?? 'auto');

async function viaCommand(e: CommandEngine, audio: AudioInput): Promise<string> {
  const a = { ...audio, language: e.language ?? audio.language };
  const args = (e.args ?? []).map(x => fill(x, a));
  if (!(e.args ?? []).some(x => x.includes('{file}'))) args.push(audio.file);
  const stdout = await new Promise<string>((resolve, reject) => {
    // A .cmd/.bat (npm shims, Windows wrappers) needs the shell; a real executable runs as is.
    const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(e.command);
    const child = spawn(e.command, args, { cwd: e.cwd, env: { ...process.env, ...e.env }, shell, windowsHide: true });
    const out: Buffer[] = [], err: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`timed out after ${(e.timeoutMs ?? 600_000) / 1000} s`)); }, e.timeoutMs ?? 600_000);
    child.stdout.on('data', c => out.push(c));
    child.stderr.on('data', c => err.push(c));
    child.on('error', x => { clearTimeout(timer); reject(x); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else reject(new Error(`${e.command} exited with ${code}: ${Buffer.concat(err).toString('utf8').trim().split('\n').slice(-3).join(' ').slice(0, 300)}`));
    });
  });
  if (!e.outputFile) return stdout;
  const file = fill(e.outputFile, a);
  try { return await fs.readFile(file, 'utf8'); } finally { await fs.rm(file, { force: true }).catch(() => {}); }
}

const TS = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`;
const secs = (m: RegExpExecArray, i: number) => (+(m[i] ?? 0)) * 3600 + (+m[i + 1]) * 60 + (+m[i + 2]) + (+m[i + 3].padEnd(3, '0')) / 1000;

/** A tool's output as a transcript: JSON (OpenAI/whisper, whisper.cpp -oj), SRT/VTT or whisper.cpp's timed lines, else plain text. */
export function parseOutput(raw: string): Transcript {
  const s = raw.replace(/^﻿/, '').trim();
  if (/^[{[]/.test(s)) {
    try {
      const j = JSON.parse(s);
      // whisper.cpp -oj: { transcription: [{ offsets: { from, to } (ms), text }] }
      if (Array.isArray(j?.transcription)) {
        const segments = j.transcription.map((x: { offsets?: { from: number; to: number }; text: string }) => ({ start: (x.offsets?.from ?? 0) / 1000, end: (x.offsets?.to ?? 0) / 1000, text: x.text }));
        return { text: segments.map((x: Segment) => x.text).join(' '), segments };
      }
      if (typeof j?.text === 'string' || Array.isArray(j?.segments)) return { text: j.text ?? j.segments.map((x: Segment) => x.text).join(' '), segments: j.segments };
    } catch { /* not JSON after all */ }
  }
  // SRT / VTT cues and whisper.cpp's "[00:00:00.000 --> 00:00:02.500]  text" lines.
  const cue = new RegExp(String.raw`^\[?${TS}\s*-->\s*${TS}\]?\s*(.*)$`);
  const segments: Segment[] = [];
  let cur: Segment | null = null;
  for (const line of s.split(/\r?\n/)) {
    const m = cue.exec(line.trim());
    if (m) {
      cur = { start: secs(m, 1), end: secs(m, 5), text: m[9] ?? '' };
      segments.push(cur);
      continue;
    }
    if (!cur || !line.trim() || /^\d+$/.test(line.trim()) || /^WEBVTT/.test(line)) { if (!line.trim()) cur = null; continue; }
    cur.text += ' ' + line.trim();
  }
  if (segments.length) {
    const segs = segments.map(x => ({ ...x, text: x.text.replace(/<[^>]+>/g, '').trim() })).filter(x => x.text);
    return { text: segs.map(x => x.text).join(' '), segments: segs };
  }
  return { text: s };
}

/** Jobs one (or `concurrency`) at a time, so a long session doesn't run five Whisper processes at once. */
export function queue(concurrency = 1) {
  let running = 0;
  const waiting: (() => void)[] = [];
  return async function run<T>(job: () => Promise<T>): Promise<T> {
    if (running >= concurrency) await new Promise<void>(r => waiting.push(r));
    running++;
    try { return await job(); } finally { running--; waiting.shift()?.(); }
  };
}
