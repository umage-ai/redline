// The note being written: the popover (text, label chips, screenshot toggle, "Apply to file"),
// and saving it with its target, screenshot and sketch.

import type { LabelDef } from '../shared/labels.ts';
import type { NewNoteRequest, Target } from '../shared/types.ts';
import type { RedlineBeforeSave } from '../shared/extension.ts';
import { cmsInfo, describe, labelFor, sourceInfo } from './anchor.ts';
import { startTabCapture, tabCaptureActive } from './capture.ts';
import { bboxOf, sketchFile } from './sketch.ts';
import { esc, h } from './dom.ts';
import { nthOf, themeOf } from './page-dom.ts';
import type { Ctx, Draft, Part } from './context.ts';
import type { EditResult } from './transport.ts';

type Direct = { btn: HTMLButtonElement; why: HTMLElement };
type Pop = HTMLElement & { _shot?: HTMLInputElement };

const PLACEHOLDER = { comment: 'placeholderComment', text: 'placeholderText', sketch: 'placeholderSketch' } as const;

export const draftPart: Part<'openDraft' | 'cancelDraft' | 'renderPop' | 'placePop' | 'labelDef' | 'tinted'> = ctx => {
  const { el, state, config, t } = ctx;
  const popLayer = el.popLayer;

  function openDraft(d: Draft) {
    ctx.draft = d;
    renderPop();
    ctx.renderBar();
  }

  function cancelDraft() {
    const d = ctx.draft;
    if (!d) return;
    d.editor?.remove();
    if (d.sketch) { d.sketch.destroy(); state.mode = 'idle'; ctx.persist(); }
    ctx.draft = null;
    ctx.renderTools();   // takes the sketch toolbar away
    popLayer.replaceChildren();
    ctx.hideHl();
    ctx.renderAll();
  }

  /* ---------- labels (D46) ---------- */
  const labels = (): LabelDef[] => config.labels ?? [];
  const labelDef = (name?: string) => name ? labels().find(l => l.name.toLowerCase() === name.toLowerCase()) : undefined;
  const tinted = <T extends HTMLElement>(t: T, color?: string) => { if (color) t.style.setProperty('--c', color); return t; };

  // One row of chips, never wrapped: when they don't fit it scrolls sideways, faded at the edge.
  function labelChips(d: Draft, ta: HTMLTextAreaElement) {
    if (!labels().length) return null;
    const btns = labels().map(l => tinted(h('button', {
      class: 'chip', type: 'button', title: t('labelTitle', { name: l.name, tag: l.name.toLowerCase() }),
      onclick: () => { d.label = d.label === l.name ? undefined : l.name; sync(); ta.focus(); },
    }, l.name), l.color));
    const row = h('div', { class: 'chips', role: 'group', 'aria-label': t('label') }, ...btns);
    const sync = () => btns.forEach((b, i) => { const on = labels()[i].name === d.label; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
    const fit = () => row.classList.toggle('more', row.scrollWidth > row.clientWidth + 1 && row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    row.addEventListener('scroll', fit, { passive: true });
    // A mouse wheel scrolls the row sideways when it overflows.
    row.addEventListener('wheel', e => { if (row.scrollWidth > row.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { row.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
    sync();
    return { el: row, sync, fit };
  }

  /** "#bug rest…" → the Bug label and "rest…", when Bug is a label. While typing, only once a space follows. */
  function takeTag(text: string, typing = false): { label: string; rest: string } | null {
    const m = (typing ? /^#([^\s#]+)\s+/ : /^#([^\s#]+)(\s+|$)/).exec(text);
    const l = m && labelDef(m[1]);
    return l ? { label: l.name, rest: text.slice(m![0].length) } : null;
  }

  /* ---------- the popover ---------- */
  function popHeader(d: Draft, what: string) {
    return h('header', {},
      h('span', { class: 'what', title: what }, (d.type === 'text' ? '✎ ' : d.type === 'sketch' ? '' : '💬 ') + what),
      d.type === 'comment' && d.el && d.el.parentElement && d.el.parentElement !== document.body
        ? h('button', { title: t('parentTitle'), onclick: () => { d.el = d.el!.parentElement; renderPop(); } }, t('parent')) : null,
      d.type === 'comment' && !d.whole ? h('button', { title: t('pageTitle'), onclick: () => { d.el = null; d.whole = true; renderPop(); } }, t('page')) : null,
    );
  }

  function renderPop() {
    const d = ctx.draft!;
    if (d.el) ctx.showHl(d.el, null, d.type === 'text' ? 'text' : '');
    else ctx.hideHl();
    const what = d.type === 'sketch' ? t('sketchOf', { what: d.el ? labelFor(d.el) : t('sketchPage') }) : d.el ? labelFor(d.el) : t('wholePage');
    const ta = h('textarea', { placeholder: t(PLACEHOLDER[d.type]) });
    const shot = h('input', { type: 'checkbox', ...(ctx.store.get('shot', '1') === '1' ? { checked: true } : {}) }) as HTMLInputElement;
    shot.addEventListener('change', () => ctx.store.set('shot', shot.checked ? '1' : '0'));
    const save = h('button', { class: 'btn primary', onclick: () => saveDraft(ta.value) }, t('save'));
    const direct: Direct | null = d.type === 'text' && config.directEdit && ctx.transport.edit && d.el && d.to !== undefined ? {
      btn: h('button', { class: 'btn apply', disabled: true, title: t('applyChecking'), onclick: () => applyDirect(d, direct!, save) }, t('applyToFile')),
      why: h('div', { class: 'why', style: 'display:none' }),
    } : null;
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveDraft(ta.value); }
      else if (e.key === 'Enter' && !e.shiftKey && d.type !== 'comment' && !ta.value.trim()) { e.preventDefault(); saveDraft(''); }
      else if (e.key === 'Escape') { e.preventDefault(); cancelDraft(); }
    });
    const chips = labelChips(d, ta);
    // "#bug " at the start of the text picks that label, so it can be chosen without the mouse.
    ta.addEventListener('input', () => {
      const tag = takeTag(ta.value, true);
      if (!tag) return;
      d.label = tag.label;
      ta.value = tag.rest;
      chips?.sync();
    });
    const pop: Pop = h('div', { class: 'pop' },
      popHeader(d, what),
      d.type === 'text' ? h('div', { class: 'diff', html: `<div class="del">${esc(d.from ?? '')}</div><div class="ins">${esc(d.to ?? '')}</div>` }) : null,
      chips?.el ?? null,
      ta,
      direct ? direct.why : null,
      h('footer', {},
        h('label', { title: t('screenshotTitle') }, shot, t('screenshot')),
        // The buttons stay together; short of room (Save note + Apply to file) they wrap below, right-aligned.
        h('span', { class: 'btns' }, h('button', { class: 'btn', onclick: cancelDraft }, t('cancel')), save, direct ? direct.btn : null),
      ),
    );
    pop._shot = shot;
    popLayer.replaceChildren(pop);
    chips?.fit();
    placePop();
    setTimeout(() => ta.focus());
    if (direct) void checkDirect(d, direct, save);
  }

  /* ---------- direct source edits (D20) ---------- */
  const editRequest = (d: Draft) => ({
    from: d.from, to: d.to, html: d.html, tag: d.el!.localName, url: location.href, source: sourceInfo(d.el!).source, nth: nthOf(d.el!, d.from!), cms: cmsInfo(d.el!),
  });

  // Dry run first: offer "Apply to source" only when a writer accepts this edit.
  async function checkDirect(d: Draft, direct: Direct, save: HTMLButtonElement) {
    let r: EditResult;
    try { r = await ctx.transport.edit!(editRequest(d), 'dry'); }
    catch (e) { r = { ok: false, reason: (e as Error).message }; }
    if (ctx.draft !== d) return;
    if (r.ok) {
      direct.btn.disabled = false;
      direct.btn.title = t('applyTitle', { file: r.file + (r.line ? ':' + r.line : '') });
      direct.btn.className = 'btn apply primary';
      save.className = 'btn';
      save.textContent = t('saveNote');
    } else refuse(direct, save, r.reason);
    placePop();
  }

  // Can't write it: the note is the way (the old text-note flow), and the reason is shown.
  function refuse(direct: Direct, save: HTMLButtonElement, reason: string) {
    direct.btn.disabled = true;
    direct.btn.className = 'btn apply';
    direct.btn.title = t('applyRefusedTitle', { reason });
    direct.why.textContent = t('applyRefused', { reason });
    direct.why.style.display = '';
    save.className = 'btn primary';
    placePop();
  }

  async function applyDirect(d: Draft, direct: Direct, save: HTMLButtonElement) {
    ctx.busy = true;
    try {
      const r = await ctx.transport.edit!(editRequest(d), 'apply');
      if (!r.ok) { refuse(direct, save, r.reason); return; }
      ctx.emit('sourceWritten', { file: r.file, line: r.line, from: d.from!, to: d.to! });
      cancelDraft();
      state.mode = 'idle'; ctx.persist(); ctx.renderAll();
      ctx.toast(t('written', { file: r.file + (r.line ? ':' + r.line : '') }));
    } catch (e) {
      refuse(direct, save, (e as Error).message);
    } finally { ctx.busy = false; }
  }

  // Near the anchor point, inside the visible viewport. On phones the on-screen keyboard
  // shrinks only the visual viewport, so re-place when it opens or closes.
  function placePop() {
    const pop = popLayer.querySelector<HTMLElement>('.pop');
    const d = ctx.draft;
    if (!pop || !d) return;
    const vv = visualViewport;
    const top = vv?.offsetTop ?? 0, bottom = vv ? vv.offsetTop + vv.height : innerHeight;
    const W = pop.offsetWidth || 360, H = pop.offsetHeight || 200;
    let x = d.x + 14, y = d.y + 14;
    if (x + W > innerWidth - 8) x = Math.max(8, d.x - W - 14);
    if (x + W > innerWidth - 8) x = Math.max(8, innerWidth - W - 8);
    if (y + H > bottom - 8) y = Math.max(top + 8, bottom - H - 8);
    if (y < top + 8) y = top + 8;
    Object.assign(pop.style, { left: `${x}px`, top: `${y}px` });
  }
  ctx.life.on(visualViewport, 'resize', placePop);
  ctx.life.on(visualViewport, 'scroll', placePop);

  /* ---------- saving ---------- */
  /** The note's text: a leading #label taken off, and for a rich edit the wanted markup added. */
  function noteBody(d: Draft, text: string): string {
    let body = text.trim();
    const tag = takeTag(body);
    if (tag) { d.label = tag.label; body = tag.rest.trim(); }
    // A rich edit saved as a note: the diff shows text only, so give the agent the wanted markup too.
    if (d.type === 'text' && d.rich && d.html) body = [body, t('wantedSource', { html: d.html.replace(/\s+/g, ' ').trim() })].filter(Boolean).join('\n\n');
    return body;
  }

  async function saveDraft(text: string) {
    const d = ctx.draft!;
    const body = noteBody(d, text);
    if (d.type === 'comment' && !body) { ctx.toast(t('writeFirst'), true); return; }
    const wantShot = (popLayer.querySelector<Pop>('.pop')?._shot?.checked) ?? true;
    ctx.busy = true;
    popLayer.style.display = 'none';
    ctx.hideHl();
    if (d.editor) d.editor.style.visibility = 'hidden';
    const stopNotice = ctx.savingNotice();
    let ok = false;
    try {
      const draft = await hooks(ctx.ext.beforeSave, await buildRequest(ctx, d, body, wantShot), 'beforeSave');
      if (!draft) {   // an extension said no: the draft stays open as it was
        stopNotice();
        if (d.editor) d.editor.style.visibility = '';
        return;
      }
      const req = await hooks(ctx.ext.beforeCreate, draft, 'beforeCreate');
      if (!req) {   // dropped (v6): nothing is saved, the draft closes
        stopNotice();
        ctx.cancelDraft();
        state.mode = 'idle'; ctx.persist();
        return;
      }
      const saved = await ctx.transport.create(req);
      stopNotice();
      d.editor?.remove(); d.sketch?.destroy();
      ctx.draft = null;
      popLayer.replaceChildren();
      ctx.hideHl();   // a scroll while saving may have redrawn it (L36)
      ctx.toast(t('saved', { file: saved.file ?? config.dir }));
      state.mode = 'idle'; ctx.persist();   // one note per pick: the next tap goes to the app again (D15)
      ctx.emit('noteCreated', saved);
      ok = true;
    } catch (err) {
      stopNotice();
      ctx.toast(t('saveFailed', { error: ctx.fail('create', err).message }), true, 5000);
      if (d.editor) d.editor.style.visibility = '';
    } finally {
      ctx.busy = false;
      popLayer.style.display = '';
      ctx.renderAll();
    }
    // After the toolbar shows idle and picking is free again: a slow reload must not leave a stale
    // "Comment" button that ignores the next tap.
    if (ok) await ctx.poll(true);
  }

  /** Extensions' beforeSave (v4) or beforeCreate (v6) hooks, in order: each may change the request, or stop with false. A throwing hook is skipped. */
  async function hooks(list: RedlineBeforeSave[], req: NewNoteRequest, name: string): Promise<NewNoteRequest | null> {
    for (const fn of list.slice()) {
      let r: NewNoteRequest | void | false;
      try { r = await fn(req); } catch (err) { console.warn(`[redline] ${name} hook failed:`, err); continue; }
      if (r === false) return null;
      if (r && typeof r === 'object' && r.note) req = r;
    }
    return req;
  }

  return { openDraft, cancelDraft, renderPop, placePop, labelDef, tinted };
};

/** The POST body: the note with its target, page context, screenshot and sketch. */
async function buildRequest(ctx: Ctx, d: Draft, body: string, wantShot: boolean) {
  if (wantShot && ctx.store.get('tabcapture', '0') === '1' && !tabCaptureActive()) await startTabCapture();
  const el = d.whole ? null : d.el ?? null;
  const target = el ? enrich(ctx, el, describe(el, d.x, d.y)) : undefined;
  if (target && d.type === 'sketch' && d.sketch) {
    // pin at the sketch's top-right corner, relative to the anchor element
    const b = bboxOf(d.sketch.shapes)!, r = el!.getBoundingClientRect();
    target.fx = +(((b[0] + b[2]) - r.x) / (r.width || 1)).toFixed(3);
    target.fy = +((b[1] - r.y) / (r.height || 1)).toFixed(3);
  }
  if (target && d.type === 'text') { target.fx = 1; target.fy = 0; }
  const vr = el?.getBoundingClientRect();
  const png = wantShot
    ? await ctx.shoot({ box: vr && d.type !== 'sketch' ? [vr.x, vr.y, vr.width, vr.height] : undefined, sketch: d.sketch?.snapshot(), crop: d.type !== 'sketch' })
    : undefined;
  const errors = ctx.errors();
  return {
    note: {
      type: d.type, page: ctx.page, url: location.href, title: document.title || undefined,
      whole: !el || undefined, target,
      viewport: [innerWidth, innerHeight, Math.round(devicePixelRatio * 100) / 100] as [number, number, number],
      scroll: [Math.round(scrollX), Math.round(scrollY)] as [number, number], theme: themeOf(),
      from: d.from, to: d.to, errors: errors.length ? errors.slice(-5) : undefined, body, label: d.label,
    },
    screenshot: png,
    sketch: d.sketch ? sketchFile(d.sketch.shapes, innerWidth, innerHeight, document.title) : undefined,
  };
}

/** Extensions' target enrichers (v6), in order: each result merged in, `cms` and `extra` key by key; `extra` keeps primitives only. */
export function enrich(ctx: Pick<Ctx, 'ext'>, el: Element, target: Target): Target {
  for (const fn of ctx.ext.enrichers.slice()) {
    let r: Partial<Target> | void;
    try { r = fn(el, target); } catch (err) { console.warn('[redline] target enricher failed:', err); continue; }
    if (!r || typeof r !== 'object' || r === target) continue;
    const { cms, extra, ...rest } = r;
    Object.assign(target, rest);
    if (cms && typeof cms === 'object') target.cms = { ...target.cms, ...cms };
    if (extra && typeof extra === 'object') target.extra = { ...target.extra, ...extra };
  }
  if (target.extra) {
    const kept = Object.entries(target.extra).filter(([k, v]) => k && (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))));
    target.extra = kept.length ? Object.fromEntries(kept) : undefined;
  }
  return target;
}
