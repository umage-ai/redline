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
interface Session extends Info { id: string; label: string; app?: string }
/** All of the project's sessions: one that keeps its context ('shared'), or one per prompt ('fresh'). */
interface Group { mode: 'shared' | 'fresh'; max: number; sessions: Session[] }
interface Command { label: string; prompt: string; title?: string }
interface Setup extends Group { command: string; token: string; commands: Command[]; approve: boolean; hotkey: string | false }

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
/** The open notes on the page no running session has yet: what a fresh session gets, so two never work on one note. */
export function freeIds(rl: Pick<RedlineApi, 'notes'>, sessions: Pick<Session, 'running' | 'sent'>[]): string[] {
  const taken = new Set(sessions.filter(s => s.running).flatMap(s => s.sent ?? []));
  return openIds(rl).filter(id => !taken.has(id));
}
const usesIds = (c: Command) => c.prompt.includes('{ids}');

/** What a note's tag says: handed to the agent and still open, or done since. */
export function noteTag(note: Pick<Note, 'id' | 'done'>, sent: ReadonlySet<string>): 'sent' | 'done' | null {
  return !sent.has(note.id) ? null : note.done ? 'done' : 'sent';
}

// The extension's own look, inside the overlay's shadow root (a <style> there applies to all of it).
const CSS = `
.ag-chip { display: flex; align-items: center; gap: 7px; padding: 0 8px; min-width: 0; max-width: 340px; color: var(--fg); white-space: nowrap; }
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
.bar button.ag-mode.on { background: color-mix(in srgb, #4f8cff 28%, var(--bg-3)); color: var(--fg); }`;
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
  /** The notes a prompt hands over: the open ones on the page; a fresh session only those no running session has. */
  const handed = () => fresh() ? freeIds(rl, group.sessions) : openIds(rl);
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
  let typing = false;   // a typed answer in the card's field: no switching sessions under it

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
    id: 'agent', label: 'Agent', key: 'a',
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
    const tabs = several() || (fresh() && group.sessions.length) ? el('div', { class: 'ag-tabs' }, ...group.sessions.map(x => {
      const xl = stateLabel(x);
      const t = el('button', { class: 'ag-tab' + (x.id === info.id ? ' cur' : ''), title: `${who(x)}: ${xl.label}${xl.msg ? ` · ${xl.msg}` : ''}`, data: { id: x.id, state: x.running ? x.status.state : 'stopped' }, onclick: () => { sel = x.id; sync(); } },
        el('span', { class: 'ag-dot' }), x.label);
      t.style.setProperty('--c', xl.color);
      if (!x.running) t.append(el('span', { class: 'ag-x', title: 'Close this session', onclick: (e: Event) => { e.stopPropagation(); void post('/dismiss', { id: x.id }).catch(fail); } }, '×'));
      return t;
    }), sep()) : null;
    const actions: HTMLElement[] = approval
      ? [btn('Allow', `Approve (${who(info)}'s prompt)`, () => answer('allow'), 'ag-allow'), btn('Deny', 'Decline', () => answer('deny'), 'ag-deny')]
      : setup.commands.map(c => {
        const n = usesIds(c) ? handed().length : -1;
        const b = btn(c.label, (c.title ?? c.prompt) + (fresh() ? ' (in a new session)' : ''), () => void run(c), '', ...(n >= 0 ? [el('span', { class: 'count' }, String(n))] : []));
        b.disabled = n === 0 || (blocked && !fresh());
        b.dataset.cmd = c.label;
        return b;
      });
    const mode = btn('Fresh', fresh()
      ? `On: every prompt starts a new session with just its notes (up to ${group.max} at once). Click for one shared session`
      : 'Off: prompts go to one session that keeps its context. Click to start a new session for every prompt', () => void post('/mode', { mode: fresh() ? 'shared' : 'fresh' }).then(g => { group = { ...group, ...g }; sync(); }).catch(fail), 'ag-mode' + (fresh() ? ' on' : ''));
    const cli = btn(blocked && !approval && !asked ? 'Answer in CLI' : 'CLI', win?.isOpen() ? 'Hide the terminal' : `Show ${who(info)}'s terminal`, () => win?.toggle(), win?.isOpen() ? 'on' : '');
    cli.dataset.cli = '';
    const stop = info.running ? btn('■', `Stop ${who(info)}`, () => void here('/stop').catch(fail), 'ag-stop') : null;
    box.replaceChildren(style(), chip, sep(), ...(tabs ? [tabs] : []), ...actions, mode, sep(), cli, ...(stop ? [stop] : []));
  }

  /**
   * What the agent is asking, attached to the toolbar: the steps of a stepped question, the lines
   * above the question (a diff keeps its colours), the question, the options as buttons (one for
   * each, with its description; "Type something" as a field), the CLI's key hint, Cancel and CLI.
   */
  function renderCard(box: HTMLElement) {
    const info = cur();
    const pv = info.running ? info.prompt : undefined;
    if (!pv?.options.length) return;
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
    const b = el('button', { class: 'ag-line', title: 'Open the agent toolbar', onclick: () => toolbar?.show() },
      el('span', { class: 'ag-dot' }), el('span', {}, text), setup.hotkey ? el('kbd', {}, hotkeyText()) : el('kbd', {}, 'A'));
    b.style.setProperty('--c', st.color);
    line.replaceChildren(style(), b);
  }
  function renderTag(t: { el: HTMLElement; note: Note }) {
    const tag = noteTag(t.note, sent());
    // The newest session that had the note: "sent to claude #2".
    const by = [...group.sessions].reverse().find(x => x.sent?.includes(t.note.id));
    const to = by ? who(by) : name();
    t.el.replaceChildren(...(tag ? [el('span', { class: `ag-tag ${tag}` }, tag === 'sent' ? `⤳ sent to ${to}` : `✓ done by ${to}`)] : []));
  }
  rl.addPanelSection({ id: 'agent', render(box) { line = box; renderLine(); } });
  rl.addCardDecorator({ id: 'agent', render(note, box) { const t = { el: box, note }; tags.set(note.id, t); renderTag(t); } });

  function sync() {
    if (sel && !group.sessions.some(s => s.id === sel)) sel = null;   // closed
    // Another session starts asking while this one doesn't: show that one (not while an answer is
    // being typed). Only when it starts, so a tab picked by hand stays picked.
    const asking = group.sessions.filter(s => s.running && s.status.state === 'blocked').map(s => s.id);
    const newly = asking.find(id => !wasAsking.has(id));
    wasAsking = new Set(asking);
    const c = cur();
    if (newly && !typing && !(c.running && c.status.state === 'blocked')) sel = newly;
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
