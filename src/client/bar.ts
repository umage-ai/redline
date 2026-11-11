// The launcher button, the toolbar, the hover highlight, and the panel's footprint.

import type { RedlinePanelState } from '../shared/extension.ts';
import { esc, h, safely } from './dom.ts';
import { ICON, type Mode, type Part } from './context.ts';

export const barPart: Part<'renderBar' | 'renderLauncher' | 'syncPanel' | 'panelState' | 'showHl' | 'hideHl' | 'extToolbar' | 'setToolbar' | 'placeAttached'> = ctx => {
  const { el, ui, config, state } = ctx;
  // An extension toolbar's attached card (v5): next to the toolbar, above it in the lower half.
  const card = h('div', { class: 'attach', style: 'display:none' });
  ui.append(card);
  ctx.life.on(window, 'resize', () => placeAttached());
  // The toolbar changes size without a render too (it wraps when the notes panel opens beside it): the
  // card follows, or it would cover the toolbar's top row (L59).
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(() => placeAttached());
    ro.observe(el.bar);
    ctx.life.add(() => ro.disconnect());
  }

  function renderLauncher() {
    el.launcher.style.display = !state.open && config.launcher ? '' : 'none';
    ctx.placeLauncher();
    for (const c of el.launcher.querySelectorAll('.badge, .dots, .ring')) c.remove();
    // The bubble (v5: an extension's text, or none); by default the open notes on this page.
    const open = ctx.pageNotes().filter(n => !n.done).length;
    const fn = ctx.ext.badge;
    const text = fn === false ? '' : fn ? safely(() => fn(open), null) : open || '';
    if (text !== null && text !== undefined && text !== '') el.launcher.append(h('span', { class: 'badge' }, String(text).slice(0, 4)));
    // Extension indicators (v5): one as a ring around the button (the agent working), the rest as dots.
    const ring = ctx.launcherRing();
    el.launcher.classList.toggle('lit', !!ring);
    if (ring) el.launcher.append(ring.el);
    const dots = ctx.statusDots('launcher');
    if (dots) el.launcher.append(dots);
  }

  function extButtons(): HTMLElement[] {
    if (!ctx.ext.buttons.length) return [];
    return [h('div', { class: 'sep' }), ...ctx.ext.buttons.map(b => h('button', {
      class: safely(() => b.active?.(), false) ? 'on' : '', 'data-ext': b.id,
      title: (b.title ?? b.label) + (b.key ? ` (${b.key.toUpperCase()})` : ''), onclick: () => safely(() => b.onClick(), undefined),
    }, b.label, b.key ? h('kbd', {}, b.key.toUpperCase()) : null))];
  }

  // Extension pick modes (v4): highlighted like the built-in modes while on.
  function extModes(): HTMLElement[] {
    const locked = ctx.locked();
    return ctx.ext.modes.map(m => {
      const key = m.key?.toUpperCase();
      return h('button', { class: state.mode === `ext:${m.id}` ? 'on' : '', 'data-mode': m.id, disabled: locked,
        title: (m.title ?? m.label) + (key ? ` (${key})` : ''), onclick: () => ctx.setMode(`ext:${m.id}`) }, m.label, key ? h('kbd', {}, key) : null);
    });
  }

  // Toolbar slots (v3): the extension renders into its own element on every toolbar render.
  function slots(): HTMLElement[] {
    return ctx.ext.slots.map(s => {
      const box = h('div', { class: 'slot', 'data-slot': s.id });
      safely(() => s.render(box), undefined);
      return box;
    });
  }

  /** The extension toolbar on screen (v5): the one in state, once its extension has added it; none behind a gate. */
  const extToolbar = () => state.toolbar && !ctx.locked() ? ctx.ext.toolbars.find(x => x.id === state.toolbar) : undefined;

  function setToolbar(id: string | null) {
    if (id && !ctx.ext.toolbars.some(x => x.id === id)) return;
    if (id && ctx.locked()) { if (!state.open) ctx.setOpen(true); return; }
    if (id && state.mode !== 'idle') ctx.setMode('idle');
    if (id && !state.open) { state.open = true; ctx.releaseTextFocus(); ctx.emit('open'); }
    const before = extToolbar();
    state.toolbar = id;
    const after = extToolbar();
    if (before !== after) {
      if (before?.onHide) safely(() => before.onHide!(), undefined);
      if (after?.onShow) safely(() => after.onShow!(), undefined);
    }
    ctx.persist(); ctx.renderAll();
  }

  function renderBar() {
    el.bar.style.display = state.open && state.mode !== 'sketch' ? '' : 'none';
    if (!state.open || state.mode === 'sketch') card.style.display = 'none';
    if (!state.open) return;
    const { t } = ctx, locked = ctx.locked();
    const brand = h('div', { class: config.draggable ? 'brand grab' : 'brand', title: config.draggable ? t('dragBar') : undefined, html: ICON + `<span>${esc(t('brand'))}</span>` });
    const dots = [ctx.statusDots('bar')].filter((d): d is HTMLElement => !!d);
    const tb = extToolbar();
    el.bar.classList.toggle('ext', !!tb);
    if (tb) {
      // An extension's toolbar in place of the main one: icon, back, its element, close (D53). ✕ closes
      // the overlay as on the main toolbar; ← (or Esc) goes back to the main one. With a `title` (D62)
      // the icon stands alone and the back button names the toolbar: "← Agent".
      const box = h('div', { class: 'xbar', 'data-toolbar': tb.id });
      safely(() => tb.render(box), undefined);
      const title = typeof tb.title === 'string' && tb.title ? tb.title : '';
      if (title) { brand.querySelector('span')?.remove(); brand.classList.add('icon'); }
      const back = h('button', { class: title ? 'back named' : 'back', title: tb.backTitle ?? t('backToToolbar'), onclick: () => setToolbar(null) },
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '←'), title ? h('span', {}, title) : null);
      back.setAttribute('aria-label', title ? `${title}: ${tb.backTitle ?? t('backToToolbar')}` : tb.backTitle ?? t('backToToolbar'));
      el.bar.replaceChildren(brand, ...dots, back,
        h('div', { class: 'sep' }), box, h('div', { class: 'sep' }),
        h('button', { class: 'close', title: t('close', { hotkey: config.hotkey }), 'aria-label': t('close', { hotkey: config.hotkey }), onclick: () => ctx.setOpen(false) }, '✕'));
      renderAttached(tb);
    } else { card.style.display = 'none'; renderMain(brand, dots, locked); }
    // An extension status as the toolbar's outline (v5): a light sweeping round it (busy), a glow, or steady.
    const lit = ctx.toolbarOutline();
    el.bar.classList.toggle('lit', !!lit);
    el.bar.classList.toggle('spin', !!lit?.status.spin);
    el.bar.classList.toggle('pulse', !!lit && !lit.status.spin && !!lit.status.pulse);
    if (lit) { el.bar.style.setProperty('--dot', lit.status.color); el.bar.title = lit.status.title ?? lit.id; el.bar.dataset.status = lit.id; }
    else { el.bar.style.removeProperty('--dot'); el.bar.removeAttribute('title'); delete el.bar.dataset.status; }
    // Astro's dev toolbar also lives bottom-centre; sit above it.
    ui.style.setProperty('--lift', document.querySelector('astro-dev-toolbar') ? '52px' : '0px');
    ctx.placeBar();
    card.classList.toggle('lit', !!lit);
    if (lit) card.style.setProperty('--dot', lit.status.color);
    placeAttached();
  }

  function renderAttached(tb: NonNullable<ReturnType<typeof extToolbar>>) {
    // Not while a field in it has focus (an answer being typed): the toolbar re-renders on every poll.
    const a = ctx.shadow.activeElement;
    // A select too: redrawn, its open list would close under the pointer.
    const typing = !!a && card.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName);
    if (!typing) {
      card.replaceChildren();
      if (tb.attached) safely(() => tb.attached!(card), undefined);
      card.dataset.toolbar = tb.id;
    }
    card.style.display = card.childNodes.length ? '' : 'none';
  }

  /** Above the toolbar while it sits in the lower half of the window, below it otherwise; centred on it, kept on screen. */
  function placeAttached() {
    if (card.style.display === 'none' || el.bar.style.display === 'none') return;
    const r = el.bar.getBoundingClientRect(), s = card.style, GAP = 8, EDGE = 8;
    s.minWidth = `${Math.min(Math.round(r.width), innerWidth - 2 * EDGE)}px`;
    const w = card.offsetWidth;
    s.left = `${Math.round(Math.max(EDGE, Math.min(r.left + r.width / 2 - w / 2, innerWidth - w - EDGE)))}px`;
    if (r.top + r.height / 2 > innerHeight / 2) {
      s.top = 'auto'; s.bottom = `${Math.round(innerHeight - r.top + GAP)}px`; s.maxHeight = `${Math.round(r.top - GAP - EDGE)}px`;
      card.classList.add('above'); card.classList.remove('below');
    } else {
      s.bottom = 'auto'; s.top = `${Math.round(r.bottom + GAP)}px`; s.maxHeight = `${Math.round(innerHeight - r.bottom - GAP - EDGE)}px`;
      card.classList.add('below'); card.classList.remove('above');
    }
  }

  function renderMain(brand: HTMLElement, dots: HTMLElement[], locked: boolean) {
    const { t } = ctx;
    // No hint line: the buttons show their keys, and the extras live in the tooltips (D18).
    const btn = (m: Mode, label: string, key: string, how: string) =>
      h('button', { class: state.mode === m ? 'on' : '', disabled: locked, title: `${label} (${key}): ${how}`, onclick: () => ctx.setMode(m) }, label, h('kbd', {}, key));
    el.bar.replaceChildren(
      brand,
      ...dots,
      h('div', { class: 'sep' }),
      btn('comment', t('comment'), 'C', t('commentHow')),
      btn('text', t('text'), 'T', t('textHow')),
      btn('sketch', t('sketch'), 'S', t('sketchHow')),
      ...extModes(),
      ...extButtons(),
      ...slots(),
      h('div', { class: 'sep' }),
      h('button', { class: state.panel ? 'on' : '', disabled: locked, title: t('notesTitle'), onclick: () => ctx.togglePanel() }, t('notes'), h('span', { class: 'count' }, String(ctx.openCount()))),
      h('button', { title: t('close', { hotkey: config.hotkey }), onclick: () => ctx.setOpen(false) }, '✕'),
    );
  }

  // The panel's footprint: the bar and toasts move left of it, and extensions hear about it
  // (a host page can lay itself out beside the panel).
  let panelSeen: RedlinePanelState = { open: false, width: 0 };
  function panelState(): RedlinePanelState {
    const open = state.open && state.panel;
    return { open, width: open ? Math.round(el.panel.getBoundingClientRect().width) : 0 };
  }
  function syncPanel() {
    const s = panelState();
    // A panel that fills (nearly) the whole width, as on phones, leaves nothing to move beside.
    ui.style.setProperty('--panel-w', s.open && s.width < innerWidth - 240 ? `${s.width}px` : '0px');
    if (s.open !== panelSeen.open || s.width !== panelSeen.width) { panelSeen = s; ctx.emit('panel', { ...s }); }
  }

  function showHl(target: Element, label: string | null, cls = '') {
    const r = target.getBoundingClientRect();
    Object.assign(el.hl.style, { display: '', left: `${r.x - 2}px`, top: `${r.y - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });
    el.hl.className = 'hl ' + cls;
    if (!label) { el.hlLabel.style.display = 'none'; return; }
    el.hlLabel.textContent = label;
    el.hlLabel.style.display = '';
    const above = r.y > 26;
    el.hlLabel.style.left = `${Math.max(4, Math.min(r.x - 2, innerWidth - 300))}px`;
    el.hlLabel.style.top = above ? `${r.y - 24}px` : `${r.bottom + 4}px`;
  }
  function hideHl() { el.hl.style.display = 'none'; el.hlLabel.style.display = 'none'; }

  return { renderBar, renderLauncher, syncPanel, panelState, showHl, hideHl, extToolbar, setToolbar, placeAttached };
};
