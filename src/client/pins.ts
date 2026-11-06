// Numbered pins on the elements notes point at, and their hover tooltip.

import type { Note } from '../shared/types.ts';
import { clip, resolve } from './anchor.ts';
import { esc, h } from './dom.ts';
import type { Part } from './context.ts';

export const pinsPart: Part<'renderPins' | 'targetOf'> = ctx => {
  const { el, state, config } = ctx;
  const pinEls = new Map<string, HTMLElement>();
  // Resolving a target is a few DOM queries: cached briefly, re-done once the element is gone.
  const resolved = new Map<string, { el: Element | null; at: number }>();
  let resolvedFor = ctx.page;   // a new page key (route change) starts a fresh cache

  function targetOf(n: Note) {
    if (resolvedFor !== ctx.page) { resolved.clear(); resolvedFor = ctx.page; }
    const c = resolved.get(n.id);
    if (c && (c.el ? c.el.isConnected : true) && Date.now() - c.at < 1500) return c.el;
    const found = n.target ? resolve(n.target) : null;
    resolved.set(n.id, { el: found, at: Date.now() });
    return found;
  }

  function pinFor(n: Note): HTMLElement {
    let pin = pinEls.get(n.id);
    if (pin) return pin;
    pin = h('div', { class: 'pin' });
    pin.addEventListener('mouseenter', () => onPinHover(n.id, true));
    pin.addEventListener('mouseleave', () => onPinHover(n.id, false));
    pin.addEventListener('click', () => {
      ctx.focusId = n.id; state.open = true; state.panel = true;
      ctx.persist(); ctx.renderAll();
      requestAnimationFrame(() => el.panel.querySelector('.card.focus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    });
    el.pins.append(pin);
    pinEls.set(n.id, pin);
    return pin;
  }

  function place(pin: HTMLElement, n: Note, r: DOMRect) {
    pin.className = `pin ${n.type}${ctx.isResolved(n) ? ' resolved' : n.done ? ' done' : ''}`;
    pin.textContent = String(ctx.numberOf(n));
    const fx = Math.min(Math.max(n.target!.fx ?? 1, 0), 1), fy = Math.min(Math.max(n.target!.fy ?? 0, 0), 1);
    // Kept on screen: full-width targets on a phone would put the pin past the right edge.
    const size = pin.offsetWidth || 24;
    pin.style.left = `${Math.min(r.x + fx * r.width, innerWidth - size - 4)}px`;
    pin.style.top = `${Math.max(r.y + fy * r.height, size + 4)}px`;
    pin.style.display = r.bottom < 0 || r.top > innerHeight ? 'none' : '';
    if (pin.style.display !== 'none') ctx.markSeen(n);
  }

  function renderPins() {
    const show = state.open || config.launcher;
    const list = show ? ctx.pageNotes().filter(n => !n.whole && n.target && (!n.done || state.showDone || ctx.isResolved(n))) : [];
    const keep = new Set<string>();
    for (const n of list) {
      const target = targetOf(n);
      if (!target) continue;
      const r = target.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      keep.add(n.id);
      place(pinFor(n), n, r);
    }
    for (const [id, pin] of pinEls) if (!keep.has(id)) { pin.remove(); pinEls.delete(id); }
  }

  function onPinHover(id: string, on: boolean) {
    const n = ctx.notes.find(x => x.id === id);
    if (!on || !n) { el.tip.style.display = 'none'; if (!ctx.draft) ctx.hideHl(); return; }
    const target = targetOf(n);
    if (target && !ctx.draft) ctx.showHl(target, null);
    const pin = pinEls.get(id)!.getBoundingClientRect();
    el.tip.innerHTML = tipHtml(n, ctx.t('seeSketch'));
    el.tip.style.display = '';
    el.tip.style.left = `${Math.min(pin.right + 8, innerWidth - 310)}px`;
    el.tip.style.top = `${Math.min(pin.top, innerHeight - el.tip.offsetHeight - 8)}px`;
  }

  return { renderPins, targetOf };
};

/** The tooltip's markup; every note field is escaped. The thread shows its latest message. */
function tipHtml(n: Note, seeSketch: string): string {
  const by = n.author ? `<div class="by">${esc(n.author)}</div>` : '';
  const main = n.type === 'text'
    ? `<div style="color:#ff8a9d;text-decoration:line-through">${esc(clip(n.from, 140))}</div><div style="color:#7ee2b0">${esc(clip(n.to, 140))}</div>${n.body ? '<div style="margin-top:4px">' + esc(n.body) + '</div>' : ''}`
    : esc(n.body || (n.type === 'sketch' ? seeSketch : ''));
  const last = Array.isArray(n.messages) ? n.messages[n.messages.length - 1] : undefined;
  const re = n.reply || (typeof last?.body === 'string' ? (last.author ? `${last.author}: ` : '') + clip(last.body, 140) : '');
  return by + main + (re ? `<div class="re">${esc(re)}</div>` : '');
}
