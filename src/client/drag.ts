// Moving the launcher and the toolbar (the `draggable` option, D51). The launcher drags as a
// whole; the toolbar by its icon on the left. Where they were left is kept per viewer
// (`<ns>:pos:launcher`, `<ns>:pos:bar`); double-clicking the toolbar's icon puts both back.
// A toolbar that spans (nearly) the whole width, as on phones, moves only up and down.

import type { Part } from './context.ts';

/** Top-left corner in px; `x: null` keeps the stylesheet's horizontal layout (vertical-only). */
type Pos = { x: number | null; y: number };
type Which = 'launcher' | 'bar';

const THRESHOLD = 4;   // px before a press on the launcher counts as a drag, not a click
const EDGE = 4;        // px kept between the viewport edge and the dragged element

export const dragPart: Part<'placeLauncher' | 'placeBar'> = ctx => {
  const { el, config, store, life } = ctx;
  if (!config.draggable) return { placeLauncher() {}, placeBar() {} };

  const load = (k: Which): Pos | null => {
    try {
      const p = JSON.parse(store.get(`pos:${k}`, 'null'));
      return p && typeof p.y === 'number' && (p.x === null || typeof p.x === 'number') ? { x: p.x, y: p.y } : null;
    } catch { return null; }
  };
  const pos: Record<Which, Pos | null> = { launcher: load('launcher'), bar: load('bar') };
  const save = (k: Which) => store.set(`pos:${k}`, JSON.stringify(pos[k]));

  /** The toolbar fills (nearly) the width: only vertical moves make sense. */
  const wide = () => innerWidth <= 560 || el.bar.offsetWidth >= innerWidth - 48;
  const clampX = (x: number, w: number) => Math.round(Math.max(EDGE, Math.min(x, innerWidth - w - EDGE)));
  const clampY = (y: number, hgt: number) => Math.round(Math.max(EDGE, Math.min(y, innerHeight - hgt - EDGE)));

  function place(k: Which) {
    const node = el[k], p = pos[k], s = node.style;
    if (!p) { s.left = s.top = s.right = s.bottom = s.margin = ''; return; }
    const horizontal = p.x !== null && !(k === 'bar' && wide());
    s.top = `${clampY(p.y, node.offsetHeight)}px`;
    s.bottom = 'auto';
    if (horizontal) { s.left = `${clampX(p.x!, node.offsetWidth)}px`; s.right = 'auto'; s.margin = '0'; }
    else { s.left = s.right = s.margin = ''; }
  }

  /** Follows the pointer from `e` on; `onDone(moved)` when it lets go. */
  function drag(e: PointerEvent, k: Which, onDone?: (moved: boolean) => void) {
    if (e.button !== 0) return;
    const node = el[k], r = node.getBoundingClientRect(), vertical = k === 'bar' && wide();
    const sx = e.clientX, sy = e.clientY;
    let moved = false;
    const target = e.target as Element;
    try { target.setPointerCapture(e.pointerId); } catch { /* already released */ }
    const move = (m: Event) => {
      const pe = m as PointerEvent, dx = pe.clientX - sx, dy = pe.clientY - sy;
      if (!moved && Math.hypot(dx, dy) < THRESHOLD) return;
      if (!moved) { moved = true; node.classList.add('dragging'); }
      pos[k] = { x: vertical ? null : r.left + dx, y: r.top + dy };
      place(k);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      node.classList.remove('dragging');
      if (moved) save(k);
      onDone?.(moved);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
    e.preventDefault();   // no text selection, no scroll start
  }

  // The launcher: a press that moves is a drag, and the click that follows it doesn't open.
  el.launcher.classList.add('grab');
  life.on(el.launcher, 'pointerdown', e => drag(e as PointerEvent, 'launcher', moved => {
    if (!moved) return;
    const eat = (c: Event) => { c.stopImmediatePropagation(); c.preventDefault(); };
    el.launcher.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => el.launcher.removeEventListener('click', eat, { capture: true }), 400);
  }));
  // The toolbar is rebuilt on every render, so listen on it and look for the handle.
  const handle = (e: Event) => (e.target as Element | null)?.closest?.('.brand');
  life.on(el.bar, 'pointerdown', e => { if (handle(e)) drag(e as PointerEvent, 'bar'); });
  life.on(el.bar, 'dblclick', e => {
    if (!handle(e)) return;
    pos.launcher = pos.bar = null;
    store.set('pos:launcher', 'null'); store.set('pos:bar', 'null');
    place('launcher'); place('bar');
  });
  life.on(window, 'resize', () => { place('launcher'); place('bar'); });

  return { placeLauncher: () => place('launcher'), placeBar: () => place('bar') };
};
