// The agent panel's overlay extension (D53), served at /__redline/agent/panel.js when the dev
// server has the `agent` option. Every agent action lives in one place, the agent toolbar
// (`rl.addToolbar`), opened by the Agent button (A) or its own shortcut (alt+shift+a) from anywhere:
// the agent's state and message, the prompt buttons ("Apply 3 notes", starting the CLI when needed),
// Allow/Deny while it waits for approval, "CLI" for the terminal window (xterm.js in an iframe, see
// terminal.ts) and stop. The notes panel only shows: a status line that opens the toolbar, and a
// "sent"/"done by" tag on the notes a prompt handed over. The live indicator (`rl.setStatus`) comes
// from the program's OSC 7501 status. Built on the public extension API (v5), so a product can write
// its own panel the same way.

import type { Note } from '../shared/types.ts';
import type { RedlineApi, RedlineStatus, RedlineWindow } from '../shared/extension.ts';
import { API_BASE } from '../shared/types.ts';

const BASE = `${API_BASE}/agent`;

type State = 'idle' | 'working' | 'done' | 'blocked' | 'error';
interface Info {
  running: boolean;
  command: string;
  exitCode?: number | null;
  status: { state: State; kind?: string; progress?: number; msg?: string; title?: string; source: '7501' | 'activity' | 'none' };
  sent?: string[];
}
interface Command { label: string; prompt: string; title?: string }
interface Setup extends Info { token: string; commands: Command[]; approve: boolean; hotkey: string | false }

const GREY = '#a3a3ad', OFF = '#5c5c66';

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

