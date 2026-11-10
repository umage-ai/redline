// The notes panel: filters, extension sections, note cards, and the footer (agent prompt,
// tab capture).

import type { Note } from '../shared/types.ts';
import type { NoteType } from '../shared/types.ts';
import { isStale, relativeAge, STALE_DAYS } from '../shared/age.ts';
import { clip } from './anchor.ts';
import { startTabCapture, stopTabCapture } from './capture.ts';
import { esc, h, safely, inFrame } from './dom.ts';
import type { Ctx, Part } from './context.ts';
import type { StoredNote } from './transport.ts';

const TYPE_ICON: Record<NoteType, string> = { comment: '💬', text: 'T', sketch: '✎' };

// Only links into the store's own UI over http(s); anything else from a store is dropped.
const safeHref = (u?: string) => { try { return u && /^https?:$/.test(new URL(u).protocol) ? u : null; } catch { return null; } };

export const panelPart: Part<'renderPanel' | 'togglePanel'> = ctx => {
  const { el, state, config, transport, t } = ctx;
  const panel = el.panel;

  function togglePanel(v = !state.panel) {
    if (v && ctx.locked()) { if (!state.open) ctx.setOpen(true); else ctx.toast(t('gateFirst'), true); return; }
    state.panel = v; if (v) state.open = true; ctx.persist(); ctx.renderAll();
  }

  function scrollCardIntoView() {
    requestAnimationFrame(() => panel.querySelector('.card.focus')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  const assetUrl = (rel?: string) => rel ? transport.assetUrl(rel) : '';

  const patch = (id: string, p: Partial<Note>) => ctx.updateNote(id, p);
  const remove = (id: string) => ctx.removeNote(id);

  function goTo(n: StoredNote, here: boolean) {
    if (!here) { location.href = n.url; return; }
    const target = ctx.targetOf(n);
    if (!target) { ctx.toast(t('elementNotFound'), true); return; }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setTimeout(() => ctx.showHl(target, null), 350);
    setTimeout(() => { if (!ctx.draft) ctx.hideHl(); }, 1800);
  }

  function zoom(src: string) {
    const z = h('div', { class: 'zoom', onclick: () => z.remove() }, h('img', { src }));
    ctx.ui.append(z);
  }

  /** ✕ asks "Delete?" first; a second press within 2.5 s deletes. */
  function deleteButton(id: string) {
    let armed = false;
    return h('button', { title: t('delete'), onclick: (e: Event) => {
      const b = e.currentTarget as HTMLButtonElement;
      if (armed) { remove(id); return; }
      armed = true; b.textContent = t('deleteConfirm'); b.style.color = '#ff6b85';
      setTimeout(() => { armed = false; b.textContent = '✕'; b.style.color = ''; }, 2500);
    } }, '✕');
  }

  function cardTop(c: () => HTMLElement, n: StoredNote, here: boolean) {
    const tg = n.target;
    const loc = n.whole || !tg ? t('wholePage')
      : `${tg.tag ?? ''}${tg.text ? ` “${clip(tg.text, 28)}”` : ''}${tg.source ? ` · ${tg.source.file.split('/').pop()}:${tg.source.line ?? ''}` : ''}`;
    const href = safeHref(n.href);
    const st = ctx.statusOf(n);
    return h('div', { class: 'top' },
      h('span', { class: 'num', title: n.type }, String(ctx.numberOf(n))),
      n.label ? ctx.tinted(h('span', { class: 'tag', title: t('label') }, n.label), ctx.labelDef(n.label)?.color) : null,
      st ? ctx.tinted(h('span', { class: 'tag status', title: t('status') }, st.label ?? st.id), st.color) : null,
      h('span', { class: 'loc', title: tg?.selector ?? '' }, `${TYPE_ICON[n.type]}  ${loc}`),
      h('span', { class: 'acts' },
        h('button', { title: here ? t('showOnPage') : t('openPage'), onclick: () => goTo(n, here) }, here ? '◎' : '↗'),
        href ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', title: t('openIn', { dir: config.dir }), class: 'out' }, '⧉') : null,
        config.statuses?.length ? statusMenu(n)
          : h('button', { title: n.done ? t('reopen') : t('markDone'), onclick: () => patch(n.id, { done: !n.done }) }, n.done ? '↺' : '✓'),
        ...cardActions(n),
        h('button', { title: t('edit'), onclick: () => editCard(c(), n) }, '✎'),
        deleteButton(n.id),
      ),
    );
  }

  // Extensions' card buttons (v4), before edit and delete.
  function cardActions(n: StoredNote): HTMLElement[] {
    return ctx.ext.cardActions.filter(a => safely(() => a.show?.(n) ?? true, false)).map(a =>
      h('button', { 'data-ext': a.id, title: a.title ?? a.label, onclick: () => safely(() => a.onClick({ ...n }), undefined) }, a.label));
  }

  // Extensions' own elements on the card (v4), each in its own box above the meta line.
  function cardDecorations(n: StoredNote): HTMLElement[] {
    return ctx.ext.cardDecorators.map(d => {
      const box = h('div', { class: 'ext-card', 'data-ext': d.id });
      safely(() => d.render({ ...n }, box), undefined);
      return box;
    }).filter(b => b.childNodes.length);
  }

  // The product's statuses (D50) in place of the done button: picking one sets its `done` too.
  function statusMenu(n: StoredNote) {
    const list = config.statuses!;
    const unknown = n.status && !list.some(s => s.id === n.status) ? [h('option', { value: n.status }, n.status)] : [];
    const sel = h('select', { class: 'status-menu', title: t('status'), 'aria-label': t('status'), onchange: () => {
      const s = list.find(x => x.id === sel.value);
      if (s) patch(n.id, { status: s.id, done: !!s.done });
    } }, ...unknown, ...list.map(s => h('option', { value: s.id }, s.label ?? s.id)));
    sel.value = n.status ?? list.find(s => !!s.done === n.done)?.id ?? list[0].id;
    return sel;
  }

  // A thread (D50): the store's messages, oldest first, under the body.
  function thread(n: StoredNote): HTMLElement[] {
    const msgs = Array.isArray(n.messages) ? n.messages.filter(m => m && typeof m.body === 'string') : [];
    return msgs.map(m => h('div', { class: `msg${m.kind ? ' ' + String(m.kind).replace(/[^\w-]/g, '') : ''}` },
      m.author || m.at ? h('div', { class: 'by' }, [m.author, m.at && (relativeAge(m.at) ?? m.at)].filter(Boolean).join(' · ')) : null,
      m.body));
  }

  // A store with threads (`transport.message`) gets a reply box on every card.
  function replyBox(n: StoredNote) {
    if (!transport.message) return null;
    const ta = h('textarea', { class: 'reply-box', rows: '1', placeholder: t('replyPlaceholder') });
    const go = async () => {
      const body = ta.value.trim();
      if (!body) return;
      ta.disabled = true;
      if (await ctx.sendMessage(n.id, body)) ta.value = '';
      ta.disabled = false; renderPanel(true);
    };
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void go(); } });
    return h('div', { class: 'reply-row' }, ta, h('button', { class: 'btn', onclick: go }, t('send')));
  }

  function cardMeta(n: StoredNote, here: boolean) {
    const age = !n.done && isStale(n.at)
      ? h('span', { class: 'age stale', title: t('staleTitle', { at: n.at, days: STALE_DAYS }) }, `⏱ ${relativeAge(n.at)}`)
      : h('span', { class: 'age', title: n.at }, relativeAge(n.at) ?? n.at);
    const rest = `${n.author ? ` · ${n.author}` : ''}${n.viewport ? ` · ${n.viewport[0]}×${n.viewport[1]}` : ''}${n.theme ? ` · ${n.theme}` : ''}${here && n.target && !ctx.targetOf(n) ? ' · ' + t('notFoundOnPage') : ''}`;
    return h('div', { class: 'meta' }, age, rest);
  }

  /** A note's screenshot: from `assetUrl`, or (header auth, D60) the transport's `assetSrc` once it has it. */
  function shot(rel: string): HTMLElement {
    if (!transport.assetSrc) return h('img', { src: assetUrl(rel) + `?v=${ctx.version}`, alt: t('screenshotAlt'), loading: 'lazy', onclick: () => zoom(assetUrl(rel)) });
    const img = h('img', { alt: t('screenshotAlt'), onclick: () => { if (img.getAttribute('src')) zoom(img.getAttribute('src')!); } });
    transport.assetSrc(rel).then(src => img.setAttribute('src', src), () => { /* left without a picture */ });
    return img;
  }

  function card(n: StoredNote, here: boolean): HTMLElement {
    if (here) ctx.markSeen(n);
    const c: HTMLElement = h('div', { class: `card${ctx.isResolved(n) ? ' resolved' : n.done ? ' done' : ''}${ctx.focusId === n.id ? ' focus' : ''}`, 'data-id': n.id },
      cardTop(() => c, n, here),
      n.type === 'text' ? h('div', { class: 'diff', html: `<div class="del">${esc(n.from ?? '')}</div><div class="ins">${esc(n.to ?? '')}</div>` }) : null,
      n.body ? h('div', { class: 'body' }, n.body) : n.type === 'sketch' ? h('div', { class: 'body muted' }, t('seeSketch')) : null,
      n.screenshot ? shot(n.screenshot) : null,
      n.reply ? h('div', { class: 'reply', 'data-who': t('agent') }, n.reply) : null,
      ...thread(n),
      replyBox(n),
      ...cardDecorations(n),
      cardMeta(n, here),
    );
    c.addEventListener('mouseenter', () => { const target = here ? ctx.targetOf(n) : null; if (target && !ctx.draft) ctx.showHl(target, null); });
    c.addEventListener('mouseleave', () => { if (!ctx.draft) ctx.hideHl(); });
    return c;
  }

  function editCard(c: HTMLElement, n: StoredNote) {
    const ta = h('textarea', {}) as HTMLTextAreaElement;
    ta.value = n.body;
    const old = c.querySelector('.body');
    if (old) old.replaceWith(ta); else c.querySelector('.top')!.after(ta);
    ta.focus();
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) patch(n.id, { body: ta.value.trim() });
      if (e.key === 'Escape') renderPanel(true);
    });
    ta.addEventListener('blur', () => { if (ta.value.trim() !== n.body) patch(n.id, { body: ta.value.trim() }); else renderPanel(true); });
  }

  const visible = (n: Note) => state.showDone || !n.done || ctx.isResolved(n);

  function list(): HTMLElement {
    const listEl = h('div', { class: 'list' });
    if (state.scope === 'page') {
      const here = ctx.pageNotes().filter(visible);
      if (!here.length) listEl.append(h('div', { class: 'empty' }, ctx.pageNotes().length ? t('emptyPageDone') : t('emptyPage')));
      for (const n of here) listEl.append(card(n, true));
      return listEl;
    }
    // Grouped by app + page; in a monorepo other apps' notes are listed too (they open in their own app).
    const key = (n: Note) => `${n.app ?? ''}\u0000${n.page}`, mine = `${ctx.app}\u0000${ctx.page}`;
    const groups = [...new Set(ctx.notes.filter(visible).map(key))].sort((a, b) => (a === mine ? -1 : b === mine ? 1 : a.localeCompare(b)));
    if (!groups.length) listEl.append(h('div', { class: 'empty' }, t('emptyAll')));
    for (const g of groups) {
      const [gApp, gPage] = g.split('\u0000');
      const label = (gApp && gApp !== ctx.app ? `${gApp} · ` : '') + gPage;
      listEl.append(h('div', { class: 'group' }, g === mine ? t('thisPageGroup', { label }) : label));
      for (const n of ctx.notes.filter(x => key(x) === g && visible(x))) listEl.append(card(n, g === mine));
    }
    return listEl;
  }

  function filters(): HTMLElement {
    const scope = (s: 'page' | 'all', label: string) =>
      h('button', { class: state.scope === s ? 'on' : '', onclick: () => { state.scope = s; ctx.persist(); renderPanel(true); } }, label);
    return h('div', { class: 'filters' },
      h('div', { class: 'seg' },
        scope('page', t('thisPage', { n: ctx.pageNotes().filter(n => !n.done).length })),
        scope('all', t('all', { n: ctx.openCount() })),
      ),
      h('label', {}, h('input', { type: 'checkbox', ...(state.showDone ? { checked: true } : {}), onchange: (e: Event) => { state.showDone = (e.target as HTMLInputElement).checked; ctx.persist(); ctx.renderAll(); } }), t('showDone')),
    );
  }

  function sections(): HTMLElement[] {
    return ctx.ext.sections.map(s => {
      const body = h('div');
      safely(() => s.render(body), undefined);
      return h('section', { class: 'ext', 'data-ext': s.id }, s.title ? h('h3', {}, s.title) : null, body);
    });
  }

  function footer(): HTMLElement {
    const file = ctx.pageNotes()[0]?.file;
    const custom = typeof config.prompt === 'string';
    const open = state.scope === 'page' ? ctx.pageNotes().filter(n => !n.done).length : ctx.openCount();
    const prompt = agentPrompt(ctx, file, open);
    return h('footer', {},
      config.prompt !== false && !custom && h('div', { class: 'file' }, file && state.scope === 'page' ? file : `${config.dir}/INDEX.md`),
      config.prompt !== false && h('div', { class: 'row' },
        h('button', { class: 'btn primary', disabled: !open, onclick: async () => {
          try { await navigator.clipboard.writeText(prompt); ctx.toast(t('promptCopied')); }
          catch { ctx.toast(prompt, false, 8000); }
        } }, t('copyPrompt')),
      ),
      tabCaptureToggle(),
    );
  }

  // Mobile browsers have no getDisplayMedia.
  function tabCaptureToggle() {
    // In a frame, tab capture would show the whole tab (D60): DOM capture only.
    if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function' || inFrame()) return false;
    const tab = ctx.store.get('tabcapture', '0') === '1';
    return h('label', { title: t('tabCaptureTitle') },
      h('input', { type: 'checkbox', ...(tab ? { checked: true } : {}), onchange: async (e: Event) => {
        const on = (e.target as HTMLInputElement).checked;
        ctx.store.set('tabcapture', on ? '1' : '0');
        if (on) { if (!(await startTabCapture())) { ctx.store.set('tabcapture', '0'); ctx.toast(t('tabCaptureDenied'), true); renderPanel(true); } }
        else stopTabCapture();
      } }),
      t('tabCapture'));
  }

  function renderPanel(force = false) {
    const shown = state.open && state.panel && !ctx.locked();
    panel.style.display = shown ? '' : 'none';
    if (!shown) return;
    const active = ctx.shadow.activeElement;
    if (!force && panel.contains(active) && active?.tagName === 'TEXTAREA') return; // don't clobber an edit
    panel.replaceChildren(
      h('header', {}, h('h2', {}, t('notes')), h('button', { title: t('closePanel'), onclick: () => togglePanel(false) }, '✕')),
      filters(),
      ...sections(),
      list(),
      footer(),
    );
    if (ctx.focusId) scrollCardIntoView();
  }

  return { renderPanel, togglePanel };
};

/** The text "Copy prompt" puts on the clipboard. Works in any agent: names the installed guide, or spells out the contract (D16). */
function agentPrompt(ctx: Ctx, file: string | undefined, open: number): string {
  const { config, state, t } = ctx;
  const how = config.guide ? t('promptGuide', { guide: config.guide }) : t('promptHow');
  // The server's own text (a remote store, D47): {open} and {page} filled in. Unset: the markdown store's files.
  if (typeof config.prompt === 'string') return config.prompt.replace(/\{open\}/g, String(open)).replace(/\{page\}/g, ctx.page);
  return state.scope === 'page' && file
    ? t('promptPage', { file, n: open, how })
    : t('promptAll', { dir: config.dir, n: ctx.openCount(), how });
}
