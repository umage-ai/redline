// Short messages at the bottom (or next to a moved toolbar) ("Saved → …"), and the spinner while a slow save runs.
// A toast with actions (v7, D69) is clickable: its buttons, ✕, longer on screen and paused while hovered.

import type { RedlineToastAction } from '../shared/extension.ts';
import { h } from './dom.ts';
import type { Part } from './context.ts';

export const toastPart: Part<'toast' | 'savingNotice'> = ctx => {
  const el = ctx.el.toast;
  let timer = 0;
  ctx.life.add(() => clearTimeout(timer));
  const hide = () => { clearTimeout(timer); el.style.display = 'none'; el.onpointerleave = null; };

  function toast(msg: string, err = false, ms?: number, actions?: RedlineToastAction[]): () => void {
    const live = !!actions?.length;
    el.className = 'toast' + (err ? ' err' : '') + (live ? ' act' : '');
    if (!live) el.textContent = msg;
    else {
      el.replaceChildren(h('span', { class: 'msg' }, msg),
        ...actions!.map(a => h('button', {
          class: 'btn' + (a.primary ? ' primary' : ''), title: a.title ?? '', type: 'button',
          onclick: () => { hide(); try { a.onClick(); } catch (e) { console.warn('[redline] toast action failed:', e); } },
        }, a.label)),
        h('button', { class: 'x', type: 'button', title: ctx.t('dismiss'), 'aria-label': ctx.t('dismiss'), onclick: hide }, '✕'));
    }
    el.style.display = '';
    ctx.placeNearBar(el);
    const wait = ms ?? (live ? 8000 : 2600);
    // Read and decided on at the reader's pace: while the pointer is on it, it waits (asked when the
    // time is up: a toast that appears under a resting pointer gets no pointerenter).
    const arm = () => { clearTimeout(timer); timer = window.setTimeout(() => live && el.matches(':hover') ? arm() : hide(), wait); };
    el.onpointerleave = live ? arm : null;
    arm();
    let mine = true;
    const token = el.firstChild;
    return () => { if (mine && el.firstChild === token) { mine = false; hide(); } };
  }

  /**
   * A spinner toast while a slow save runs: nothing for a fast one, "Saving…" after 0.5 s, a word on
   * big pages after 2 s. The overlay is never in the screenshot, so the toast isn't either. Returns stop.
   */
  function savingNotice(): () => void {
    const show = (msg: string) => {
      clearTimeout(timer);
      el.textContent = msg;
      el.className = 'toast wait';
      el.style.display = '';
      ctx.placeNearBar(el);
    };
    const timers = [
      window.setTimeout(() => show(ctx.t('saving')), 500),
      window.setTimeout(() => show(ctx.t('savingLarge')), 2000),
    ];
    return () => {
      timers.forEach(clearTimeout);
      if (el.classList.contains('wait')) el.style.display = 'none';
    };
  }

  return { toast, savingNotice };
};
