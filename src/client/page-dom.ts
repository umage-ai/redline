// What the overlay reads off the reviewed page: an element's text, which of several look-alikes
// it is, the page's theme and background.

/** What text mode reads as an element's text (and sends as `from`). */
export function blockText(el: Element): string {
  const t = getComputedStyle(el).textTransform === 'none' ? (el as HTMLElement).innerText : el.textContent;
  return (t ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Several elements with this tag and text (a deck's nine identical <span>s): which one this is,
 * in document order. The static-HTML writer picks the same one in source when the counts agree.
 */
export function nthOf(el: Element, from: string): { index: number; count: number } | undefined {
  const n = (s: string) => s.replace(/[\s ]+/g, ' ').trim();
  const want = n(from);
  // textContent too: innerText is '' for hidden elements (Reveal hides every other slide)
  const same = Array.from(document.getElementsByTagName(el.localName)).filter(x => x === el || n(blockText(x)) === want || n(x.textContent ?? '') === want);
  return same.length > 1 ? { index: same.indexOf(el), count: same.length } : undefined;
}

const RGB = /rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/;
const CLEAR = /rgba\(0, 0, 0, 0\)|transparent/;

export function themeOf(): 'light' | 'dark' {
  const de = document.documentElement;
  const attr = (de.getAttribute('data-theme') ?? de.getAttribute('data-mode') ?? de.getAttribute('data-color-scheme') ?? '').toLowerCase();
  if (de.classList.contains('dark') || document.body?.classList.contains('dark') || attr.includes('dark')) return 'dark';
  if (de.classList.contains('light') || attr.includes('light')) return 'light';
  // No explicit marker: judge by the page background, then the OS preference.
  for (const el of [document.body, de]) {
    const m = el && RGB.exec(getComputedStyle(el).backgroundColor);
    if (m && (m[4] === undefined || +m[4] > 0.5)) return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255 < 0.45 ? 'dark' : 'light';
  }
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** The first opaque background up the tree, so the text editor sits on the same colour. */
export function bgOf(el: Element): string {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const c = getComputedStyle(cur).backgroundColor;
    if (c && !CLEAR.test(c)) return c;
  }
  return themeOf() === 'dark' ? '#111' : '#fff';
}
