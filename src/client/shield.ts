// The shield: the app never notices the overlay (D14, L17).
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

import { Life } from './dom.ts';

const BUBBLE_CUT = ['pointerdown', 'pointerup', 'pointermove', 'pointerover', 'pointerout', 'pointercancel', 'mousedown', 'mouseup',
  'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'auxclick', 'contextmenu', 'touchstart', 'touchmove', 'touchend',
  'wheel', 'focusin', 'focusout', 'input', 'change', 'keydown', 'keyup', 'keypress', 'beforeinput', 'paste', 'copy', 'cut'];
const CAPTURE_CUT = ['mousedown', 'mouseup', 'touchstart', 'touchend', 'focusin', 'focusout', 'pointerover', 'pointerout', 'mouseover', 'mouseout', 'keyup', 'keypress'];
const CAPTURE_COPY = ['pointerdown', 'pointerup', 'keydown'];   // the overlay itself listens to these
const LEAVING = ['blur', 'focusout', 'pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
const INIT = ['bubbles', 'cancelable', 'clientX', 'clientY', 'screenX', 'screenY', 'button', 'buttons', 'altKey', 'ctrlKey', 'shiftKey',
  'metaKey', 'pointerId', 'pointerType', 'isPrimary', 'width', 'height', 'pressure', 'key', 'code', 'location', 'repeat', 'isComposing', 'detail'];

const copies = new WeakSet<Event>();

/**
 * Where the event really went. Seen from window, a closed shadow root's nodes are hidden: the
 * path starts at the host. Then the shadow root tells: the focused field for keys, the element
 * under the pointer otherwise.
 */
function innerTarget(e: Event, host: HTMLElement, shadow?: ShadowRoot): EventTarget | null {
  const first = e.composedPath()[0];
  if (first !== host) return first;
  if (!shadow) return null;
  if (e instanceof KeyboardEvent) return shadow.activeElement;
  return e instanceof MouseEvent ? shadow.elementFromPoint(e.clientX, e.clientY) : null;
}

function redispatch(e: Event, host: HTMLElement, shadow?: ShadowRoot) {
  const to = innerTarget(e, host, shadow);
  if (!to || to === host) return;
  const init: Record<string, unknown> = { composed: false };
  for (const k of INIT) if (k in e) init[k] = (e as unknown as Record<string, unknown>)[k];
  const copy = new (e.constructor as typeof Event)(e.type, init);
  copies.add(copy);
  to.dispatchEvent(copy);
  if (copy.defaultPrevented) e.preventDefault();
}

export interface Shield {
  /** Runs `fn` (a blur) without the app hearing about the focus leaving. */
  quietly(fn: () => void): void;
}

/** Shields the app from events on `host` (pass its shadow root when closed). Listeners are released with `life`. */
export function shieldApp(host: HTMLElement, life = new Life(), shadow?: ShadowRoot): Shield {
  let quietBlur = false;
  for (const t of BUBBLE_CUT) life.on(host, t, e => e.stopPropagation());
  let pressedAt = 0;
  const ours = (e: Event) => e.composedPath().includes(host);
  for (const t of [...CAPTURE_CUT, ...CAPTURE_COPY]) {
    life.on(window, t, e => {
      if (!ours(e) || copies.has(e)) return;
      if (t === 'pointerdown' || t === 'mousedown') pressedAt = Date.now();
      e.stopPropagation();   // not Immediate: the overlay's own window listeners still run
      if (CAPTURE_COPY.includes(t)) redispatch(e, host, shadow);
    }, true);
  }
  for (const t of LEAVING) {
    life.on(window, t, e => {
      if (ours(e)) return;   // the overlay's own editors still need their blur
      const to = (e as FocusEvent | MouseEvent).relatedTarget;
      // Pressing a non-focusable part of the overlay moves focus to <body> (relatedTarget null).
      if (to === host || quietBlur || (to === null && t !== 'mouseout' && t !== 'pointerout' && Date.now() - pressedAt < 400)) e.stopPropagation();
    }, true);
  }
  return { quietly(fn) { quietBlur = true; try { fn(); } finally { quietBlur = false; } } };
}
