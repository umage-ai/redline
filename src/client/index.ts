// Redline overlay. Injected by the dev server into every HTML page; lives in a
// shadow root on <html>. Modes: comment (pin a note on an element), text (rewrite
// text in place → a text-change note), sketch (draw on the page). Notes are stored
// by the dev server as markdown under .redline/ for an agent to work through.

import type { Note, NotesResponse, NoteType } from '../shared/types.ts';
import { API_BASE } from '../shared/types.ts';
import { isStale, relativeAge, STALE_DAYS } from '../shared/age.ts';
import type { Token } from '../server/edit.ts';
import type { RedlineApi, RedlineButton, RedlineEvents, RedlineExtension, RedlinePageKey, RedlinePanelSection, RedlinePanelState } from '../shared/extension.ts';
import { pageKey, type PageKeyMode } from '../shared/page.ts';
import { clip, cmsInfo, describe, labelFor, resolve, sourceInfo, textBlockFor } from './anchor.ts';
import { screenshot, startTabCapture, stopTabCapture, tabCaptureActive } from './capture.ts';
import { bboxOf, COLORS, sketchFile, SketchLayer, type Tool } from './sketch.ts';
import { CSS } from './styles.ts';

type StoredNote = Note & { file?: string };
type Mode = 'idle' | 'comment' | 'text' | 'sketch';
interface Config { hotkey: string; launcher: boolean; dir: string; guide?: string | null; app?: string; directEdit?: boolean; extensions?: string[]; pageKey?: PageKeyMode }
interface Draft {
  type: NoteType; el?: Element | null; whole?: boolean; x: number; y: number;
  from?: string; to?: string; sketch?: SketchLayer; editor?: HTMLElement;
  rich?: Inspection; html?: string;   // rich text edits (D20): the source tokens and the new source content
}
interface Inspection { tokens: Token[]; braces: boolean; selfClose: boolean; spell?: Record<string, string> }
type EditResult = { ok: true; file: string; line?: number; inspect?: Inspection } | { ok: false; reason: string };

declare global { interface Window { __redline?: boolean; redlineExtensions?: { push(...fns: RedlineExtension[]): unknown } } }

/* ---------- errors seen on the page, attached to notes ---------- */
const errors: string[] = [];
const pushErr = (s: string) => { errors.push(clip(s, 300)); if (errors.length > 10) errors.shift(); };
const origError = console.error;
console.error = (...a: unknown[]) => { pushErr(a.map(x => (x instanceof Error ? x.message : typeof x === 'string' ? x : safeJson(x))).join(' ')); origError.apply(console, a); };
addEventListener('error', e => pushErr(e.message));
addEventListener('unhandledrejection', e => pushErr('Unhandled rejection: ' + String((e.reason as Error)?.message ?? e.reason)));
function safeJson(x: unknown) { try { return JSON.stringify(x); } catch { return String(x); } }

/* ---------- helpers ---------- */
type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'html') el.innerHTML = v as string;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = v as string;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const ls = {
  get: (k: string, d: string) => { try { return localStorage.getItem('redline:' + k) ?? d; } catch { return d; } },
  set: (k: string, v: string) => { try { localStorage.setItem('redline:' + k, v); } catch { /* private mode */ } },
};
const ss = {
  get: <T,>(d: T): T => { try { return { ...d, ...JSON.parse(sessionStorage.getItem('redline:state') ?? '{}') }; } catch { return d; } },
  set: (v: unknown) => { try { sessionStorage.setItem('redline:state', JSON.stringify(v)); } catch { /* ignore */ } },
};

