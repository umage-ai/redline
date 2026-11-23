// A recorded review session: what the page sends, what lands in `.redline/sessions/<id>/`, and the
// `session.md` an agent reads: the transcript lined up with what the reviewer pointed at, when.

import type { Target } from '../../src/shared/types.ts';
import { clip } from '../../src/shared/text.ts';
import type { Segment } from './transcribe.ts';

/** Something the reviewer did, `t` ms into the recording (pauses left out). */
export type SessionEvent =
  | { kind: 'point'; t: number; target?: Target; whole?: boolean; url: string; shot?: string }
  | { kind: 'shot'; t: number; url: string; shot?: string }
  | { kind: 'draw'; t: number; url: string; shot?: string; target?: Target }
  | { kind: 'click'; t: number; url: string; target?: Target }
  | { kind: 'nav'; t: number; url: string; title?: string }
  | { kind: 'pause'; t: number }
  | { kind: 'resume'; t: number }
  | { kind: 'note'; t: number; text: string };

export type TranscriptStatus = 'queued' | 'transcribing' | 'done' | 'failed' | 'none';

/** session.json: everything about one session. */
export interface SessionData {
  id: string;
  page: string;
  url: string;
  title?: string;
  app?: string;
  /** ISO time the recording started. */
  started: string;
  /** Seconds of recording. */
  duration: number;
  audio?: string;
  events: SessionEvent[];
  viewport?: [number, number, number];
  transcript: { status: TranscriptStatus; engine?: string; error?: string; text?: string; segments?: Segment[]; ms?: number };
  /** The pointer note in the page's notes. */
  note?: string;
}

/** `m:ss`, or `h:mm:ss`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const p = (n: number) => String(n).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}` : `${Math.floor(s / 60)}:${p(s % 60)}`;
}

/** One line about an element, like a note heading: `button` “Save” · [data-testid="save"] · src/Form.tsx:42 · <Form>. */
export function describeTarget(t?: Target, whole?: boolean): string {
  if (whole || !t) return 'the whole page';
  const parts = [`\`${t.tag ?? 'element'}\`` + (t.text ? ` “${clip(t.text, 50)}”` : t.name ? ` “${clip(t.name, 50)}”` : '')];
  if (t.testid) parts.push(`[data-testid="${t.testid}"]`);
  else if (t.id) parts.push(`#${t.id}`);
  if (t.cms?.property) parts.push(`CMS ${[t.cms.type, t.cms.content].filter(Boolean).join(' ') || 'content'} › ${t.cms.property}`);
  if (t.source) parts.push(t.source.file + (t.source.line ? `:${t.source.line}` : ''));
  if (t.components?.length) parts.push(`<${t.components[0]}>`);
  return parts.join(' · ');
}

const path = (u: string) => { try { const x = new URL(u); return x.pathname + x.search + x.hash; } catch { return u; } };

function eventLine(e: SessionEvent): string {
  switch (e.kind) {
    case 'point': return `👉 **Pointed at** ${describeTarget(e.target, e.whole)}` + (e.target?.selector ? ` — \`${e.target.selector}\`` : '');
    case 'shot': return `📸 **Screenshot** of ${path(e.url)}`;
    case 'draw': return `✏️ **Drew on the page**` + (e.target ? ` over ${describeTarget(e.target)}` : '');
    case 'click': return `🖱 Clicked ${describeTarget(e.target)} (browsing)`;
    case 'nav': return `🧭 **Went to** ${path(e.url)}` + (e.title ? ` (“${clip(e.title, 60)}”)` : '');
    case 'pause': return '⏸ Paused the recording';
    case 'resume': return '▶ Resumed';
    case 'note': return `📝 Typed: ${e.text}`;
  }
}

type Item = { at: number; order: number } & ({ speech: string } | { event: SessionEvent });

/**
 * The timeline: speech and events merged by time. Consecutive segments join into one quote until an
 * event comes between them; each event shows with its screenshot. Without timed segments the
 * transcript comes first and the events follow with their times.
 */
