// OSC 7501, the Program Status Protocol (https://www.superlogical.com/rex/docs/build/program-status):
// a program in a terminal reports what it is doing, `ESC ] 7501 ; state=working:app=claude-code ST`.
// Claude Code reports through it once its startup query `ESC ] 7501 ; ? ST` is answered (D53).
// Used by the bridge (sessions.ts) on the program's output; emit.ts is the other end, for a CLI.
// Everything here is untrusted terminal output: a report that breaks a rule is dropped whole.
// The rules are the spec's, as CodeShellManager implements them.

export type ProgramState = 'idle' | 'working' | 'done' | 'blocked' | 'error';
export type BlockedKind = 'permission' | 'question' | 'auth';

export interface ProgramReport {
  state: ProgramState | 'clear';
  kind?: BlockedKind;
  /** 0–100; absent = indeterminate. */
  progress?: number;
  app?: string;
  /** Record id, `/`-separated segments; absent = the root record. */
  id?: string;
  title?: string;
  msg?: string;
}

/** One live record and when it was last reported. */
export interface ProgramRecord extends ProgramReport { state: ProgramState; at: number }

/** What a session shows: the winning record's state, or idle. */
export interface ProgramStatus {
  state: ProgramState;
  kind?: BlockedKind;
  progress?: number;
  app?: string;
  title?: string;
  msg?: string;
  /** Live records (the root first). */
  records: number;
}

/** The terminal's fixed answer to the feature query (baseline states and kinds). */
export const PROBE_REPLY = '\x1b]7501;?\x1b\\';

const MAX_SEQUENCE = 4096, MAX_KEY = 16, MAX_MSG = 2048, MAX_TITLE = 192, MAX_ID = 128, MAX_SEGMENT = 32, MAX_DEPTH = 8, ENVELOPE = 9;
const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error', 'clear']);
const KINDS = new Set(['permission', 'question', 'auth']);
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]+$/;

const segmentOk = (s: string, max: number) => s.length > 0 && s.length <= max && SEGMENT.test(s);
const idOk = (id: string) => id.length > 0 && id.length <= MAX_ID && id.split('/').length <= MAX_DEPTH && id.split('/').every(s => segmentOk(s, MAX_SEGMENT));

/** True for the feature query (`?`), which carries no pairs. */
export const isProbe = (payload: string) => payload.trim() === '?';

/** Standard base64 → single-line text, or null (bad base64, too long, invalid UTF-8, a control or line break). */
export function decodeText(b64: string, max: number): string | null {
  if (!b64) return '';
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const body = b64.replace(/=+$/, '');
  if (body.length % 4 === 1 || (b64.length !== body.length && b64.length % 4 !== 0)) return null;
  let text: string;
  try {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > max) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch { return null; }
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(text)) return null;   // controls (C0, DEL, C1), line and paragraph separators
  // Format characters (bidi overrides, zero-width, the tag block) are invisible: stripped, not rejected.
  return text.replace(/\p{Cf}/gu, '');
}

/** Parses one report payload (the text after `7501;`); null when it must be ignored. */
export function parseReport(payload: string): ProgramReport | null {
  if (!payload || Buffer.byteLength(payload) + ENVELOPE > MAX_SEQUENCE) return null;
  const f = new Map<string, string>();
  for (const raw of payload.split(':')) {
    const pair = raw.trim(), eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const key = pair.slice(0, eq).trim(), value = pair.slice(eq + 1).trim();
    if (!KEY.test(key)) continue;
    if (key.length > MAX_KEY) return null;
    if (!VALUE.test(value)) continue;
    f.set(key, value);   // a repeat: the last one wins
  }
  const state = f.get('state');
  if (!state || !STATES.has(state)) return null;
  const r: ProgramReport = { state: state as ProgramReport['state'] };
  const id = f.get('id');
  if (id !== undefined) { if (!idOk(id)) return null; r.id = id; }
  const app = f.get('app');
  if (app && segmentOk(app, 32)) r.app = app;
  const kind = f.get('kind');
  if (state === 'blocked' && kind && KINDS.has(kind)) r.kind = kind as BlockedKind;
  const p = f.get('progress');
  if (p !== undefined && /^\d{1,3}$/.test(p) && +p <= 100) r.progress = +p;
  for (const [key, max] of [['msg', MAX_MSG], ['title', MAX_TITLE]] as const) {
    const v = f.get(key);
    if (v === undefined) continue;
    const text = decodeText(v, max);
    if (text === null) return null;
    if (text) r[key] = text;
  }
  return r;
}