/** What text mode reads as an element's text (and sends as `from`). */
function blockText(el: Element): string {
  const t = getComputedStyle(el).textTransform === 'none' ? (el as HTMLElement).innerText : el.textContent;
  return (t ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Several elements with this tag and text (a deck's nine identical <span>s): which one this is,
 * in document order. The static-HTML writer picks the same one in source when the counts agree.
 */
function nthOf(el: Element, from: string): { index: number; count: number } | undefined {
  const n = (s: string) => s.replace(/[\s ]+/g, ' ').trim();
  const want = n(from);
  // textContent too: innerText is '' for hidden elements (Reveal hides every other slide)
  const same = Array.from(document.getElementsByTagName(el.localName)).filter(x => x === el || n(blockText(x)) === want || n(x.textContent ?? '') === want);
  return same.length > 1 ? { index: same.indexOf(el), count: same.length } : undefined;
}

function themeOf(): 'light' | 'dark' {
  const de = document.documentElement;
  const attr = (de.getAttribute('data-theme') ?? de.getAttribute('data-mode') ?? de.getAttribute('data-color-scheme') ?? '').toLowerCase();
  if (de.classList.contains('dark') || document.body?.classList.contains('dark') || attr.includes('dark')) return 'dark';
  if (de.classList.contains('light') || attr.includes('light')) return 'light';
  // No explicit marker: judge by the page background, then the OS preference.
  for (const el of [document.body, de]) {
    const m = el && /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(getComputedStyle(el).backgroundColor);
    if (m && (m[4] === undefined || +m[4] > 0.5)) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 < 0.45 ? 'dark' : 'light';
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function matchHotkey(e: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split('+');
  const key = parts.pop()!;
  const want = { alt: parts.includes('alt'), shift: parts.includes('shift'), ctrl: parts.includes('ctrl'), meta: parts.includes('meta') || parts.includes('cmd') };
  if (e.altKey !== want.alt || e.shiftKey !== want.shift || e.ctrlKey !== want.ctrl || e.metaKey !== want.meta) return false;
  return e.code === (key.length === 1 ? (/[0-9]/.test(key) ? 'Digit' : 'Key') + key.toUpperCase() : key) || e.key.toLowerCase() === key;
}


/** Extension code must never break the overlay. */
function safely<T>(fn: () => T, fallback: T): T {
  try { return fn(); } catch (err) { console.warn('[redline] extension failed:', err); return fallback; }
}

const isTyping = (e: Event) => e.composedPath().some(n => n instanceof HTMLElement && (n.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(n.tagName)));

const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="#ff2d55" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/><path d="M14 20h6"/></svg>`;
const TYPE_ICON: Record<NoteType, string> = { comment: '💬', text: 'T', sketch: '✎' };

/* ---------- shield: the app never notices the overlay (D14, L17) ---------- */
// Dropdowns, popovers and comboboxes close on any press, focus move or Escape outside
// themselves, so using the toolbar would close the very UI being reviewed.
// - Bubble-phase listeners on document/window: cut at the host.
// - Capture-phase listeners on document (Headless UI, Radix Escape): cut at window, where we
//   are registered first. Events our own UI needs are re-dispatched inside the shadow root as
//   non-composed copies, which never leave it. `click` is never copied: a dispatched click
//   runs activation behaviour again (a checkbox would toggle twice); bubble-cutting it is enough.
// - Focus leaving the app for the overlay (blur/focusout/pointerout with relatedTarget = host)
//   is hidden from the app, as is the blur when opening the overlay or pressing on a
//   non-focusable part of it.
let quietBlur = false;
function quietly(fn: () => void) { quietBlur = true; try { fn(); } finally { quietBlur = false; } }

const BUBBLE_CUT = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointercancel', 'mousedown', 'mouseup',
  'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend',
  'wheel', 'focusin', 'focusout', 'input', 'change', 'keydown', 'keyup', 'keypress', 'beforeinput', 'paste', 'copy', 'cut'];
const CAPTURE_CUT = ['mousedown', 'mouseup', 'touchstart', 'touchend', 'focusin', 'focusout', 'pointerover', 'pointerout', 'mouseover', 'mouseout', 'keyup', 'keypress'];
const CAPTURE_COPY = ['pointerdown', 'pointerup', 'keydown'];   // the overlay itself listens to these
const LEAVING = ['blur', 'focusout', 'pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
const INIT = ['bubbles', 'cancelable', 'clientX', 'clientY', 'screenX', 'screenY', 'button', 'buttons', 'altKey', 'ctrlKey', 'shiftKey',
  'metaKey', 'pointerId', 'pointerType', 'isPrimary', 'width', 'height', 'pressure', 'key', 'code', 'location', 'repeat', 'isComposing', 'detail'];

function redispatch(e: Event) {
  const init: Record<string, unknown> = { composed: false };
  for (const k of INIT) if (k in e) init[k] = (e as unknown as Record<string, unknown>)[k];
  const copy = new (e.constructor as typeof Event)(e.type, init);
  e.composedPath()[0].dispatchEvent(copy);
  if (copy.defaultPrevented) e.preventDefault();
}

function shieldApp(host: HTMLElement) {
  for (const t of BUBBLE_CUT) host.addEventListener(t, e => e.stopPropagation());
  let pressedAt = 0;
  const ours = (e: Event) => e.composedPath().includes(host);
  for (const t of [...CAPTURE_CUT, ...CAPTURE_COPY]) {
    addEventListener(t, e => {
      if (!ours(e)) return;
      if (t === 'pointerdown' || t === 'mousedown') pressedAt = Date.now();
      e.stopPropagation();   // not Immediate: the overlay's own window listeners still run
      if (CAPTURE_COPY.includes(t)) redispatch(e);
    }, true);
  }
  for (const t of LEAVING) {
    addEventListener(t, e => {
      if (ours(e)) return;   // the overlay's own editors still need their blur
      const to = (e as FocusEvent | MouseEvent).relatedTarget;
      // Pressing a non-focusable part of the overlay moves focus to <body> (relatedTarget null).
      if (to === host || quietBlur || (to === null && t !== 'mouseout' && t !== 'pointerout' && Date.now() - pressedAt < 400)) e.stopPropagation();
    }, true);
  }
}

/* ---------- app ---------- */
async function boot() {
  if (window.__redline || window.top !== window) return;  // once per page, never inside iframes
  window.__redline = true;

  let config: Config = { hotkey: 'alt+shift+r', launcher: true, dir: '.redline' };
  try { config = await (await fetch(`${API_BASE}/config`)).json(); } catch { /* defaults */ }

  const host = document.createElement('redline-root');
  host.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.append(h('style', {}, CSS));
  const ui = h('div', { class: 'rl' });
  shadow.append(ui);
  shieldApp(host);
  const mount = () => { if (!host.isConnected) document.documentElement.append(host); };
  mount();
  new MutationObserver(mount).observe(document.documentElement, { childList: true });

  const state = ss.get({ open: false, mode: 'idle' as Mode, panel: false, scope: 'page' as 'page' | 'all', showDone: false });
  if (state.mode === 'sketch') state.mode = 'idle';
  let notes: StoredNote[] = [];
  let version = '';
  let draft: Draft | null = null;
  // Page key: built-in ('route' or 'path', from the pageKey option), or an extension's function.
  let customKey: RedlinePageKey | null = null;
  const keyNow = () => {
    const builtIn = pageKey(location, config.pageKey);
    const k = customKey ? safely(() => customKey!(location, builtIn), null) : null;
    return typeof k === 'string' && k ? k : builtIn;
  };
  let page = keyNow();
  let focusId: string | null = null;
  let busy = false;
  const persist = () => ss.set({ open: state.open, mode: state.mode, panel: state.panel, scope: state.scope, showDone: state.showDone });

  /* extensions (D21): buttons, keys, panel sections, events */
  const extButtons: RedlineButton[] = [];
  const extSections: RedlinePanelSection[] = [];
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  function emit<E extends keyof RedlineEvents>(e: E, ...args: RedlineEvents[E]) {
    for (const fn of listeners.get(e) ?? []) { try { fn(...args); } catch (err) { console.warn(`[redline] "${e}" listener failed:`, err); } }
  }
  const BUILTIN_KEYS = ['c', 't', 's', 'k', 'n', 'escape'];

  /* layers */
  const launcher = h('button', { class: 'launcher', title: `Redline (${config.hotkey})`, html: ICON, onclick: () => setOpen(true) });
  const hl = h('div', { class: 'hl', style: 'display:none' });
  const hlLabel = h('div', { class: 'hl-label', style: 'display:none' });
  const pins = h('div');
  const tip = h('div', { class: 'tip', style: 'display:none' });
  const bar = h('div', { class: 'bar' });
  const panel = h('div', { class: 'panel' });
  const popLayer = h('div');
  const toastEl = h('div', { class: 'toast', style: 'display:none' });
  ui.append(hl, hlLabel, pins, launcher, bar, panel, popLayer, tip, toastEl);

  let toastTimer = 0;
  function toast(msg: string, err = false, ms = 2600) {
    toastEl.textContent = msg;
    toastEl.className = 'toast' + (err ? ' err' : '');
    toastEl.style.display = '';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => (toastEl.style.display = 'none'), ms);
  }

  /* ---------- data ---------- */
  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(API_BASE + path, { method, headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: body ? JSON.stringify(body) : undefined });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText);
    return r.json();
  }

  async function poll(force = false) {
    try {
      const r = await fetch(`${API_BASE}/notes`, { headers: force || !version ? {} : { 'if-none-match': `"${version}"` }, cache: 'no-store' });
      if (r.status === 304) return;
      const data = (await r.json()) as NotesResponse;
      const changed = data.version !== version;
      version = data.version;
      notes = data.notes as StoredNote[];
      config.dir = data.root;
      renderAll();
      if (changed) emit('notes', notes);
    } catch { /* dev server restarting */ }
  }

  // Monorepos: every app's notes come back from /notes; this app only pins and numbers its own.
  const app = config.app ?? '';
  const pageNotes = (p = page, a = app) => notes.filter(n => n.page === p && (n.app ?? '') === a);
  const numberOf = (n: Note) => pageNotes(n.page, n.app ?? '').indexOf(n as StoredNote) + 1;
  const openCount = () => notes.filter(n => !n.done).length;

  /* ---------- open / mode ---------- */
  // An autofocused field would swallow the single-key shortcuts (C, T, S, N). Only text fields
  // are blurred (a focused menu item keeps focus), and quietly, so an open combobox stays open.
  function releaseTextFocus() {
    const a = document.activeElement;
    if (a instanceof HTMLElement && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) quietly(() => a.blur());
  }

  function setOpen(v: boolean) {
    const was = state.open;
    state.open = v;
    if (v) releaseTextFocus();
    if (!v) { cancelDraft(); state.mode = 'idle'; state.panel = false; hideHl(); }
    persist(); renderAll();
    if (was !== v) emit(v ? 'open' : 'close');
  }

  function setMode(m: Mode) {
    if (draft) cancelDraft();
    if (m !== 'idle' && !state.open) { state.open = true; emit('open'); }
    state.mode = state.mode === m ? 'idle' : m;
    if (state.mode === 'sketch') startSketch();
    hideHl(); persist(); renderAll();
    emit('mode', state.mode);
  }

  /* ---------- rendering ---------- */
  function renderAll() {
    renderLauncher(); renderBar(); renderPanel(); renderPins(); syncPanel();
  }

  // The panel's footprint: the bar and toasts move left of it, and extensions hear about it
  // (a host page can lay itself out beside the panel).
  let panelSeen: RedlinePanelState = { open: false, width: 0 };
  function panelState(): RedlinePanelState {
    const open = state.open && state.panel;
    return { open, width: open ? Math.round(panel.getBoundingClientRect().width) : 0 };
  }
  function syncPanel() {
    const s = panelState();
    // A panel that fills (nearly) the whole width, as on phones, leaves nothing to move beside.
    ui.style.setProperty('--panel-w', s.open && s.width < innerWidth - 240 ? `${s.width}px` : '0px');
    if (s.open !== panelSeen.open || s.width !== panelSeen.width) { panelSeen = s; emit('panel', { ...s }); }
  }

  function renderLauncher() {
    launcher.style.display = !state.open && config.launcher ? '' : 'none';
    launcher.querySelector('.badge')?.remove();
    const open = pageNotes().filter(n => !n.done).length;
    if (open) launcher.append(h('span', { class: 'badge' }, String(open)));
  }

  function renderBar() {
    bar.style.display = state.open && state.mode !== 'sketch' ? '' : 'none';
    if (!state.open) return;
    // No hint line: the buttons show their keys, and the extras live in the tooltips (D18).
    const btn = (m: Mode, label: string, key: string, how: string) =>
      h('button', { class: state.mode === m ? 'on' : '', title: `${label} (${key}): ${how}`, onclick: () => setMode(m) }, label, h('kbd', {}, key));
    const open = openCount();
    const ext = extButtons.length ? [h('div', { class: 'sep' }), ...extButtons.map(b => h('button', {
      class: safely(() => b.active?.(), false) ? 'on' : '', 'data-ext': b.id,
      title: (b.title ?? b.label) + (b.key ? ` (${b.key.toUpperCase()})` : ''), onclick: () => safely(() => b.onClick(), undefined),
    }, b.label, b.key ? h('kbd', {}, b.key.toUpperCase()) : null))] : [];
    bar.replaceChildren(
      h('div', { class: 'brand', html: ICON + '<span>Redline</span>' }),
      h('div', { class: 'sep' }),
      btn('comment', 'Comment', 'C', 'click an element. Alt+click picks its parent, Shift+click the whole page.'),
      btn('text', 'Text', 'T', 'click any text and rewrite it in place; Enter keeps it.'),
      btn('sketch', 'Sketch', 'S', 'draw boxes, arrows, lines and labels. Ctrl+Z undoes, Enter finishes.'),
      ...ext,
      h('div', { class: 'sep' }),
      h('button', { class: state.panel ? 'on' : '', title: 'Notes (N)', onclick: () => togglePanel() }, 'Notes', h('span', { class: 'count' }, String(open))),
      h('button', { title: `Close (${config.hotkey})`, onclick: () => setOpen(false) }, '✕'),
    );
    // Astro's dev toolbar also lives bottom-centre; sit above it.
    ui.style.setProperty('--lift', document.querySelector('astro-dev-toolbar') ? '52px' : '0px');
  }

  /* ---------- hover highlight ---------- */
  function showHl(el: Element, label: string | null, cls = '') {
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, { display: '', left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    hl.className = 'hl ' + cls;
    if (label) {
      hlLabel.textContent = label;
      hlLabel.style.display = '';
      const above = r.y > 26;
      hlLabel.style.left = `${Math.max(4, Math.min(r.x - 2, innerWidth - 300))}px`;
      hlLabel.style.top = above ? `${r.y - 24}px` : `${r.bottom + 4}px`;
    } else hlLabel.style.display = 'none';
  }
  function hideHl() { hl.style.display = 'none'; hlLabel.style.display = 'none'; }

  const fromUs = (e: Event) => e.composedPath().includes(host);
  const picking = () => state.open && (state.mode === 'comment' || state.mode === 'text') && !busy;

  addEventListener('pointermove', e => {
    if (!picking() || draft || fromUs(e)) { if (picking() && !draft) hideHl(); return; }
    let el = e.target as Element | null;
    if (!(el instanceof Element)) return;
    if (state.mode === 'text') { el = textBlockFor(el); if (!el) { hideHl(); return; } showHl(el, '✎ ' + labelFor(el), 'text'); return; }
    if (e.altKey && el.parentElement && el.parentElement !== document.documentElement) el = el.parentElement;
    if (e.shiftKey) { hideHl(); hlLabel.textContent = 'whole page'; Object.assign(hlLabel.style, { display: '', left: `${e.clientX + 12}px`, top: `${e.clientY + 12}px` }); return; }
    showHl(el, labelFor(el));
  }, true);

  // Swallow pointer input while picking so the app never sees the click. Picks happen on
  // pointerup, not click: browsers don't fire click on disabled buttons and inputs.
  // touchstart/touchmove are hidden from the app but not cancelled, so a finger can still
  // scroll; a scroll fires pointercancel, so only a tap reaches pointerup (L15).
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'submit']) {
    const scrolls = type === 'touchstart' || type === 'touchmove';
    addEventListener(type, e => {
      if (!picking() || fromUs(e)) return;
      if (!scrolls && e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'pointerup' && (e as PointerEvent).button === 0) onPick(e as MouseEvent);
    }, { capture: true, passive: scrolls });
  }
  addEventListener('pointercancel', () => { if (picking() && !draft) hideHl(); }, true);

  function onPick(e: MouseEvent) {
    if (draft) {
      // Tapping outside a text edit finishes it. The page's pointerdown is cancelled, so the
      // editor never blurs by itself (and phones have no Enter-to-confirm habit).
      if (draft.editor?.isContentEditable) { draft.editor.blur(); return; }
      const ta = popLayer.querySelector('textarea');
      if (draft.editor || (ta && ta.value.trim())) { popLayer.querySelector('.pop')?.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], 160); return; }
      cancelDraft();
    }
    let el = e.target as Element;
    if (state.mode === 'text') {
      const block = textBlockFor(el);
      if (block) void startTextEdit(block);
      return;
    }
    if (e.altKey && el.parentElement && el.parentElement !== document.documentElement) el = el.parentElement;
    const whole = e.shiftKey || el === document.body || el === document.documentElement;
    openDraft({ type: 'comment', el: whole ? null : el, whole, x: e.clientX, y: e.clientY });
  }

  /* ---------- draft popover ---------- */
  function openDraft(d: Draft) {
    draft = d;
    renderPop();
    renderBar();
  }

  function cancelDraft() {
    if (!draft) return;
    draft.editor?.remove();
    if (draft.sketch) { draft.sketch.destroy(); tools?.remove(); tools = null; state.mode = 'idle'; persist(); }
    draft = null;
    popLayer.replaceChildren();
    hideHl();
    renderAll();
  }

  function renderPop() {
    const d = draft!;
    if (d.el) showHl(d.el, null, d.type === 'text' ? 'text' : '');
    else hideHl();
    const what = d.type === 'sketch' ? `sketch · ${d.el ? labelFor(d.el) : 'page'}` : d.el ? labelFor(d.el) : 'whole page';
    const placeholder = { comment: 'What should change here?', text: 'Optional: why / anything else…', sketch: 'What does the sketch mean? (optional)' }[d.type];
    const ta = h('textarea', { placeholder });
    const shotOn = ls.get('shot', '1') === '1';
    const shot = h('input', { type: 'checkbox', ...(shotOn ? { checked: true } : {}) }) as HTMLInputElement;
    shot.addEventListener('change', () => ls.set('shot', shot.checked ? '1' : '0'));
    const save = h('button', { class: 'btn primary', onclick: () => saveDraft(ta.value) }, 'Save');
    const direct: Direct | null = d.type === 'text' && config.directEdit && d.el && d.to !== undefined ? {
      btn: h('button', { class: 'btn apply', disabled: true, title: 'Checking whether this text is written in source…', onclick: () => applyDirect(d, direct!, save) }, 'Apply to file'),
      why: h('div', { class: 'why', style: 'display:none' }),
    } : null;
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDraft(ta.value); }
      else if (e.key === 'Enter' && !e.shiftKey && d.type !== 'comment' && !ta.value.trim()) { e.preventDefault(); saveDraft(''); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
    });
    const pop = h('div', { class: 'pop' },
      h('header', {},
        h('span', { class: 'what', title: what }, (d.type === 'text' ? '✎ ' : d.type === 'sketch' ? '' : '💬 ') + what),
        d.type === 'comment' && d.el && d.el.parentElement && d.el.parentElement !== document.body
          ? h('button', { title: 'Comment on the parent element instead', onclick: () => { d.el = d.el!.parentElement; renderPop(); } }, '↑ Parent') : null,
        d.type === 'comment' && !d.whole ? h('button', { title: 'Comment on the whole page', onclick: () => { d.el = null; d.whole = true; renderPop(); } }, 'Page') : null,
      ),
      d.type === 'text' ? h('div', { class: 'diff', html: `<div class="del">${esc(d.from ?? '')}</div><div class="ins">${esc(d.to ?? '')}</div>` }) : null,
      ta,
      direct ? direct.why : null,
      h('footer', {},
        h('label', { title: 'Attach a screenshot with the target outlined' }, shot, 'Screenshot'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn', onclick: cancelDraft }, 'Cancel'),
        save,
        direct ? direct.btn : null,
      ),
    );
    (pop as HTMLElement & { _shot?: HTMLInputElement })._shot = shot;
    popLayer.replaceChildren(pop);
    placePop();
    setTimeout(() => ta.focus());
    if (direct) void checkDirect(d, direct, save);
  }

  /* ---------- direct source edits (D20) ---------- */
  type Direct = { btn: HTMLButtonElement; why: HTMLElement };
  const editRequest = (d: Draft) => ({
    from: d.from, to: d.to, html: d.html, tag: d.el!.localName, url: location.href, source: sourceInfo(d.el!).source, nth: nthOf(d.el!, d.from!), cms: cmsInfo(d.el!),
  });

  // When text mode opens on an element: is it written in source, and with inline markup?
  // Then the editor shows that markup and keeps it (the presentations editor's approach).
  async function inspectBlock(block: Element, from: string): Promise<Inspection | null> {
    const req = api<EditResult>('POST', '/edit?inspect=1', { from, tag: block.localName, url: location.href, source: sourceInfo(block).source, nth: nthOf(block, from), cms: cmsInfo(block) });
    const r = await Promise.race([req.catch(() => null), new Promise<null>(res => setTimeout(() => res(null), 1500))]);
    return r?.ok && r.inspect ? r.inspect : null;
  }

  // Dry run first: offer "Apply to source" only when a writer accepts this edit.
  async function checkDirect(d: Draft, direct: Direct, save: HTMLButtonElement) {
    let r: EditResult;
    try { r = await api<EditResult>('POST', '/edit?dry=1', editRequest(d)); }
    catch (e) { r = { ok: false, reason: (e as Error).message }; }
    if (draft !== d) return;
    if (r.ok) {
      direct.btn.disabled = false;
      direct.btn.title = `Write the new text into ${r.file}${r.line ? ':' + r.line : ''}`;
      direct.btn.className = 'btn apply primary';
      save.className = 'btn';
      save.textContent = 'Save note';
    } else refuse(direct, save, r.reason);
    placePop();
  }

  // Can't write it: the note is the way (the old text-note flow), and the reason is shown.
  function refuse(direct: Direct, save: HTMLButtonElement, reason: string) {
    direct.btn.disabled = true;
    direct.btn.className = 'btn apply';
    direct.btn.title = `Can't apply to source: ${reason}`;
    direct.why.textContent = `Can't apply to the file: ${reason}. Save it as a note for your agent.`;
    direct.why.style.display = '';
    save.className = 'btn primary';
    placePop();
  }

  async function applyDirect(d: Draft, direct: Direct, save: HTMLButtonElement) {
    busy = true;
    try {
      const r = await api<EditResult>('POST', '/edit', editRequest(d));
      if (!r.ok) { refuse(direct, save, r.reason); return; }
      emit('sourceWritten', { file: r.file, line: r.line, from: d.from!, to: d.to! });
      cancelDraft();
      state.mode = 'idle'; persist(); renderAll();
      toast(`Written to ${r.file}${r.line ? ':' + r.line : ''}`);
    } catch (e) {
      refuse(direct, save, (e as Error).message);
    } finally { busy = false; }
  }

  // Near the anchor point, inside the visible viewport. On phones the on-screen keyboard
  // shrinks only the visual viewport, so re-place when it opens or closes.
  function placePop() {
    const pop = popLayer.querySelector<HTMLElement>('.pop');
    if (!pop || !draft) return;
    const vv = visualViewport;
    const top = vv?.offsetTop ?? 0, bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    const W = pop.offsetWidth || 360, H = pop.offsetHeight || 200;
    let x = draft.x + 14, y = draft.y + 14;
    if (x + W > innerWidth - 8) x = Math.max(8, draft.x - W - 14);
    if (x + W > innerWidth - 8) x = Math.max(8, innerWidth - W - 8);
    if (y + H > bottom - 8) y = Math.max(top + 8, bottom - H - 8);
    if (y < top + 8) y = top + 8;
    Object.assign(pop.style, { left: `${x}px`, top: `${y}px` });
  }
  visualViewport?.addEventListener('resize', placePop);
  visualViewport?.addEventListener('scroll', placePop);

  async function saveDraft(text: string) {
    const d = draft!;
    let body = text.trim();
    if (d.type === 'comment' && !body) { toast('Write a comment first', true); return; }
    // A rich edit saved as a note: the diff shows text only, so give the agent the wanted markup too.
    if (d.type === 'text' && d.rich && d.html) body = [body, 'Wanted source (keeps the markup): `' + d.html.replace(/\s+/g, ' ').trim() + '`'].filter(Boolean).join('\n\n');
    const wantShot = ((popLayer.querySelector('.pop') as HTMLElement & { _shot?: HTMLInputElement })?._shot?.checked) ?? true;
    busy = true;
    popLayer.style.display = 'none';
    hideHl();
    if (d.editor) d.editor.style.visibility = 'hidden';
    try {
      if (wantShot && ls.get('tabcapture', '0') === '1' && !tabCaptureActive()) await startTabCapture();
      const el = d.whole ? null : d.el ?? null;
      const target = el ? describe(el, d.x, d.y) : undefined;
      if (target && d.type === 'sketch' && d.sketch) {
        // pin at the sketch's top-right corner, relative to the anchor element
        const b = bboxOf(d.sketch.shapes)!, r = el!.getBoundingClientRect();
        target.fx = +(((b[0] + b[2]) - r.x) / (r.width || 1)).toFixed(3);
        target.fy = +((b[1] - r.y) / (r.height || 1)).toFixed(3);
      }
      if (target && d.type === 'text') { target.fx = 1; target.fy = 0; }
      const vr = el?.getBoundingClientRect();
      const png = wantShot
        ? await screenshot(host, {
            box: vr && d.type !== 'sketch' ? [vr.x, vr.y, vr.width, vr.height] : undefined,
            sketch: d.sketch?.snapshot(), crop: d.type !== 'sketch',
          })
        : undefined;
      const saved = await api<StoredNote>('POST', '/notes', {
        note: {
          type: d.type, page, url: location.href, title: document.title || undefined,
          whole: !el || undefined, target,
          viewport: [innerWidth, innerHeight, Math.round(devicePixelRatio * 100) / 100],
          scroll: [Math.round(scrollX), Math.round(scrollY)], theme: themeOf(),
          from: d.from, to: d.to, errors: errors.length ? errors.slice(-5) : undefined, body,
        },
        screenshot: png,
        sketch: d.sketch ? sketchFile(d.sketch.shapes, innerWidth, innerHeight, document.title) : undefined,
      });
      d.editor?.remove(); d.sketch?.destroy();
      draft = null;
      popLayer.replaceChildren();
      toast(`Saved → ${saved.file ?? config.dir}`);
      state.mode = 'idle'; persist();   // one note per pick: the next tap goes to the app again (D15)
      emit('noteCreated', saved);
      await poll(true);
    } catch (err) {
      toast('Could not save: ' + (err as Error).message, true, 5000);
      if (d.editor) d.editor.style.visibility = '';
    } finally {
      busy = false;
      popLayer.style.display = '';
      renderAll();
    }
  }

  /* ---------- text mode ---------- */
  function bgOf(el: Element): string {
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      const c = getComputedStyle(cur).backgroundColor;
      if (c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return c;
    }
    return themeOf() === 'dark' ? '#111' : '#fff';
  }

  // The rich editor's content: source tags become plain elements tagged with their token index,
  // so serialising can write each one back byte for byte. Tag names are from the server's
  // inline allowlist; attributes are left out on purpose (they stay in the source).
  function richHtml(tokens: Token[]): string {
    return tokens.map((t, i) => t.k === 'text' ? esc(t.text)
      : !/^[a-z][a-z0-9]*$/.test(t.tag) ? ''
      : t.k === 'close' ? `</${t.tag}>` : `<${t.tag} data-rl="${i}">`).join('');
  }

  const ADDABLE = ['b', 'i', 'u', 's', 'em', 'strong'];
  /** The editor's content as source: original tags verbatim, unchanged text verbatim, the rest encoded. */
  function serialize(ed: HTMLElement, insp: Inspection): string {
    const texts = insp.tokens.filter(t => t.k === 'text') as Extract<Token, { k: 'text' }>[];
    const rawText = new Map(texts.map(t => [t.text, t.raw]));
    const keepNbsp = texts.some(t => t.text.includes('\u00a0'));
    // Characters the source wrote as references (`&mdash;`) are written the same way again.
    const spell: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '\u00a0': '&nbsp;',
      ...(insp.braces ? { '{': '&#123;', '}': '&#125;' } : {}), ...insp.spell };
    const encode = (s: string) => {
      if (!keepNbsp) s = s.replace(/\u00a0/g, ' ');   // Chrome types nbsp at the end of a line
      let out = '';
      for (const ch of s) out += spell[ch] ?? ch;
      return out;
    };
    const walk = (n: Node): string => {
      if (n.nodeType === Node.TEXT_NODE) { const t = (n as Text).data; return rawText.get(t) ?? encode(t); }
      if (!(n instanceof Element)) return '';
      const kids = Array.from(n.childNodes).map(walk).join('');
      const i = n.getAttribute('data-rl');
      const tok = i === null ? undefined : insp.tokens[+i];
      if (tok && tok.k === 'open' && tok.tag === n.localName) return tok.raw + kids + insp.tokens[tok.close].raw;
      if (tok && tok.k === 'void' && tok.tag === n.localName) return tok.raw;
      if (n.localName === 'br') return insp.selfClose ? '<br />' : '<br>';
      if (ADDABLE.includes(n.localName)) return `<${n.localName}>${kids}</${n.localName}>`;
      return kids;   // whatever else the browser made (div, styled span): keep its text
    };
    const nodes = Array.from(ed.childNodes);
    const last = nodes[nodes.length - 1];
    if (last instanceof HTMLBRElement && !last.hasAttribute('data-rl')) nodes.pop();   // Chrome's placeholder <br>
    return nodes.map(walk).join('');
  }

  async function startTextEdit(block: Element) {
    const r = block.getBoundingClientRect();
    const cs = getComputedStyle(block);
    const from = blockText(block);
    // Hold the pick while asking the server whether the source has inline markup to keep.
    const pending: Draft = { type: 'text', el: block, x: r.right, y: r.bottom, from };
    draft = pending;
    showHl(block, null, 'text');
    const insp = config.directEdit ? await inspectBlock(block, from) : null;
    if (draft !== pending) return;
    const rich = insp && insp.tokens.some(t => t.k !== 'text') ? insp : undefined;
    const ed = h('div', { class: 'ed' + (rich ? ' rich' : ''), contenteditable: rich ? 'true' : 'plaintext-only', spellcheck: 'true' });
    if (rich) ed.innerHTML = richHtml(rich.tokens); else ed.textContent = from;
    const original = rich ? serialize(ed, rich) : '';
    const copy = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textAlign', 'textTransform',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'color', 'wordSpacing', 'textIndent'] as const;
    for (const k of copy) (ed.style as unknown as Record<string, string>)[k] = cs[k];
    Object.assign(ed.style, { left: `${r.x}px`, top: `${r.y}px`, minWidth: `${r.width}px`, maxWidth: `${Math.max(r.width, innerWidth - r.x - 8)}px`, minHeight: `${r.height}px`, background: bgOf(block) });
    if (cs.display.startsWith('inline')) ed.style.width = 'auto'; else ed.style.width = `${r.width}px`;
    popLayer.replaceChildren(ed);
    draft = { ...pending, editor: ed, rich };
    renderBar();
    ed.focus();
    // caret where the user clicked is nice-to-have; put it at the end
    const sel = getSelection(); const range = document.createRange();
    range.selectNodeContents(ed); range.collapse(false); sel?.removeAllRanges(); sel?.addRange(range);

    const commit = () => {
      const to = ed.innerText.replace(/\n$/, '').trim();
      const html = rich ? serialize(ed, rich) : undefined;
      if (to === from && html === (rich ? original : undefined)) { cancelDraft(); return; }
      draft!.to = to;
      draft!.html = html;
      ed.contentEditable = 'false';
      const er = ed.getBoundingClientRect();
      draft!.x = er.left; draft!.y = er.bottom;
      renderPop();
      popLayer.prepend(ed);   // keep the new text showing under the popover
    };
    ed.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
    });
    // Rich editor: paste plain text only, so no markup from elsewhere gets in.
    if (rich) ed.addEventListener('paste', e => {
      e.preventDefault();
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
    });
    ed.addEventListener('blur', () => setTimeout(() => { if (draft?.editor === ed && ed.isContentEditable) commit(); }, 120));
  }

  /* ---------- sketch mode ---------- */
  let tools: HTMLElement | null = null;
  let paletteOpen = false;   // the colour swatch folds out the palette
  function setPalette(open: boolean) { if (paletteOpen !== open) { paletteOpen = open; renderTools(); } }
  function startSketch() {
    const layer = new SketchLayer(ui, () => renderTools(), bar);
    const saved = ls.get('sketchColor', COLORS[0].c);
    layer.color = COLORS.some(x => x.c === saved) ? saved : COLORS[0].c;
    layer.el.addEventListener('pointerdown', () => setPalette(false));   // drawing folds it away
    paletteOpen = false;
    draft = { type: 'sketch', sketch: layer, x: 0, y: 0 };
    tools = h('div', { class: 'tools' });
    ui.append(tools);
    renderTools();
  }
  function setColor(c: string) {
    if (!draft?.sketch) return;
    draft.sketch.color = c;
    ls.set('sketchColor', c);   // the next sketch starts with it too
    paletteOpen = false;
    renderTools();
  }
  function renderTools() {
    if (!tools || !draft?.sketch) return;
    const sk = draft.sketch;
    const cur = COLORS.find(x => x.c === sk.color) ?? COLORS[0];
    const t = (tool: Tool, label: string, key: string) =>
      h('button', { class: sk.tool === tool ? 'on' : '', onclick: () => { sk.tool = tool; renderTools(); } }, label, h('kbd', {}, key));
    tools.replaceChildren(
      t('rect', '▭ Box', '1'), t('arrow', '→ Arrow', '2'), t('pen', '✎ Pen', '3'), t('text', 'T Text', '4'),
      h('span', { class: 'colors' },
        h('button', { class: 'sw current', 'aria-haspopup': 'true', 'aria-expanded': String(paletteOpen), style: `--c:${sk.color}`,
          title: `Colour: ${cur.name} (C cycles)`, 'aria-label': `Colour: ${cur.name}`, onclick: () => setPalette(!paletteOpen) }),
        paletteOpen && h('span', { class: 'palette', role: 'radiogroup', 'aria-label': 'Colour' }, ...COLORS.map(x =>
          h('button', { class: 'sw' + (sk.color === x.c ? ' on' : ''), role: 'radio', 'aria-checked': String(sk.color === x.c),
            title: x.name, 'aria-label': x.name, style: `--c:${x.c}`, onclick: () => setColor(x.c) })))),
      h('button', { title: 'Undo (Ctrl+Z)', onclick: () => sk.undo(), disabled: !sk.shapes.length }, '↶ Undo'),
      h('button', { onclick: () => sk.clear(), disabled: !sk.shapes.length }, 'Clear'),
      h('button', { title: 'Cancel (Esc)', onclick: () => endSketch(false) }, 'Cancel'),
      h('button', { class: 'done', onclick: () => endSketch(true) }, 'Done', h('kbd', {}, '↵')),
    );
    // Keep the folded-out palette on screen (on a phone the swatch can sit near an edge).
    const pal = tools.querySelector<HTMLElement>('.palette');
    if (pal) {
      // From layout sizes, not getBoundingClientRect: the fold-out animation starts scaled down.
      const host = pal.parentElement!.getBoundingClientRect(), w = pal.offsetWidth;
      const left = host.left + host.width / 2 - w / 2;
      const dx = left < 8 ? 8 - left : left + w > innerWidth - 8 ? innerWidth - 8 - (left + w) : 0;
      if (dx) pal.style.marginLeft = `${dx}px`;
    }
  }
  function endSketch(keep: boolean) {
    const d = draft;
    tools?.remove(); tools = null;
    if (!d?.sketch) return;
    if (!keep || !d.sketch.shapes.length) {
      if (keep) toast('Nothing drawn');
      cancelDraft(); state.mode = 'idle'; persist(); renderAll(); return;
    }
    const b = bboxOf(d.sketch.shapes)!;
    // anchor: the element under the middle of the drawing
    d.sketch.el.style.pointerEvents = 'none';
    // anchor: the smallest element under the drawing's centre that contains all of it
    let under = document.elementFromPoint(b[0] + b[2] / 2, b[1] + b[3] / 2);
    const contains = (el: Element) => { const r = el.getBoundingClientRect(); return r.left <= b[0] + 8 && r.top <= b[1] + 8 && r.right >= b[0] + b[2] - 8 && r.bottom >= b[1] + b[3] - 8; };
    while (under && under !== document.body && !contains(under)) under = under.parentElement;
    d.el = under && under !== document.documentElement && under !== document.body ? under : null;
    d.whole = !d.el;
    d.x = b[0] + b[2]; d.y = b[1];
    renderPop();
    hideHl();
    renderBar();
  }

  /* ---------- pins ---------- */
  const pinEls = new Map<string, HTMLElement>();
  const resolved = new Map<string, { el: Element | null; at: number }>();
  const targetOf = (n: Note) => {
    const c = resolved.get(n.id);
    if (c && (c.el ? c.el.isConnected : true) && Date.now() - c.at < 1500) return c.el;
    const el = n.target ? resolve(n.target) : null;
    resolved.set(n.id, { el, at: Date.now() });
    return el;
  };

  function renderPins() {
    const show = state.open || config.launcher;
    const list = show ? pageNotes().filter(n => !n.whole && n.target && (!n.done || state.showDone)) : [];
    const keep = new Set<string>();
    for (const n of list) {
      const el = targetOf(n);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      keep.add(n.id);
      let pin = pinEls.get(n.id);
      if (!pin) {
        pin = h('div', { class: 'pin' });
        pin.addEventListener('mouseenter', () => onPinHover(n.id, true));
        pin.addEventListener('mouseleave', () => onPinHover(n.id, false));
        pin.addEventListener('click', () => { focusId = n.id; state.open = true; state.panel = true; persist(); renderAll(); scrollCardIntoView(); });
        pins.append(pin);
        pinEls.set(n.id, pin);
      }
      pin.className = `pin ${n.type}${n.done ? ' done' : ''}`;
      pin.textContent = String(numberOf(n));
      const fx = Math.min(Math.max(n.target!.fx ?? 1, 0), 1), fy = Math.min(Math.max(n.target!.fy ?? 0, 0), 1);
      // Kept on screen: full-width targets on a phone would put the pin past the right edge.
      const size = pin.offsetWidth || 24;
      pin.style.left = `${Math.min(r.x + fx * r.width, innerWidth - size - 4)}px`;
      pin.style.top = `${Math.max(r.y + fy * r.height, size + 4)}px`;
      pin.style.display = r.bottom < 0 || r.top > innerHeight ? 'none' : '';
    }
    for (const [id, el] of pinEls) if (!keep.has(id)) { el.remove(); pinEls.delete(id); }
  }

  function onPinHover(id: string, on: boolean) {
    const n = notes.find(x => x.id === id);
    if (!on || !n) { tip.style.display = 'none'; if (!draft) hideHl(); return; }
    const el = targetOf(n);
    if (el && !draft) showHl(el, null);
    const pin = pinEls.get(id)!.getBoundingClientRect();
    tip.innerHTML = n.type === 'text'
      ? `<div style="color:#ff8a9d;text-decoration:line-through">${esc(clip(n.from, 140))}</div><div style="color:#7ee2b0">${esc(clip(n.to, 140))}</div>${n.body ? '<div style="margin-top:4px">' + esc(n.body) + '</div>' : ''}`
      : esc(n.body || (n.type === 'sketch' ? 'See the sketch.' : ''));
    if (n.reply) tip.innerHTML += `<div class="re">${esc(n.reply)}</div>`;
    tip.style.display = '';
    tip.style.left = `${Math.min(pin.right + 8, innerWidth - 310)}px`;
    tip.style.top = `${Math.min(pin.top, innerHeight - tip.offsetHeight - 8)}px`;
  }

  /* ---------- panel ---------- */
  function togglePanel(v = !state.panel) { state.panel = v; if (v) state.open = true; persist(); renderAll(); }

  function scrollCardIntoView() {
    requestAnimationFrame(() => panel.querySelector('.card.focus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  const assetUrl = (rel?: string) => rel ? `${API_BASE}/assets/${rel.split('/').pop()}` : '';

  function card(n: StoredNote, here: boolean): HTMLElement {
    const t = n.target;
    const loc = n.whole || !t ? 'whole page'
      : `${t.tag ?? ''}${t.text ? ` “${clip(t.text, 28)}”` : ''}${t.source ? ` · ${t.source.file.split('/').pop()}:${t.source.line ?? ''}` : ''}`;
    let delArmed = false;
    const c = h('div', { class: `card${n.done ? ' done' : ''}${focusId === n.id ? ' focus' : ''}`, 'data-id': n.id },
      h('div', { class: 'top' },
        h('span', { class: 'num', title: n.type }, String(numberOf(n))),
        h('span', { class: 'loc', title: t?.selector ?? '' }, `${TYPE_ICON[n.type]}  ${loc}`),
        h('span', { class: 'acts' },
          h('button', { title: here ? 'Show on page' : 'Open page', onclick: () => goTo(n, here) }, here ? '◎' : '↗'),
          h('button', { title: n.done ? 'Reopen' : 'Mark done', onclick: () => patch(n.id, { done: !n.done }) }, n.done ? '↺' : '✓'),
          h('button', { title: 'Edit', onclick: () => editCard(c, n) }, '✎'),
          h('button', { title: 'Delete', onclick: (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            if (!delArmed) { delArmed = true; b.textContent = 'Delete?'; b.style.color = '#ff6b85'; setTimeout(() => { delArmed = false; b.textContent = '✕'; b.style.color = ''; }, 2500); return; }
            remove(n.id);
          } }, '✕'),
        ),
      ),
      n.type === 'text' ? h('div', { class: 'diff', html: `<div class="del">${esc(n.from ?? '')}</div><div class="ins">${esc(n.to ?? '')}</div>` }) : null,
      n.body ? h('div', { class: 'body' }, n.body) : n.type === 'sketch' ? h('div', { class: 'body muted' }, 'See the sketch.') : null,
      n.screenshot ? h('img', { src: assetUrl(n.screenshot) + `?v=${version}`, alt: 'screenshot', loading: 'lazy', onclick: () => zoom(assetUrl(n.screenshot)) }) : null,
      n.reply ? h('div', { class: 'reply' }, n.reply) : null,
      h('div', { class: 'meta' },
        !n.done && isStale(n.at)
          ? h('span', { class: 'age stale', title: `${n.at} · open for over ${STALE_DAYS} days; the UI may have changed since` }, `⏱ ${relativeAge(n.at)}`)
          : h('span', { class: 'age', title: n.at }, relativeAge(n.at) ?? n.at),
        `${n.viewport ? ` · ${n.viewport[0]}×${n.viewport[1]}` : ''}${n.theme ? ` · ${n.theme}` : ''}${here && n.target && !targetOf(n) ? ' · ⚠ element not found on page' : ''}`),
    );
    c.addEventListener('mouseenter', () => { const el = here ? targetOf(n) : null; if (el && !draft) showHl(el, null); });
    c.addEventListener('mouseleave', () => { if (!draft) hideHl(); });
    return c;
  }

  function editCard(c: HTMLElement, n: StoredNote) {
    const ta = h('textarea', {}) as HTMLTextAreaElement;
    ta.value = n.body;
    const old = c.querySelector('.body');
    if (old) old.replaceWith(ta); else c.querySelector('.top')!.after(ta);
    ta.focus();
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) patch(n.id, { body: ta.value.trim() });
      if (e.key === 'Escape') renderPanel(true);
    });
    ta.addEventListener('blur', () => { if (ta.value.trim() !== n.body) patch(n.id, { body: ta.value.trim() }); else renderPanel(true); });
  }

  function goTo(n: StoredNote, here: boolean) {
    if (!here) { location.href = n.url; return; }
    const el = targetOf(n);
    if (!el) { toast('Element not found on this page', true); return; }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => showHl(el, null), 350);
    setTimeout(() => { if (!draft) hideHl(); }, 1800);
  }

  function zoom(src: string) {
    const z = h('div', { class: 'zoom', onclick: () => z.remove() }, h('img', { src }));
    ui.append(z);
  }

  async function patch(id: string, p: Partial<Note>) {
    try { await api('PATCH', `/notes/${id}`, p); await poll(true); } catch (e) { toast('Update failed: ' + (e as Error).message, true); }
  }
  async function remove(id: string) {
    try { await api('DELETE', `/notes/${id}`); await poll(true); } catch (e) { toast('Delete failed: ' + (e as Error).message, true); }
  }

  function renderPanel(force = false) {
    panel.style.display = state.open && state.panel ? '' : 'none';
    if (!state.open || !state.panel) return;
    if (!force && panel.contains(shadow.activeElement) && shadow.activeElement?.tagName === 'TEXTAREA') return; // don't clobber an edit
    const listEl = h('div', { class: 'list' });
    const visible = (n: Note) => state.showDone || !n.done;
    const here = pageNotes().filter(visible) as StoredNote[];
    if (state.scope === 'page') {
      if (!here.length) listEl.append(h('div', { class: 'empty' }, pageNotes().length ? 'All notes on this page are done.' : 'No notes on this page yet. Press C to comment.'));
      for (const n of here) listEl.append(card(n, true));
    } else {
      // Grouped by app + page; in a monorepo other apps' notes are listed too (they open in their own app).
      const key = (n: Note) => `${n.app ?? ''}\u0000${n.page}`, mine = `${app}\u0000${page}`;
      const groups = [...new Set(notes.filter(visible).map(key))].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : a.localeCompare(b)));
      if (!groups.length) listEl.append(h('div', { class: 'empty' }, 'No notes yet.'));
      for (const g of groups) {
        const [gApp, gPage] = g.split('\u0000');
        const label = (gApp && gApp !== app ? `${gApp} · ` : '') + gPage;
        listEl.append(h('div', { class: 'group' }, g === mine ? `${label}  (this page)` : label));
        for (const n of notes.filter(x => key(x) === g && visible(x))) listEl.append(card(n, g === mine));
      }
    }
    const tab = ls.get('tabcapture', '0') === '1';
    const file = pageNotes()[0]?.file;
    const open = state.scope === 'page' ? pageNotes().filter(n => !n.done).length : openCount();
    // Works in any agent: names the installed guide, or spells out the contract when there is none (D16).
    const how = config.guide
      ? `Follow ${config.guide} (the redline skill).`
      : 'For each open "### [ ]" note: make the change, tick it "### [x]" and add a one-line "> " reply saying what changed (or a question, leaving it open). Never edit the <!-- redline … --> lines.';
    const prompt = state.scope === 'page' && file
      ? `Apply the open Redline notes in ${file} (${open} open). ${how}`
      : `Apply the open Redline UI feedback in ${config.dir}/INDEX.md (${openCount()} open). ${how}`;
    panel.replaceChildren(
      h('header', {}, h('h2', {}, 'Notes'), h('button', { title: 'Close panel (N)', onclick: () => togglePanel(false) }, '✕')),
      h('div', { class: 'filters' },
        h('div', { class: 'seg' },
          h('button', { class: state.scope === 'page' ? 'on' : '', onclick: () => { state.scope = 'page'; persist(); renderPanel(true); } }, `This page (${pageNotes().filter(n => !n.done).length})`),
          h('button', { class: state.scope === 'all' ? 'on' : '', onclick: () => { state.scope = 'all'; persist(); renderPanel(true); } }, `All (${openCount()})`),
        ),
        h('label', {}, h('input', { type: 'checkbox', ...(state.showDone ? { checked: true } : {}), onchange: (e: Event) => { state.showDone = (e.target as HTMLInputElement).checked; persist(); renderAll(); } }), 'Show done'),
      ),
      ...extSections.map(s => {
        const body = h('div');
        safely(() => s.render(body), undefined);
        return h('section', { class: 'ext', 'data-ext': s.id }, s.title ? h('h3', {}, s.title) : null, body);
      }),
      listEl,
      h('footer', {},
        h('div', { class: 'file' }, file && state.scope === 'page' ? file : `${config.dir}/INDEX.md`),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', disabled: !open, onclick: async () => {
            try { await navigator.clipboard.writeText(prompt); toast('Prompt copied — paste it into your coding agent'); }
            catch { toast(prompt, false, 8000); }
          } }, 'Copy prompt for your agent'),
        ),
        // Mobile browsers have no getDisplayMedia.
        typeof navigator.mediaDevices?.getDisplayMedia === 'function' && h('label', { title: 'Capture the real pixels of this tab (needed for WebGL/maps/video). Chrome asks for permission once per page load.' },
          h('input', { type: 'checkbox', ...(tab ? { checked: true } : {}), onchange: async (e: Event) => {
            const on = (e.target as HTMLInputElement).checked;
            ls.set('tabcapture', on ? '1' : '0');
            if (on) { if (!(await startTabCapture())) { ls.set('tabcapture', '0'); toast('Tab capture was not allowed', true); renderPanel(true); } }
            else stopTabCapture();
          } }),
          'Pixel-perfect screenshots (tab capture)'),
      ),
    );
    if (focusId) scrollCardIntoView();
  }

  /* ---------- keys ---------- */
  addEventListener('keydown', e => {
    if (matchHotkey(e, config.hotkey)) { e.preventDefault(); e.stopImmediatePropagation(); setOpen(!state.open); return; }
    if (!state.open || e.ctrlKey && e.key !== 'z' || e.metaKey || e.altKey) return;
    if (state.mode === 'sketch' && draft?.sketch && !popLayer.querySelector('.pop')) {
      if (isTyping(e)) return;
      const sk = draft.sketch;
      const tool = ({ '1': 'rect', '2': 'arrow', '3': 'pen', '4': 'text' } as Record<string, Tool>)[e.key];
      if (tool) { sk.tool = tool; renderTools(); }
      else if (e.key === 'c' || e.key === 'C') setColor(COLORS[(COLORS.findIndex(x => x.c === sk.color) + (e.shiftKey ? COLORS.length - 1 : 1)) % COLORS.length].c);
      else if (e.key === 'z' && e.ctrlKey) sk.undo();
      else if (e.key === 'Enter') endSketch(true);
      else if (e.key === 'Escape') { if (paletteOpen) setPalette(false); else endSketch(false); }
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
      return;
    }
    if (isTyping(e) || e.ctrlKey) return;
    const k = e.key.toLowerCase();
    if (k === 'escape') {
      if (draft) cancelDraft();
      else if (state.mode !== 'idle') setMode('idle');
      else if (state.panel) togglePanel(false);
      else setOpen(false);
    } else if (k === 'c') setMode('comment');
    else if (k === 't') setMode('text');
    else if (k === 's' || k === 'k') setMode('sketch');
    else if (k === 'n') togglePanel();
    else {
      const b = extButtons.find(x => x.key?.toLowerCase() === k);
      if (!b) return;
      safely(() => b.onClick(), undefined);
    }
    e.preventDefault(); e.stopImmediatePropagation();
  }, true);

  /* ---------- loop: route changes, pin positions, polling ---------- */
  let raf = 0;
  const reposition = () => { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; renderPins(); if (draft?.el && !draft.sketch) showHl(draft.el, null, draft.type === 'text' ? 'text' : ''); }); };
  addEventListener('scroll', reposition, true);
  addEventListener('resize', () => { reposition(); syncPanel(); });
  // Route changes (and setPageKey): a new page key means a new notes file and pin set.
  const checkPage = () => {
    const p = keyNow();
    if (p === page) return false;
    page = p; resolved.clear();
    if (draft && !draft.sketch) cancelDraft();
    renderAll();
    emit('page', page);
    return true;
  };
  setInterval(() => { if (!checkPage()) renderPins(); }, 500);
  let lastPoll = 0;
  setInterval(() => {
    if (document.hidden) return;
    const every = state.open ? 2000 : 6000;
    if (Date.now() - lastPoll >= every) { lastPoll = Date.now(); poll(); }
  }, 1000);

  await poll(true);
  renderAll();
  if (state.open) releaseTextFocus();   // reopened after a reload: the page's autofocus ran meanwhile

  /* ---------- extension API (D21) ---------- */
  const rl: RedlineApi = {
    version: 2,
    addButton(b) {
      const key = b.key?.toLowerCase();
      if (key && BUILTIN_KEYS.includes(key)) console.warn(`[redline] key "${b.key}" for "${b.id}" is taken by the overlay; use the button`);
      const i = extButtons.findIndex(x => x.id === b.id);
      if (i >= 0) extButtons[i] = b; else extButtons.push(b);
      renderBar();
    },
    removeButton(id) {
      const i = extButtons.findIndex(x => x.id === id);
      if (i >= 0) { extButtons.splice(i, 1); renderBar(); }
    },
    panelState: () => panelState(),
    setPageKey(fn) { customKey = typeof fn === 'function' ? fn : null; checkPage(); },
    addPanelSection(s) {
      const i = extSections.findIndex(x => x.id === s.id);
      if (i >= 0) extSections[i] = s; else extSections.push(s);
      renderPanel(true);
    },
    on(e, fn) {
      const f = fn as (...a: unknown[]) => void;
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(f);
      return () => { listeners.get(e)?.delete(f); };
    },
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => state.open,
    setMode: m => setMode(m),
    togglePanel: v => togglePanel(v),
    toast: (m, err) => toast(m, err),
    notes: (scope = 'page') => (scope === 'page' ? pageNotes() : notes).map(n => ({ ...n })),
    page: () => page,
    refresh: () => poll(true),
    render: () => { renderBar(); renderPanel(true); },
  };
  const run = (fn: unknown) => {
    if (typeof fn !== 'function') return;
    try { Promise.resolve((fn as RedlineExtension)(rl)).catch(err => console.warn('[redline] extension failed:', err)); }
    catch (err) { console.warn('[redline] extension failed:', err); }
  };
  // Scripts can queue extensions before the overlay loads: (window.redlineExtensions ||= []).push(fn)
  const queued = Array.isArray(window.redlineExtensions) ? window.redlineExtensions as RedlineExtension[] : [];
  window.redlineExtensions = { push: (...fns: RedlineExtension[]) => { fns.forEach(run); return fns.length; } };
  queued.forEach(run);
  for (const url of config.extensions ?? []) {
    import(/* @vite-ignore */ url).then(m => run(m.default), err => {
      console.warn(`[redline] couldn't load extension ${url}:`, err);
      toast(`Extension failed to load: ${url}`, true, 5000);
    });
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void boot());
else void boot();
