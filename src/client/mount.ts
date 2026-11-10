// mount(): starts one overlay and returns its API and unmount (D49). Nothing happens on import;
// the dev server's injected script (index.ts) is one caller, an embedding product another.
//
//   import { mount, httpTransport } from '@umage.ai/redline/overlay';
//   const rl = await mount({ transport: myStore, shadowMode: 'closed', namespace: 'att' });
//   rl.api.open(); … rl.unmount();

import type { Note } from '../shared/types.ts';
import type { RedlineGate, RedlineOp, RedlinePageKey } from '../shared/extension.ts';
import { pageKey } from '../shared/page.ts';
import { launcherPlace, launcherVars } from '../shared/place.ts';
import { screenshot as builtInShot, stopTabCapture } from './capture.ts';
import { h, Life, safely, storage } from './dom.ts';
import { captureErrors } from './errors.ts';
import { shieldApp } from './shield.ts';
import { CSS } from './styles.ts';
import { httpTransport, type StoredNote } from './transport.ts';
import { ICON, type Ctx, type Layers, type Mode, type ViewState } from './context.ts';
import type { MountOptions, OverlayConfig, RedlineHandle, ScreenshotRequest } from './options.ts';
import { createApi, events, loadExtensions } from './api.ts';
import { translator, type Translate } from './strings.ts';
import { toastPart } from './toast.ts';
import { barPart } from './bar.ts';
import { pinsPart } from './pins.ts';
import { panelPart } from './panel.ts';
import { draftPart } from './draft.ts';
import { textPart } from './text.ts';
import { sketchPart } from './sketch-tools.ts';
import { dragPart } from './drag.ts';
import { installInput } from './input.ts';
import { windowsPart } from './windows.ts';

export type { MountOptions, OverlayConfig, RedlineHandle, ScreenshotRequest, StatusDef } from './options.ts';
export type { RedlineTransport, StoredNote, EditRequest, EditResult, Inspection } from './transport.ts';
export type { NoteMessage, Note, NewNoteRequest, NotesResponse } from '../shared/types.ts';
export { STRINGS, type RedlineStrings, type StringKey } from './strings.ts';
export type * from '../shared/extension.ts';
export { httpTransport } from './transport.ts';
export { captureErrors, type ErrorCapture } from './errors.ts';

const DEFAULTS: OverlayConfig = { hotkey: 'alt+shift+r', launcher: true, draggable: true, dir: '.redline' };

export async function mount(opts: MountOptions = {}): Promise<RedlineHandle> {
  const transport = opts.transport ?? httpTransport();
  const ns = opts.namespace ?? 'redline';
  const life = new Life();
  let fetched: Partial<OverlayConfig> = {};
  try { fetched = await transport.config(); } catch { /* defaults */ }
  const config: OverlayConfig = { ...DEFAULTS, ...fetched, ...opts.config };
  const t = translator(config.strings, opts.strings);

  const errors = errorSource(opts.captureErrors, life);
  const { host, shadow, ui } = createHost(opts, life);
  const shield = shieldApp(host, life, shadow);
  const store = storage(ns);
  const bus = events();
  life.add(bus.clear);
  life.add(stopTabCapture);

  const state = store.session<ViewState>({ open: false, mode: 'idle', panel: false, scope: 'page', showDone: false });
  // Sketches and extension modes don't survive a reload (their state, or the extension, is gone).
  if (state.mode === 'sketch' || state.mode.startsWith('ext:') || opts.gate) state.mode = 'idle';
  if (!state.open || opts.gate) state.toolbar = null;   // an extension toolbar comes back with its extension (agent panel)
  // Page key: built-in ('route' or 'path', from the pageKey option), or an extension's function.
  let customKey: RedlinePageKey | null = null;
  const keyNow = () => {
    const builtIn = pageKey(location, config.pageKey);
    const k = customKey ? safely(() => customKey!(location, builtIn), null) : null;
    return typeof k === 'string' && k ? k : builtIn;
  };

  ui.style.setProperty('--launcher', `${launcherPx(config.launcherSize)}px`);
  for (const [k, v] of Object.entries(launcherVars(launcherPlace(config.launcherPosition)))) ui.style.setProperty(k, v);
  const el = layers(config, t);
  ui.append(el.hl, el.hlLabel, el.pins, el.launcher, el.bar, el.panel, el.windows, el.gate, el.popLayer, el.tip, el.toast);
  el.launcher.addEventListener('click', () => ctx.setOpen(true));

  const shoot = (mark: ScreenshotRequest) => opts.screenshot
    ? opts.screenshot(mark, r => builtInShot(r.host, r))
    : builtInShot(mark.host, mark);

  // Filled in below: core actions here, the rest by each part.
  const ctx = {
    config, transport, store, life, shield, host, shadow, ui, el,
    app: config.app ?? '',
    errors, t, ns,
    shoot: mark => shoot({ ...mark, host }),
    state, notes: [] as StoredNote[], version: '', draft: null, page: keyNow(), focusId: null, busy: false,
    ext: { buttons: [], sections: [], slots: [], beforeSave: [], cardDecorators: [], cardActions: [], modes: [], sketchTools: [], pinStyle: null, statuses: new Map(), toolbars: [], badge: null, enrichers: [], beforeCreate: [] },
    gate: { fn: opts.gate ?? null, running: null },
    emit: bus.emit,
    persist: () => store.saveSession({ open: state.open, mode: state.mode, panel: state.panel, scope: state.scope, showDone: state.showDone, toolbar: state.toolbar ?? null }),
  } as Partial<Ctx> as Ctx;

  Object.assign(ctx, core(ctx, keyNow));
  Object.assign(ctx, toastPart(ctx), barPart(ctx), pinsPart(ctx), panelPart(ctx), draftPart(ctx), textPart(ctx), sketchPart(ctx), dragPart(ctx), windowsPart(ctx));
  installInput(ctx);
  startLoop(ctx);

  await ctx.poll(true);
  ctx.renderAll();
  if (state.open) ctx.releaseTextFocus();   // reopened after a reload: the page's autofocus ran meanwhile
  if (state.open && ctx.locked()) ctx.setOpen(true);   // …and the gate is asked again

  const api = createApi(ctx, bus.on, fn => { customKey = fn; });
  loadExtensions(ctx, api, ns, opts.extensions);
  return { api, unmount: () => { ctx.draft?.sketch?.destroy(); life.end(); } };
}

