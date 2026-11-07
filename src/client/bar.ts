// The launcher button, the toolbar, the hover highlight, and the panel's footprint.

import type { RedlinePanelState } from '../shared/extension.ts';
import { esc, h, safely } from './dom.ts';
import { ICON, type Mode, type Part } from './context.ts';

export const barPart: Part<'renderBar' | 'renderLauncher' | 'syncPanel' | 'panelState' | 'showHl' | 'hideHl'> = ctx => {
  const { el, ui, config, state } = ctx;

  function renderLauncher() {
    el.launcher.style.display = !state.open && config.launcher ? '' : 'none';
    ctx.placeLauncher();
    el.launcher.querySelector('.badge')?.remove();
    const open = ctx.pageNotes().filter(n => !n.done).length;
    if (open) el.launcher.append(h('span', { class: 'badge' }, String(open)));
  }

  function extButtons(): HTMLElement[] {
    if (!ctx.ext.buttons.length) return [];
    return [h('div', { class: 'sep' }), ...ctx.ext.buttons.map(b => h('button', {
      class: safely(() => b.active?.(), false) ? 'on' : '', 'data-ext': b.id,
      title: (b.title ?? b.label) + (b.key ? ` (${b.key.toUpperCase()})` : ''), onclick: () => safely(() => b.onClick(), undefined),
    }, b.label, b.key ? h('kbd', {}, b.key.toUpperCase()) : null))];
  }

  // Toolbar slots (v3): the extension renders into its own element on every toolbar render.
  function slots(): HTMLElement[] {
    return ctx.ext.slots.map(s => {
      const box = h('div', { class: 'slot', 'data-slot': s.id });
      safely(() => s.render(box), undefined);
      return box;
    });
  }

  function renderBar() {
    el.bar.style.display = state.open && state.mode !== 'sketch' ? '' : 'none';
    if (!state.open) return;
    const { t } = ctx, locked = ctx.locked();
    // No hint line: the buttons show their keys, and the extras live in the tooltips (D18).
    const btn = (m: Mode, label: string, key: string, how: string) =>
      h('button', { class: state.mode === m ? 'on' : '', disabled: locked, title: `${label} (${key}): ${how}`, onclick: () => ctx.setMode(m) }, label, h('kbd', {}, key));
    el.bar.replaceChildren(
      h('div', { class: config.draggable ? 'brand grab' : 'brand', title: config.draggable ? t('dragBar') : undefined, html: ICON + `<span>${esc(t('brand'))}</span>` }),
      h('div', { class: 'sep' }),
      btn('comment', t('comment'), 'C', t('commentHow')),
      btn('text', t('text'), 'T', t('textHow')),
      btn('sketch', t('sketch'), 'S', t('sketchHow')),
      ...extButtons(),
      ...slots(),
      h('div', { class: 'sep' }),
      h('button', { class: state.panel ? 'on' : '', disabled: locked, title: t('notesTitle'), onclick: () => ctx.togglePanel() }, t('notes'), h('span', { class: 'count' }, String(ctx.openCount()))),
      h('button', { title: t('close', { hotkey: config.hotkey }), onclick: () => ctx.setOpen(false) }, '✕'),
    );
    // Astro's dev toolbar also lives bottom-centre; sit above it.
    ui.style.setProperty('--lift', document.querySelector('astro-dev-toolbar') ? '52px' : '0px');
    ctx.placeBar();
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

  return { renderBar, renderLauncher, syncPanel, panelState, showHl, hideHl };
};
