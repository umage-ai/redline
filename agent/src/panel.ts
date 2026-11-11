// The agent panel's overlay extension (D53, D62), served at /__redline/agent/panel.js when the dev
// server has the `agent` option. Every agent action lives in one place, the agent toolbar
// (`rl.addToolbar`), opened by the Agent button (A) or its own shortcut (alt+shift+a) from anywhere.
// Left to right: "← Agent" (drawn by the core from the toolbar's `title`), the state ("Claude Code ·
// Working…" and the CLI's message), a tab per session (named by its notes; × ends it), **Apply N
// notes** (long-press, right-click or Alt+↓ switches the CLI) with ⋯ for the project's other prompts,
// >_ for the CLI window (xterm.js in an iframe, see terminal.ts; End session sits in its header) and ⚙
// for the viewer's settings (CLI, model, effort, sessions), then the core's ✕. A card attached to the
// toolbar shows what the CLI asks, or the menu or settings opened. The notes panel only shows: a status
// line that opens the toolbar, and a "sent"/"done by" tag on the notes a prompt handed over. The live
// indicator (`rl.setStatus`) comes from the program's OSC 7501 status (or ACP). Built on the public
// extension API, so a product can write its own panel the same way.

import type { Note } from '../../src/shared/types.ts';
import type { RedlineApi, RedlineStatus, RedlineWindow } from '../../src/shared/extension.ts';
import { API_BASE } from '../../src/shared/types.ts';
import type { PromptView, Span } from './screen.ts';
import { pickCli, pickFor, recallCli, recallSettings, rememberCli, rememberSettings, type Cli, type PerCli } from './settings.ts';

export { pickCli };
export type { Cli };

const BASE = `${API_BASE}/agent`;

type State = 'idle' | 'working' | 'done' | 'blocked' | 'error';
interface Info {
  running: boolean;
  command: string;
  exitCode?: number | null;
  status: { state: State; kind?: string; progress?: number; msg?: string; title?: string; source: '7501' | 'activity' | 'acp' | 'none' };
  sent?: string[];
  /** The menu on the agent's screen (a permission prompt, stepped questions), read off it by the server. */
  prompt?: PromptView;
}
export interface Session extends Info {
  id: string; label: string; app?: string;
  /** The CLI it runs, an id in `Setup.clis` (D59). */
  cli?: string;
  /** Its tab's name (the first note's text, or the prompt's label) and the prompt that started it (D62). */
  title?: string; task?: string;
  model?: string; effort?: string;
}
/** All of the project's sessions: one that keeps its context ('shared'), or one per prompt ('fresh'). */
interface Group { mode: 'shared' | 'fresh'; max: number; sessions: Session[] }
interface Command { label: string; prompt: string; title?: string }
interface Setup extends Group {
  command: string; token: string; commands: Command[]; approve: boolean; hotkey: string | false; key?: string | false; clis?: Cli[]; cli?: string;
  /** The project's settings (D62): what Reset goes back to. */
  defaults?: { sessions?: 'shared' | 'fresh'; model?: string; effort?: string };
}

const RANK: Record<State, number> = { blocked: 4, working: 3, error: 2, done: 1, idle: 0 };
/** The session the indicator shows: the one that most needs you (asking, then working, failed, done). */
export function overall(sessions: Session[]): Session | undefined {
  let best: Session | undefined, rank = -1;
  for (const s of sessions) {
    if (!s.running && s.status.state !== 'done' && s.status.state !== 'error') continue;
    const r = RANK[s.status.state] ?? 0;
    if (r >= rank) { best = s; rank = r; }   // ties: the newest
  }
  return best;
}

const GREY = '#a3a3ad', OFF = '#5c5c66';
const ESC = '\x1b', LEFT = '\x1b[D', RIGHT = '\x1b[C';
const DEFAULT_LABEL = 'Apply notes';
const HOLD_MS = 500;

/**
 * The indicator for a status, the same on the open toolbar (its outline) and the closed launcher (a
 * ring): a light sweeping round it while working, a glow while it waits for you, steady when done or
 * failed; nothing while it rests. Hover (the toolbar, the Agent button) says what it is doing.
 */
export function indicatorFor(info: Info): Omit<RedlineStatus, 'onClick'> | null {
  const s = info.status;
  if (!info.running && s.state !== 'done' && s.state !== 'error') return null;
  const tip = (what: string) => `${info.command}: ${what}${s.progress !== undefined && s.state === 'working' ? ` ${s.progress}%` : ''}${s.msg ? ` · ${s.msg}` : ''}`;
  const on = { toolbar: 'outline', launcher: 'ring' } as const;
  switch (s.state) {
    case 'working': return { ...on, color: '#4f8cff', spin: true, title: tip(s.source === 'activity' ? 'busy' : 'working') };
    case 'blocked': return s.kind === 'permission'
      ? { ...on, color: '#ff9f0a', pulse: true, title: tip('waiting for your approval') }
      : { ...on, color: '#ffd60a', pulse: true, title: tip('waiting for your answer') };
    case 'done': return { ...on, color: '#3ecf8e', title: tip('done') };
    case 'error': return { ...on, color: '#ff453a', title: tip('failed') };
    default: return { color: GREY, toolbar: false, launcher: false, title: tip('ready') };
  }
}

/** The agent toolbar's state: a short word for the state, and the program's message. */
export function stateLabel(info: Info): { label: string; msg?: string; color: string } {
  const s = info.status;
  const msg = s.msg || undefined;
  if (!info.running && s.state !== 'done' && s.state !== 'error') {
    return { label: info.exitCode === undefined ? 'Not started' : `Stopped${info.exitCode ? ` (exit ${info.exitCode})` : ''}`, color: OFF };
  }
  const color = indicatorFor(info)?.color ?? GREY;
  switch (s.state) {
    case 'working': return { label: s.progress !== undefined ? `Working ${s.progress}%` : 'Working…', msg, color };
    case 'blocked': return { label: s.kind === 'permission' ? 'Needs your approval' : 'Needs your answer', msg, color };
    case 'done': return { label: 'Done', msg, color };
    case 'error': return { label: 'Failed', msg, color };
    default: return { label: 'Ready', msg, color };
  }
}

/** A prompt template with {page}, {url} and {ids} (the notes it hands over: by default the open notes on the page) filled in. */
export function fill(prompt: string, rl: Pick<RedlineApi, 'page' | 'notes'>, list = openIds(rl)): string {
  const ids = list.join(', ');
  return prompt.replace(/\{(page|url|ids)\}/g, (_, k: string) => k === 'page' ? rl.page() : k === 'url' ? location.href : ids || 'none');
}
const openIds = (rl: Pick<RedlineApi, 'notes'>) => rl.notes('page').filter(n => !n.done).map(n => n.id);
/**
 * The open notes on the page no running session has yet: what a prompt hands over, in both modes, so
 * two sessions never work on one note and the count doesn't change with Fresh. Stopping a session frees its notes.
 */
export function freeIds(rl: Pick<RedlineApi, 'notes'>, sessions: Pick<Session, 'running' | 'sent'>[]): string[] {
  const taken = new Set(sessions.filter(s => s.running).flatMap(s => s.sent ?? []));
  return openIds(rl).filter(id => !taken.has(id));
}
const usesIds = (c: Command) => c.prompt.includes('{ids}');

/** A note in a few words: its text (a text change: the new text), on one line. */
export const noteText = (n: Pick<Note, 'body' | 'type'> & { to?: string }) => ((n.body ?? '').trim() || (n.type === 'text' ? n.to ?? '' : '') || n.type).replace(/\s+/g, ' ').trim();
/** Cut to `max` characters with an ellipsis. */
export const shorten = (s: string, max = 18) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > max ? t.slice(0, max - 1).trimEnd() + '…' : t; };
/** A session's tab name (D62): its first note's text, shortened, "+1" for each more; no notes: the prompt's label. */
export function tabTitle(notes: (Pick<Note, 'body' | 'type'> & { to?: string })[], label = ''): string {
  if (!notes.length) return label;
  return shorten(noteText(notes[0])) + (notes.length > 1 ? ` +${notes.length - 1}` : '');
}

/** A CLI's initials for its tab when several CLIs are in use: "Claude Code" CC, "OpenCode" OC, "codex" C. */
export function initials(name: string): string {
  const caps = name.match(/\p{Lu}/gu) ?? [];
  if (caps.length) return caps.slice(0, 2).join('');
  return name.split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
}