export function timeline(events: SessionEvent[], transcript: { text?: string; segments?: Segment[] }): string {
  const segs = transcript.segments?.filter(s => s.text.trim()) ?? [];
  const items: Item[] = [];
  let order = 0;
  if (segs.length) for (const s of segs) items.push({ at: s.start, order: order++, speech: s.text.trim() });
  for (const e of events) items.push({ at: e.t / 1000, order: order++, event: e });
  items.sort((a, b) => a.at - b.at || a.order - b.order);

  let md = '';
  if (!segs.length && transcript.text?.trim()) md += `> ${transcript.text.trim()}\n\n_The transcript has no timings, so it is shown whole; the actions follow with their times._\n\n`;
  let quote: { at: number; text: string[] } | null = null;
  const flush = () => { if (quote) md += `**${clock(quote.at)}** “${quote.text.join(' ')}”\n\n`; quote = null; };
  for (const it of items) {
    if ('speech' in it) { if (quote) quote.text.push(it.speech); else quote = { at: it.at, text: [it.speech] }; continue; }
    flush();
    const e = it.event;
    md += `**${clock(it.at)}** ${eventLine(e)}\n`;
    if ('shot' in e && e.shot) md += `\n![${e.kind} at ${clock(it.at)}](${e.shot})\n`;
    md += '\n';
  }
  flush();
  return md;
}

const PREAMBLE = `<!--
  A review session recorded with Redline's session recorder (@umage.ai/redline-voice), for a coding
  agent. The reviewer talked while pointing at elements, drawing and taking screenshots; the
  timeline below lines up what they said with what they did, by time on the recording (m:ss).
  Read it as one set of instructions: "this" and "here" mean the element pointed at nearest in time.
  Each pointer names the element like a note: tag, text, test id, source file:line, component,
  and its CSS selector. Screenshots mark the element in red. Raw data: session.json (full targets,
  xpath, viewport). When done, tick the session's note in .redline/pages/ ("### [x]") with a
  one-line "> " reply, as for any note.
-->`;

/** `YYYY-MM-DD HH:MM` in the dev server's time zone, like note times and the folder name. */
const localTime = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(+d)) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

export function sessionMarkdown(s: SessionData): string {
  const points = s.events.filter(e => e.kind === 'point').length;
  const shots = s.events.filter(e => 'shot' in e && e.shot).length;
  const t = s.transcript;
  const status = t.status === 'done' ? `transcribed${t.engine ? ` by ${t.engine}` : ''}`
    : t.status === 'failed' ? `transcription failed: ${t.error ?? 'unknown error'}`
    : t.status === 'none' ? 'no transcript (no speech engine); listen to the recording'
    : `transcript ${t.status}… (wait for it before acting)`;
  let md = `# Review session — ${s.app ? s.app + ' · ' : ''}${s.page}\n\n${PREAMBLE}\n\n`;
  md += `- Page: ${s.url}${s.title ? ` (“${clip(s.title, 80)}”)` : ''}\n`;
  md += `- Recorded: ${localTime(s.started)}, ${clock(s.duration)} long, ${points} pointer${points === 1 ? '' : 's'}, ${shots} screenshot${shots === 1 ? '' : 's'}\n`;
  if (s.viewport) md += `- Viewport: ${s.viewport[0]}×${s.viewport[1]} @${s.viewport[2]}x\n`;
  md += `- Transcript: ${status}\n`;
  if (s.audio) md += `- Recording: [${s.audio}](${s.audio})\n`;
  md += `\n## Timeline\n\n`;
  md += timeline(s.events, t.status === 'done' ? t : { text: t.text, segments: t.segments });
  return md.replace(/\n+$/, '\n');
}

/** A folder name: `2026-11-23-1042-checkout`, unique among `taken`. */
export function sessionId(started: Date, page: string, taken: (id: string) => boolean): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const slug = page.replace(/^\/+|\/+$/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'home';
  const base = `${started.getFullYear()}-${p(started.getMonth() + 1)}-${p(started.getDate())}-${p(started.getHours())}${p(started.getMinutes())}-${slug}`;
  let id = base;
  for (let i = 2; taken(id); i++) id = `${base}-${i}`;
  return id;
}
