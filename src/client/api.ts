// The extension API (D21) a mounted overlay hands to extensions and to mount()'s caller, and
// the loading of extensions: mount options, the `<ns>Extensions` queue, and config URLs.

import type { RedlineApi, RedlineEvents, RedlineExtension, RedlinePageKey } from '../shared/extension.ts';
import type { Ctx } from './context.ts';
import { BUILTIN_KEYS } from './input.ts';

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

export function createApi(ctx: Ctx, on: (e: string, fn: Listener) => () => void, setPageKey: (fn: RedlinePageKey | null) => void): RedlineApi {
  const { ext, state } = ctx;
  return {
    version: 3,
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
    on: (e, fn) => on(e, fn as Listener),
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
