// Describe an element so an agent can find it in code (source location, component
// chain, test id, selector) and so the overlay can find it again after reloads
// (selector → test id → id → xpath → tag+text).

import type { CmsRef, SourceLoc, Target } from '../shared/types.ts';

const TESTID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa'];

export function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

const cssEsc = (s: string) => (typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(s) : s.replace(/["\\]/g, '\\$&'));

function testIdOf(el: Element): { attr: string; value: string } | null {
  for (const attr of TESTID_ATTRS) {
    const v = el.getAttribute(attr);
    if (v) return { attr, value: v };
  }
  return null;
}

// Framework-generated ids (React useId ":r1:", "radix-123", long hashes) aren't stable.
const stableId = (id: string) => !!id && !/^:|^radix-|^headlessui-|\d{4,}|^[a-f0-9-]{16,}$/i.test(id);

function unique(sel: string, el: Element): boolean {
  try {
    const all = document.querySelectorAll(sel);
    return all.length === 1 && all[0] === el;
  } catch { return false; }
}

export function selectorFor(el: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== document.documentElement) {
    const tid = testIdOf(cur);
    if (tid) {
      const s = `[${tid.attr}="${cssEsc(tid.value)}"]`;
      parts.unshift(s);
      if (unique(parts.join(' > '), el)) return parts.join(' > ');
    } else if (cur.id && stableId(cur.id)) {
      parts.unshift(`#${cssEsc(cur.id)}`);
      if (unique(parts.join(' > '), el)) return parts.join(' > ');
    } else {
      const tag = cur.localName;
      const parent: Element | null = cur.parentElement;
      let part = tag;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.localName === tag);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (parts.length > 2 && unique(parts.join(' > '), el)) return parts.join(' > ');
    }
    cur = cur.parentElement;
  }
  return parts.join(' > ');
}

export function xpathFor(el: Element): string {
  const segs: string[] = [];
  for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
    const tag = cur.localName;
    const sibs = cur.parentElement ? Array.from(cur.parentElement.children).filter(c => c.localName === tag) : [cur];
    segs.unshift(sibs.length > 1 ? `${tag}[${sibs.indexOf(cur) + 1}]` : tag);
  }
  return '/' + segs.join('/');
}

const IMPLICIT_ROLE: Record<string, string> = {
  a: 'link', button: 'button', nav: 'navigation', main: 'main', header: 'banner', footer: 'contentinfo',
  aside: 'complementary', form: 'form', img: 'img', ul: 'list', ol: 'list', li: 'listitem', table: 'table',
  select: 'combobox', textarea: 'textbox', dialog: 'dialog', h1: 'heading', h2: 'heading', h3: 'heading',
  h4: 'heading', h5: 'heading', h6: 'heading', section: 'region',
};

function roleOf(el: Element): string | undefined {
  const r = el.getAttribute('role');
  if (r) return r;
  if (el.localName === 'input') {
    const t = (el as HTMLInputElement).type;
    return t === 'checkbox' ? 'checkbox' : t === 'radio' ? 'radio' : t === 'button' || t === 'submit' ? 'button' : 'textbox';
  }
  return IMPLICIT_ROLE[el.localName];
}

function nameOf(el: Element): string | undefined {
  const label = el.getAttribute('aria-label');
  if (label) return label;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ');
    if (t.trim()) return clip(t, 80);
  }
  for (const a of ['alt', 'title', 'placeholder']) { const v = el.getAttribute(a); if (v) return v; }
  if ((el as HTMLInputElement).labels?.[0]) return clip((el as HTMLInputElement).labels![0].textContent, 80);
  return undefined;
}

// Source stamps (ours for JSX/Vue, Angular's template locations): noise for the agent.
const NOISE = ['data-redline-src', 'data-redline-cms', 'data-ng-source-location'];

function htmlExcerpt(el: Element): string {
  const clone = el.cloneNode(true) as Element;
  // Drop noise the agent can't use.
  clone.querySelectorAll?.('svg *').forEach(n => n.remove());
  for (const a of NOISE) for (const n of [clone, ...Array.from(clone.querySelectorAll?.(`[${a}]`) ?? [])]) n.removeAttribute?.(a);
  let html = clone.outerHTML.replace(/\s+/g, ' ');
  if (html.length > 400) {
    const open = html.slice(0, html.indexOf('>') + 1);
    html = open.length > 380 ? open.slice(0, 379) + '…' : open + ` …${clip(el.textContent, 120)}… </${el.localName}>`;
  }
  return html;
}

/* ---------- source location and components, per framework ---------- */