/** The launcher's size in px: a named size, or a number (also as text, from .NET) within 20–64. */
export function launcherPx(v: OverlayConfig['launcherSize']): number {
  if (v === 'small') return 26;
  if (v === 'large') return 40;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? +v : NaN;
  return Number.isFinite(n) ? Math.max(20, Math.min(64, Math.round(n))) : 32;
}

/** Errors to attach to notes: our own capture (stopped at unmount), the caller's list, or none. */
function errorSource(opt: MountOptions['captureErrors'], life: Life): () => string[] {
  if (typeof opt === 'function') return () => safely(opt, []);
  if (opt === false) return () => [];
  const cap = captureErrors();
  life.add(cap.stop);
  return cap.list;
}

/** The host element on <html> with its shadow root; put back if the app replaces <html>'s children. */
function createHost(opts: MountOptions, life: Life) {
  const host = document.createElement(opts.hostTag ?? 'redline-root');
  host.setAttribute('style', 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;');
  for (const [k, v] of Object.entries(opts.theme ?? {})) host.style.setProperty(k, v);
  const shadow = host.attachShadow({ mode: opts.shadowMode ?? 'open' });
  shadow.append(h('style', {}, CSS));
  const ui = h('div', { class: 'rl' });
  shadow.append(ui);
  const attach = () => { if (!life.ended && !host.isConnected) document.documentElement.append(host); };
  attach();
  const mo = new MutationObserver(attach);
  mo.observe(document.documentElement, { childList: true });
  life.add(() => { mo.disconnect(); host.remove(); });
  return { host, shadow, ui };
}

function layers(config: OverlayConfig, t: Translate): Layers {
  return {
    launcher: h('button', { class: 'launcher', title: t('launcherTitle', { hotkey: config.hotkey }) + (config.draggable ? ` · ${t('dragLauncher')}` : ''), html: ICON }),
    hl: h('div', { class: 'hl', style: 'display:none' }),
    hlLabel: h('div', { class: 'hl-label', style: 'display:none' }),
    pins: h('div'),
    tip: h('div', { class: 'tip', style: 'display:none' }),
    bar: h('div', { class: 'bar' }),
    panel: h('div', { class: 'panel' }),
    popLayer: h('div'),
    toast: h('div', { class: 'toast', style: 'display:none' }),
    gate: h('div', { class: 'gate', style: 'display:none' }),
    windows: h('div'),
  };
}

/** Notes, open/close, modes and the page key. */
function core(ctx: Ctx, keyNow: () => string) {
  const { state, config } = ctx;

  async function poll(force = false) {
    if (ctx.gate.fn) return;   // nothing is fetched before the gate is passed
    try {
      const data = await ctx.transport.load(force || !ctx.version ? undefined : ctx.version);
      if (!data || ctx.life.ended || ctx.gate.fn) return;
      const changed = data.version !== ctx.version;
      ctx.version = data.version;
      ctx.notes = data.notes as StoredNote[];
      config.dir = data.root;
      ctx.renderAll();
      if (changed) ctx.emit('notes', ctx.notes);
      loadFailed = '';
    } catch (e) {
      // Polling goes on quietly (a restarting dev server); `error` fires once per streak, and again
      // if the reason changes (signed out → workspace gone).
      const msg = (e as Error)?.message ?? String(e);
      if (msg !== loadFailed) { loadFailed = msg; fail('load', e); }
    }
  }
  let loadFailed = '';

  function fail(op: RedlineOp, e: unknown, id?: string): Error {
    const error = e instanceof Error ? e : new Error(String(e));
    ctx.emit('error', { op, error, ...(id ? { id } : {}) });
    return error;
  }

  /* ---------- store calls from the UI (v4): one place for the events, errors and reload ---------- */
  async function updateNote(id: string, patch: Partial<Note>) {
    try { await ctx.transport.update(id, patch); }
    catch (e) { ctx.toast(ctx.t('updateFailed', { error: fail('update', e, id).message }), true); return false; }
    ctx.emit('noteUpdated', { id, patch: { ...patch } });
    await poll(true);
    return true;
  }
  async function removeNote(id: string) {
    try { await ctx.transport.remove(id); }
    catch (e) { ctx.toast(ctx.t('deleteFailed', { error: fail('remove', e, id).message }), true); return false; }
    ctx.emit('noteRemoved', { id });
    await poll(true);
    return true;
  }
  async function sendMessage(id: string, body: string) {
    if (!ctx.transport.message) return false;
    try { await ctx.transport.message(id, body); }
    catch (e) { ctx.toast(ctx.t('sendFailed', { error: fail('message', e, id).message }), true); return false; }
    ctx.emit('messageSent', { id, body });
    await poll(true);
    return true;
  }

  // A remote store keeps listing a note for a while after it is resolved (D42): it stays on the
  // page, green, whatever "show done" says. Once its author has seen it, the overlay tells the
  // store, which then stops listing it soon after.
  const isResolved = (n: Note) => n.done && !!n.resolvedAt;
  const seenSent = new Set<string>();
  function markSeen(n: Note) {
    if (!isResolved(n) || !n.mine || n.seen || seenSent.has(n.id) || document.hidden) return;
    seenSent.add(n.id);
    ctx.transport.update(n.id, { seen: true }).catch(() => seenSent.delete(n.id));
  }

  const statusOf = (n: Note) => n.status ? config.statuses?.find(s => s.id === n.status) : undefined;

  /* ---------- the gate (D50) ---------- */
  const locked = () => !!ctx.gate.fn;
  function lock(fn: RedlineGate) {
    ctx.gate.fn = fn;
    ctx.notes = []; ctx.version = '';
    if (ctx.draft) ctx.cancelDraft();
    if (state.mode !== 'idle') { stopExt(); state.mode = 'idle'; ctx.persist(); ctx.emit('mode', 'idle'); }
    renderAll();
    ctx.emit('notes', ctx.notes);
    if (state.open) void runGate();
  }
  // Shown above the toolbar while open; closing hides it but the step keeps going. A newer gate
  // (locked again meanwhile) takes the box over, and the older one's outcome is ignored.
  async function runGate() {
    const g = ctx.gate, fn = g.fn;
    if (!fn || g.running === fn) return;
    g.running = fn;
    const box = ctx.el.gate;
    box.replaceChildren();
    renderAll();
    try {
      await fn(box);
      if (g.fn !== fn || ctx.life.ended) return;
      g.fn = null;
      await poll(true);
      if (state.open) releaseTextFocus();
    } catch (e) {
      if (g.fn === fn) ctx.toast(ctx.t('gateFailed', { error: (e as Error)?.message ?? String(e) }), true, 5000);
    } finally {
      // Passed, or failed (asked again on the next open): the box empties.
      if (g.running === fn) { g.running = null; box.replaceChildren(); renderAll(); }
    }
  }

  // Monorepos: every app's notes come back from the store; this app only pins and numbers its own.
  const pageNotes = (p = ctx.page, a = ctx.app) => ctx.notes.filter(n => n.page === p && (n.app ?? '') === a);
  const numberOf = (n: Note) => pageNotes(n.page, n.app ?? '').indexOf(n as StoredNote) + 1;
  const openCount = () => ctx.notes.filter(n => !n.done).length;

  // An autofocused field would swallow the single-key shortcuts (C, T, S, N). Only text fields
  // are blurred (a focused menu item keeps focus), and quietly, so an open combobox stays open.
  function releaseTextFocus() {
    const a = document.activeElement;
    if (a instanceof HTMLElement && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName))) ctx.shield.quietly(() => a.blur());
  }

  function setOpen(v: boolean) {
    const was = state.open;
    state.open = v;
    if (v) releaseTextFocus();
    if (!v) { ctx.cancelDraft(); stopExt(); state.mode = 'idle'; state.panel = false; ctx.hideHl(); leaveToolbar(); }
    ctx.persist(); ctx.renderAll();
    if (was !== v) ctx.emit(v ? 'open' : 'close');
    if (v) void runGate();
  }

  /** Leaving an extension mode some other way than setMode (closing, a gate): it hears onStop. */
  function stopExt() { const m = extMode(); if (m?.onStop) safely(() => m.onStop!(), undefined); }
  const extMode = (m = state.mode) => m.startsWith('ext:') ? ctx.ext.modes.find(x => `ext:${x.id}` === m) : undefined;

  /** An extension toolbar goes away with the overlay, and when a mode starts: it hears onHide. */
  function leaveToolbar() {
    const tb = ctx.extToolbar();
    state.toolbar = null;
    if (tb?.onHide) safely(() => tb.onHide!(), undefined);
  }

  function setMode(m: Mode) {
    if (m.startsWith('ext:') && !extMode(m)) return;   // no such extension mode (removed, or never added)
    if (m !== 'idle' && locked()) {
      if (!state.open) setOpen(true); else ctx.toast(ctx.t('gateFirst'), true);
      return;
    }
    if (m !== 'idle') leaveToolbar();
    if (ctx.draft) ctx.cancelDraft();
    if (m !== 'idle' && !state.open) { state.open = true; ctx.emit('open'); }
    const before = extMode();
    state.mode = state.mode === m ? 'idle' : m;
    const after = extMode();
    if (before !== after) { if (before?.onStop) safely(() => before.onStop!(), undefined); if (after?.onStart) safely(() => after.onStart!(), undefined); }
    if (state.mode === 'sketch') ctx.startSketch();
    ctx.hideHl(); ctx.persist(); ctx.renderAll();
    ctx.emit('mode', state.mode);
  }

  function renderAll() {
    if (ctx.life.ended) return;
    ctx.renderLauncher(); ctx.renderBar(); ctx.renderPanel(); ctx.renderPins(); ctx.syncPanel();
    ctx.el.gate.style.display = state.open && ctx.gate.running ? '' : 'none';
    ctx.placeNearBar(ctx.el.gate);
  }

  // Route changes (and setPageKey): a new page key means a new notes file and pin set.
  function checkPage() {
    const p = keyNow();
    if (p === ctx.page) return false;
    ctx.page = p;
    if (ctx.draft && !ctx.draft.sketch) ctx.cancelDraft();
    renderAll();
    ctx.emit('page', ctx.page);
    return true;
  }

  return { poll, fail, updateNote, removeNote, sendMessage, extMode, isResolved, markSeen, statusOf, locked, lock, pageNotes, numberOf, openCount, releaseTextFocus, setOpen, setMode, renderAll, checkPage };
}