/** Where a tab sorts (D62): busy, asking or done-unseen first, then resting (seen), then ended. */
export function tabRank(s: Pick<Session, 'running' | 'status'>): number {
  if (!s.running) return 2;
  return s.status.state === 'idle' ? 1 : 0;
}
/**
 * The sessions with a tab on the toolbar, in toolbar order; the rest sit behind "+N" (the session list).
 * Always the one on screen and any that asks; then the newest busy or unseen, the newest resting, the
 * newest ended, up to `max`. Shown: busy first, ended last (faded), in session order within.
 */
export function visibleTabs(sessions: Pick<Session, 'id' | 'running' | 'status'>[], selected: string, max = 3): { shown: string[]; hidden: string[] } {
  const keep = new Set(sessions.filter(s => s.id === selected || (s.running && s.status.state === 'blocked')).map(s => s.id));
  const newest = [...sessions].reverse();
  for (const r of [0, 1, 2]) for (const s of newest) if (keep.size < max && tabRank(s) === r) keep.add(s.id);
  const order = (list: typeof sessions) => list.map((s, i) => ({ s, i })).sort((a, b) => tabRank(a.s) - tabRank(b.s) || a.i - b.i).map(x => x.s.id);
  return { shown: order(sessions.filter(s => keep.has(s.id))), hidden: order(sessions.filter(s => !keep.has(s.id))) };
}

/** What a note's tag says: handed to the agent and still open, or done since. */
export function noteTag(note: Pick<Note, 'id' | 'done'>, sent: ReadonlySet<string>): 'sent' | 'done' | null {
  return !sent.has(note.id) ? null : note.done ? 'done' : 'sent';
}

/**
 * A handed-over note's tag, from the newest session that has it: being worked on (a pulsing dot),
 * waiting for your answer, sent (the session rests or has ended), or done. `who` names the session.
 */
export function tagFor(note: Pick<Note, 'id' | 'done'>, sessions: Session[], who: (s: Session) => string): { cls: string; text: string } | null {
  const by = [...sessions].reverse().find(x => x.sent?.includes(note.id));
  if (!by) return null;
  if (note.done) return { cls: 'done', text: `✓ done by ${who(by)}` };
  const st = by.running ? by.status.state : 'stopped';
  if (st === 'working') return { cls: 'sent working', text: `${who(by)} is working on it` };
  if (st === 'blocked') return { cls: 'sent asking', text: `${who(by)} needs your answer` };
  return { cls: 'sent', text: `⤳ sent to ${who(by)}` };
}

