// The page's side of live pages (D65): a stream to the dev server so MCP tools can ask this page what
// only it knows (the console errors it saw, the DOM around a note's target now). Started by the
// injected script for a same-origin API without extra headers; a server without /live (404, .NET)
// just ends it. Answers go back as POSTs with the x-redline header.

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

export function startLive(apiBase: string, page: () => string, errors: () => string[]) {
  if (typeof EventSource === 'undefined') return;
  let id = '';
  const post = (p: string, body: object) => fetch(`${apiBase}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-redline': '1' }, body: JSON.stringify(body) }).catch(() => {});
  const q = () => new URLSearchParams({ page: page(), path: location.pathname + location.search, title: document.title });
  const es = new EventSource(`${apiBase}/live?${q()}`);
  es.addEventListener('hello', e => { id = JSON.parse((e as MessageEvent).data).id; });
  es.addEventListener('ask', e => {
    const a = JSON.parse((e as MessageEvent).data) as { req: string; kind: string; target?: Target };
    let data: unknown;
    if (a.kind === 'console') data = { errors: errors(), url: location.href };
    else if (a.kind === 'dom' && a.target) {
      const el = resolve(a.target);
      data = el ? outline(el) : { missing: true, url: location.href };
    }
    void post('/live/reply', { conn: id, req: a.req, data });
  });
  // A server without live pages answers 404: EventSource stops by itself (no retry on a failed open).
  // Client-side routing: the page key and path follow, checked when the URL changes.
  let last = location.href;
  setInterval(() => {
    if (!id || location.href === last) return;
    last = location.href;
    void post('/live/moved', { conn: id, page: page(), path: location.pathname + location.search, title: document.title });
  }, 1000);
}
