// The agent panel's overlay extension (D53), served at /__redline/agent/panel.js when the dev
// server has the `agent` option. Every agent action lives in one place, the agent toolbar
// (`rl.addToolbar`), opened by the Agent button (A) or its own shortcut (alt+shift+a) from anywhere:
// the agent's state and message, the prompt buttons ("Apply 3 notes", starting the CLI when needed),
// a tab per session (several with "Fresh": one per prompt), the card with what it asks (Claude Code) or
// Allow/Deny while it waits for approval, "CLI" for the terminal window (xterm.js in an iframe, see
// terminal.ts) and stop. The notes panel only shows: a status line that opens the toolbar, and a
// "sent"/"done by" tag on the notes a prompt handed over. The live indicator (`rl.setStatus`) comes
// from the program's OSC 7501 status. Built on the public extension API (v5), so a product can write
// its own panel the same way.

import type { Note } from '../../src/shared/types.ts';
import type { RedlineApi, RedlineStatus, RedlineWindow } from '../../src/shared/extension.ts';
import { API_BASE } from '../../src/shared/types.ts';
import type { PromptView, Span } from './screen.ts';

const BASE = `${API_BASE}/agent`;

type State = 'idle' | 'working' | 'done' | 'blocked' | 'error';
interface Info {
  running: boolean;
  command: string;
  exitCode?: number | null;
  status: { state: State; kind?: string; progress?: number; msg?: string; title?: string; source: '7501' | 'activity' | 'none' };
  sent?: string[];
  /** The menu on the agent's screen (a permission prompt, stepped questions), read off it by the server. */
  prompt?: PromptView;
}
export interface Session extends Info { id: string; label: string; app?: string }
/** All of the project's sessions: one that keeps its context ('shared'), or one per prompt ('fresh'). */
interface Group { mode: 'shared' | 'fresh'; max: number; sessions: Session[] }
interface Command { label: string; prompt: string; title?: string }
interface Setup extends Group { command: string; token: string; commands: Command[]; approve: boolean; hotkey: string | false; key?: string | false }

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