/** A prompt template with {page}, {url} and {ids} (the open notes on the page) filled in. */
export function fill(prompt: string, rl: Pick<RedlineApi, 'page' | 'notes'>): string {
  const ids = openIds(rl).join(', ');
  return prompt.replace(/\{(page|url|ids)\}/g, (_, k: string) => k === 'page' ? rl.page() : k === 'url' ? location.href : ids || 'none');
}
const openIds = (rl: Pick<RedlineApi, 'notes'>) => rl.notes('page').filter(n => !n.done).map(n => n.id);
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
.ag-tag.done { color: #3ecf8e; background: color-mix(in srgb, #3ecf8e 16%, transparent); }`;
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
  let info: Info = setup;
  const sent = () => new Set(info.sent ?? []);
  const name = () => setup.command;
  const hotkeyText = () => setup.hotkey ? setup.hotkey.split('+').map(k => k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1)).join('+') : '';

  const post = async (p: string, body: unknown = {}) => {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1', 'x-redline-agent': setup.token }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.json().catch(() => null))?.error ?? `HTTP ${r.status}`);
    return r.json();
  };
  const fail = (e: unknown) => rl.toast(`Agent: ${(e as Error).message}`, true);
  /** A prompt button: starts the CLI when needed (the server holds the prompt until it is ready); the terminal stays closed. */
  const run = async (c: Command) => {
    const notes = usesIds(c) ? openIds(rl) : [];
    if (!info.running) rl.toast(`Starting ${name()}…`);
    try { await post('/send', { text: fill(c.prompt, rl), notes }); }
    catch (e) { fail(e); }
  };
  const answer = (choice: 'allow' | 'deny') => void post('/answer', { choice }).catch(fail);

  let frame: HTMLIFrameElement | null = null;
  const toFrame = (msg: unknown) => frame?.contentWindow?.postMessage(msg, location.origin);
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
    const st = stateLabel(info), s = info.status;
    const blocked = info.running && s.state === 'blocked';
    const approval = blocked && s.kind === 'permission' && setup.approve;
    const btn = (label: string, title: string, onclick: () => void, cls = '', ...extra: (Node | string)[]) =>
      el('button', { class: cls, title, onclick }, label, ...extra);
    const chip = el('div', { class: 'ag-chip', title: `${name()}: ${st.label}${st.msg ? ` · ${st.msg}` : ''}`, data: { state: info.running ? s.state : 'stopped' } },
      el('span', { class: 'ag-dot' }), el('b', {}, st.label), st.msg ? el('span', { class: 'ag-msg' }, st.msg) : null);
    chip.style.setProperty('--c', st.color);
    const sep = () => el('div', { class: 'sep' });
    const actions: HTMLElement[] = approval
      ? [btn('Allow', `Approve (${name()}'s prompt)`, () => answer('allow'), 'ag-allow'), btn('Deny', 'Decline', () => answer('deny'), 'ag-deny')]
      : setup.commands.map(c => {
        const n = usesIds(c) ? openIds(rl).length : -1;
        const b = btn(c.label, c.title ?? c.prompt, () => void run(c), '', ...(n >= 0 ? [el('span', { class: 'count' }, String(n))] : []));
        b.disabled = n === 0 || blocked;
        b.dataset.cmd = c.label;
        return b;
      });
    const cli = btn(blocked && !approval ? 'Answer in CLI' : 'CLI', win?.isOpen() ? 'Hide the terminal' : `Show ${name()}'s terminal`, () => win?.toggle(), win?.isOpen() ? 'on' : '');
    cli.dataset.cli = '';
    const stop = info.running ? btn('■', `Stop ${name()}`, () => void post('/stop').catch(fail), 'ag-stop') : null;
    box.replaceChildren(style(), chip, sep(), ...actions, sep(), cli, ...(stop ? [stop] : []));
  }

  toolbar = rl.addToolbar({
    id: 'agent', hotkey: setup.hotkey || undefined, render: renderToolbar,
    onShow() { void post('/ack').catch(() => {}); sync(); },
    onHide() { sync(); },
  });

  win = rl.addWindow({
    id: 'agent', title: name(), width: 680, height: 440,
    render(body) {
      frame = document.createElement('iframe');
      frame.src = `${BASE}/terminal`;
      frame.title = `${name()} terminal`;
      frame.setAttribute('style', 'position:absolute;inset:0;width:100%;height:100%;border:0;background:#131316');
      body.append(frame);
    },
    onShow() { void post('/ack').catch(() => {}); toFrame({ type: 'focus' }); toolbar?.render(); },
    onHide() { toolbar?.render(); },
    onResize() { toFrame({ type: 'fit' }); },
  });

  // The notes panel shows, the toolbar acts: a line that opens it, and a tag on handed-over notes.
  // Both are kept and updated in place, so a status change doesn't re-render the panel (and a reply being typed).
  function renderLine() {
    if (!line) return;
    const st = stateLabel(info), all = rl.notes('all'), s = sent();
    const open = all.filter(n => s.has(n.id) && !n.done).length, done = all.filter(n => s.has(n.id) && n.done).length;
    const counts = [open && `${open} sent note${open === 1 ? '' : 's'} open`, done && `${done} done`].filter(Boolean).join(' · ');
    const text = info.running || info.status.state === 'done' || info.status.state === 'error'
      ? `${name()}: ${st.label}${counts ? ` · ${counts}` : st.msg ? ` · ${st.msg}` : ''}`
      : `Hand these notes to ${name()}`;
    const b = el('button', { class: 'ag-line', title: 'Open the agent toolbar', onclick: () => toolbar?.show() },
      el('span', { class: 'ag-dot' }), el('span', {}, text), setup.hotkey ? el('kbd', {}, hotkeyText()) : el('kbd', {}, 'A'));
    b.style.setProperty('--c', st.color);
    line.replaceChildren(style(), b);
  }
  function renderTag(t: { el: HTMLElement; note: Note }) {
    const tag = noteTag(t.note, sent());
    t.el.replaceChildren(...(tag ? [el('span', { class: `ag-tag ${tag}` }, tag === 'sent' ? `⤳ sent to ${name()}` : `✓ done by ${name()}`)] : []));
  }
  rl.addPanelSection({ id: 'agent', render(box) { line = box; renderLine(); } });
  rl.addCardDecorator({ id: 'agent', render(note, box) { const t = { el: box, note }; tags.set(note.id, t); renderTag(t); } });

  function sync() {
    const ind = indicatorFor(info);
    rl.setStatus('agent', ind ? { ...ind, onClick: () => toolbar?.show() } : null);
    addAgentButton(ind?.title);
    toolbar?.render();
    renderLine();
    for (const t of tags.values()) if (t.el.isConnected) renderTag(t); else tags.delete(t.note.id);
  }

  // The status feed: the indicator works with the toolbar and window closed. EventSource reconnects
  // by itself (a dev-server restart); a stale token (another server process) re-reads /info.
  let es: EventSource | null = null;
  const connect = () => {
    es?.close();
    es = new EventSource(`${BASE}/stream?status=1&token=${encodeURIComponent(setup.token)}`);
    for (const ev of ['hello', 'status', 'start']) es.addEventListener(ev, e => { info = JSON.parse((e as MessageEvent).data); sync(); });
    es.addEventListener('exit', () => { info = { ...info, running: false }; sync(); });
    es.onerror = async () => {
      if (es?.readyState !== EventSource.CLOSED) return;
      try { const r = await fetch(`${BASE}/info`); if (r.ok) { setup = await r.json(); info = setup; sync(); setTimeout(connect, 1000); } } catch { /* down: retried on the next open */ }
    };
  };
  connect();
  // Keys in the terminal acknowledge a finished turn (the frame tells us).
  window.addEventListener('message', e => {
    if (e.origin !== location.origin || e.source !== frame?.contentWindow) return;
    if (e.data?.type === 'ack') void post('/ack').catch(() => {});
  });
  sync();
}
