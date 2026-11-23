// The microphone in the browser: a MediaRecorder for the file, an analyser for the level meter, and the
// Web Speech API (Chrome, Edge) for a live transcript with times on the recording's clock. The clock
// leaves out pauses, like the recorded file does, so screen events and speech line up with the audio.

export interface LiveSegment { start: number; end: number; text: string }

export interface Recording {
  mime: string;
  /** Seconds on the recording's clock (pauses left out). */
  elapsed(): number;
  /** 0–1, for a meter. */
  level(): number;
  paused(): boolean;
  pause(): void;
  resume(): void;
  /** The live transcript so far: final segments, and what is being said now. */
  live(): { segments: LiveSegment[]; interim: string; available: boolean; error?: string };
  stop(): Promise<{ blob: Blob; mime: string; duration: number; segments: LiveSegment[]; text: string }>;
  cancel(): void;
}

type SR = {
  lang: string; continuous: boolean; interimResults: boolean;
  start(): void; stop(): void; abort(): void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};
const SpeechRecognitionCtor = (): (new () => SR) | undefined =>
  (globalThis as { SpeechRecognition?: new () => SR; webkitSpeechRecognition?: new () => SR }).SpeechRecognition
  ?? (globalThis as { webkitSpeechRecognition?: new () => SR }).webkitSpeechRecognition;

export const liveSupported = () => !!SpeechRecognitionCtor();
export const micSupported = () => typeof MediaRecorder === 'function' && !!navigator.mediaDevices?.getUserMedia;

const MIMES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];

/** Starts recording; rejects when the microphone is refused or missing. */
export async function record(opts: { live: boolean; lang?: string | null; onChange?: () => void }): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = MIMES.find(m => MediaRecorder.isTypeSupported?.(m)) ?? '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  rec.start(1000);

  // Clock: run time without pauses.
  let acc = 0, since = performance.now(), isPaused = false;
  const elapsed = () => (acc + (isPaused ? 0 : performance.now() - since)) / 1000;

  // Level meter.
  let ac: AudioContext | null = null, analyser: AnalyserNode | null = null;
  try {
    ac = new AudioContext();
    analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(analyser);
  } catch { /* no meter */ }
  const buf = new Uint8Array(512);
  const level = () => {
    if (!analyser || isPaused) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += ((v - 128) / 128) ** 2;
    return Math.min(1, Math.sqrt(sum / buf.length) * 4);
  };

  // Live transcript.
  const segments: LiveSegment[] = [];
  let interim = '', started: number | null = null, srError: string | undefined, active = true;
  const Ctor = opts.live ? SpeechRecognitionCtor() : undefined;
  let sr: SR | null = null;
  const startSr = () => { try { sr?.start(); } catch { /* already running */ } };
  if (Ctor) {
    sr = new Ctor();
    sr.lang = opts.lang || navigator.language || 'en-US';
    sr.continuous = true;
    sr.interimResults = true;
    sr.onresult = e => {
      let now = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript?.trim() ?? '';
        if (r.isFinal) {
          if (text) segments.push({ start: started ?? Math.max(0, elapsed() - 2), end: elapsed(), text });
          started = null;
        } else {
          started ??= elapsed();
          now += (now ? ' ' : '') + text;
        }
      }
      interim = now;
      opts.onChange?.();
    };
    // Chrome ends recognition after a silence or a minute: start again while we record.
    sr.onend = () => { if (active && !isPaused && !srError) setTimeout(startSr, 100); };
    sr.onerror = e => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      srError = e.error === 'not-allowed' ? 'speech recognition blocked' : e.error === 'network' ? 'speech service unreachable' : e.error;
      opts.onChange?.();
    };
    startSr();
  }

  const close = () => {
    active = false;
    try { sr?.abort(); } catch { /* gone */ }
    stream.getTracks().forEach(t => t.stop());
    void ac?.close().catch(() => {});
  };

  return {
    mime: rec.mimeType || mime || 'audio/webm',
    elapsed, level,
    paused: () => isPaused,
    pause() {
      if (isPaused) return;
      acc += performance.now() - since; isPaused = true;
      if (rec.state === 'recording') rec.pause();
      try { sr?.stop(); } catch { /* not running */ }
      if (interim) { segments.push({ start: started ?? elapsed(), end: elapsed(), text: interim }); interim = ''; started = null; }
    },
    resume() {
      if (!isPaused) return;
      since = performance.now(); isPaused = false;
      if (rec.state === 'paused') rec.resume();
      startSr();
    },
    live: () => ({ segments: segments.slice(), interim, available: !!sr && !srError, error: srError }),
    stop() {
      return new Promise(resolve => {
        const duration = elapsed();
        if (interim) segments.push({ start: started ?? duration, end: duration, text: interim });
        rec.onstop = () => {
          close();
          const type = rec.mimeType || mime || 'audio/webm';
          resolve({ blob: new Blob(chunks, { type }), mime: type, duration, segments: segments.slice(), text: segments.map(s => s.text).join(' ') });
        };
        if (rec.state !== 'inactive') rec.stop(); else rec.onstop(new Event('stop'));
      });
    },
    cancel() { rec.onstop = null; if (rec.state !== 'inactive') rec.stop(); close(); },
  };
}

/** A blob as base64 (no data: prefix). */
export function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** 16 kHz mono 16-bit WAV, what whisper.cpp reads. */
export async function toWav(blob: Blob): Promise<Blob> {
  const ac = new AudioContext();
  let audio: AudioBuffer;
  try { audio = await ac.decodeAudioData(await blob.arrayBuffer()); } finally { void ac.close().catch(() => {}); }
  const rate = 16000;
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * rate)), rate);
  const src = off.createBufferSource();
  src.buffer = audio;
  src.connect(off.destination);
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0);
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Blob([out.buffer], { type: 'audio/wav' });
}