/** The agent toolbar's state chip: a short word for the state, and the program's message. */
export function stateLabel(info: Info): { label: string; msg?: string; color: string } {
  const s = info.status;
  const msg = s.msg || undefined;
  if (!info.running && s.state !== 'done' && s.state !== 'error') {
    return { label: info.exitCode === undefined ? 'Not started' : `Stopped${info.exitCode ? ` (exit ${info.exitCode})` : ''}`, color: OFF };
  }
  const color = indicatorFor(info)?.color ?? GREY;
  switch (s.state) {
    case 'working': return { label: `Working${s.progress !== undefined ? ` ${s.progress}%` : ''}`, msg, color };
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

/**
 * The sessions with a tab on the toolbar, in their order; the rest sit behind "+N" (the session list).
 * Always the one on screen and any that asks; then the newest running, then the newest ended, up to `max`.
 */
export function visibleTabs(sessions: Pick<Session, 'id' | 'running' | 'status'>[], selected: string, max = 3): { shown: string[]; hidden: string[] } {
  const keep = new Set(sessions.filter(s => s.id === selected || (s.running && s.status.state === 'blocked')).map(s => s.id));
  const newest = [...sessions].reverse();
  for (const s of [...newest.filter(x => x.running), ...newest.filter(x => !x.running)]) if (keep.size < max) keep.add(s.id);
  return { shown: sessions.filter(s => keep.has(s.id)).map(s => s.id), hidden: sessions.filter(s => !keep.has(s.id)).map(s => s.id) };
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

// The extension's own look, inside the overlay's shadow root (a <style> there applies to all of it).
const CSS = `
/* A fixed width, so the toolbar doesn't change size with every message (the full text is the hover). */
.ag-chip { display: flex; align-items: center; gap: 7px; padding: 0 8px; flex: none; width: 290px; box-sizing: border-box; color: var(--fg); white-space: nowrap; overflow: hidden; }
.ag-chip b { flex: none; }
.ag-chip .ag-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 25%, transparent); }
.ag-chip b { font-weight: 650; }
.ag-chip .ag-msg { color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.bar button.ag-allow { background: #3ecf8e; color: #08130d; font-weight: 650; }
.bar button.ag-allow:hover { background: #5fdca3; color: #08130d; }
.bar button.ag-deny:hover { background: color-mix(in srgb, #ff453a 25%, var(--bg-3)); }
.ag-line { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 10px; border-radius: 8px; background: var(--bg-2); color: var(--fg); text-align: left; cursor: pointer; }
.ag-line:hover { background: var(--bg-3); }
.ag-line .ag-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.ag-line span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-line kbd { flex: none; }
.ag-tag { display: inline-block; margin-top: 6px; padding: 1px 7px; border-radius: 9px; font-size: 11px; font-weight: 600; }
.ag-tag.sent { color: #8fb4ff; background: color-mix(in srgb, #4f8cff 18%, transparent); }
.ag-tag.done { color: #3ecf8e; background: color-mix(in srgb, #3ecf8e 16%, transparent); }
.ag-tag.working, .ag-tag.asking { cursor: pointer; }
.ag-tag.asking { color: #ffb340; background: color-mix(in srgb, #ff9f0a 18%, transparent); }
.ag-tag.working::before, .ag-tag.asking::before { content: ""; display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: currentColor; vertical-align: 1px; animation: ag-beat 1.2s ease-in-out infinite; }
@keyframes ag-beat { 50% { opacity: .45; transform: scale(.75); } }
.ag-chip[data-state="working"] .ag-dot, .ag-tab[data-state="working"] .ag-dot, .ag-switch[data-state="working"] .ag-dot, .ag-line[data-state="working"] .ag-dot { animation: ag-beat 1.2s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .ag-tag::before, .ag-dot { animation: none !important; } }
.ag-card { display: grid; gap: 10px; font-size: 13px; }
.ag-card .ag-who { display: flex; align-items: center; gap: 7px; color: var(--fg-2); font-size: 12px; }
.ag-card .ag-who .ag-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
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
.ag-input button, .ag-foot button { padding: 4px 10px; border-radius: 7px; background: var(--bg-3); color: var(--fg); }
.ag-foot { display: flex; align-items: center; gap: 8px; color: var(--fg-2); font-size: 11.5px; }
.ag-foot span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ag-tabs { display: flex; align-items: center; gap: 2px; }
.bar button.ag-tab { gap: 5px; padding: 0 7px; font-variant-numeric: tabular-nums; }
.ag-tab .ag-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.ag-tab .ag-x { opacity: .55; padding-left: 2px; }
.ag-tab .ag-x:hover { opacity: 1; }
.bar button.ag-tab.cur { background: var(--bg-3); color: var(--fg); }
.bar button.ag-mode.on { background: color-mix(in srgb, #4f8cff 28%, var(--bg-3)); color: var(--fg); }
.bar button.ag-more { padding: 0 7px; font-variant-numeric: tabular-nums; }
.bar button.ag-more.lit { color: var(--fg); box-shadow: inset 0 0 0 1px var(--c); }
.ag-list { display: grid; gap: 4px; font-size: 13px; min-width: min(420px, calc(100vw - 48px)); }
.ag-list h4 { margin: 0 0 4px; font-size: 11px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-2); }
.ag-row { display: grid; grid-template-columns: 8px 28px auto 1fr auto; gap: 8px; align-items: center; padding: 7px 10px; border-radius: 8px; background: var(--bg-2); color: var(--fg); text-align: left; cursor: pointer; border: 1px solid transparent; }
.ag-row:hover { background: var(--bg-3); }
.ag-row.cur { border-color: color-mix(in srgb, var(--c) 60%, var(--line)); }
.ag-row .ag-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c); }
.ag-row .l { font-variant-numeric: tabular-nums; color: var(--fg-2); }
.ag-row .m { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-2); }
.ag-row .ag-x { padding: 0 4px; color: var(--fg-2); }
.ag-row .ag-x:hover { color: var(--fg); }
.ag-row[data-state="working"] .ag-dot { animation: ag-beat 1.2s ease-in-out infinite; }
.ag-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
.ag-head h4 { margin: 0; }
.ag-head .ag-mode { padding: 4px 10px; border-radius: 7px; background: var(--bg-3); color: var(--fg-2); }
.ag-head .ag-mode.on { background: color-mix(in srgb, #4f8cff 28%, var(--bg-3)); color: var(--fg); }
.bar .ag-phone { display: none; }
.bar button.ag-switch { gap: 5px; font-variant-numeric: tabular-nums; }
.ag-switch .ag-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
/* Phones: what fits one row. The outline says the state, the list has the words: the
   session button (its dot the state) in place of the chip and tabs, Fresh and stop in its list, then the prompts and CLI. */
@media (max-width: 560px) {
  .ag-chip, .ag-chip + .sep { display: none; }
  .bar .ag-desk { display: none; }
  .bar .ag-phone { display: flex; }
  .bar button.ag-switch { padding: 6px 8px; }
  .ag-row { grid-template-columns: 8px 24px auto 1fr auto; padding: 9px 8px; }
}`;
const style = () => Object.assign(document.createElement('style'), { textContent: CSS });

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string; data?: Record<string, string> } = {}, ...kids: (Node | string | null | false)[]) {
  const { class: cls, data, ...rest } = props;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls;
  for (const [k, v] of Object.entries(data ?? {})) n.dataset[k] = v;
  n.append(...kids.filter((k): k is Node | string => !!k));
  return n;
}

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
  const NONE = (): Session => ({ id: '', label: '', running: false, command: name(), status: { state: 'idle', source: 'none' }, sent: [] });
  // The session the toolbar, the card and the terminal are on: picked by a tab, or the newest.
  let sel: string | null = null;
  const cur = (): Session => group.sessions.find(s => s.id === sel) ?? group.sessions[group.sessions.length - 1] ?? NONE();
  const several = () => group.sessions.length > 1;
  const fresh = () => group.mode === 'fresh';
  /** "claude", or "claude #2" when there are several sessions. */
  const who = (s: Session) => several() && s.label ? `${name()} ${s.label}` : name();
  const sent = () => new Set(group.sessions.flatMap(s => s.sent ?? []));
  const hotkeyText = () => setup.hotkey ? setup.hotkey.split('+').map(k => k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+') : '';

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
  /** A prompt button: starts the CLI when needed (the server holds the prompt until it is ready); the terminal stays closed. */
  const run = async (c: Command) => {
    const notes = usesIds(c) ? handed() : [];
    if (fresh()) rl.toast(`Starting a new ${name()} session…`);
    else if (!cur().running) rl.toast(`Starting ${name()}…`);
    try {
      const r = await post('/send', { text: fill(c.prompt, rl, notes), notes, ...(!fresh() && cur().id ? { id: cur().id } : {}) });
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
  let listOpen = false;   // the session list ("+N") in the attached card

  let frame: HTMLIFrameElement | null = null;
  const toFrame = (msg: unknown) => frame?.contentWindow?.postMessage(msg, location.origin);
  const frameSrc = () => `${BASE}/terminal${cur().id ? `?id=${encodeURIComponent(cur().id)}` : ''}`;
  // Set below; a window or toolbar left open before a reload shows (and renders) while it is added.
  let win: RedlineWindow | null = null;
  let toolbar: ReturnType<RedlineApi['addToolbar']> | null = null;
  // The notes panel's status line and tags, kept to update in place (below).
  let line: HTMLElement | null = null;
  const tags = new Map<string, { el: HTMLElement; note: Note }>();

  const addAgentButton = (state?: string) => rl.addButton({
    id: 'agent', label: 'Agent', key: setup.key === false ? undefined : setup.key || 'a',
    title: state ?? `${name()}: agent toolbar${setup.hotkey ? ` · ${hotkeyText()} from anywhere` : ''}`,
    onClick: () => toolbar?.show(), active: () => !!toolbar?.isOpen(),
  });
  addAgentButton();

  function renderToolbar(box: HTMLElement) {
    const info = cur(), st = stateLabel(info), s = info.status;
    const blocked = info.running && s.state === 'blocked';
    const asked = blocked && !!info.prompt?.options.length;   // the card shows the options
    const approval = blocked && !asked && s.kind === 'permission' && setup.approve;
    const btn = (label: string, title: string, onclick: () => void, cls = '', ...extra: (Node | string)[]) =>
      el('button', { class: cls, title, onclick }, label, ...extra);
    const chip = el('div', { class: 'ag-chip', title: `${who(info)}: ${st.label}${st.msg ? ` · ${st.msg}` : ''}`, data: { state: info.running ? s.state : 'stopped' } },
      el('span', { class: 'ag-dot' }), el('b', {}, st.label), st.msg && !asked ? el('span', { class: 'ag-msg' }, st.msg) : null);   // asking: the card has the question
    chip.style.setProperty('--c', st.color);
    const sep = () => el('div', { class: 'sep' });
    // Several sessions: a tab each (its state as a dot); an ended one can be closed.
    const vis = visibleTabs(group.sessions, info.id);
    const hidden = group.sessions.filter(x => vis.hidden.includes(x.id));
    // "+N": the sessions without a tab, outlined in the colour of the busiest running one among them.
    let more: HTMLElement | null = null;
    if (hidden.length) {
      const top = overall(hidden.filter(x => x.running && (x.status.state === 'working' || x.status.state === 'blocked')));
      more = btn(`+${hidden.length}`, `${hidden.length} more session${hidden.length === 1 ? '' : 's'}: show all`, () => { listOpen = !listOpen; toolbar?.render(); }, 'ag-more' + (top ? ' lit' : '') + (listOpen ? ' on' : ''));
      if (top) more.style.setProperty('--c', stateLabel(top).color);
    }
    const tabs = several() || (fresh() && group.sessions.length) ? el('div', { class: 'ag-tabs' }, ...group.sessions.filter(x => vis.shown.includes(x.id)).map(x => {
      const xl = stateLabel(x);
      const t = el('button', { class: 'ag-tab' + (x.id === info.id ? ' cur' : ''), title: `${who(x)}: ${xl.label}${xl.msg ? ` · ${xl.msg}` : ''}`, data: { id: x.id, state: x.running ? x.status.state : 'stopped' }, onclick: () => { sel = x.id; sync(); } },
        el('span', { class: 'ag-dot' }), x.label);
      t.style.setProperty('--c', xl.color);
      if (!x.running) t.append(el('span', { class: 'ag-x', title: 'Close this session', onclick: (e: Event) => { e.stopPropagation(); void post('/dismiss', { id: x.id }).catch(fail); } }, '×'));
      return t;
    }), ...(more ? [more] : []), sep()) : null;
    const actions: HTMLElement[] = approval
      ? [btn('Allow', `Approve (${who(info)}'s prompt)`, () => answer('allow'), 'ag-allow'), btn('Deny', 'Decline', () => answer('deny'), 'ag-deny')]
      : setup.commands.map(c => {
        const n = usesIds(c) ? handed().length : -1;
        const busy = n >= 0 ? openIds(rl).length - n : 0;   // open notes a running session already has
        const b = btn(c.label, (c.title ?? c.prompt) + (fresh() ? ' (in a new session)' : '') + (busy ? ` · ${busy} note${busy === 1 ? ' is' : 's are'} already with a session` : ''), () => void run(c), '', ...(n >= 0 ? [el('span', { class: 'count' }, String(n))] : []));
        b.disabled = n === 0 || (blocked && !fresh());
        b.dataset.cmd = c.label;
        return b;
      });
    const mode = modeButton('ag-desk');
    const cli = btn(blocked && !approval && !asked ? 'Answer in CLI' : 'CLI', win?.isOpen() ? 'Hide the terminal' : `Show ${who(info)}'s terminal`, () => win?.toggle(), win?.isOpen() ? 'on' : '');
    cli.dataset.cli = '';
    const stop = info.running ? btn('■', `Stop ${who(info)}`, () => void here('/stop').catch(fail), 'ag-stop ag-desk') : null;
    // Phones: one button for the session on screen; the list it opens has the tabs, Fresh and stop.
    const sw = btn(`${info.label || 'Sessions'} ▾`, 'All sessions, Fresh, stop', () => { listOpen = !listOpen; toolbar?.render(); }, 'ag-switch ag-phone' + (listOpen ? ' on' : ''));
    sw.prepend(el('span', { class: 'ag-dot' }));
    sw.style.setProperty('--c', st.color);
    sw.dataset.state = info.running ? s.state : 'stopped';
    if (tabs) tabs.classList.add('ag-desk');
    box.replaceChildren(style(), chip, sep(), ...(tabs ? [tabs] : []), sw, ...actions, mode, sep(), cli, ...(stop ? [stop] : []));
  }

  /** Fresh on or off: a new session for every prompt, or one shared session. */
  function modeButton(cls = '') {
    const b = el('button', {
      class: `ag-mode ${cls}` + (fresh() ? ' on' : ''),
      title: fresh()
        ? `On: every prompt starts a new session with just its notes (up to ${group.max} at once). Click for one shared session`
        : 'Off: prompts go to one session that keeps its context. Click to start a new session for every prompt',
      onclick: () => void post('/mode', { mode: fresh() ? 'shared' : 'fresh' }).then(g => { group = { ...group, ...g }; sync(); }).catch(fail),
    }, 'Fresh');
    return b;
  }

  /**
   * What the agent is asking, attached to the toolbar: the steps of a stepped question, the lines
   * above the question (a diff keeps its colours), the question, the options as buttons (one for
   * each, with its description; "Type something" as a field), the CLI's key hint, Cancel and CLI.
   */
  function renderCard(box: HTMLElement) {
    const info = cur();
    const pv = info.running ? info.prompt : undefined;
    if (!pv?.options.length) { if (listOpen) renderList(box); return; }   // a question comes first
    const st = stateLabel(info);
    const card = el('div', { class: 'ag-card', data: { kind: info.status.kind ?? '', session: info.id } });
    card.style.setProperty('--c', st.color);
    card.append(el('div', { class: 'ag-who' }, el('span', { class: 'ag-dot' }), who(info) + ' · ' + st.label));
    if (pv.steps?.length) {
      const at = pv.steps.findIndex(x => x.current);
      const go = (to: number) => { if (at >= 0 && to !== at) key((to > at ? RIGHT : LEFT).repeat(Math.abs(to - at))); };
      card.append(el('div', { class: 'ag-steps' },
        el('button', { class: 'nav', title: 'Previous question', onclick: () => key(LEFT) }, '←'),
        ...pv.steps.map((x, i) => el('button', { class: (x.current ? 'cur ' : '') + x.state, title: x.label, onclick: () => go(i) }, (x.state === 'done' ? '☒ ' : x.state === 'submit' ? '✔ ' : '☐ ') + x.label)),
        el('button', { class: 'nav', title: 'Next question', onclick: () => key(RIGHT) }, '→')));
    }
    if (pv.lines.length) card.append(el('pre', { class: 'ag-ctx' }, ...pv.lines.flatMap((l, i) => [...(i ? ['\n'] : []), ...l.map(spanEl)])));
    if (pv.question) card.append(el('div', { class: 'ag-q' }, pv.question));
    const opts = el('div', { class: 'ag-opts' });
    pv.options.forEach((o, i) => {
      const num = el('span', { class: 'n' }, String(o.n ?? i + 1));
      if (o.input) {
        const field = document.createElement('input');
        field.placeholder = o.label.replace(/\.$/, '') + '…';
        field.disabled = choosing;
        // Sent: let go of the field, or the card (not redrawn while a field has focus) would keep this step.
        const send = () => { const v = field.value.trim(); if (v) { field.blur(); void choose(i, v); } };
        field.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
        field.addEventListener('focus', () => { typing = true; });
        field.addEventListener('blur', () => { typing = false; });
        opts.append(el('div', { class: 'ag-input' }, num, field, el('button', { onclick: send, disabled: choosing }, 'Send')));
        return;
      }
      opts.append(el('button', { class: 'ag-opt' + (o.selected ? ' sel' : ''), disabled: choosing, onclick: () => void choose(i), title: o.selected ? 'Selected in the CLI' : '' },
        num, el('span', {}, o.label), o.description ? el('span', { class: 'd' }, o.description) : null));
    });
    card.append(opts, el('div', { class: 'ag-foot' }, el('span', {}, pv.hint ?? ''),
      el('button', { title: 'Esc in the CLI', onclick: () => key(ESC) }, 'Cancel'),
      el('button', { title: 'Show ' + who(info) + "'s terminal", onclick: () => win?.show() }, 'CLI')));
    box.append(style(), card);
  }
  /** Every session (the "+N" list), newest first: state, message, its notes; a click shows it, × closes an ended one. */
  function renderList(box: HTMLElement) {
    const ended = group.sessions.filter(x => !x.running);
    const rows = [...group.sessions].reverse().map(x => {
      const xl = stateLabel(x), n = x.sent?.length ?? 0;
      const r = el('button', { class: 'ag-row' + (x.id === cur().id ? ' cur' : ''), title: `${who(x)}: ${xl.label}${xl.msg ? ` · ${xl.msg}` : ''}`, data: { id: x.id, state: x.running ? x.status.state : 'stopped' }, onclick: () => { sel = x.id; listOpen = false; sync(); } },
        el('span', { class: 'ag-dot' }), el('span', { class: 'l' }, x.label), el('b', {}, xl.label),
        el('span', { class: 'm' }, [n ? `${n} note${n === 1 ? '' : 's'}` : '', xl.msg ?? ''].filter(Boolean).join(' · ')),
        x.running
          ? el('span', { class: 'ag-x', title: `Stop ${who(x)}`, onclick: (e: Event) => { e.stopPropagation(); void post('/stop', { id: x.id }).catch(fail); } }, '■')
          : el('span', { class: 'ag-x', title: 'Close this session', onclick: (e: Event) => { e.stopPropagation(); void post('/dismiss', { id: x.id }).catch(fail); } }, '×'));
      r.style.setProperty('--c', xl.color);
      return r;
    });
    const closeEnded = async () => { for (const x of ended) await post('/dismiss', { id: x.id }).catch(fail); };
    const running = group.sessions.filter(x => x.running).length;
    box.append(style(), el('div', { class: 'ag-list' },
      el('div', { class: 'ag-head' }, el('h4', {}, group.sessions.length ? `Sessions · ${running} running` : 'No sessions yet'), modeButton()), ...rows,
      el('div', { class: 'ag-foot' }, el('span', {}, ''),
        ended.length ? el('button', { onclick: () => void closeEnded() }, `Close ended (${ended.length})`) : null,
        el('button', { onclick: () => { listOpen = false; toolbar?.render(); } }, 'Done'))));
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
    id: 'agent', hotkey: setup.hotkey || undefined, render: renderToolbar, attached: renderCard,
    onShow() { if (cur().id) void here('/ack').catch(() => {}); sync(); },
    onHide() { sync(); },
  });

  win = rl.addWindow({
    id: 'agent', title: name(), width: 680, height: 440,
    render(body) {
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
      : `Hand these notes to ${name()}`;
    const b = el('button', { class: 'ag-line', title: 'Open the agent toolbar', onclick: () => toolbar?.show(), data: { state: top.running ? top.status.state : 'stopped' } },
      el('span', { class: 'ag-dot' }), el('span', {}, text), setup.hotkey ? el('kbd', {}, hotkeyText()) : setup.key !== false ? el('kbd', {}, (setup.key || 'a').toUpperCase()) : null);
    b.style.setProperty('--c', st.color);
    line.replaceChildren(style(), b);
  }
  function renderTag(t: { el: HTMLElement; note: Note }) {
    const tag = tagFor(t.note, group.sessions, who);
    // Being worked on or asking: a click opens the agent toolbar (and its card).
    const live = !!tag && /working|asking/.test(tag.cls);
    t.el.replaceChildren(...(tag ? [el('span', { class: `ag-tag ${tag.cls}`, ...(live ? { title: 'Open the agent toolbar', onclick: () => toolbar?.show() } : {}) }, tag.text)] : []));
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
    if (next && !typing && !isAsking(c)) sel = next;
    lastCur = { id: cur().id, asking: isAsking(cur()) };
    const top = overall(group.sessions);
    const ind = top ? indicatorFor({ ...top, command: who(top) }) : null;
    rl.setStatus('agent', ind ? { ...ind, onClick: () => toolbar?.show() } : null);
    addAgentButton(ind?.title);
    if (frame && !frame.src.endsWith(frameSrc())) frame.src = frameSrc();   // the terminal follows the tab
    win?.setTitle(who(cur()));
    toolbar?.render();
    renderLine();
    for (const t of tags.values()) if (t.el.isConnected) renderTag(t); else tags.delete(t.note.id);
  }

  // The status feed: every session, with the toolbar and window closed. EventSource reconnects by
  // itself (a dev-server restart); a stale token (another server process) re-reads /info.
  let es: EventSource | null = null;
  const connect = () => {
    es?.close();
    es = new EventSource(`${BASE}/stream?status=1&token=${encodeURIComponent(setup.token)}`);
    for (const ev of ['hello', 'status']) es.addEventListener(ev, e => { group = JSON.parse((e as MessageEvent).data); sync(); });
    es.onerror = async () => {
      if (es?.readyState !== EventSource.CLOSED) return;
      try { const r = await fetch(`${BASE}/info`); if (r.ok) { setup = await r.json(); group = setup; sync(); setTimeout(connect, 1000); } } catch { /* down: retried on the next open */ }
    };
  };
  connect();
  // The terminal: keys there acknowledge a finished turn; a session it started is the one shown.
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== frame?.contentWindow) return;
    if (e.data?.type === 'ack') void here('/ack').catch(() => {});
    if (e.data?.type === 'session' && typeof e.data.id === 'string') { sel = e.data.id; sync(); }
  });
  sync();
}
