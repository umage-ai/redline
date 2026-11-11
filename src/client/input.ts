// Page input while the overlay is open: hovering and picking an element (comment/text mode),
// the keyboard shortcuts, and the page's own open buttons (`data-redline-open`, D51). The app
// never sees a pick (picks happen on pointerup, L3).

import { labelFor, textBlockFor } from './anchor.ts';
import { isTyping, matchHotkey, safely } from './dom.ts';
import type { Ctx } from './context.ts';

export function installInput(ctx: Ctx) {
  const { state, life, el } = ctx;
  const fromUs = (e: Event) => e.composedPath().includes(ctx.host);
  // Comment, text, and extension modes (v4) pick an element; sketch draws instead.
  const picking = () => state.open && (state.mode === 'comment' || state.mode === 'text' || !!ctx.extMode()) && !ctx.busy;

  // The page's own buttons: `<button data-redline-open>` toggles the overlay; the value picks what
  // ("open", "close", "comment", "text", "sketch", "notes"). The attribute follows the namespace.
  const attr = `data-${ctx.ns}-open`;
  const trigger = (e: Event) => e.composedPath().find((n): n is Element => n instanceof Element && n.hasAttribute(attr));
  let tookPress = false;   // a press used while picking: the click after it is not a second one
  let eatClick = false;    // a pick that ended picking (an extension mode): its click must not reach the app
  function runTrigger(t: Element) {
    const v = (t.getAttribute(attr) ?? '').trim().toLowerCase();
    if (v === 'comment' || v === 'text' || v === 'sketch') ctx.setMode(v);
    else if (v === 'notes') { if (!state.open) ctx.setOpen(true); ctx.togglePanel(); }
    else if (v === 'open' || v === 'close') ctx.setOpen(v === 'open');
    else ctx.setOpen(!state.open);
  }
  life.on(window, 'pointerdown', () => { tookPress = false; eatClick = false; }, true);
  life.on(window, 'click', e => {
    if (eatClick) { eatClick = false; if (e.cancelable) e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (tookPress) { tookPress = false; return; }
    if (picking() || fromUs(e)) return;
    const t = trigger(e);
    if (t) runTrigger(t);
  }, true);

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
      if (type !== 'pointerup' || (e as PointerEvent).button !== 0) return;
      const t = trigger(e);
      if (t) { tookPress = true; runTrigger(t); } else onPick(e as MouseEvent);
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
    const ext = ctx.extMode();
    if (ext) {
      // An extension's pick (v4): handed over, and the mode ends unless it stays.
      ctx.hideHl();
      if (!ext.stay) { eatClick = true; ctx.setMode('idle'); }
      safely(() => ext.onPick({ el: whole ? null : t, whole, x: e.clientX, y: e.clientY }), undefined);
      return;
    }
    ctx.openDraft({ type: 'comment', el: whole ? null : t, whole, x: e.clientX, y: e.clientY });
  }

  life.on(window, 'keydown', ev => onKey(ctx, ev as KeyboardEvent), true);
}

/** Built-in single keys; an extension button can't take these. */
export const BUILTIN_KEYS = ['c', 't', 's', 'k', 'n', 'escape'];

function onKey(ctx: Ctx, e: KeyboardEvent) {
  const { state } = ctx;
  if (matchHotkey(e, ctx.config.hotkey)) { e.preventDefault(); e.stopImmediatePropagation(); ctx.setOpen(!state.open); return; }
  // An extension toolbar's own shortcut (v5): opens the overlay in it; pressed there, closes the overlay.
  const tb = ctx.ext.toolbars.find(x => x.hotkey && matchHotkey(e, x.hotkey));
  if (tb) {
    e.preventDefault(); e.stopImmediatePropagation();
    if (state.open && ctx.extToolbar() === tb) ctx.setOpen(false); else ctx.setToolbar(tb.id);
    return;
  }
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
    const m = ctx.ext.modes.find(x => x.key?.toLowerCase() === k);
    const b = m ? null : ctx.ext.buttons.find(x => x.key?.toLowerCase() === k);
    if (m) ctx.setMode(`ext:${m.id}`);
    else if (b) safely(() => b.onClick(), undefined);
    else return;
  }
  e.preventDefault(); e.stopImmediatePropagation();
}

/** Esc steps back one level: draft, mode, extension toolbar (its own popover first), panel, overlay. */
function escape(ctx: Ctx) {
  const tb = ctx.extToolbar();
  if (ctx.draft) ctx.cancelDraft();
  else if (ctx.state.mode !== 'idle') ctx.setMode('idle');
  else if (tb) { if (!safely(() => tb.onEscape?.() === true, false)) ctx.setToolbar(null); }
  else if (ctx.state.panel) ctx.togglePanel(false);
  else ctx.setOpen(false);
}