type SvelteMeta = { loc?: { file: string; line: number; column: number }; parent?: SvelteParent };
type SvelteParent = { type?: string; file?: string; line?: number; column?: number; componentTag?: string; parent?: SvelteParent | null };

const baseName = (f: string) => f.split(/[\\/]/).pop()!.replace(/\.(svelte|astro|tsx|jsx|vue|ts|js|html|razor|cshtml)$/, '');

function svelteInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const meta = (cur as unknown as { __svelte_meta?: SvelteMeta }).__svelte_meta;
    if (!meta?.loc) continue;
    const comps: string[] = [baseName(meta.loc.file)];
    for (let p = meta.parent; p; p = p.parent ?? undefined) {
      if (p.type === 'component' && p.componentTag) comps.push(p.componentTag);
      else if (p.file && baseName(p.file) !== comps[comps.length - 1]) comps.push(baseName(p.file));
    }
    // drop SvelteKit's own wrappers (root, layout, Pyramid_n)
    const own = comps.filter(c => !/^(Pyramid_\d+|root|layout)$/.test(c));
    return { source: { file: meta.loc.file, line: meta.loc.line, col: meta.loc.column + 1 }, components: dedupe(own) };
  }
  return null;
}

// Astro's dev toolbar removes these attributes after load; the server injects a
// parse-time snapshot into window.__redlineSrc.
function astroAttr(el: Element): [string, string] | null {
  const snap = (window as unknown as { __redlineSrc?: WeakMap<Element, [string, string]> }).__redlineSrc?.get(el);
  if (snap) return snap;
  const f = el.getAttribute('data-astro-source-file');
  return f ? [f, el.getAttribute('data-astro-source-loc') ?? ''] : null;
}

function astroInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  let source: SourceLoc | undefined;
  const comps: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    const a = astroAttr(cur);
    if (!a) continue;
    if (!source) {
      const [line, col] = a[1].split(':').map(Number);
      source = { file: a[0], line: line || undefined, col: col || undefined };
    }
    comps.push(baseName(a[0]));
  }
  return source ? { source, components: dedupe(comps) } : null;
}

type Fiber = { type?: unknown; return?: Fiber | null; _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number } };

function fiberOf(el: Element): Fiber | null {
  for (const k in el) if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) return (el as unknown as Record<string, Fiber>)[k];
  return null;
}

function reactName(type: unknown): string | null {
  if (!type || typeof type === 'string') return null;
  const t = type as { displayName?: string; name?: string; render?: { displayName?: string; name?: string }; type?: unknown };
  return t.displayName || t.name || t.render?.displayName || t.render?.name || (t.type ? reactName(t.type) : null);
}

// Library wrappers that say nothing about where the UI is written.
const REACT_PLUMBING = /^(Anonymous|Fragment|Suspense|StrictMode|Consumer|Context|Route|Routes|RenderedRoute|Outlet|Router|BrowserRouter|RouterProvider|DataRoutes|Navigate|ErrorBoundary|Hydrate|Portal)$|Provider$|^ForwardRef|^Memo/;

function reactInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  let fiber: Fiber | null = null;
  for (let cur: Element | null = el; cur && !fiber; cur = cur.parentElement) fiber = fiberOf(cur);
  if (!fiber) return null;
  let source = stampOf(el)?.source;
  const comps: string[] = [];
  for (let f: Fiber | null = fiber; f && comps.length < 6; f = f.return ?? null) {
    if (!source && f._debugSource) source = { file: f._debugSource.fileName, line: f._debugSource.lineNumber, col: f._debugSource.columnNumber };
    const n = reactName(f.type);
    if (n && !REACT_PLUMBING.test(n) && !n.startsWith('_')) comps.push(n);
  }
  return { source, components: dedupe(comps) };
}

/*
 * data-redline-src="file:line:col[ Component]": stamped by the dev server into JSX (jsx-source.ts) and Vue
 * templates (vue-source.ts), or by Umage.Redline.Build into Razor/Blazor markup (no component: the file names it).
 */
function parseStamp(s: string | null | undefined): { source: SourceLoc; comp?: string } | null {
  const m = s ? /^(.*):(\d+):(\d+)(?: (\S+))?$/.exec(s) : null;
  return m ? { source: { file: m[1], line: +m[2], col: +m[3] }, comp: m[4] } : null;
}
const stampOf = (el: Element) => parseStamp(el.closest('[data-redline-src]')?.getAttribute('data-redline-src'));

