// Extension windows and live indicators (v5, D53). A window floats in the overlay with a header
// (title, the extension's controls, ✕) and a body the extension fills; it moves by its header and
// resizes from its corner, both kept per viewer (`<ns>:win:<id>`), and it stays up while the overlay
// is closed. Indicators (`setStatus`) are dots on the launcher and in the toolbar.

import type { RedlineStatus, RedlineWindow, RedlineWindowDef } from '../shared/extension.ts';
import { h, safely } from './dom.ts';
import type { Part } from './context.ts';

type Saved = { x: number; y: number; w: number; h: number; open: boolean };
const EDGE = 4, MIN_W = 260, MIN_H = 140, HEAD = 34;

export const windowsPart: Part<'addWindow' | 'setStatus' | 'statusDots' | 'toolbarOutline' | 'launcherRing'> = ctx => {
  const { el, store, life } = ctx;
  const wins = new Map<string, { api: RedlineWindow; place(): void }>();

  function addWindow(def: RedlineWindowDef): RedlineWindow {
    wins.get(def.id)?.api.remove();
    const key = `win:${def.id}`;
    let saved: Saved | null = null;
    try { const s = JSON.parse(store.get(key, 'null')); if (s && typeof s.x === 'number') saved = s; } catch { /* default place */ }
    const w0 = Math.min(def.width ?? 560, innerWidth - 2 * EDGE), h0 = Math.min(def.height ?? 380, innerHeight - 2 * EDGE);
    const box: Saved = saved ?? { x: innerWidth - w0 - 16, y: Math.max(EDGE, innerHeight - h0 - 70), w: w0, h: h0, open: false };

    const title = h('span', { class: 'win-title' }, def.title);
    const controls = h('div', { class: 'win-controls' });
    // `hideAs: 'minimize'` (D62): the same hide, drawn as —, for a window whose work goes on hidden (an agent's terminal).
    const minimize = def.hideAs === 'minimize';
    const close = h('button', { class: minimize ? 'win-close win-min' : 'win-close', title: ctx.t(minimize ? 'minimizeWindow' : 'closeWindow'), 'aria-label': ctx.t(minimize ? 'minimizeWindow' : 'closeWindow'), onclick: () => api.hide() }, minimize ? '—' : '✕');
    const head = h('div', { class: 'win-head' }, title, controls, close);
    const body = h('div', { class: 'win-body' });
    const grip = h('div', { class: 'win-grip' });
    const node = h('div', { class: 'win', 'data-win': def.id, style: 'display:none' }, head, body, grip);
    el.windows.append(node);
    let rendered = false;

    const save = () => store.set(key, JSON.stringify(box));
    function place() {
      box.w = Math.max(MIN_W, Math.min(box.w, innerWidth - 2 * EDGE));
      box.h = Math.max(MIN_H, Math.min(box.h, innerHeight - 2 * EDGE));
      box.x = Math.max(EDGE, Math.min(box.x, innerWidth - box.w - EDGE));
      box.y = Math.max(EDGE, Math.min(box.y, innerHeight - box.h - EDGE));
      Object.assign(node.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.w}px`, height: `${box.h}px` });
    }
    const resized = () => def.onResize && safely(() => def.onResize!({ width: body.clientWidth, height: body.clientHeight }), undefined);

    /** Follows the pointer from a press on the header (move) or the grip (resize). */
    function follow(e: PointerEvent, resize: boolean) {
      if (e.button !== 0) return;
      if (!resize && (e.target as Element).closest('button, input, select, a, .win-controls > *')) return;
      const start = { ...box }, sx = e.clientX, sy = e.clientY, target = e.target as Element;
      try { target.setPointerCapture(e.pointerId); } catch { /* released */ }
      node.classList.add('moving');   // the body's iframe (if any) must not swallow the moves
      const move = (m: Event) => {
        const p = m as PointerEvent;
        if (resize) { box.w = start.w + p.clientX - sx; box.h = start.h + p.clientY - sy; }
        else { box.x = start.x + p.clientX - sx; box.y = start.y + p.clientY - sy; }
        place();
      };
      const up = () => {
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        node.classList.remove('moving');
        save();
        if (resize) resized();
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
      e.preventDefault();
    }
    head.addEventListener('pointerdown', e => follow(e, false));
    grip.addEventListener('pointerdown', e => follow(e, true));
    // Bring to front on any press.
    node.addEventListener('pointerdown', () => { if (el.windows.lastElementChild !== node) el.windows.append(node); }, true);

    const api: RedlineWindow = {
      show() {
        if (!rendered) { rendered = true; safely(() => def.render(body, controls), undefined); }
        if (node.style.display !== 'none') return;
        node.style.display = '';
        place();
        box.open = true; save();
        if (def.onShow) safely(() => def.onShow!(), undefined);
        requestAnimationFrame(resized);
        ctx.renderBar();
      },
      hide() {
        if (node.style.display === 'none') return;
        node.style.display = 'none';
        box.open = false; save();
        if (def.onHide) safely(() => def.onHide!(), undefined);
        ctx.renderBar();
      },
      toggle() { if (api.isOpen()) api.hide(); else api.show(); },
      isOpen: () => node.style.display !== 'none',
      setTitle(t) { title.textContent = t; },
      remove() { node.remove(); wins.delete(def.id); },
    };
    wins.set(def.id, { api, place });
    if (box.open) api.show();   // open before a reload: open again
    return api;
  }
  // A smaller viewport: open windows are clamped back into it.
  life.on(window, 'resize', () => { for (const w of wins.values()) if (w.api.isOpen()) w.place(); });

  function setStatus(id: string, status: RedlineStatus | null) {
    if (status && typeof status.color === 'string') ctx.ext.statuses.set(id, status);
    else if (!ctx.ext.statuses.delete(id)) return;
    ctx.renderLauncher(); ctx.renderBar();
    ctx.emit('status', { id, status: status ? { ...status } : null });
  }

  const dotFor = (id: string, s: RedlineStatus, extra = '') =>
    h('span', { class: `dot${s.spin ? ' spin' : s.pulse ? ' pulse' : ''}${extra}`, 'data-status': id, title: s.title ?? id, style: `--dot:${s.color}` });

  /**
   * The indicators shown as dots: `bar` after the toolbar's brand (a click runs onClick), `launcher`
   * on the launcher, each leaving out what shows as the outline or ring, or asked not to show there.
   */
  function statusDots(where: 'bar' | 'launcher'): HTMLElement | null {
    const big = where === 'bar' ? toolbarOutline() : launcherRing();
    const list = [...ctx.ext.statuses].filter(([, s]) => (where === 'bar' ? s.toolbar : s.launcher) !== false && s !== big?.status);
    if (!list.length) return null;
    return h('span', { class: 'dots' }, ...list.map(([id, s]) => {
      const dot = dotFor(id, s);
      if (where === 'launcher') return dot;
      // In the toolbar: a still hit area around the (maybe turning) dot carries the hover text and the click.
      dot.removeAttribute('data-status'); dot.removeAttribute('title');
      const hit = h('span', { class: s.onClick ? 'hit click' : 'hit', 'data-status': id, title: s.title ?? id }, dot);
      if (s.onClick) hit.addEventListener('click', e => { e.stopPropagation(); safely(() => s.onClick!(), undefined); });
      return hit;
    }));
  }

  const first = (pick: (s: RedlineStatus) => boolean) => {
    const hit = [...ctx.ext.statuses].find(([, s]) => pick(s));
    return hit ? { id: hit[0], status: hit[1] } : null;
  };
  /** The status the open toolbar's outline shows, if any. */
  const toolbarOutline = () => first(s => s.toolbar === 'outline');

  /** The launcher's ring: the first status that asks for one. */
  function launcherRing(): { el: HTMLElement; status: RedlineStatus } | null {
    const hit = first(s => s.launcher === 'ring');
    if (!hit) return null;
    const { id, status: s } = hit;
    return { status: s, el: h('span', { class: `ring${s.spin ? ' spin' : s.pulse ? ' pulse' : ''}`, 'data-status': id, title: s.title ?? id, style: `--dot:${s.color}` }) };
  }

  return { addWindow, setStatus, statusDots, toolbarOutline, launcherRing };
};
