// Short messages at the bottom (or next to a moved toolbar) ("Saved → …"), and the spinner while a slow save runs.

import type { Part } from './context.ts';

export const toastPart: Part<'toast' | 'savingNotice'> = ctx => {
  const el = ctx.el.toast;
  let timer = 0;
  ctx.life.add(() => clearTimeout(timer));

  function toast(msg: string, err = false, ms = 2600) {
    el.textContent = msg;
    el.className = 'toast' + (err ? ' err' : '');
    el.style.display = '';
    ctx.placeNearBar(el);
    clearTimeout(timer);
    timer = window.setTimeout(() => (el.style.display = 'none'), ms);
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
