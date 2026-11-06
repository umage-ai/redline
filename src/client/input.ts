// Page input while the overlay is open: hovering and picking an element (comment/text mode),
// and the keyboard shortcuts. The app never sees a pick (picks happen on pointerup, L3).

import { labelFor, textBlockFor } from './anchor.ts';
import { isTyping, matchHotkey, safely } from './dom.ts';
import type { Ctx } from './context.ts';

export function installInput(ctx: Ctx) {
  const { state, life, el } = ctx;
  const fromUs = (e: Event) => e.composedPath().includes(ctx.host);
  const picking = () => state.open && (state.mode === 'comment' || state.mode === 'text') && !ctx.busy;

  life.on(window, 'pointermove', ev => {
    const e = ev as PointerEvent;
    if (!picking() || ctx.draft || fromUs(e)) { if (picking() && !ctx.draft) ctx.hideHl(); return; }
    let t = e.target as Element | null;
    if (!(t instanceof Element)) return;
    if (state.mode === 'text') { t = textBlockFor(t); if (!t) { ctx.hideHl(); return; } ctx.showHl(t, '✎ ' + labelFor(t), 'text'); return; }
    if (e.altKey && t.parentElement && t.parentElement !== document.documentElement) t = t.parentElement;
    if (e.shiftKey) { ctx.hideHl(); el.hlLabel.textContent = ctx.t('wholePage'); Object.assign(el.hlLabel.style, { display: '', left: `${e.clientX + 12}px`, top: `${e.clientY + 12}px` }); return; }
    ctx.showHl(t, labelFor(t));
  }, true);

  // Swallow pointer input while picking so the app never sees the click. Picks happen on
  // pointerup, not click: browsers don't fire click on disabled buttons and inputs.
  // touchstart/touchmove are hidden from the app but not cancelled, so a finger can still
  // scroll; a scroll fires pointercancel, so only a tap reaches pointerup (L15).
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend', 'submit']) {
    const scrolls = type === 'touchstart' || type === 'touchmove';
    life.on(window, type, e => {
      if (!picking() || fromUs(e)) return;
      if (!scrolls && e.cancelable) e.preventDefault();
      e.stopImmediatePropagation();
      if (type === 'pointerup' && (e as PointerEvent).button === 0) onPick(e as MouseEvent);
    }, { capture: true, passive: scrolls });
  }
  life.on(window, 'pointercancel', () => { if (picking() && !ctx.draft) ctx.hideHl(); }, true);

  /** A tap while a draft is open: finishes a text edit, nudges a started note, else drops the draft. True when the tap is used up. */
  function tapWithDraft(): boolean {
    const d = ctx.draft!;
    // The page's pointerdown is cancelled, so the editor never blurs by itself (and phones have no Enter-to-confirm habit).
    if (d.editor?.isContentEditable) { d.editor.blur(); return true; }
    const ta = el.popLayer.querySelector('textarea');
    if (d.editor || (ta && ta.value.trim())) {
      el.popLayer.querySelector('.pop')?.animate([{ transform: 'translateX(-4px)' }, { transform: 'translateX(4px)' }, { transform: 'none' }], 160);
      return true;
    }
    ctx.cancelDraft();
    return false;
  }

  function onPick(e: MouseEvent) {
    if (ctx.draft && tapWithDraft()) return;
    let t = e.target as Element;
    if (state.mode === 'text') {
      const block = textBlockFor(t);
      if (block) void ctx.startTextEdit(block);
      return;
    }
    if (e.altKey && t.parentElement && t.parentElement !== document.documentElement) t = t.parentElement;
    const whole = e.shiftKey || t === document.body || t === document.documentElement;
    ctx.openDraft({ type: 'comment', el: whole ? null : t, whole, x: e.clientX, y: e.clientY });
  }

  life.on(window, 'keydown', ev => onKey(ctx, ev as KeyboardEvent), true);
}

/** Built-in single keys; an extension button can't take these. */
export const BUILTIN_KEYS = ['c', 't', 's', 'k', 'n', 'escape'];

function onKey(ctx: Ctx, e: KeyboardEvent) {
  const { state } = ctx;
  if (matchHotkey(e, ctx.config.hotkey)) { e.preventDefault(); e.stopImmediatePropagation(); ctx.setOpen(!state.open); return; }
  if (!state.open || e.ctrlKey && e.key !== 'z' || e.metaKey || e.altKey) return;
  if (ctx.sketchKey(e)) return;
  if (isTyping(e, ctx.shadow) || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape') escape(ctx);
  else if (k === 'c') ctx.setMode('comment');
  else if (k === 't') ctx.setMode('text');
  else if (k === 's' || k === 'k') ctx.setMode('sketch');
  else if (k === 'n') ctx.togglePanel();
  else {
    const b = ctx.ext.buttons.find(x => x.key?.toLowerCase() === k);
    if (!b) return;
    safely(() => b.onClick(), undefined);
  }
  e.preventDefault(); e.stopImmediatePropagation();
}

/** Esc steps back one level: draft, mode, panel, overlay. */
function escape(ctx: Ctx) {
  if (ctx.draft) ctx.cancelDraft();
  else if (ctx.state.mode !== 'idle') ctx.setMode('idle');
  else if (ctx.state.panel) ctx.togglePanel(false);
  else ctx.setOpen(false);
}