const RANK: Record<ProgramState, number> = { blocked: 4, working: 3, error: 2, done: 1, idle: 0 };

/**
 * The records one session reported: each report replaces its record, `clear` removes it and its
 * children (or everything, without an id). The status is blocked > working > error > done > idle,
 * ties to the root, then the most recent: live work outranks a finished child's result.
 */
export class ProgramRecords {
  private records = new Map<string, ProgramRecord>();
  private max: number;
  constructor(max = 256) { this.max = max; }

  apply(r: ProgramReport, now = Date.now()) {
    const key = r.id ?? '';
    if (r.state === 'clear') {
      if (!key) this.records.clear();
      else for (const k of [...this.records.keys()]) if (k === key || k.startsWith(key + '/')) this.records.delete(k);
      return;
    }
    this.records.delete(key);
    this.records.set(key, { ...r, state: r.state, at: now });
    if (this.records.size > this.max) {
      const oldest = [...this.records.values()].reduce((a, b) => (b.at < a.at ? b : a));
      this.records.delete(oldest.id ?? '');
    }
  }

  /** The program ended or a new prompt began: working, blocked and idle go; done and error stay. */
  dropTransient() {
    for (const [k, r] of this.records) if (r.state !== 'done' && r.state !== 'error') this.records.delete(k);
  }

  /** Someone looked: done and error records are retired. */
  acknowledge() {
    for (const [k, r] of this.records) if (r.state === 'done' || r.state === 'error') this.records.delete(k);
  }

  clear() { this.records.clear(); }

  status(): ProgramStatus {
    let best: ProgramRecord | undefined;
    for (const r of this.records.values()) {
      if (!best || RANK[r.state] > RANK[best.state]) { best = r; continue; }
      if (RANK[r.state] < RANK[best.state]) continue;
      const rootR = r.id === undefined, rootB = best.id === undefined;
      if (rootR !== rootB ? rootR : r.at >= best.at) best = r;
    }
    if (!best) return { state: 'idle', records: 0 };
    const { state, kind, progress, app, title, msg } = best;
    return { state, kind, progress, app, title, msg, records: this.records.size };
  }
}

/** xterm.js's answer to DA1 (`CSI c`): a VT100 with advanced video. */
export const DA1_REPLY = '\x1b[?1;2c';

export type ScanEvent = { type: 'probe' } | { type: 'da1' } | { type: 'report'; report: ProgramReport };

const OSC_START = '\x1b]7501;';
// The 7501 introducer, or a primary device attributes query (CSI c / CSI 0 c, not CSI > c or CSI ? c).
const NEXT = /\x1b\]7501;|\x1b\[0?c/g;

/**
 * Finds OSC 7501 sequences and DA1 queries in a terminal output stream, in order and across chunk
 * boundaries. The server answers both itself (D53): Claude Code sends DA1 right after its 7501
 * query as a "no more replies" sentinel, so the 7501 answer must go first, and with several viewers
 * (or none) attached nobody else can answer either in time. The output goes to viewers unchanged.
 */
export class OscScanner {
  private carry = '';

  feed(chunk: string): ScanEvent[] {
    const text = this.carry + chunk;
    this.carry = '';
    const out: ScanEvent[] = [];
    NEXT.lastIndex = 0;
    for (;;) {
      const m = NEXT.exec(text);
      if (!m) {
        // Keep a tail that could be the start of an introducer or query split across chunks.
        const tail = text.lastIndexOf('\x1b');
        if (tail >= 0 && tail >= text.length - OSC_START.length) {
          const t = text.slice(tail);
          if (OSC_START.startsWith(t) || '\x1b[0c'.startsWith(t)) this.carry = t;
        }
        break;
      }
      if (m[0] !== OSC_START) { out.push({ type: 'da1' }); continue; }
      const body = m.index + OSC_START.length;
      const bel = text.indexOf('\x07', body), st = text.indexOf('\x1b\\', body);
      const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
      if (end < 0) {
        // Unterminated: wait for the rest, unless it is already longer than a sequence may be.
        if (text.length - m.index < MAX_SEQUENCE) this.carry = text.slice(m.index);
        break;
      }
      const payload = text.slice(body, end);
      if (isProbe(payload)) out.push({ type: 'probe' });
      else { const report = parseReport(payload); if (report) out.push({ type: 'report', report }); }
      NEXT.lastIndex = end + (end === bel ? 1 : 2);
    }
    return out;
  }
}