/** Pins follow scrolling; route changes and the store are watched (change feed, then polling). */
function startLoop(ctx: Ctx) {
  const { life, state } = ctx;
  let raf = 0;
  const reposition = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      ctx.renderPins();
      if (ctx.draft?.el && !ctx.draft.sketch && !ctx.busy) ctx.showHl(ctx.draft.el, null, ctx.draft.type === 'text' ? 'text' : '');
    });
  };
  life.add(() => cancelAnimationFrame(raf));
  life.on(window, 'scroll', reposition, true);
  life.on(window, 'resize', () => { reposition(); ctx.syncPanel(); });
  life.every(() => { if (!ctx.checkPage()) ctx.renderPins(); }, 500);
  // Live (D41): when the store has a change feed, it says "changed" and the overlay re-reads at
  // once; polling then only backs it up. Without one, nothing is opened.
  let live = false;
  if (ctx.config.events && ctx.transport.subscribe) {
    life.add(ctx.transport.subscribe(() => void ctx.poll(), up => { live = up; }));
  }
  let lastPoll = 0;
  life.every(() => {
    if (document.hidden) return;
    const every = live ? 30_000 : state.open ? 2000 : 6000;
    if (Date.now() - lastPoll >= every) { lastPoll = Date.now(); void ctx.poll(); }
  }, 1000);
}
