// Moving the launcher, the toolbar and the sketch tools (the `draggable` option, D51). The
// launcher drags as a whole; the toolbar and the sketch tools by their icon on the left. Where
// they were left is kept per viewer (`<ns>:pos:launcher|bar|tools`); double-clicking an icon puts
// all of them back. A bar that spans (nearly) the whole width, as on phones, moves only up and
// down. The gate and toasts sit next to a moved toolbar instead of at the bottom centre.

import type { Part } from './context.ts';

/** Top-left corner in px; `x: null` keeps the stylesheet's horizontal layout (vertical-only). */
type Pos = { x: number | null; y: number };
type Which = 'launcher' | 'bar' | 'tools';
const ALL: Which[] = ['launcher', 'bar', 'tools'];

const THRESHOLD = 4;   // px before a press on the launcher counts as a drag, not a click
const EDGE = 4;        // px kept between the viewport edge and a dragged element
const GAP = 10;        // px between a moved toolbar and the gate or toast next to it

export const dragPart: Part<'placeLauncher' | 'placeBar' | 'placeTools' | 'placeNearBar'> = ctx => {
  const { el, config, store, life, ui } = ctx;
  if (!config.draggable) return { placeLauncher() {}, placeBar() {}, placeTools() {}, placeNearBar() {} };

  const load = (k: Which): Pos | null => {
    try {
      const p = JSON.parse(store.get(`pos:${k}`, 'null'));
      return p && typeof p.y === 'number' && (p.x === null || typeof p.x === 'number') ? { x: p.x, y: p.y } : null;
    } catch { return null; }
  };
  const pos = Object.fromEntries(ALL.map(k => [k, load(k)])) as Record<Which, Pos | null>;
  const save = (k: Which) => store.set(`pos:${k}`, JSON.stringify(pos[k]));
  const nodeOf = (k: Which): HTMLElement | null => k === 'tools' ? ui.querySelector<HTMLElement>('.tools') : el[k];

  /** A bar that fills (nearly) the width: only vertical moves make sense. */
  const wide = (k: Which, node: HTMLElement) => k !== 'launcher' && (innerWidth <= 560 || node.offsetWidth >= innerWidth - 48);
  const clampX = (x: number, w: number) => Math.round(Math.max(EDGE, Math.min(x, innerWidth - w - EDGE)));
  const clampY = (y: number, hgt: number) => Math.round(Math.max(EDGE, Math.min(y, innerHeight - hgt - EDGE)));

  function place(k: Which) {
    const node = nodeOf(k), p = pos[k];
    if (!node) return;
    const s = node.style;
    if (!p) s.left = s.top = s.right = s.bottom = s.margin = s.transform = '';
    else {
      s.top = `${clampY(p.y, node.offsetHeight)}px`;
      s.bottom = 'auto';
      if (p.x !== null && !wide(k, node)) { s.left = `${clampX(p.x, node.offsetWidth)}px`; s.right = 'auto'; s.margin = '0'; s.transform = 'none'; }
      else s.left = s.right = s.margin = s.transform = '';
    }
    if (k === 'bar') { follow(el.gate); follow(el.toast); }
  }

  /** The gate or a toast: next to a moved, visible toolbar (above it in the lower half, else below). */
  function follow(node: HTMLElement) {
    const s = node.style;
    if (!pos.bar || el.bar.style.display === 'none' || node.style.display === 'none') { s.left = s.top = s.bottom = s.transform = ''; return; }
    const r = el.bar.getBoundingClientRect(), w = node.offsetWidth;
    s.transform = 'none';
    s.left = `${clampX(r.left + r.width / 2 - w / 2, w)}px`;
    if (r.top > innerHeight / 2) { s.top = 'auto'; s.bottom = `${Math.round(innerHeight - r.top + GAP)}px`; }
    else { s.bottom = 'auto'; s.top = `${Math.round(r.bottom + GAP)}px`; }
  }

  /** Follows the pointer from `e` on; `onDone(moved)` when it lets go. */
  function drag(e: PointerEvent, k: Which, onDone?: (moved: boolean) => void) {
    const node = nodeOf(k);
    if (e.button !== 0 || !node) return;
    const r = node.getBoundingClientRect(), vertical = wide(k, node);
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
    e.stopPropagation();  // not a stroke on the sketch layer
  }

  // The launcher: a press that moves is a drag, and the click that follows it doesn't open.
  el.launcher.classList.add('grab');
  life.on(el.launcher, 'pointerdown', e => drag(e as PointerEvent, 'launcher', moved => {
    if (!moved) return;
    const eat = (c: Event) => { c.stopImmediatePropagation(); c.preventDefault(); };
    el.launcher.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => el.launcher.removeEventListener('click', eat, { capture: true }), 400);
  }));
  // The toolbar and the sketch tools are rebuilt on every render: listen above them for the handle.
  const handleOf = (e: Event): Which | null => {
    const brand = (e.target as Element | null)?.closest?.('.brand');
    return !brand ? null : brand.closest('.bar') ? 'bar' : brand.closest('.tools') ? 'tools' : null;
  };
  life.on(ui, 'pointerdown', e => { const k = handleOf(e); if (k) drag(e as PointerEvent, k); });
  life.on(ui, 'dblclick', e => {
    if (!handleOf(e)) return;
    for (const k of ALL) { pos[k] = null; store.set(`pos:${k}`, 'null'); place(k); }
  });
  life.on(window, 'resize', () => ALL.forEach(place));

  return {
    placeLauncher: () => place('launcher'),
    placeBar: () => place('bar'),
    placeTools: () => place('tools'),
    placeNearBar: (node: HTMLElement) => follow(node),
  };
};