// Solid, Preact, Razor and Blazor keep no component tree on DOM nodes: the chain is the components
// the stamped ancestors are written in (the element's own first, then the ones around it).
function stampInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  const own = stampOf(el);
  if (!own) return null;
  const comps: string[] = [];
  for (let cur = el.closest('[data-redline-src]'); cur; cur = cur.parentElement?.closest('[data-redline-src]') ?? null) {
    const s = parseStamp(cur.getAttribute('data-redline-src'));
    if (s) comps.push(s.comp ?? baseName(s.source.file));
  }
  return { source: own.source, components: dedupe(comps) };
}

/* Vue 3: elements carry their component instance; the line comes from the template stamp. */
type VueInstance = { type?: { __name?: string; name?: string; __file?: string }; parent?: VueInstance | null };
const VUE_PLUMBING = /^(RouterView|RouterLink|Transition|TransitionGroup|BaseTransition|KeepAlive|Teleport|Suspense|NuxtRoot|NuxtPage|NuxtLayout|NuxtLayoutProvider|NuxtPageProvider|RouteProvider|ClientOnly|NuxtErrorBoundary|NuxtLink|Anonymous)$/;

function vueInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  let inst: VueInstance | undefined;
  for (let cur: Element | null = el; cur && !inst; cur = cur.parentElement) inst = (cur as unknown as { __vueParentComponent?: VueInstance }).__vueParentComponent;
  if (!inst) return null;
  let source = stampOf(el)?.source;
  if (!source && inst.type?.__file) source = { file: inst.type.__file };
  const comps: string[] = [];
  for (let i: VueInstance | null | undefined = inst; i && comps.length < 6; i = i.parent) {
    const t = i.type ?? {};
    const n = t.__name || t.name || (t.__file ? baseName(t.__file) : '');
    if (n && !VUE_PLUMBING.test(n)) comps.push(n);
  }
  return { source, components: dedupe(comps) };
}

/*
 * Angular (dev mode): Redline's builder turns on enableTemplateSourceLocations, so template
 * elements carry data-ng-source-location="src/app/x.html@o:12,l:3,c:4" (0-based line/col).
 * Components come from the global `ng` debug API: the one whose template holds the element,
 * then the components it sits in.
 */
type NgComponent = { constructor: { name: string; ɵcmp?: { debugInfo?: { className?: string; filePath?: string; lineNumber?: number } } } };
type NgDebug = { getOwningComponent(el: Element): NgComponent | null; getComponent(el: Element): NgComponent | null };
const ngName = (c: NgComponent) => c.constructor.ɵcmp?.debugInfo?.className || c.constructor.name.replace(/^_+/, '');

function angularInfo(el: Element): { source?: SourceLoc; components?: string[] } | null {
  const ng = (window as unknown as { ng?: NgDebug }).ng;
  const loc = el.closest('[data-ng-source-location]')?.getAttribute('data-ng-source-location');
  const m = loc ? /^(.*)@o:\d+,l:(\d+),c:(\d+)$/.exec(loc) : null;
  let source: SourceLoc | undefined = m ? { file: m[1], line: +m[2] + 1, col: +m[3] + 1 } : undefined;
  if (!ng?.getOwningComponent) return source ? { source } : null;
  const comps: string[] = [];
  const safe = <T>(f: () => T) => { try { return f(); } catch { return null; } };
  const owner = safe(() => ng.getOwningComponent(el));
  if (owner) {
    comps.push(ngName(owner));
    const dbg = owner.constructor.ɵcmp?.debugInfo;
    if (!source && dbg?.filePath) source = { file: dbg.filePath, line: dbg.lineNumber };
  }
  for (let cur = el.parentElement; cur; cur = cur.parentElement) {
    const host = cur;
    const c = safe(() => ng.getComponent(host));
    if (c) comps.push(ngName(c));
  }
  return source || comps.length ? { source, components: dedupe(comps) } : null;
}

/**
 * CMS content behind the element: `data-redline-cms="<content id>|<property>"` (stamped by a CMS
 * integration such as Umage.Redline.Optimizely), or Optimizely's own edit-mode attributes.
 * The nearest stamp with a content id decides the content; a property stamp below it names the
 * property (a block in a content area: the block, not the page's area property). A property
 * rendered as the element's only child (a wrapper around the value) counts as the element's own.
 */
export function cmsInfo(el: Element): CmsRef | undefined {
  const kid = el.children.length === 1 ? el.firstElementChild! : null;
  const start = kid?.hasAttribute('data-redline-cms') && clip(kid.textContent, 200) === clip(el.textContent, 200) ? kid : el;
  let property: string | undefined;
  for (let cur: Element | null = start.closest('[data-redline-cms]'); cur; cur = cur.parentElement?.closest('[data-redline-cms]') ?? null) {
    const v = cur.getAttribute('data-redline-cms')!;
    const i = v.lastIndexOf('|');
    const content = (i < 0 ? v : v.slice(0, i)) || undefined;
    property ??= (i < 0 ? '' : v.slice(i + 1)) || undefined;
    if (content) return { content, property };
  }
  if (property) return { property };
  const epi = el.closest('[data-epi-property-name],[data-epi-edit]');
  const epiProperty = epi?.getAttribute('data-epi-property-name') ?? epi?.getAttribute('data-epi-edit') ?? undefined;
  return epiProperty ? { property: epiProperty } : undefined;
}

