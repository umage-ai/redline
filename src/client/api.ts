// The extension API (D21) a mounted overlay hands to extensions and to mount()'s caller, and
// the loading of extensions: mount options, the `<ns>Extensions` queue, and config URLs.

import type { RedlineApi, RedlineEvents, RedlineExtension, RedlinePageKey } from '../shared/extension.ts';
import type { Ctx } from './context.ts';
import { BUILTIN_KEYS } from './input.ts';
import { safely } from './dom.ts';

type Listener = (...a: unknown[]) => void;

/** Event listeners for `rl.on`, and `emit` to call them (a failing listener is logged, never thrown). */
export function events() {
  const listeners = new Map<string, Set<Listener>>();
  return {
    emit<E extends keyof RedlineEvents>(e: E, ...args: RedlineEvents[E]) {
      for (const fn of listeners.get(e) ?? []) { try { fn(...args); } catch (err) { console.warn(`[redline] "${e}" listener failed:`, err); } }
    },
    on(e: string, fn: Listener) {
      if (!listeners.has(e)) listeners.set(e, new Set());
      listeners.get(e)!.add(fn);
      return () => { listeners.get(e)?.delete(fn); };
    },
    clear: () => listeners.clear(),
  };
}

/** Adds `item` to `list`, replacing one with the same id. */
function upsert<T extends { id: string }>(list: T[], item: T) {
  const i = list.findIndex(x => x.id === item.id);
  if (i >= 0) list[i] = item; else list.push(item);
}
/** Removes the item with `id`; true when there was one. */
function drop<T extends { id: string }>(list: T[], id: string) {
  const i = list.findIndex(x => x.id === id);
  if (i >= 0) list.splice(i, 1);
  return i >= 0;
}

/** Adds a hook to a list; returns its remover. Not a function: nothing is added. */
function addHook<T>(list: T[], fn: T): () => void {
  if (typeof fn !== 'function') return () => {};
  list.push(fn);
  return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
}

