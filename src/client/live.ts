// The page's side of live pages (D65): MCP tools ask this page what only it knows (the console errors
// it saw, the DOM around a note's target now). The stream is the transport's `live` (one per tab, also
// the change feed, D72), held by mount.ts while the tab is visible; answers go back as POSTs.

import type { Target } from '../shared/types.ts';
import { resolve } from './anchor.ts';

/** An element in a few words: `button#save.btn.primary`. */
function label(el: Element): string {
  const cls = [...el.classList].slice(0, 3).map(c => `.${c}`).join('');
  return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`;
}

/** The DOM around an element, for an agent: where it sits, what it says, how it is drawn now. */
export function outline(el: Element): Record<string, unknown> {
  const chain: string[] = [];
  for (let p = el.parentElement; p && chain.length < 6 && p !== document.documentElement; p = p.parentElement) chain.unshift(label(p));
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const html = el.outerHTML;
  const parent = el.parentElement;
  return {
    element: label(el),
    ancestors: chain,
    siblings: parent ? { index: [...parent.children].indexOf(el), count: parent.children.length } : undefined,
    text: ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
    html: html.length > 4000 ? html.slice(0, 4000) + '…' : html,
    box: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth },
    style: { display: cs.display, visibility: cs.visibility, opacity: cs.opacity, color: cs.color, background: cs.backgroundColor, font: `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily.split(',')[0]}` },
  };
}

/** The answer to an MCP tool's ask: the console errors this page saw, or the DOM around a note's target now. */
export function answer(a: { kind: string; target?: Target }, errors: () => string[]): unknown {
  if (a.kind === 'console') return { errors: errors(), url: location.href };
  if (a.kind === 'dom' && a.target) {
    const el = resolve(a.target);
    return el ? outline(el) : { missing: true, url: location.href };
  }
  return undefined;
}