function dedupe(a: string[]): string[] | undefined {
  const out = a.filter((x, i) => x && a.indexOf(x) === i).slice(0, 6);
  return out.length ? out : undefined;
}

export function sourceInfo(el: Element) {
  return reactInfo(el) ?? vueInfo(el) ?? angularInfo(el) ?? svelteInfo(el) ?? astroInfo(el) ?? stampInfo(el) ?? {};
}

/** The short label shown on hover and in pins: test id, else tag#id.class, plus source. */
export function labelFor(el: Element): string {
  const tid = testIdOf(el);
  let s = el.localName;
  if (tid) s += `[${tid.value}]`;
  else if (el.id && stableId(el.id)) s += `#${el.id}`;
  else {
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(c => c && !c.includes(':') && c.length < 24).slice(0, 2) : [];
    if (cls.length) s += '.' + cls.join('.');
  }
  const src = sourceInfo(el).source;
  if (src) s += `  ·  ${src.file.split(/[\\/]/).pop()}${src.line ? ':' + src.line : ''}`;
  return s;
}

export function describe(el: Element, clickX?: number, clickY?: number): Target {
  const r = el.getBoundingClientRect();
  const tid = testIdOf(el);
  const info = sourceInfo(el);
  const t: Target = {
    selector: selectorFor(el),
    testid: tid?.value,
    id: el.id && stableId(el.id) ? el.id : undefined,
    xpath: xpathFor(el),
    tag: el.localName,
    text: clip((el as HTMLElement).innerText ?? el.textContent, 80) || undefined,
    role: roleOf(el),
    name: nameOf(el),
    html: htmlExcerpt(el),
    source: info.source,
    components: info.components,
    cms: cmsInfo(el),
    box: [Math.round(r.x + scrollX), Math.round(r.y + scrollY), Math.round(r.width), Math.round(r.height)],
  };
  if (clickX !== undefined && clickY !== undefined && r.width && r.height) {
    t.fx = +((clickX - r.x) / r.width).toFixed(3);
    t.fy = +((clickY - r.y) / r.height).toFixed(3);
  }
  return t;
}

/** Find the element a stored target pointed at, or null. */
export function resolve(t: Target): Element | null {
  const textOk = (el: Element) => !t.text || clip((el as HTMLElement).innerText ?? el.textContent, 80).startsWith(t.text.slice(0, 20).replace(/…$/, ''));
  const tagOk = (el: Element | null): el is Element => !!el && (!t.tag || el.localName === t.tag);
  const q = (sel: string) => { try { return document.querySelector(sel); } catch { return null; } };

  if (t.selector) { const el = q(t.selector); if (tagOk(el) && textOk(el)) return el; }
  if (t.testid) { const el = q(TESTID_ATTRS.map(a => `[${a}="${cssEsc(t.testid!)}"]`).join(',')); if (tagOk(el)) return el; }
  if (t.id) { const el = document.getElementById(t.id); if (tagOk(el)) return el; }
  if (t.xpath) {
    try {
      const el = document.evaluate(t.xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue as Element | null;
      if (tagOk(el) && textOk(el)) return el;
    } catch { /* bad xpath */ }
  }
  if (t.tag && t.text) {
    const list = document.getElementsByTagName(t.tag);
    for (let i = 0; i < list.length && i < 3000; i++) if (textOk(list[i])) return list[i];
  }
  if (t.selector) { const el = q(t.selector); if (tagOk(el)) return el; }
  return null;
}

/** For text mode: the highest element that holds only text and inline markup. */
export function textBlockFor(el: Element): Element | null {
  const inlineOnly = (e: Element) => Array.from(e.children).every(c => {
    const d = getComputedStyle(c).display;
    return d.startsWith('inline') || d === 'contents' || c.localName === 'br';
  });
  let cur: Element | null = el;
  while (cur && !(inlineOnly(cur) && (cur as HTMLElement).innerText?.trim())) cur = cur.parentElement;
  if (!cur || cur === document.body) return null;
  while (cur.parentElement && cur.parentElement !== document.body && inlineOnly(cur.parentElement) &&
         getComputedStyle(cur).display.startsWith('inline')) cur = cur.parentElement;
  return cur;
}