export function createApi(ctx: Ctx, on: (e: string, fn: Listener) => () => void, setPageKey: (fn: RedlinePageKey | null) => void): RedlineApi {
  const { ext, state } = ctx;
  const keyTaken = (key: string | undefined, id: string) => {
    const k = key?.toLowerCase();
    if (k && BUILTIN_KEYS.includes(k)) console.warn(`[redline] key "${key}" for "${id}" is taken by the overlay; use the button`);
  };
  return {
    version: 6,
    addButton(b) {
      const key = b.key?.toLowerCase();
      if (key && BUILTIN_KEYS.includes(key)) console.warn(`[redline] key "${b.key}" for "${b.id}" is taken by the overlay; use the button`);
      const i = ext.buttons.findIndex(x => x.id === b.id);
      if (i >= 0) ext.buttons[i] = b; else ext.buttons.push(b);
      ctx.renderBar();
    },
    removeButton(id) {
      const i = ext.buttons.findIndex(x => x.id === id);
      if (i >= 0) { ext.buttons.splice(i, 1); ctx.renderBar(); }
    },
    panelState: () => ctx.panelState(),
    setPageKey(fn) { setPageKey(typeof fn === 'function' ? fn : null); ctx.checkPage(); },
    addPanelSection(s) {
      const i = ext.sections.findIndex(x => x.id === s.id);
      if (i >= 0) ext.sections[i] = s; else ext.sections.push(s);
      ctx.renderPanel(true);
    },
    addSlot(s) {
      const i = ext.slots.findIndex(x => x.id === s.id);
      if (i >= 0) ext.slots[i] = s; else ext.slots.push(s);
      ctx.renderBar();
    },
    removeSlot(id) {
      const i = ext.slots.findIndex(x => x.id === id);
      if (i >= 0) { ext.slots.splice(i, 1); ctx.renderBar(); }
    },
    gate: fn => { if (typeof fn === 'function') ctx.lock(fn); },
    locked: () => ctx.locked(),
    /* v4 */
    beforeSave: fn => addHook(ext.beforeSave, fn),
    addCardDecorator(d) { upsert(ext.cardDecorators, d); ctx.renderPanel(true); },
    removeCardDecorator(id) { if (drop(ext.cardDecorators, id)) ctx.renderPanel(true); },
    addCardAction(a) { upsert(ext.cardActions, a); ctx.renderPanel(true); },
    removeCardAction(id) { if (drop(ext.cardActions, id)) ctx.renderPanel(true); },
    setPinStyle(fn) { ext.pinStyle = typeof fn === 'function' ? fn : null; ctx.renderPins(); },
    addMode(m) { keyTaken(m.key, m.id); upsert(ext.modes, m); ctx.renderBar(); },
    removeMode(id) {
      if (state.mode === `ext:${id}`) ctx.setMode('idle');
      if (drop(ext.modes, id)) ctx.renderBar();
    },
    addSketchTool(t) { upsert(ext.sketchTools, t); ctx.renderTools(); },
    removeSketchTool(id) { if (drop(ext.sketchTools, id)) ctx.renderTools(); },
    /* v5 */
    addWindow: w => ctx.addWindow(w),
    addToolbar(def) {
      const id = String(def.id);
      const shown = () => state.open && ctx.extToolbar()?.id === id;
      const hide = () => { if (shown()) ctx.setToolbar(null); };
      const replaced = ext.toolbars.some(x => x.id === id);
      upsert(ext.toolbars, def);
      // Back after a reload (the view keeps it), or replaced while on screen: it is showing now.
      if (shown() && !replaced && def.onShow) safely(() => def.onShow!(), undefined);
      ctx.renderBar();
      return {
        show: () => ctx.setToolbar(id),
        hide,
        toggle: () => (shown() ? hide() : ctx.setToolbar(id)),
        isOpen: shown,
        render: () => { if (shown()) ctx.renderBar(); },
        remove: () => { hide(); if (drop(ext.toolbars, id)) ctx.renderBar(); },
      };
    },
    setStatus: (id, s) => ctx.setStatus(String(id), s),
    statuses: () => Object.fromEntries([...ext.statuses].map(([k, v]) => [k, { ...v }])),
    setBadge(fn) { ext.badge = typeof fn === 'function' || fn === false ? fn : null; ctx.renderLauncher(); },
    /* v6 */
    addTargetEnricher: fn => addHook(ext.enrichers, fn),
    beforeCreate: fn => addHook(ext.beforeCreate, fn),
    on: ((e: string, fn: Listener) => e === 'beforeCreate' ? addHook(ext.beforeCreate, fn as never) : on(e, fn)) as RedlineApi['on'],
    open: () => ctx.setOpen(true),
    close: () => ctx.setOpen(false),
    isOpen: () => state.open,
    setMode: m => ctx.setMode(m),
    togglePanel: v => ctx.togglePanel(v),
    toast: (m, err) => ctx.toast(m, err),
    notes: (scope = 'page') => (scope === 'page' ? ctx.pageNotes() : ctx.notes).map(n => ({ ...n })),
    page: () => ctx.page,
    refresh: () => ctx.poll(true),
    render: () => { ctx.renderBar(); ctx.renderPanel(true); },
  };
}

type Queue = { push(...fns: RedlineExtension[]): unknown };

/** Runs the given extensions, the global queue (`window.<ns>Extensions`) and the config's module URLs. */
export function loadExtensions(ctx: Ctx, rl: RedlineApi, ns: string, given: RedlineExtension[] = []) {
  const run = (fn: unknown) => {
    if (typeof fn !== 'function' || ctx.life.ended) return;
    try { Promise.resolve((fn as RedlineExtension)(rl)).catch(err => console.warn('[redline] extension failed:', err)); }
    catch (err) { console.warn('[redline] extension failed:', err); }
  };
  given.forEach(run);
  // Scripts can queue extensions before the overlay loads: (window.redlineExtensions ||= []).push(fn)
  const w = window as unknown as Record<string, Queue | RedlineExtension[] | undefined>;
  const key = `${ns}Extensions`;
  const before = w[key];
  const queued = Array.isArray(before) ? before : [];
  w[key] = { push: (...fns: RedlineExtension[]) => { fns.forEach(run); return fns.length; } };
  // Unmounted: later pushes queue up again for the next mount.
  ctx.life.add(() => { w[key] = []; });
  queued.forEach(run);
  for (const url of ctx.config.extensions ?? []) {
    import(/* @vite-ignore */ url).then(m => run(m.default), err => {
      console.warn(`[redline] couldn't load extension ${url}:`, err);
      ctx.toast(ctx.t('extensionFailed', { url }), true, 5000);
    });
  }
}
