// Types for @umage.ai/redline-voice.
import type { RedlinePlugin } from '@umage.ai/redline/server';

/** A stretch of speech, in seconds from the start of the recording. */
export interface Segment { start: number; end: number; text: string }
export interface Transcript { text: string; segments?: Segment[] }
export interface AudioInput { file: string; mime: string; duration?: number; language?: string }

/** An OpenAI-compatible `/audio/transcriptions` endpoint: a self-hosted Whisper server, OpenAI, Groq… */
export interface HttpEngine {
  /** The API base (`http://localhost:8000/v1`) or the full `…/audio/transcriptions` URL. */
  url: string;
  /** Default `whisper-1`. */
  model?: string;
  apiKey?: string;
  /** Read the key from this environment variable. */
  apiKeyEnv?: string;
  language?: string;
  prompt?: string;
  fields?: Record<string, string>;
  headers?: Record<string, string>;
  /** The browser's recording (default) or 16 kHz mono WAV. */
  format?: 'webm' | 'wav';
  timeoutMs?: number;
  label?: string;
}

/** A local tool, e.g. whisper.cpp. `{file}`, `{dir}`, `{name}`, `{lang}` are filled in. */
export interface CommandEngine {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** A file the tool writes (`'{file}.srt'`), read instead of stdout. */
  outputFile?: string;
  /** Default `wav` (16 kHz mono). */
  format?: 'webm' | 'wav';
  language?: string;
  timeoutMs?: number;
  label?: string;
}

export type TranscribeFn = (audio: AudioInput) => Promise<string | Transcript>;
export type Engine = 'browser' | HttpEngine | CommandEngine | TranscribeFn | { transcribe: TranscribeFn; label?: string; format?: 'webm' | 'wav' };

export interface VoiceOptions {
  /** Engines tried in order until one returns text. Default `'browser'` (Web Speech API). */
  transcribe?: Engine | Engine[];
  /** Show the browser's live transcript while recording. Default 'auto'. */
  live?: 'auto' | boolean;
  /** BCP 47, e.g. `'da-DK'`. Default: the browser's. */
  language?: string;
  /** Voice notes (Voice mode, key V). Default true. */
  notes?: boolean;
  /** The session recorder. Default true. */
  sessions?: boolean;
  /** Voice mode's key (default 'v'); false for none. */
  key?: string | false;
  /** Opens the session recorder from anywhere (default 'alt+shift+v'); false for none. */
  hotkey?: string | false;
  /** Longest voice note in seconds (default 300). */
  maxSeconds?: number;
  /** Transcriptions at once (default 1). */
  concurrency?: number;
}

/** Voice notes and the session recorder: `redline({ plugins: [voice({ transcribe: { url: 'http://localhost:8000/v1' } })] })`. */
export declare function voice(opts?: VoiceOptions): RedlinePlugin;
/** Parses a tool's output (JSON, SRT, VTT, whisper.cpp lines, text) into a transcript. */
export declare function parseOutput(raw: string): Transcript;