// The icons: inline SVG in the core's style (24-unit grid, round strokes, currentColor).
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${d}</svg>`;
const ICONS = {
  term: svg('<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M7.5 9.5l3 2.5-3 2.5"/><path d="M12.5 15h4"/>'),
  gear: svg('<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>'),
  more: svg('<circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  x: svg('<path d="M7 7l10 10M17 7L7 17"/>'),
  down: svg('<path d="M7 10l5 5 5-5"/>'),
};
const icon = (k: keyof typeof ICONS) => { const s = document.createElement('span'); s.className = 'ag-ic'; s.innerHTML = ICONS[k]; return s; };

// The extension's own look, inside the overlay's shadow root (a <style> there applies to all of it).
// Colours come from the overlay's tokens (--bg, --fg, --ink…), so a host's theme carries over.
const STYLES = `
.ag-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.xbar[data-toolbar="agent"] button:focus-visible, .attach[data-toolbar="agent"] :is(button, input, select, label):focus-visible, .win-controls .ag-wend:focus-visible { outline: 2px solid var(--ink-2); outline-offset: 1px; }
.ag-ic { display: grid; place-items: center; width: 16px; height: 16px; flex: none; }
.ag-ic svg { width: 16px; height: 16px; display: block; }
.ag-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
/* the state: a fixed width, so the toolbar doesn't change size with every message (the full text is the hover) */
.ag-chip { display: flex; align-items: center; gap: 6px; padding: 0 8px; flex: none; width: 270px; box-sizing: border-box; color: var(--fg); white-space: nowrap; overflow: hidden; }
.ag-chip .ag-dot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 25%, transparent); }
.ag-chip .ag-who { flex: none; max-width: 120px; overflow: hidden; text-overflow: ellipsis; color: var(--fg-2); }
.ag-chip .ag-mid { flex: none; color: var(--fg-3); }
.ag-chip b { flex: none; font-weight: 650; }
.ag-chip .ag-msg { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
/* the primary action, filled; long-press (or right-click, Alt+↓) switches the agent */
.bar button.ag-primary { background: var(--ink); color: #fff; font-weight: 650; padding: 6px 12px; -webkit-touch-callout: none; -webkit-user-select: none; user-select: none; touch-action: manipulation; }
.bar button.ag-primary:hover { background: var(--ink-2); color: #fff; }
.bar button.ag-primary[aria-disabled="true"] { cursor: default; background: var(--bg-3); color: var(--fg-3); }
.bar button.ag-primary .count { background: rgba(255,255,255,.25); color: #fff; }
.bar button.ag-icon { padding: 6px 7px; }
.bar button.ag-icon[aria-pressed="true"], .bar button.ag-icon[aria-expanded="true"] { background: var(--bg-3); color: var(--fg); }
.bar button.ag-term.ask { color: var(--fg); box-shadow: inset 0 0 0 1px #ff9f0a; }
/* session tabs: named by their notes; the dot is the state; seen and ended ones fade */
.ag-tabs { display: flex; align-items: center; gap: 2px; }
.ag-tab { display: flex; align-items: center; border-radius: 8px; transition: opacity .15s; }
.ag-tab:hover { background: var(--bg-2); }
.ag-tab.cur { background: var(--bg-3); }
.bar .ag-tab button { padding: 5px 2px 5px 8px; gap: 6px; background: none; }
.bar .ag-tab button:hover { background: none; color: var(--fg); }
.bar .ag-tab.cur button { color: var(--fg); }
.ag-tab .ag-name { max-width: 140px; overflow: hidden; text-overflow: ellipsis; }
.ag-tab[data-state="done"] .ag-name { font-weight: 700; color: var(--fg); }
.ag-tab:is([data-state="idle"], [data-state="seen"], [data-state="stopped"]):not(.cur):not(:hover):not(:focus-within) { opacity: .55; }
.ag-ini { flex: none; font-size: 10px; font-weight: 700; line-height: 1; padding: 2px 4px; border-radius: 4px; background: var(--bg-2); color: var(--fg-2); }
.bar .ag-tab button.ag-x { padding: 5px 7px 5px 4px; color: var(--fg-2); }
.ag-x .ag-ic, .ag-x .ag-ic svg { width: 12px; height: 12px; }
.bar .ag-tab button.ag-x:hover, .ag-row .ag-x:hover { color: var(--fg); }
.ag-x.armed, .bar .ag-tab button.ag-x.armed { color: #fff; background: #ff2d55; border-radius: 6px; padding: 3px 7px; margin-right: 2px; font-size: 12px; font-weight: 650; }
.bar button.ag-more { padding: 0 8px; height: 28px; font-variant-numeric: tabular-nums; }
.bar button.ag-more.lit { color: var(--fg); box-shadow: inset 0 0 0 1px var(--c); }
.bar .ag-phone { display: none; }
.bar button.ag-switch { gap: 6px; max-width: 150px; }
.ag-switch .ag-name { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
@keyframes ag-beat { 50% { opacity: .45; transform: scale(.75); } }
:is(.ag-chip, .ag-tab, .ag-switch, .ag-row, .ag-line)[data-state="working"] .ag-dot { animation: ag-beat 1.2s ease-in-out infinite; }
/* the notes panel: a status line and tags */
.ag-line { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); color: var(--fg); text-align: left; cursor: pointer; }
.ag-line:hover { background: var(--bg-3); }
.ag-line span:not(.ag-dot) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-line kbd { flex: none; }
.ag-tag { display: inline-block; margin-top: 6px; padding: 1px 7px; border-radius: 9px; font-size: 11px; font-weight: 600; }
.ag-tag.sent { color: #8fb4ff; background: color-mix(in srgb, #4f8cff 18%, transparent); }
.ag-tag.done { color: #3ecf8e; background: color-mix(in srgb, #3ecf8e 16%, transparent); }
.ag-tag.working, .ag-tag.asking { cursor: pointer; }
.ag-tag.asking { color: #ffb340; background: color-mix(in srgb, #ff9f0a 18%, transparent); }
.ag-tag.working::before, .ag-tag.asking::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; animation: ag-beat 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ag-tag::before, .ag-dot { animation: none !important; } .ag-tab { transition: none; } }
/* the card: what the CLI asks */
.ag-card { display: grid; gap: 10px; font-size: 13px; }
.ag-card .ag-who { display: flex; align-items: center; gap: 7px; color: var(--fg-2); font-size: 12px; }
.ag-steps { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
.ag-steps button { padding: 3px 9px; border-radius: 99px; border: 1px solid var(--line); color: var(--fg-2); font-size: 12px; }
.ag-steps button.cur { color: var(--fg); border-color: var(--c); background: color-mix(in srgb, var(--c) 18%, transparent); }
.ag-steps button.done { color: #3ecf8e; }
.ag-steps .nav { border: 0; padding: 3px 6px; }
.ag-ctx { margin: 0; padding: 8px 10px; border-radius: 8px; background: #0b0b0e; font: 12px/1.45 ui-monospace, SFMono-Regular, "Cascadia Mono", Menlo, Consolas, monospace; color: #c7c7cf; white-space: pre; overflow: auto; max-height: 260px; }
.ag-q { font-weight: 650; font-size: 14px; line-height: 1.35; }
.ag-opts { display: grid; gap: 4px; }
.ag-opt { display: grid; grid-template-columns: 22px 1fr; gap: 2px 8px; align-items: baseline; text-align: left; padding: 7px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--bg-2); color: var(--fg); cursor: pointer; }
.ag-opt:hover:not(:disabled) { background: var(--bg-3); border-color: color-mix(in srgb, var(--c) 50%, var(--line)); }
.ag-opt.sel { border-color: color-mix(in srgb, var(--c) 70%, var(--line)); }
.ag-opt:disabled { opacity: .5; cursor: default; }
.ag-opt .n, .ag-input .n { font: 600 11px ui-monospace, Consolas, monospace; color: var(--fg-2); background: var(--bg-3); border-radius: 5px; text-align: center; padding: 1px 0; }
.ag-opt .d { grid-column: 2; color: var(--fg-2); font-size: 12px; line-height: 1.35; }
.ag-input { display: grid; grid-template-columns: 22px 1fr auto; gap: 8px; align-items: center; padding: 5px 6px 5px 10px; border-radius: 8px; border: 1px dashed var(--line); }
.ag-input input { min-width: 0; background: transparent; border: 0; outline: 0; color: var(--fg); font: inherit; padding: 4px 0; }
.ag-input button, .ag-foot button, .ag-set footer button { padding: 5px 10px; border-radius: 7px; background: var(--bg-3); color: var(--fg); }
.ag-input button:hover, .ag-foot button:hover, .ag-set footer button:hover { background: color-mix(in srgb, var(--fg) 12%, var(--bg-3)); }
.ag-ask { display: flex; gap: 8px; }
.ag-ask button { padding: 7px 14px; border-radius: 8px; background: var(--bg-3); color: var(--fg); font-weight: 600; }
.ag-ask button.ag-allow { background: #3ecf8e; color: #08130d; }
.ag-ask button.ag-allow:hover { background: #5fdca3; }
.ag-ask button.ag-deny:hover { background: color-mix(in srgb, #ff453a 25%, var(--bg-3)); }
.ag-foot { display: flex; align-items: center; gap: 8px; color: var(--fg-2); font-size: 11.5px; }
.ag-foot span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* menus and the session list */
.ag-list { display: grid; gap: 4px; font-size: 13px; min-width: min(360px, calc(100vw - 48px)); }
.ag-list h4, .ag-set h4 { margin: 0 0 4px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); }
.ag-mi { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); color: var(--fg); text-align: left; cursor: pointer; border: 1px solid transparent; }
.ag-mi:hover, .ag-mi:focus-visible { background: var(--bg-3); }
.ag-mi b { font-weight: 650; }
.ag-mi span { margin-left: auto; color: var(--fg-2); font-size: 12px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-mi[aria-checked]::before { content: ""; flex: none; width: 8px; height: 8px; border-radius: 50%; box-shadow: inset 0 0 0 1.5px var(--fg-2); }
.ag-mi[aria-checked="true"] { border-color: color-mix(in srgb, var(--ink) 55%, var(--line)); }
.ag-mi[aria-checked="true"]::before { background: var(--ink); box-shadow: none; }
.ag-mi[aria-disabled="true"] { opacity: .5; cursor: default; }
.ag-hint { color: var(--fg-3); font-size: 11.5px; padding: 2px 2px 0; }
.ag-row { display: flex; align-items: center; border-radius: 8px; background: var(--bg-2); border: 1px solid transparent; }
.ag-row:hover { background: var(--bg-3); }
.ag-row.cur { border-color: color-mix(in srgb, var(--c) 60%, var(--line)); }
.ag-row .ag-row-main { flex: 1; min-width: 0; display: grid; grid-template-columns: 8px auto auto 1fr; gap: 8px; align-items: center; padding: 8px 4px 8px 10px; color: var(--fg); text-align: left; cursor: pointer; }
.ag-row .l { font-variant-numeric: tabular-nums; color: var(--fg-2); }
.ag-row .m { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); }
.ag-row .ag-x { flex: none; display: flex; align-items: center; padding: 8px 10px; color: var(--fg-2); }
.ag-row:is([data-state="idle"], [data-state="seen"], [data-state="stopped"]) .ag-row-main { opacity: .7; }
/* settings (⚙) */
.ag-set { display: grid; gap: 14px; font-size: 13px; min-width: min(360px, calc(100vw - 48px)); }
.ag-set fieldset { border: 0; margin: 0; padding: 0; display: grid; gap: 4px; min-width: 0; }
.ag-set legend, .ag-set .ag-lbl { padding: 0; margin: 0 0 6px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); }
.ag-radio { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; background: var(--bg-2); color: var(--fg); cursor: pointer; border: 1px solid transparent; }
.ag-radio:hover { background: var(--bg-3); }
.ag-radio:has(input:checked) { border-color: color-mix(in srgb, var(--ink) 55%, var(--line)); }
.ag-radio input { accent-color: var(--ink); margin: 0; flex: none; }
.ag-radio span { min-width: 0; }
.ag-radio small { margin-left: auto; color: var(--fg-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-field { display: grid; gap: 0; }
.ag-field select { width: 100%; font: inherit; color: var(--fg); background: var(--bg-2); border: 1px solid var(--line); border-radius: 8px; padding: 7px 8px; }
.ag-field select:disabled { opacity: .6; }
.ag-set .ag-note { color: var(--fg-2); font-size: 12px; line-height: 1.4; }
.ag-set footer { display: flex; align-items: center; gap: 8px; color: var(--fg-2); font-size: 12px; border-top: 1px solid var(--line); padding-top: 10px; }
.ag-set footer span { flex: 1; }
/* the CLI window's header */
.win-controls button.ag-wend { color: #ff6b85; }
.win-controls button.ag-wend:hover { background: color-mix(in srgb, #ff2d55 20%, var(--bg-3)); color: #fff; }
.win-controls button.ag-wend.armed { background: #ff2d55; color: #fff; }
/* phones: what fits one row. The outline says the state; the session button (its dot the state) opens
   the list with every session and End; the prompts, >_ and ⚙ stay. */
@media (max-width: 560px) {
  .bar .ag-desk { display: none; }
  .bar .ag-phone { display: flex; }
  .bar button.ag-switch { padding: 6px 7px; max-width: 92px; }
  .bar button.ag-primary { padding: 6px 10px; }
  .bar button.ag-primary .ag-wide { display: none; }
  .bar button.ag-icon { padding: 6px; }
  .ag-row .ag-row-main { grid-template-columns: 8px auto auto 1fr; padding: 10px 4px 10px 8px; }
  .ag-radio { padding: 9px 10px; }
}`;
const style = () => Object.assign(document.createElement('style'), { textContent: STYLES });

/** Element properties (`onclick`, `title`, `disabled`…), plus `class`, `data-*` and plain attributes (`aria-*`, `role`). */
type Props = { class?: string; data?: Record<string, string>; attrs?: Record<string, string | false | undefined>; [prop: string]: unknown };
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...kids: (Node | string | null | false | undefined)[]): HTMLElementTagNameMap[K] {
  const { class: cls, data, attrs, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(data ?? {})) n.dataset[k] = v;
  for (const [k, v] of Object.entries(attrs ?? {})) if (v !== false && v !== undefined) n.setAttribute(k, v);
  n.append(...kids.filter((k): k is Node | string => !!k));
  return n;
}

/** Arrow keys, Home and End move focus through `items` (a menu or radio list with roving focus). */
function roving(box: HTMLElement, items: HTMLElement[]) {
  box.addEventListener('keydown', (e: KeyboardEvent) => {
    const at = items.indexOf(e.target as HTMLElement);
    if (at < 0) return;
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : null;
    if (to === null) return;
    e.preventDefault();
    items[(to + items.length) % items.length].focus();
  });
}

type View = 'list' | 'switch' | 'cmds' | 'settings' | null;

export default async function agentPanel(rl: RedlineApi) {
  if (!(rl.version >= 5) || typeof rl.addToolbar !== 'function') return;
  let setup: Setup;
  try {
    const r = await fetch(`${BASE}/info`);
    if (!r.ok) return;
    setup = await r.json();
  } catch { return; }
  let group: Group = setup;
  const name = () => setup.command;
  // The CLIs (D59) and the viewer's settings (D62): the CLI for the next prompt, a model and effort per CLI.
  const clis = () => setup.clis ?? [];
  const multi = () => clis().length > 1;
  const cliOf = (id?: string) => clis().find(c => c.id === id);
  let pick = pickCli(clis(), recallCli(), setup.cli);
  let per: PerCli = recallSettings();
  const picked = () => cliOf(pick);
  const pickName = () => picked()?.name ?? name();
  /** The CLI a session runs, by name ("Claude Code"). */
  const nameOf = (s: Pick<Session, 'cli'>) => cliOf(s.cli)?.name ?? clis()[0]?.name ?? name();
  const NONE = (): Session => ({ id: '', label: '', running: false, command: name(), cli: pick, status: { state: 'idle', source: 'none' }, sent: [] });
  // The session the toolbar, the card and the CLI window are on: picked by a tab, or the newest.
  let sel: string | null = null;
  const cur = (): Session => group.sessions.find(s => s.id === sel) ?? group.sessions[group.sessions.length - 1] ?? NONE();
  const several = () => group.sessions.length > 1;
  const fresh = () => group.mode === 'fresh';
  /** "Claude Code", or "Claude Code #2" when there are several sessions. */
  const who = (s: Session) => several() && s.label ? `${nameOf(s)} ${s.label}` : nameOf(s);
  const tabName = (s: Session) => s.title || s.label;
  // Done and looked at (its tab picked while the toolbar is open): drawn as seen, faded, sorted right.
  const seenDone = new Set<string>();
  const doneKey = (x: Session) => `${x.id}:${x.status.msg ?? ''}`;
  const isSeen = (x: Session) => x.running && x.status.state === 'done' && seenDone.has(doneKey(x));
  const shownState = (x: Session) => !x.running ? 'stopped' : isSeen(x) ? 'seen' : x.status.state;
  const sent = () => new Set(group.sessions.flatMap(s => s.sent ?? []));
  const hotkeyText = () => setup.hotkey ? setup.hotkey.split('+').map(k => k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+') : '';
  const notesOf = (ids: string[]) => { const all = rl.notes('all'); return ids.map(id => all.find(n => n.id === id)).filter((n): n is Note => !!n); };

  const post = async (p: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': setup.token }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
    return r.json();
  };
  /** A call for the selected session. */
  const here = (p: string, body: Record<string, unknown> = {}) => post(p, { ...body, ...(cur().id ? { id: cur().id } : {}) });
  const fail = (e: unknown) => rl.toast(`Agent: ${(e as Error).message}`, true);
  /** The notes a prompt hands over: the open ones on the page no running session has (both modes). */
  const handed = () => freeIds(rl, group.sessions);
  /**
   * A prompt: starts the CLI when needed (the server holds the prompt until it is ready); the CLI window
   * stays closed. A new session runs the viewer's CLI, model and effort, and is named by its notes.
   */
  const run = async (c: Command) => {
    const notes = usesIds(c) ? handed() : [];
    if (fresh()) rl.toast(`Starting a new ${pickName()} session…`);
    else if (!cur().running || (multi() && cur().cli !== pick)) rl.toast(`Starting ${pickName()}…`);
    try {
      const r = await post('/send', {
        text: fill(c.prompt, rl, notes), notes, title: tabTitle(notesOf(notes), c.label), task: c.label,
        ...(!fresh() && cur().id ? { id: cur().id } : {}), ...(multi() ? { cli: pick } : {}), ...pickFor(picked(), per),
      });
      if (r?.id) { sel = r.id; sync(); }
    } catch (e) { fail(e); }
  };
  const answer = (choice: 'allow' | 'deny') => void here('/answer', { choice }).catch(fail);
  // A choice on its way: the card's buttons wait for the next screen.
  let choosing = false;
  const choose = async (index: number, text?: string) => {
    choosing = true; toolbar?.render();
    try { await here('/choose', text === undefined ? { index } : { index, text }); }
    catch (e) { fail(e); }
    finally { setTimeout(() => { choosing = false; toolbar?.render(); }, 400); }
  };
  const key = (data: string) => void here('/input', { data }).catch(fail);
  let wasAsking = new Set<string>();
  let lastCur = { id: '', asking: false };
  let typing = false;   // a typed answer in the card's field: no switching sessions under it

  // The attached card's views besides a question: the session list (+N, or the phone's session
  // button), the CLI switch (long-press on Apply), the other prompts (⋯) and the settings (⚙).
  let view: View = null;
  // Focus survives the re-renders (every status change redraws the toolbar): the focused element's
  // data-k is noted before a render and focused again after it; an action can name where focus goes next.
  let wantFocus: string | null = null;
  let lastBox: HTMLElement | null = null, lastCard: HTMLElement | null = null;
  const rootOf = () => lastBox?.getRootNode() as ShadowRoot | Document | undefined;
  const noteFocus = () => {
    const a = rootOf()?.activeElement as HTMLElement | null | undefined;
    if (wantFocus || !a || !(lastBox?.contains(a) || lastCard?.contains(a))) return;
    wantFocus = a.closest<HTMLElement>('[data-k]')?.dataset.k ?? null;
  };
  const restoreFocus = () => {
    const k = wantFocus, root = rootOf();
    wantFocus = null;
    if (!k || !root || !('querySelector' in root)) return;
    const t = root.querySelector<HTMLElement>(`[data-k="${CSS.escape(k)}"]`);
    if (t && root.activeElement !== t) t.focus();
  };
  /** Opens a view (a second press closes it); `focus` is where the keyboard goes in it. */
  const openView = (v: View, focus: string | null = null) => {
    view = view === v ? null : v;
    wantFocus = view ? focus : wantFocus;
    toolbar?.render();
  };
  const OPENER: Record<Exclude<View, null>, string> = { list: 'more', switch: 'primary', cmds: 'more-cmds', settings: 'gear' };
  const closeView = () => {
    if (!view) return false;
    const back = view === 'list' && matchMedia('(max-width: 560px)').matches ? 'sw' : OPENER[view];
    view = null; wantFocus = back;
    toolbar?.render();
    return true;
  };

  // Ending a session is one action: stop the CLI and close its tab. One working or asking asks first
  // ("End?"), a second press within 2.5 s ends it.
  let arming: string | null = null, armTimer = 0;
  const busy = (x: Session) => x.running && (x.status.state === 'working' || x.status.state === 'blocked');
  const rerender = () => { toolbar?.render(); renderWinControls(); };
  const end = (x: Session) => {
    if (busy(x) && arming !== x.id) {
      arming = x.id; clearTimeout(armTimer);
      armTimer = window.setTimeout(() => { arming = null; rerender(); }, 2500);
      rerender();
      return;
    }
    arming = null; clearTimeout(armTimer);
    void post('/end', { id: x.id }).catch(fail);
  };
  const endTitle = (x: Session) => arming === x.id ? `Press again to end ${who(x)}` : x.running ? `End ${who(x)}: stop the CLI and close the session${busy(x) ? ' (asks first)' : ''}` : `Close ${who(x)} (ended)`;
  /** The × on a tab or a list row: ends that session (or closes an ended one). */
  const endX = (x: Session, k: string) => el('button', {
    class: 'ag-x' + (arming === x.id ? ' armed' : ''), title: endTitle(x), data: { end: x.id, k },
    attrs: { 'aria-label': arming === x.id ? `Press again to end ${tabName(x)}` : `End ${tabName(x)}` },
    onclick: (e: Event) => { e.stopPropagation(); end(x); },
  }, arming === x.id ? 'End?' : icon('x'));

  let frame: HTMLIFrameElement | null = null;
  const toFrame = (msg: unknown) => frame?.contentWindow?.postMessage(msg, location.origin);
  const frameSrc = () => `${BASE}/terminal${cur().id ? `?id=${encodeURIComponent(cur().id)}` : ''}`;
  // Set below; a window or toolbar left open before a reload shows (and renders) while it is added.
  let win: RedlineWindow | null = null;
  let winControls: HTMLElement | null = null;
  let toolbar: ReturnType<RedlineApi['addToolbar']> | null = null;
  // The notes panel's status line and tags, kept to update in place (below).
  let line: HTMLElement | null = null;
  const tags = new Map<string, { el: HTMLElement; note: Note }>();
  // A screen reader hears the state change (kept across renders: a new live region each time says nothing).
  const live = el('span', { class: 'ag-sr', attrs: { role: 'status' } });

  const addAgentButton = (state?: string) => rl.addButton({
    id: 'agent', label: 'Agent', key: setup.key === false ? undefined : setup.key || 'a',
    title: state ?? `${pickName()}: agent toolbar${setup.hotkey ? ` · ${hotkeyText()} from anywhere` : ''}`,
    onClick: () => toolbar?.show(), active: () => !!toolbar?.isOpen(),
  });
  addAgentButton();

  /** A tab's hover text: its number, CLI and state, the prompt, its notes, model and effort, the last message. */
  const tabTip = (x: Session) => {
    const xl = stateLabel(x), notes = notesOf(x.sent ?? []);
    return [
      `${x.label} · ${nameOf(x)} · ${xl.label}`,
      x.task && `Prompt: ${x.task}`,
      notes.length ? `Notes: ${notes.slice(0, 3).map(n => shorten(noteText(n), 40)).join('; ')}${notes.length > 3 ? ` (+${notes.length - 3})` : ''}` : x.sent?.length ? `Notes: ${x.sent.length}` : '',
      [x.model && `Model: ${x.model}`, x.effort && `Effort: ${x.effort}`].filter(Boolean).join(' · '),
      xl.msg && `Last: ${xl.msg}`,
      x.status.state === 'blocked' && x.running ? 'Click to answer' : '',
    ].filter(Boolean).join('\n');
  };

  // Long-press on Apply (D62): held 500 ms, the CLI switch opens and the click that follows is dropped.
  let holdTimer = 0, held = false;
  const startHold = (e: PointerEvent) => {
    if (!multi() || e.button !== 0) return;
    held = false; clearTimeout(holdTimer);
    const x0 = e.clientX, y0 = e.clientY;
    const moved = (m: PointerEvent) => { if (Math.hypot(m.clientX - x0, m.clientY - y0) > 10) clearTimeout(holdTimer); };
    // Let go: the click that follows a hold (if any) is dropped, then clicks count again.
    const up = () => {
      clearTimeout(holdTimer);
      for (const t of ['pointerup', 'pointercancel'] as const) window.removeEventListener(t, up, true);
      window.removeEventListener('pointermove', moved, true);
      if (held) setTimeout(() => { held = false; }, 50);
    };
    holdTimer = window.setTimeout(() => { held = true; view = null; openView('switch', `cli:${pick}`); }, HOLD_MS);
    // On window, capturing: the shield stops these at window (D14), after its own listener there.
    for (const t of ['pointerup', 'pointercancel'] as const) window.addEventListener(t, up, true);
    window.addEventListener('pointermove', moved, true);
  };

  /** The primary prompt button: "Apply 2 notes" (filled); with several CLIs, hold it to switch the agent. */
  function primaryButton(c: Command, blocked: boolean) {
    const n = usesIds(c) ? handed().length : -1;
    const taken = n >= 0 ? openIds(rl).length - n : 0;   // open notes a running session already has
    // "Apply 2 notes" ("Apply 2" on a phone, where every pixel of the row counts).
    const label = c.label === DEFAULT_LABEL && n >= 0 ? el('span', {}, n ? `Apply ${n}` : 'Apply', el('span', { class: 'ag-wide' }, n === 1 ? ' note' : ' notes')) : c.label;
    const off = n === 0 || (blocked && !fresh());
    const switchHint = 'Hold, right-click or Alt+↓ to switch the agent';
    const b = el('button', {
      class: 'ag-primary', data: { k: 'primary', cmd: c.label, ...(n >= 0 ? { count: String(n) } : {}) },
      title: [c.title ?? c.prompt, `with ${pickName()}`, fresh() && 'in a new session', taken && `${taken} note${taken === 1 ? ' is' : 's are'} already with a session`, n === 0 && 'no open notes on this page', multi() && switchHint].filter(Boolean).join(' · '),
      attrs: { 'aria-disabled': off ? 'true' : undefined, 'aria-keyshortcuts': multi() ? 'Alt+ArrowDown Shift+F10' : undefined, 'aria-description': multi() ? `Runs ${pickName()}. ${switchHint}.` : undefined },
      onclick: () => { if (held) { held = false; return; } if (!off) void run(c); },
    }, label, n >= 0 && c.label !== DEFAULT_LABEL ? el('span', { class: 'count' }, String(n)) : null);
    b.addEventListener('pointerdown', startHold);
    b.addEventListener('contextmenu', (e: Event) => { if (!multi()) return; e.preventDefault(); if (view !== 'switch') openView('switch', `cli:${pick}`); });
    b.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!multi() || !((e.altKey && e.key === 'ArrowDown') || (e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return;
      e.preventDefault();
      if (view !== 'switch') openView('switch', `cli:${pick}`);
    });
    return b;
  }

  function renderToolbar(box: HTMLElement) {
    noteFocus();
    lastBox = box;
    const info = cur(), st = stateLabel(info), s = info.status;
    const blocked = info.running && s.state === 'blocked';
    const asked = blocked && (!!info.prompt?.options.length || (s.kind === 'permission' && setup.approve));   // the card shows it
    const btn = (label: string | Node, title: string, onclick: () => void, cls = '', k = '', attrs: Record<string, string | undefined> = {}) =>
      el('button', { class: cls, title, onclick, data: k ? { k } : {}, attrs }, label);
    const sep = (cls = '') => el('div', { class: `sep ${cls}` });
    if (info.running && s.state === 'done') seenDone.add(doneKey(info));   // on screen: seen
    const stateText = `${nameOf(info)} · ${st.label}`;
    if (live.textContent !== stateText) live.textContent = stateText;
    // The state: the CLI's name, the state, the CLI's own message (not while the card shows the question).
    const chip = el('div', { class: 'ag-chip ag-desk', title: `${who(info)}: ${st.label}${st.msg ? ` · ${st.msg}` : ''}`, data: { state: info.running ? s.state : 'stopped' } },
      el('span', { class: 'ag-dot' }), el('span', { class: 'ag-who' }, nameOf(info)), el('span', { class: 'ag-mid', attrs: { 'aria-hidden': 'true' } }, ' · '),
      el('b', {}, st.label), st.msg && !asked ? el('span', { class: 'ag-msg' }, st.msg) : null);
    chip.style.setProperty('--c', st.color);
    // A tab per session (named by its notes, its state as a dot, × ends it); the rest behind "+N".
    const vis = visibleTabs(group.sessions.map(x => isSeen(x) ? { ...x, status: { ...x.status, state: 'idle' as const } } : x), info.id);
    const hidden = group.sessions.filter(x => vis.hidden.includes(x.id));
    let more: HTMLElement | null = null;
    if (hidden.length) {
      const top = overall(hidden.filter(busy));
      more = btn(`+${hidden.length}`, `${hidden.length} more session${hidden.length === 1 ? '' : 's'}: show all`, () => openView('list', `row:${hidden[0].id}`), 'ag-more' + (top ? ' lit' : ''), 'more',
        { 'aria-haspopup': 'dialog', 'aria-expanded': String(view === 'list'), 'aria-label': `${hidden.length} more sessions` });
      if (top) more.style.setProperty('--c', stateLabel(top).color);
    }
    const mixed = new Set(group.sessions.map(x => x.cli)).size > 1;   // the CLI on a tab only when several are in use
    const tabs = group.sessions.length ? el('div', { class: 'ag-tabs ag-desk', attrs: { role: 'group', 'aria-label': 'Sessions' } }, ...vis.shown.map(id => group.sessions.find(x => x.id === id)!).map(x => {
      const xl = stateLabel(x), state = shownState(x);
      const main = el('button', {
        class: 'ag-tab-main', title: tabTip(x), data: { k: `tab:${x.id}` },
        attrs: { 'aria-current': x.id === info.id ? 'true' : undefined, 'aria-label': `${tabName(x)}, ${nameOf(x)}, ${xl.label}` },
        // Picked: its card (a question) or nothing; a menu or the settings close.
        onclick: () => { sel = x.id; view = null; sync(); },
      }, el('span', { class: 'ag-dot' }), mixed ? el('span', { class: 'ag-ini', attrs: { 'aria-hidden': 'true' } }, initials(nameOf(x))) : null, el('span', { class: 'ag-name' }, tabName(x)));
      const t = el('div', { class: 'ag-tab' + (x.id === info.id ? ' cur' : ''), data: { id: x.id, state } }, main, endX(x, `x:${x.id}`));
      t.style.setProperty('--c', xl.color);
      return t;
    }), more, sep()) : null;
    // Phones: one button for the session on screen; the list it opens has every session and End.
    const sw = btn(el('span', { class: 'ag-name' }, info.id ? tabName(info) : 'Sessions'), 'All sessions', () => openView('list', info.id ? `row:${info.id}` : 'list-done'), 'ag-switch ag-phone', 'sw',
      { 'aria-haspopup': 'dialog', 'aria-expanded': String(view === 'list'), 'aria-label': `Sessions: ${info.id ? `${tabName(info)}, ${st.label}` : 'none'}` });
    sw.prepend(el('span', { class: 'ag-dot' }));
    sw.append(icon('down'));
    sw.style.setProperty('--c', st.color);
    sw.dataset.state = info.running ? s.state : 'stopped';
    // The prompt: Apply (and ⋯ for the project's other prompts). Questions, Allow/Deny included, go in the card.
    const [first, ...rest] = setup.commands;
    const actions: HTMLElement[] = first ? [primaryButton(first, blocked)] : [];
    if (rest.length) {
      actions.push(btn(icon('more'), 'More prompts', () => openView('cmds', 'cmd:0'), 'ag-icon ag-cmds', 'more-cmds',
        { 'aria-label': 'More prompts', 'aria-haspopup': 'menu', 'aria-expanded': String(view === 'cmds') }));
    }
    // >_ the CLI window; ⚙ the settings.
    const open = !!win?.isOpen();
    const needsCli = blocked && !asked;   // only the CLI window can answer
    const term = btn(icon('term'), open ? 'Hide the CLI window (the session keeps running)' : needsCli ? `${who(info)} is asking: answer in the CLI window` : `Show ${who(info)}'s CLI window`,
      () => win?.toggle(), 'ag-icon ag-term' + (needsCli && !open ? ' ask' : ''), 'term', { 'aria-label': 'CLI window', 'aria-pressed': String(open) });
    term.dataset.cli = '';
    const firstSetting = multi() ? `set-cli:${pick}` : picked()?.models?.length || picked()?.pending ? 'set-model' : picked()?.efforts?.length ? 'set-effort' : `set-mode:${group.mode}`;
    const gear = btn(icon('gear'), 'Agent settings: CLI, model, effort, sessions', () => openView('settings', firstSetting), 'ag-icon ag-gear', 'gear',
      { 'aria-label': 'Agent settings', 'aria-haspopup': 'dialog', 'aria-expanded': String(view === 'settings') });
    box.replaceChildren(style(), live, chip, sep('ag-desk'), ...(tabs ? [tabs] : []), sw, ...actions, sep('ag-desk'), term, gear);
    queueMicrotask(restoreFocus);
  }

  /**
   * The attached card: a view the viewer opened (the CLI switch, prompts, settings, the session list),
   * else what the agent asks: the steps of a stepped question, the lines above the question (a diff
   * keeps its colours), the question, the options as buttons ("Type something" as a field), Cancel and CLI.
   */
  function renderCard(box: HTMLElement) {
    lastCard = box;
    if (view === 'settings') return void box.append(style(), renderSettings());
    if (view === 'switch' && multi()) return void box.append(style(), switchMenu());
    if (view === 'cmds') return void box.append(style(), cmdsMenu());
    if (view === 'list') return renderList(box);
    const info = cur();
    const pv = info.running ? info.prompt : undefined;
    const st = stateLabel(info);
    const card = el('div', { class: 'ag-card', data: { kind: info.status.kind ?? '', session: info.id }, attrs: { role: 'group', 'aria-label': `${who(info)} asks` } });
    card.style.setProperty('--c', st.color);
    card.append(el('div', { class: 'ag-who' }, el('span', { class: 'ag-dot' }), `${who(info)}${info.title ? ` · ${info.title}` : ''} · ${st.label}`));
    if (!pv?.options.length) {
      // A CLI whose menus aren't read waits for approval: its message, Allow and Deny (the `keys`), and its window.
      if (!(info.running && info.status.state === 'blocked' && info.status.kind === 'permission' && setup.approve)) return;
      if (st.msg) card.append(el('div', { class: 'ag-q' }, st.msg));
      card.append(el('div', { class: 'ag-ask' },
        el('button', { class: 'ag-allow', title: `Approve (${who(info)}'s prompt)`, data: { k: 'allow' }, onclick: () => answer('allow') }, 'Allow'),
        el('button', { class: 'ag-deny', title: 'Decline', data: { k: 'deny' }, onclick: () => answer('deny') }, 'Deny')),
      el('div', { class: 'ag-foot' }, el('span', {}, 'Its own prompt is in the CLI window'), el('button', { title: `Show ${who(info)}'s CLI window`, onclick: () => win?.show() }, 'Open CLI window')));
      box.append(style(), card);
      return;
    }
    if (pv.steps?.length) {
      const at = pv.steps.findIndex(x => x.current);
      const go = (to: number) => { if (at >= 0 && to !== at) key((to > at ? RIGHT : LEFT).repeat(Math.abs(to - at))); };
      card.append(el('div', { class: 'ag-steps' },
        el('button', { class: 'nav', title: 'Previous question', attrs: { 'aria-label': 'Previous question' }, onclick: () => key(LEFT) }, '←'),
        ...pv.steps.map((x, i) => el('button', { class: (x.current ? 'cur ' : '') + x.state, title: x.label, attrs: { 'aria-current': x.current ? 'step' : undefined }, onclick: () => go(i) }, (x.state === 'done' ? '☒ ' : x.state === 'submit' ? '✔ ' : '☐ ') + x.label)),
        el('button', { class: 'nav', title: 'Next question', attrs: { 'aria-label': 'Next question' }, onclick: () => key(RIGHT) }, '→')));
    }
    if (pv.lines.length) card.append(el('pre', { class: 'ag-ctx' }, ...pv.lines.flatMap((l, i) => [...(i ? ['\n'] : []), ...l.map(spanEl)])));
    if (pv.question) card.append(el('div', { class: 'ag-q' }, pv.question));
    const opts = el('div', { class: 'ag-opts' });
    pv.options.forEach((o, i) => {
      const num = el('span', { class: 'n', attrs: { 'aria-hidden': 'true' } }, String(o.n ?? i + 1));
      if (o.input) {
        const field = el('input', { placeholder: o.label.replace(/\.$/, '') + '…', disabled: choosing, data: { k: `opt:${i}` }, attrs: { 'aria-label': o.label.replace(/\.$/, '') } });
        // Sent: let go of the field, or the card (not redrawn while a field has focus) would keep this step.
        const send = () => { const v = field.value.trim(); if (v) { field.blur(); void choose(i, v); } };
        field.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
        field.addEventListener('focus', () => { typing = true; });
        field.addEventListener('blur', () => { typing = false; });
        opts.append(el('div', { class: 'ag-input' }, num, field, el('button', { onclick: send, disabled: choosing }, 'Send')));
        return;
      }
      opts.append(el('button', { class: 'ag-opt' + (o.selected ? ' sel' : ''), disabled: choosing, onclick: () => void choose(i), title: o.selected ? 'Selected in the CLI' : '', data: { k: `opt:${i}` } },
        num, el('span', {}, o.label), o.description ? el('span', { class: 'd' }, o.description) : null));
    });
    card.append(opts, el('div', { class: 'ag-foot' }, el('span', {}, pv.hint ?? ''),
      el('button', { title: 'Esc in the CLI', onclick: () => key(ESC) }, 'Cancel'),
      el('button', { title: `Show ${who(info)}'s CLI window`, onclick: () => win?.show() }, 'Open CLI window')));
    box.append(style(), card);
  }

  /** A menu in the card: one item per entry, arrows move (roving focus), Enter or a click picks. */
  function menu(label: string, items: { k: string; text: string; sub?: string; checked?: boolean; disabled?: boolean; title?: string; act(): void }[], hint?: string) {
    const m = el('div', { class: 'ag-list ag-menu', attrs: { role: 'menu', 'aria-label': label } }, el('h4', { attrs: { 'aria-hidden': 'true' } }, label));
    const radio = items.some(i => i.checked !== undefined);
    const focusK = items.find(i => i.checked)?.k ?? items[0]?.k;
    const btns = items.map(it => el('button', {
      class: 'ag-mi', title: it.title ?? '', data: { k: it.k }, tabIndex: it.k === focusK ? 0 : -1,
      attrs: { role: radio ? 'menuitemradio' : 'menuitem', 'aria-checked': radio ? String(!!it.checked) : undefined, 'aria-disabled': it.disabled ? 'true' : undefined },
      onclick: () => { if (!it.disabled) it.act(); },
    }, el('b', {}, it.text), it.sub ? el('span', {}, it.sub) : null));
    roving(m, btns);
    m.append(...btns);
    if (hint) m.append(el('div', { class: 'ag-hint' }, hint));
    return m;
  }
  /** The CLI switch (long-press on Apply, D62): the next prompt runs the CLI picked; nothing runs now. */
  function switchMenu() {
    return menu('Run the next prompt with', clis().map(c => ({
      k: `cli:${c.id}`, text: c.name, sub: c.name !== c.command ? c.command : undefined, checked: c.id === pick,
      title: `Run ${c.name} (${c.command}) for the next prompt${fresh() ? '' : ', in place of the shared session'}`,
      act: () => { setPick(c.id); view = null; wantFocus = 'primary'; rl.toast(`Next prompt: ${c.name}`); sync(); },
    })), 'Model and effort: ⚙');
  }
  /** The project's other prompts (⋯). */
  function cmdsMenu() {
    return menu('Prompts', setup.commands.slice(1).map((c, i) => {
      const n = usesIds(c) ? handed().length : -1;
      return { k: `cmd:${i}`, text: c.label, sub: n >= 0 ? `${n} note${n === 1 ? '' : 's'}` : undefined, disabled: n === 0, title: c.title ?? c.prompt, act: () => { view = null; wantFocus = 'more-cmds'; toolbar?.render(); void run(c); } };
    }), `with ${pickName()}${fresh() ? ', in a new session' : ''}`);
  }
  const setPick = (id: string) => { pick = id; rememberCli(id); };

  /**
   * The settings (⚙, D62): the CLI (several), its model and effort (those it offers), new session per
   * prompt or one kept going, and reset. Kept per viewer in this browser (model and effort per CLI);
   * the project's options are the defaults. They apply to new sessions.
   */
  let setEl: HTMLElement | null = null;
  function renderSettings(): HTMLElement {
    const c = picked(), d = setup.defaults ?? {}, mine = pickFor(c, per);
    const box = el('div', { class: 'ag-set', attrs: { role: 'dialog', 'aria-label': 'Agent settings' } }, el('h4', { attrs: { 'aria-hidden': 'true' } }, 'Agent settings'));
    const radios = (legend: string, nameAttr: string, items: { value: string; label: string; sub?: string; k: string }[], checked: string, on: (v: string) => void) => {
      const fs = el('fieldset', {}, el('legend', {}, legend));
      for (const it of items) {
        const input = el('input', { type: 'radio', name: nameAttr, value: it.value, checked: it.value === checked, data: { k: it.k } });
        input.addEventListener('change', () => { if (input.checked) on(it.value); });
        fs.append(el('label', { class: 'ag-radio' }, input, el('span', {}, it.label), it.sub ? el('small', {}, it.sub) : null));
      }
      return fs;
    };
    const select = (label: string, k: string, list: { value: string; name?: string }[], value: string | undefined, dflt: string | undefined, on: (v: string) => void) => {
      const id = `ag-${k}`;
      const sel = el('select', { id, data: { k } }, el('option', { value: '' }, `Default${dflt ? ` (${dflt})` : ''}`), ...list.map(m => el('option', { value: m.value, selected: m.value === value }, m.name ?? m.value)));
      sel.addEventListener('change', () => on(sel.value));
      return el('div', { class: 'ag-field' }, el('label', { class: 'ag-lbl', htmlFor: id }, label), sel);
    };
    const setFor = (field: 'model' | 'effort', v: string) => {
      if (!c) return;
      const next = { ...per[c.id], [field]: v || undefined };
      if (!next.model) delete next.model;
      if (!next.effort) delete next.effort;
      per = { ...per, [c.id]: next };
      if (!next.model && !next.effort) delete per[c.id];
      rememberSettings(per);
      refreshSettings();
    };
    if (multi()) box.append(radios('Agent', 'ag-set-cli', clis().map(x => ({ value: x.id, label: x.name, sub: x.name !== x.command ? x.command : undefined, k: `set-cli:${x.id}` })), pick, v => { setPick(v); refreshSettings(); sync(); }));
    if (c?.pending) {
      box.append(el('div', { class: 'ag-field' }, el('label', { class: 'ag-lbl', htmlFor: 'ag-set-model' }, 'Model'),
        el('select', { id: 'ag-set-model', disabled: true, data: { k: 'set-model' } }, el('option', {}, `Asking ${c.name} for its models…`))));
    } else if (c?.models?.length) box.append(select('Model', 'set-model', c.models, mine.model, d.model, v => setFor('model', v)));
    if (c?.efforts?.length) box.append(select('Effort', 'set-effort', c.efforts, mine.effort, d.effort, v => setFor('effort', v)));
    if (c && !c.pending && !c.models?.length && !c.efforts?.length) box.append(el('div', { class: 'ag-note' }, `${c.name} offers no model or effort choice here: it uses its own config.`));
    box.append(radios('Sessions', 'ag-set-mode', [
      { value: 'fresh', label: 'New session per prompt', sub: `up to ${group.max} at once`, k: 'set-mode:fresh' },
      { value: 'shared', label: 'Keep one session going', sub: 'keeps its context', k: 'set-mode:shared' },
    ], group.mode, v => void post('/mode', { mode: v }).then(g => { group = { ...group, ...g }; sync(); }).catch(fail)));
    box.append(el('footer', {}, el('span', {}, 'Applies to new sessions.'),
      el('button', { data: { k: 'set-reset' }, title: 'Forget this browser\'s choices: the project\'s CLI, model, effort and sessions', onclick: reset }, 'Reset to project defaults')));
    // Esc in a field (the core leaves keys in fields alone): close the settings, back on ⚙.
    box.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && /^(INPUT|SELECT)$/.test((e.target as HTMLElement).tagName)) { e.preventDefault(); closeView(); }
    });
    setEl = box;
    return box;
  }
  /** Redraws the settings in place (the core leaves the card alone while a field in it has focus), focus kept. */
  function refreshSettings() {
    if (!setEl?.isConnected) { toolbar?.render(); return; }
    const a = (rootOf()?.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-k]')?.dataset.k;
    const old = setEl, next = renderSettings();
    old.replaceWith(next);
    if (a) next.querySelector<HTMLElement>(`[data-k="${CSS.escape(a)}"]`)?.focus();
    toolbar?.render();
  }
  async function reset() {
    per = {}; rememberSettings(null);
    pick = pickCli(clis(), null, setup.cli); rememberCli(null);
    const mode = setup.defaults?.sessions ?? 'fresh';
    if (group.mode !== mode) { try { group = { ...group, ...(await post('/mode', { mode })) }; } catch (e) { fail(e); } }
    wantFocus = 'set-reset';
    rl.toast('Agent settings: back to the project\'s defaults');
    sync();
  }

  /** Every session (the "+N" list, the phone's session button), newest first: a click shows it, × ends it. */
  function renderList(box: HTMLElement) {
    const ended = group.sessions.filter(x => !x.running);
    const rows = [...group.sessions].reverse().map(x => {
      const xl = stateLabel(x), n = x.sent?.length ?? 0;
      const main = el('button', {
        class: 'ag-row-main', title: tabTip(x), data: { k: `row:${x.id}` }, attrs: { 'aria-current': x.id === cur().id ? 'true' : undefined },
        onclick: () => { sel = x.id; view = null; wantFocus = matchMedia('(max-width: 560px)').matches ? 'sw' : `tab:${x.id}`; sync(); },
      }, el('span', { class: 'ag-dot' }), el('span', { class: 'l' }, x.label), el('b', {}, xl.label),
      el('span', { class: 'm' }, [x.title, multi() ? nameOf(x) : '', n ? `${n} note${n === 1 ? '' : 's'}` : '', xl.msg ?? ''].filter(Boolean).join(' · ')));
      const r = el('div', { class: 'ag-row' + (x.id === cur().id ? ' cur' : ''), data: { id: x.id, state: shownState(x) } }, main, endX(x, `rowx:${x.id}`));
      r.style.setProperty('--c', xl.color);
      return r;
    });
    const closeEnded = async () => { for (const x of ended) await post('/end', { id: x.id }).catch(fail); };
    const running = group.sessions.filter(x => x.running).length;
    box.append(style(), el('div', { class: 'ag-list', attrs: { role: 'dialog', 'aria-label': 'Sessions' } },
      el('h4', {}, group.sessions.length ? `Sessions · ${running} running` : 'No sessions yet'), ...rows,
      el('div', { class: 'ag-foot' }, el('span', {}, ''),
        ended.length ? el('button', { data: { k: 'close-ended' }, onclick: () => void closeEnded() }, `Close ended (${ended.length})`) : null,
        el('button', { data: { k: 'list-done' }, onclick: () => closeView() }, 'Done'))));
  }
  const spanEl = (sp: Span) => {
    const n = el('span', {}, sp.t);
    if (sp.fg) n.style.color = sp.fg;
    if (sp.bg) n.style.background = sp.bg;
    if (sp.b) n.style.fontWeight = '700';
    if (sp.dim) n.style.opacity = '.6';
    return n;
  };

  toolbar = rl.addToolbar({
    id: 'agent', title: 'Agent', backTitle: 'Back to the Redline toolbar (Esc)', hotkey: setup.hotkey || undefined, render: renderToolbar, attached: renderCard,
    onEscape: closeView,
    onShow() { if (cur().id) void here('/ack').catch(() => {}); sync(); },
    onHide() { view = null; sync(); },
  });

  /** The CLI window's name: "#1 · Claude Code · Purple button". */
  const winTitle = () => { const x = cur(); return x.id ? [x.label, nameOf(x), x.title].filter(Boolean).join(' · ') : `${pickName()} · no session yet`; };
  /** End session in the CLI window's header (asks first while it works); — minimizes, the session runs on. */
  function renderWinControls() {
    if (!winControls) return;
    const x = cur();
    if (!x.id) { winControls.replaceChildren(); return; }
    const armed = arming === x.id;
    winControls.replaceChildren(style(), el('button', {
      class: 'ag-wend' + (armed ? ' armed' : ''), title: endTitle(x), data: { k: 'wend' }, onclick: () => end(x),
    }, armed ? 'End? Press again' : x.running ? 'End session' : 'Close session'));
  }
  win = rl.addWindow({
    id: 'agent', title: winTitle(), width: 680, height: 440, hideAs: 'minimize',
    render(body, controls) {
      winControls = controls;
      renderWinControls();
      frame = document.createElement('iframe');
      frame.src = frameSrc();
      frame.title = `${name()} terminal`;
      frame.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#131316');
      body.append(frame);
    },
    onShow() { if (cur().id) void here('/ack').catch(() => {}); toFrame({ type: 'focus' }); toolbar?.render(); },
    onHide() { toolbar?.render(); },
    onResize() { toFrame({ type: 'fit' }); },
  });

  // The notes panel shows, the toolbar acts: a line that opens it, and a tag on handed-over notes.
  // Both are kept and updated in place, so a status change doesn't re-render the panel (and a reply being typed).
  function renderLine() {
    if (!line) return;
    const top = overall(group.sessions) ?? cur(), st = stateLabel(top), all = rl.notes('all'), s = sent();
    const open = all.filter(n => s.has(n.id) && !n.done).length, done = all.filter(n => s.has(n.id) && n.done).length;
    const running = group.sessions.filter(x => x.running).length;
    const counts = [running > 1 && `${running} sessions`, open && `${open} sent note${open === 1 ? '' : 's'} open`, done && `${done} done`].filter(Boolean).join(' · ');
    const text = top.running || top.status.state === 'done' || top.status.state === 'error'
      ? `${who(top)}: ${st.label}${counts ? ` · ${counts}` : st.msg ? ` · ${st.msg}` : ''}`
      : `Hand these notes to ${pickName()}`;
    const b = el('button', { class: 'ag-line', title: 'Open the agent toolbar', onclick: () => toolbar?.show(), data: { state: top.running ? top.status.state : 'stopped' } },
      el('span', { class: 'ag-dot' }), el('span', {}, text), setup.hotkey ? el('kbd', {}, hotkeyText()) : setup.key !== false ? el('kbd', {}, (setup.key || 'a').toUpperCase()) : null);
    b.style.setProperty('--c', st.color);
    line.replaceChildren(style(), b);
  }
  function renderTag(t: { el: HTMLElement; note: Note }) {
    const tag = tagFor(t.note, group.sessions, who);
    // Being worked on or asking: a click opens the agent toolbar (and its card).
    const lit = !!tag && /working|asking/.test(tag.cls);
    t.el.replaceChildren(...(tag ? [el('span', { class: `ag-tag ${tag.cls}`, ...(lit ? { title: 'Open the agent toolbar', onclick: () => toolbar?.show() } : {}) }, tag.text)] : []));
  }
  rl.addPanelSection({ id: 'agent', render(box) { line = box; renderLine(); } });
  rl.addCardDecorator({ id: 'agent', render(note, box) { const t = { el: box, note }; tags.set(note.id, t); renderTag(t); } });

  function sync() {
    if (sel && !group.sessions.some(s => s.id === sel)) sel = null;   // closed
    // Another session asks while this one doesn't: show that one (not while an answer is being typed).
    // Only when it starts asking, or when this one's question was just answered (the next question
    // comes up), so a tab picked by hand stays picked.
    const isAsking = (s: Session) => s.running && s.status.state === 'blocked';
    const asking = group.sessions.filter(isAsking).map(s => s.id);
    const newly = asking.find(id => !wasAsking.has(id));
    wasAsking = new Set(asking);
    const c = cur(), answered = lastCur.id === c.id && lastCur.asking && !isAsking(c);
    const next = newly ?? (answered ? asking[0] : undefined);
    if (next && !typing && !isAsking(c)) { sel = next; if (view === 'list') view = null; }
    lastCur = { id: cur().id, asking: isAsking(cur()) };
    pick = pickCli(clis(), pick, setup.cli);
    const top = overall(group.sessions);
    const ind = top ? indicatorFor({ ...top, command: who(top) }) : null;
    rl.setStatus('agent', ind ? { ...ind, onClick: () => toolbar?.show() } : null);
    addAgentButton(ind?.title);
    if (frame && !frame.src.endsWith(frameSrc())) frame.src = frameSrc();   // the CLI window follows the tab
    win?.setTitle(winTitle());
    renderWinControls();
    toolbar?.render();
    renderLine();
    for (const t of tags.values()) if (t.el.isConnected) renderTag(t); else tags.delete(t.note.id);
  }

  // The status feed: every session, with the toolbar and window closed; `clis` when an ACP agent's
  // models and effort levels arrive (D62). EventSource reconnects by itself (a dev-server restart); a
  // stale token (another server process) re-reads /info.
  let es: EventSource | null = null;
  const connect = () => {
    es?.close();
    es = new EventSource(`${BASE}/stream?status=1&token=${encodeURIComponent(setup.token)}`);
    for (const ev of ['hello', 'status']) es.addEventListener(ev, e => { group = JSON.parse((e as MessageEvent).data); sync(); });
    es.addEventListener('clis', e => { setup.clis = JSON.parse((e as MessageEvent).data); if (view === 'settings') refreshSettings(); sync(); });
    es.onerror = async () => {
      if (es?.readyState !== EventSource.CLOSED) return;
      try { const r = await fetch(`${BASE}/info`); if (r.ok) { setup = await r.json(); group = setup; pick = pickCli(clis(), pick, setup.cli); sync(); setTimeout(connect, 1000); } } catch { /* down: retried on the next open */ }
    };
  };
  connect();
  // The CLI window: keys there acknowledge a finished turn; a session it started is the one shown.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== frame?.contentWindow) return;
    if (e.data?.type === 'ack') void here('/ack').catch(() => {});
    if (e.data?.type === 'session' && typeof e.data.id === 'string') { sel = e.data.id; sync(); }
  });
  sync();
}
